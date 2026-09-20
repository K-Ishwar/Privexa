from __future__ import annotations

import hmac
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
import asyncio
import websockets
# Load environment variables from .env file automatically
try:
    import os
    env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.env'))
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8-sig') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    os.environ[k.strip()] = v.strip()
    else:
        print(f"DEBUG: .env not found at {env_path}")
except Exception as e:
    print(f"DEBUG: .env loading failed: {e}")


# Coloured demo logging ──────────────────────────────────────────────────────
RESET  = "\033[0m"
CYAN   = "\033[96m"
GREEN  = "\033[92m"
YELLOW = "\033[93m"
RED    = "\033[91m"
BOLD   = "\033[1m"

def _log(msg: str, colour: str = CYAN) -> None:
    print(f"{colour}{BOLD}[Privexa]{RESET} {msg}", flush=True)

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

try:  # supports `uvicorn main:app` from server/ and `server.main:app` from repo root
    from .schema import Action, ModelPlan, Plan, Scene, ChatRequest
except ImportError:
    from schema import Action, ModelPlan, Plan, Scene, ChatRequest

MAX_BODY = 15 * 1024 * 1024
MAX_MODEL_OUTPUT = 32 * 1024
CLICK_LABELS = {"CONTINUE", "NEXT", "REVIEW", "BACK", "CANCEL"}

# Map from element semantic label to the vault token the server should request.
# The real value is resolved client-side from the encrypted vault — never on the server.
LABEL_TO_TOKEN: dict[str, str] = {
    "[PERSON_NAME]": "{{NAME}}",  "NAME": "{{NAME}}",
    "[EMAIL]": "{{EMAIL}}",        "EMAIL": "{{EMAIL}}",
    "[PHONE]": "{{PHONE}}",        "PHONE": "{{PHONE}}",
    "[ADDRESS]": "{{ADDRESS}}",    "ADDRESS": "{{ADDRESS}}",
    "[AADHAAR]": "{{AADHAAR}}",    "AADHAAR": "{{AADHAAR}}",
    "[PAN]": "{{PAN}}",            "PAN": "{{PAN}}",
    "[PASSWORD]": "{{PASSWORD}}",  "PASSWORD": "{{PASSWORD}}",
}

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Privexa Local planner", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def body_limit(request: Request, call_next):
    """Read at most MAX_BODY+1 bytes, never using an unbounded request.body()."""
    advertised = request.headers.get("content-length")
    if advertised is not None and (not advertised.isdigit() or int(advertised) > MAX_BODY):
        return JSONResponse({"detail": "request too large"}, status_code=413)
    try:
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_BODY:
                return JSONResponse({"detail": "request too large"}, status_code=413)
            chunks.append(chunk)
        # FastAPI's body parser sees this cache instead of attempting to consume the
        # already-read ASGI stream a second time.
        request._body = b"".join(chunks)
    except Exception:
        return JSONResponse({"detail": "invalid request"}, status_code=400)
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, __: RequestValidationError):
    return JSONResponse({"detail": "invalid request"}, status_code=422)


@app.exception_handler(ValidationError)
async def pydantic_error(_: Request, __: ValidationError):
    return JSONResponse({"detail": "invalid request"}, status_code=422)


@app.get("/health")
async def health():
    return {"status": "ok"}


def _authorized(request: Request) -> bool:
    token = os.environ.get("PRIVEXA_TOKEN", "")
    header = request.headers.get("authorization", "")
    if not token or not header.startswith("Bearer "):
        _log(f"Auth failed: token='{token}', header='{header}'", RED)
        return False
    supplied = header[7:]
    match = hmac.compare_digest(supplied, token)
    if not match:
        _log(f"Token mismatch! Server expects: '{token}', Extension sent: '{supplied}'", RED)
    return bool(supplied) and match


