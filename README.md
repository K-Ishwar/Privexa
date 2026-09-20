# Privexa Local
## SIH 26171 · On-device Visual Perception for Light-weight Browser Agents

**Prototype v0.1 — runnable DOM-first demonstration, not yet finale-ready.**

The extension reconstructs the screen as typed labels and geometry. A name field becomes `[PERSON_NAME]`, an email becomes `[EMAIL]`, an unknown image becomes `[IMAGE]`. The planner does not receive screenshots, input values, page URLs, titles, or unrestricted text. It returns one validated action, which the user approves locally.

## What is implemented

- Chrome and Firefox Manifest V3 builds; user-activated top-frame inspection, no permanent all-sites content script.
- DOM-first perception, local field hints and regex rules for email, Indian mobile formats, Aadhaar-shaped and PAN-shaped identifiers. Common Indian numeral scripts are normalized locally. These are format detectors, not identity/ID-validity verification.
- Semantic-only screen map and exact outgoing JSON preview. Unknown content is conservatively replaced, not blurred or blacked out. The original webpage is not modified.
- Local MediaPipe face inference integration using packaged WASM and a separately downloaded BlazeFace model. Faces become `[PERSON_IMAGE]`; other images remain generic. **The model has not been executed in this build environment.**
- Token-authenticated FastAPI planner: clearly marked deterministic **DEMO** mode and a real **OLLAMA** integration for an offline open-weight model. OLLAMA does not silently fall back to rules.
- Strict schemas on both sides; unknown fields and invalid actions rejected. Revision checks, target revalidation, one-use approvals, no arbitrary selectors/scripts, no native submission/save/link actions.
- Synthetic two-step application demo, browser test harness, server tests, PII fixtures and evaluation templates.

## Quick start — DOM demonstration

Prerequisites: Node.js 20+, Python 3.11+, Chrome or Firefox. Extract the archive into a local folder.

### 1. Start the planner

From the project root, in a terminal:

```sh
python -m venv .venv
# macOS/Linux:
. .venv/bin/activate
# Windows PowerShell instead:
# .\.venv\Scripts\Activate.ps1
pip install -r server/requirements.txt
```

Set a fresh token (use the same value in the extension):

```sh
# macOS/Linux
export PRIVEXA_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
echo "$PRIVEXA_TOKEN"
export PRIVEXA_MODE=DEMO
python -m uvicorn server.main:app --host 127.0.0.1 --port 8765 --no-access-log
```

PowerShell environment syntax:

```powershell
$env:PRIVEXA_TOKEN = python -c "import secrets; print(secrets.token_urlsafe(32))"
$env:PRIVEXA_TOKEN
$env:PRIVEXA_MODE = "DEMO"
python -m uvicorn server.main:app --host 127.0.0.1 --port 8765 --no-access-log
```

The token is kept only in the open popup; re-enter it when reopening. Do not expose the service publicly.

### 2. Open the test page

In another terminal at the project root:

```sh
python -m http.server 8080 --bind 127.0.0.1 --directory demo
```

Visit **http://127.0.0.1:8080**. Use fictional test data only.

### 3. Load the extension

The ZIP includes prebuilt extensions **without vision assets**.

- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → select `dist/chrome`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `dist/firefox/manifest.json`. This development installation is temporary; release signing is not provided.

Open the extension on the demo page. Leave the face-model checkbox off initially. Choose a task → **Inspect this tab** → inspect the map and complete JSON → enter token → **Approve & send labels** → inspect the plan → **Approve action**. After editing fields or acting, inspect again. Inputs are filled by the user; the agent focuses controls or advances using approved buttons. The popup closes normally when you return to the page.

## Enable local vision

```sh
npm install
npm run setup:vision
npm run build
```

