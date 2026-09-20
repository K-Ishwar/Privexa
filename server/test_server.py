import json
import uuid

from fastapi.testclient import TestClient

from . import main
from .main import app

TOKEN = "test-token"
client = TestClient(app)


def scene(*, goal="REVIEW_FORM", with_empty=True):
    elements = []
    if with_empty:
        elements.append(
            {
                "id": str(uuid.uuid4()),
                "role": "INPUT",
                "label": "EMAIL",
                "state": "EMPTY",
                "box": {"x": 0, "y": 0, "width": 100, "height": 20},
            }
        )
    return {
        "version": "1.0",
        "requestId": str(uuid.uuid4()),
        "revision": str(uuid.uuid4()),
        "goal": goal,
        "viewport": {"width": 800, "height": 600},
        "elements": elements,
        "vision": {"status": "NOT_RUN", "backend": "NONE", "durationMs": 0, "regions": []},
        "privacy": {"mode": "SEMANTIC_ONLY", "rawPixels": False, "freeText": False, "redactedPixels": None},
    }


def auth():
    return {"Authorization": f"Bearer {TOKEN}"}


def test_health_no_secret(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    response = client.get("/health")
    assert response.status_code == 200 and response.json() == {"status": "ok"}


def test_auth_required(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    response = client.post("/plan", json=scene())
    assert response.status_code == 401


def test_demo_and_strict_overpost(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    monkeypatch.setenv("PRIVEXA_MODE", "DEMO")
    payload = scene()
    payload["screenshot"] = "raw"
    assert client.post("/plan", json=payload, headers=auth()).status_code == 422
    response = client.post("/plan", json=scene(), headers=auth())
    assert response.status_code == 200 and response.json()["mode"] == "DEMO"


def test_raw_text_nested_rejected(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    payload = scene()
    payload["privacy"]["text"] = "secret"
    response = client.post("/plan", json=payload, headers=auth())
    assert response.status_code == 422


def test_duplicate_ids_and_out_of_viewport_geometry_rejected(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    payload = scene()
    payload["elements"].append(dict(payload["elements"][0]))
    assert client.post("/plan", json=payload, headers=auth()).status_code == 422

    payload = scene()
    payload["elements"][0]["box"]["x"] = 799
    payload["elements"][0]["box"]["width"] = 2
    assert client.post("/plan", json=payload, headers=auth()).status_code == 422


def test_scroll_goal_has_priority_over_empty_controls(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    monkeypatch.setenv("PRIVEXA_MODE", "DEMO")
    response = client.post("/plan", json=scene(goal="SCROLL_DOWN"), headers=auth())
    assert response.status_code == 200
    assert response.json()["actions"] == [
        {"kind": "SCROLL", "target": None, "targetCoordinate": None, "amount": 600, "reason": "USER_SCROLL"}
    ]


def test_bounded_body_rejected(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    response = client.post(
        "/plan",
        content=b"x" * (128 * 1024 + 1),
        headers={**auth(), "content-type": "application/json"},
    )
    assert response.status_code == 413


class _Response:
    status = 200

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self, _):
        return self.body


def test_valid_structured_mock_ollama_and_prompt_schema(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    monkeypatch.setenv("PRIVEXA_MODE", "OLLAMA")
    monkeypatch.setenv("OLLAMA_MODEL", "offline-test-model")
    payload = scene()
    element_id = payload["elements"][0]["id"]
    output = {
        "requestId": payload["requestId"],
        "revision": payload["revision"],
        "actions": [{"kind": "FOCUS", "target": element_id, "targetCoordinate": None, "amount": 0, "reason": "EMPTY_FIELD"}],
    }
    seen = {}

    def fake_urlopen(request, timeout):
        seen["timeout"] = timeout
        seen["payload"] = json.loads(request.data)
        return _Response(json.dumps({"response": json.dumps(output)}).encode())

    monkeypatch.setattr(main.urllib.request, "urlopen", fake_urlopen)
    response = client.post("/plan", json=payload, headers=auth())
    assert response.status_code == 200
    assert response.json()["mode"] == "OLLAMA"
    assert response.json()["actions"] == output["actions"]
    assert isinstance(seen["payload"]["format"], dict)
    assert '"requestId"' in seen["payload"]["prompt"]
    assert "CLICK only" in seen["payload"]["prompt"]


def test_malformed_model_fails_closed(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    monkeypatch.setenv("PRIVEXA_MODE", "OLLAMA")
    monkeypatch.setenv("OLLAMA_MODEL", "offline-test-model")
    monkeypatch.setattr(main.urllib.request, "urlopen", lambda *a, **k: _Response(b'{"response":"not-json"}'))
    response = client.post("/plan", json=scene(), headers=auth())
    assert response.status_code == 503


def test_unknown_target_model_fails_closed(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    monkeypatch.setenv("PRIVEXA_MODE", "OLLAMA")
    monkeypatch.setenv("OLLAMA_MODEL", "offline-test-model")
    payload = scene()
    raw = {
        "requestId": payload["requestId"],
        "revision": payload["revision"],
        "actions": [
            {
                "kind": "FOCUS",
                "target": str(uuid.uuid4()),
                "amount": 0,
                "reason": "EMPTY_FIELD",
            }
        ],
    }
    monkeypatch.setattr(
        main.urllib.request,
        "urlopen",
        lambda *a, **k: _Response(json.dumps({"response": json.dumps(raw)}).encode()),
    )
    response = client.post("/plan", json=payload, headers=auth())
    assert response.status_code == 503


def test_remote_ollama_target_fails_closed(monkeypatch):
    monkeypatch.setenv("PRIVEXA_TOKEN", TOKEN)
    monkeypatch.setenv("PRIVEXA_MODE", "OLLAMA")
    monkeypatch.setenv("OLLAMA_MODEL", "offline-test-model")
    monkeypatch.setenv("OLLAMA_URL", "http://example.invalid/api/generate")
    response = client.post("/plan", json=scene(), headers=auth())
    assert response.status_code == 503