def _action_valid(action: Action, scene: Scene) -> bool:
    by_id = {element.id: element for element in scene.elements}
    if action.kind == "DONE":
        return action.target is None and action.amount == 0 and action.reason in {"REVIEW_REQUIRED", "NO_SAFE_ACTION"}
    if action.kind == "SCROLL":
        return action.target is None and action.amount != 0 and action.reason in {"USER_SCROLL", "NEXT_CONTROL"}
    if (action.target is None and action.targetCoordinate is None) or action.amount != 0:
        return False

    if action.targetCoordinate is not None:
        box = action.targetCoordinate
        if box.x + box.width > scene.viewport.width or box.y + box.height > scene.viewport.height:
            return False
        return action.kind in {"FOCUS", "FILL", "CLICK"}

    element = by_id.get(action.target)
    if element is None or element.state == "DISABLED":
        return False
    if action.kind == "FILL":
        # FILL is only valid for INPUT/SELECT fields with a known vault token
        from .schema import VAULT_TOKENS
        return (
            element.role in {"INPUT", "SELECT"}
            and action.reason in {"EMPTY_FIELD", "NEXT_CONTROL"}
            and action.value is not None
            and action.value in VAULT_TOKENS
        )
    if action.kind == "FOCUS":
        return element.role in {"INPUT", "SELECT", "CHECKBOX"} and action.reason in {"EMPTY_FIELD", "NEXT_CONTROL"}
    if action.kind == "CLICK":
        return (
            element.role == "BUTTON"
            and (element.label in CLICK_LABELS or element.label == "[UNKNOWN_VISUAL]")
            and element.state == "AVAILABLE"
            and action.reason in {"NEXT_CONTROL", "REVIEW_REQUIRED"}
        )
    return False


def _validate_plan(plan: Plan, scene: Scene) -> Plan:
    if plan.requestId != scene.requestId or plan.revision != scene.revision:
        raise ValueError("stale plan")
    if not plan.actions:
        raise ValueError("unsafe plan")
    for action in plan.actions:
        if not _action_valid(action, scene):
            raise ValueError("unsafe plan")
    return plan


def _demo(scene: Scene) -> Plan:
    # A scroll request is a first-class user goal.
    if scene.goal == "SCROLL_DOWN":
        action = Action(kind="SCROLL", target=None, amount=600, reason="USER_SCROLL")
        return Plan(requestId=scene.requestId, revision=scene.revision, mode="DEMO", actions=[action])

    # For known PII-labelled empty fields, return FILL with a vault token.
    # The extension resolves the token from its local encrypted vault — the server
    # never learns the actual value.
    for element in scene.elements:
        if element.state != "EMPTY" or element.role not in {"INPUT", "SELECT"}:
            continue
        token = LABEL_TO_TOKEN.get(str(element.label))
        if token:
            action = Action(kind="FILL", target=element.id, amount=0, reason="EMPTY_FIELD", value=token)  # type: ignore[arg-type]
            return Plan(requestId=scene.requestId, revision=scene.revision, mode="DEMO", actions=[action])

    # Fallback: FOCUS for fields without a known token (e.g. FIELD, SEARCH)
    target = next(
        (element for element in scene.elements if element.state == "EMPTY" and element.role in {"INPUT", "SELECT", "CHECKBOX"}),
        None,
    )
    if target:
        action = Action(kind="FOCUS", target=target.id, amount=0, reason="EMPTY_FIELD")
    else:
        button = next(
            (
                element
                for element in scene.elements
                if element.role == "BUTTON"
                and element.state == "AVAILABLE"
                and element.label in CLICK_LABELS
            ),
            None,
        )
        if button:
            action = Action(
                kind="CLICK",
                target=button.id,
                amount=0,
                reason="REVIEW_REQUIRED" if button.label == "REVIEW" else "NEXT_CONTROL",
            )
        else:
            action = Action(kind="DONE", target=None, amount=0, reason="NO_SAFE_ACTION")
    return Plan(requestId=scene.requestId, revision=scene.revision, mode="DEMO", actions=[action])