Reload the extension. Setup explicitly downloads the versioned Google BlazeFace model and copies local JS/WASM runtime assets. Runtime inference has no CDN fallback. SHA256 records document downloaded bytes; they are not independently authenticated hashes. Review `vision/README.md`. Expect more than a few megabytes once runtime assets are included; measure the installed bundle rather than repeating a “1000x lighter” claim.

Enable the face-model checkbox and inspect a consented face-containing page. The model runs on the CPU/WASM delegate; **no WebGPU claim**. `UNAVAILABLE` means inference did not succeed, not that the page has no faces. Generic image labels still prevent pixel upload when vision is unavailable.

## Use a real offline LLM

Install Ollama separately, download an appropriate open-weight model, and start its local service. Restart FastAPI with:

```sh
export PRIVEXA_MODE=OLLAMA
export OLLAMA_MODEL="your-installed-model-tag"
export OLLAMA_TIMEOUT=8
```

On PowerShell, use `$env:NAME = "value"`. The model receives a semantic scene plus the response schema, not raw pixels. Model quality/latency depend on the selected model and hardware. Real-model execution has not been validated here; the structured integration is covered with mocked responses. This prototype deliberately does not enable a cloud endpoint.

## Verification performed

- **11 server tests passed.** Authentication, strict schemas, request limits, unsafe/stale actions and mocked Ollama output are covered.
- **8 Chromium browser-harness checks passed**, including a real local FastAPI DEMO request followed by a browser action.
- Both extension bundles compiled. Browser checks execute the content script with a messaging harness; they do **not** prove installed-extension permissions, popup/CSP behavior or Firefox compatibility.
- No face-model accuracy, actual LLM task-success, memory, GPU or SIH score has been measured. See `evaluation/browser-results.json` and `evaluation/README.md`.

Reproduce tests:

```sh
python -m pytest -q server/test_server.py
npm install
npm run build
npx playwright install chromium
npm run test:browser
```

On Linux, Playwright may require `npx playwright install-deps chromium`. To include the real-server round-trip test, start DEMO server and set `PRIVEXA_TEST_TOKEN` to its token before running the browser tests.

## Judging readiness and next priorities

| SIH metric | Current implementation | Work still required |
|---|---|---|
| Visual context accuracy · 25% | DOM geometry and semantic labels; face-model integration | Execute and measure vision; add local OCR/layout understanding for canvas/image-only UIs |
| Sensitive-data recall/precision · 20% | DOM hints, format rules, conservative unknown labels | Contextual names/addresses, multilingual NER, labeled held-out dataset |
| Redaction precision · 20% | Reconstructed enum-only context; no original pixel payload | Quantify retained useful content and over-redaction; alignment tests at zoom/scroll |
| Client resources · 20% | On-demand DOM scan; opt-in lazy vision and cleanup | Measure cold/warm memory, CPU and runtime/model bytes; move heavy work to worker |
| End-to-end latency · 15% | Bounded local request; timing display/template | Target-laptop p50/p95 with real model and multiple tasks |

**Honest USP:** the server cannot request arbitrary raw screenshots through this schema; unknown content has a conservative representation; typed one-use action handles and stale-scene rejection reduce execution risk. These are demonstrable design properties, not a guarantee of complete anonymity or prompt-injection immunity.

## Security and scope limits

Geometry, semantic categories, field occupancy and request timing still reveal information. A malicious page can manipulate structure or the meaning of a button; user approval does not make every click harmless. Do not use this prototype on banking, payment, medical or production systems. The original webpage may send its own data; this extension controls only its own planner channel. Browser/OS compromise and deliberate covert channels are out of scope.

Unknown text is over-redacted: this protects content but reduces planner usefulness and may hurt judging precision. OCR, semantic name NER, regional-language understanding, general image labeling, cross-origin iframe/closed-shadow DOM extraction, screenshot redaction overlays, Firefox installation testing and real device benchmarks are not complete. No claim about Comet or competing products, “1000x lighter,” formal OWASP compliance, perfect privacy or guaranteed SIH selection is made.