def _loopback(url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "http" or parsed.path == "" or parsed.username or parsed.password:
            return False
        host = parsed.hostname
        return host in {"127.0.0.1", "localhost", "::1"}
    except Exception:
        return False


def _ollama_prompt(scene: Scene) -> str:
    schema = json.dumps(ModelPlan.model_json_schema(), separators=(",", ":"), sort_keys=True)
    
    redaction_awareness = (
        "REDACTION SCHEME AWARENESS: You are operating on an anonymized, unidentifiable wire-frame of a webpage. "
        "To protect user privacy, raw pixels and sensitive texts have been redacted and replaced with semantic tags. "
        "For example, a name field is labeled '[PERSON_NAME]', an ID field is '[AADHAAR]' or '[PAN]', an email is '[EMAIL]', "
        "and general sensitive text is '[PRIVATE_TEXT]'. Images are labeled '[IMAGE]' or '[PERSON_IMAGE]'. "
        "If you see an element with label '[UNKNOWN_VISUAL]', it was discovered by a local edge computer vision model (YOLO26) "
        "and is likely a hidden UI element like a checkbox or icon. You may choose to interact with it if it logically makes sense. "
        "You must process this sanitized context to infer the form's intent and decide the next logical step.\n"
    )
    
    fill_instructions = (
        "FILL ACTION (PRIVACY-SAFE AUTOFILL): You may return a FILL action for INPUT or SELECT fields whose label "
        "maps to a known vault token. The extension resolves the token locally from the user's encrypted vault — "
        "you NEVER learn or return the real value. Use these token mappings:\n"
        "  [PERSON_NAME] or NAME  → value: \"{{NAME}}\"\n"
        "  [EMAIL] or EMAIL       → value: \"{{EMAIL}}\"\n"
        "  [PHONE] or PHONE       → value: \"{{PHONE}}\"\n"
        "  [ADDRESS] or ADDRESS   → value: \"{{ADDRESS}}\"\n"
        "  [AADHAAR] or AADHAAR   → value: \"{{AADHAAR}}\"\n"
        "  [PAN] or PAN           → value: \"{{PAN}}\"\n"
        "  [PASSWORD] or PASSWORD → value: \"{{PASSWORD}}\"\n"
        "For FILL: kind=\"FILL\", target=<element-uuid>, value=\"{{TOKEN}}\", amount=0, reason=\"EMPTY_FIELD\".\n"
        "For fields without a token mapping (like SELECT dropdowns, checkboxes, or generic text fields), you MUST use FOCUS. "
        "NEVER use CLICK to open a SELECT dropdown. NEVER return a FILL action with a made-up value; you may ONLY use the exact {{TOKEN}} strings listed above.\n"
    )
    
    policy = (
        "Allowed policy: return a single Plan containing an array of actions. "
        "You MUST provide a FILL action for EVERY empty field on the page that has a known token mapping. Process the entire form in one batch. "
        "FILL an INPUT/SELECT with a {{TOKEN}} for known PII fields (preferred over FOCUS when token is known). "
        "FOCUS only an existing non-disabled INPUT, SELECT, or CHECKBOX with no known token. "
        "CLICK only an existing available BUTTON labeled "
        "CONTINUE, NEXT, REVIEW, BACK, CANCEL, or [UNKNOWN_VISUAL]; never click SUBMIT, SAVE, a LINK, "
        "PAYMENT, or arbitrary navigation. Only provide a CLICK action if all fields are already FILLED or there are no fields to fill. "
        "SCROLL has target null, nonzero amount, and reason USER_SCROLL or NEXT_CONTROL. DONE has target null and amount 0. "
        "Never invent IDs, copy text, infer identity, or return free text. For SCROLL_DOWN, prefer SCROLL over field focus or navigation. "
        "If targeting a visually detected element without a DOM UUID, provide its box coordinates in targetCoordinate."
    )
    return (
        "Return ONLY JSON matching this exact JSON Schema (no markdown, no commentary):\n"
        + schema
        + "\n\n"
        + redaction_awareness
        + "\n"
        + fill_instructions
        + "\n"
        + policy
        + "\n\nThe semantic enum-only scene is:\n"
        + scene.model_dump_json(exclude={"privacy": {"redactedPixels": True}})
    )


def _ollama(scene: Scene) -> Plan:
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434/api/generate")
    model = os.environ.get("OLLAMA_MODEL", "")
    if not model or not _loopback(url):
        raise RuntimeError("model unavailable")

    # Ollama accepts either the JSON shorthand or a JSON Schema object as `format`.
    # Schema mode is the default; the explicit opt-out helps older local Ollama builds.
    format_value: Any
    if os.environ.get("OLLAMA_JSON_SCHEMA", "1").lower() in {"0", "false", "no"}:
        format_value = "json"
    else:
        format_value = ModelPlan.model_json_schema()
    payload = json.dumps(
        {"model": model, "prompt": _ollama_prompt(scene), "stream": False, "format": format_value},
        separators=(",", ":"),
    ).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=float(os.environ.get("OLLAMA_TIMEOUT", "8"))) as response:
            if response.status != 200:
                raise RuntimeError("model unavailable")
            outer_bytes = response.read(MAX_MODEL_OUTPUT + 1)
        if len(outer_bytes) > MAX_MODEL_OUTPUT:
            raise RuntimeError("bad model output")
        outer = json.loads(outer_bytes)
        if not isinstance(outer, dict):
            raise RuntimeError("bad model output")
        raw = outer.get("response")
        if not isinstance(raw, str) or len(raw.encode()) > MAX_MODEL_OUTPUT:
            raise RuntimeError("bad model output")
        candidate = ModelPlan.model_validate_json(raw)
        return _validate_plan(
            Plan(requestId=candidate.requestId, revision=candidate.revision, mode="OLLAMA", actions=candidate.actions),
            scene,
        )
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, ValidationError, urllib.error.URLError) as exc:
        raise RuntimeError("model unavailable") from exc

def _gemini(scene: Scene) -> Plan:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
    api_version = os.environ.get("GEMINI_API_VERSION", "v1alpha" if "live" in model.lower() else "v1beta")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")

    url = f"https://generativelanguage.googleapis.com/{api_version}/models/{model}:generateContent?key={api_key}"
    prompt = _ollama_prompt(scene)
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.0,
            "responseMimeType": "application/json"
        }
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            outer_bytes = response.read()

        outer = json.loads(outer_bytes)
        raw = outer.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        if not raw:
            raise RuntimeError("bad model output")
        _log(f"Gemini raw response: {raw[:200]}", CYAN)
        candidate = ModelPlan.model_validate_json(raw)
        return _validate_plan(
            Plan(requestId=candidate.requestId, revision=candidate.revision, mode="GEMINI", actions=candidate.actions),
            scene,
        )
    except urllib.error.HTTPError as exc:
        msg = exc.read().decode('utf-8', 'ignore')
        _log(f"Gemini API Error {exc.code}: {msg[:300]}", RED)
        if exc.code == 429:
            raise RuntimeError("API Rate Limit Exceeded (429). Please wait a minute.") from exc
        raise RuntimeError("model unavailable") from exc
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, ValidationError, urllib.error.URLError) as exc:
        raise RuntimeError("model unavailable") from exc


@app.post("/plan", response_model=Plan)
async def plan(request: Request, scene: Scene):
    if not _authorized(request):
        _log(f"401 Unauthorized – token mismatch", RED)
        return JSONResponse({"detail": "unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})

    # ── Demo logging: show what the server RECEIVED ──────────────────────────
    elem_count = len(scene.elements)
    pii_labels = [e.label for e in scene.elements if e.label.startswith('[')]
    safe_labels = [e.label for e in scene.elements if not e.label.startswith('[')]
    vision_status = scene.vision.status
    face_regions = len(scene.vision.regions)
    _log(f"Received sanitized Scene  goal={scene.goal}  elements={elem_count}  vision={vision_status}  face_regions={face_regions}", CYAN)
    _log(f"  PII labels (redacted)  : {pii_labels or 'none'}", YELLOW)
    _log(f"  Safe labels (sent)     : {safe_labels}", GREEN)
    _log(f"  rawPixels=False OK  freeText={scene.privacy.freeText}  mode={scene.privacy.mode}", GREEN)

    mode = os.environ.get("PRIVEXA_MODE", "DEMO").upper()
    try:
        if mode == "DEMO":
            result = _validate_plan(_demo(scene), scene)
        elif mode == "OLLAMA":
            result = await run_in_threadpool(_ollama, scene)
        elif mode == "GEMINI":
            if "live" in os.environ.get("GEMINI_MODEL", "").lower():
                result = await _gemini_live(scene)
            else:
                result = await run_in_threadpool(_gemini, scene)
        elif mode in ("GROQ", "OPENAI"):
            result = await run_in_threadpool(_openai_compatible, scene)
        else:
            return JSONResponse({"detail": "planner unavailable"}, status_code=503)
    except (RuntimeError, ValueError) as exc:
        _log(f"Planner error: {exc}", RED)
        return JSONResponse({"detail": str(exc)}, status_code=503)

    # ── Demo logging: show what the server RETURNED ──────────────────────────
    action = result.actions[0]
    _log(f"Returning Plan  mode={result.mode}  action={action.kind}  target={str(action.target)[:8] if action.target else 'null'}  reason={action.reason}", GREEN)
    return result


def _openai_compatible(scene: Scene) -> Plan:
    api_key = os.environ.get("OPENAI_API_KEY", "")
    url = os.environ.get("OPENAI_BASE_URL", "https://api.groq.com/openai/v1/chat/completions")
    model = os.environ.get("OPENAI_MODEL", "openai/gpt-oss-20b")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")

    prompt = _ollama_prompt(scene)
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "response_format": {"type": "json_object"}
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "Privexa/1.0"
    }, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            outer_bytes = response.read()

        outer = json.loads(outer_bytes)
        raw = outer.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not raw:
            raise RuntimeError("bad model output")
        
        _log(f"API raw response: {raw[:200]}", CYAN)
        candidate = ModelPlan.model_validate_json(raw)
        return _validate_plan(
            Plan(requestId=candidate.requestId, revision=candidate.revision, mode="OPENAI", actions=candidate.actions),
            scene,
        )
    except urllib.error.HTTPError as exc:
        msg = exc.read().decode('utf-8', 'ignore')
        _log(f"API Error {exc.code}: {msg[:300]}", RED)
        if exc.code == 429:
            raise RuntimeError("API Rate Limit Exceeded (429). Please wait a minute.") from exc
        raise RuntimeError("model unavailable") from exc
    except Exception as exc:
        _log(f"API Error: {exc}", RED)
        raise RuntimeError("model unavailable") from exc


async def _gemini_live(scene: Scene) -> Plan:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    model = os.environ.get("GEMINI_MODEL", "gemini-3.8-live")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")

    uri = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={api_key}"
    
    try:
        async with websockets.connect(uri) as ws:
            setup_payload = {
                "setup": {
                    "model": f"models/{model}"
                }
            }
            await ws.send(json.dumps(setup_payload))
            
            prompt = _ollama_prompt(scene)
            content_payload = {
                "clientContent": {
                    "turns": [{"role": "user", "parts": [{"text": prompt}]}],
                    "turnComplete": True
                }
            }
            await ws.send(json.dumps(content_payload))

            raw_response = ""
            async for message in ws:
                msg_data = json.loads(message)
                server_content = msg_data.get("serverContent", {})
                model_turn = server_content.get("modelTurn", {})
                parts = model_turn.get("parts", [])
                
                for part in parts:
                    if "text" in part:
                        raw_response += part["text"]
                        
                if server_content.get("turnComplete"):
                    break
                    
            if not raw_response:
                raise RuntimeError("bad model output (empty response)")
                
            _log(f"Gemini Live raw response: {raw_response[:200]}", CYAN)
            # Remove any markdown code block fences if the model wraps it
            if raw_response.strip().startswith("```json"):
                raw_response = raw_response.strip()[7:]
                if raw_response.endswith("```"):
                    raw_response = raw_response[:-3]
            elif raw_response.strip().startswith("```"):
                raw_response = raw_response.strip()[3:]
                if raw_response.endswith("```"):
                    raw_response = raw_response[:-3]

            candidate = ModelPlan.model_validate_json(raw_response.strip())
            return _validate_plan(
                Plan(requestId=candidate.requestId, revision=candidate.revision, mode="GEMINI", actions=candidate.actions),
                scene,
            )
    except Exception as exc:
        _log(f"Gemini Live Error: {exc}", RED)
        raise RuntimeError("model unavailable") from exc


def _gemini_chat(scene: Scene, question: str) -> str:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    
    prompt = f"""You are a helpful AI assistant helping a user navigate a web form.
The user's page has been heavily sanitized for privacy. Sensitive data (like names, emails, card numbers) has been replaced with tags like [PERSON_NAME], [EMAIL], [AADHAAR], etc.
Answer the user's question based on the structural context provided. Be extremely brief, concise, and helpful. Do not mention that the data is sanitized, just act naturally.

Sanitized Page Context:
{scene.model_dump_json(exclude_none=True)}

User Question:
{question}
"""

    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.3,
        }
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            outer_bytes = response.read()

        outer = json.loads(outer_bytes)
        raw = outer.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        if not raw:
            raise RuntimeError("bad model output")
        return raw.strip()
    except urllib.error.HTTPError as exc:
        _log(f"Gemini API Error {exc.code}: {exc.read().decode('utf-8', 'ignore')[:300]}", RED)
        raise RuntimeError("model unavailable") from exc
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, urllib.error.URLError) as exc:
        raise RuntimeError("model unavailable") from exc

@app.post("/chat")
async def chat(request: Request) -> JSONResponse:
    try:
        body = await request.body()
        if not body:
            return JSONResponse({"detail": "missing body"}, status_code=400)
        
        chat_req = ChatRequest.model_validate_json(body)
        
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else chat_req.token
        
        _log(f"Received chat request. Question: '{chat_req.question}'")
        
        if not token or token.upper() == "DEMO":
            return JSONResponse({"answer": "I am a local demo assistant. I see you are on a form with elements like " + ", ".join(e.label for e in chat_req.scene.elements[:3])})
        
        # In a real setup, we'd validate the token here.
        answer = await run_in_threadpool(_gemini_chat, chat_req.scene, chat_req.question)
        
        return JSONResponse({"answer": answer})

    except ValidationError as exc:
        _log(f"Chat request validation error: {exc}", YELLOW)
        return JSONResponse({"detail": "invalid request"}, status_code=422)
    except (RuntimeError, ValueError) as exc:
        _log(f"Chat error: {exc}", RED)
        return JSONResponse({"detail": "chat unavailable"}, status_code=503)
