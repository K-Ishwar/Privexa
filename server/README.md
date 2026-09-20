# Privexa Local planner server

Offline FastAPI planner. The server accepts only the strict semantic `Scene` wire schema; it never accepts screenshots, URLs, DOM attributes, free text, or user values. Validation errors and model errors are generic and do not echo request content. Unknown fields, duplicate element IDs, non-finite durations, and geometry outside the declared viewport are rejected.

## Local-only setup

```sh
cd server
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export PRIVEXA_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export PRIVEXA_MODE=DEMO
uvicorn main:app --host 127.0.0.1 --port 8765
```

When launched as a package, use `uvicorn server.main:app` from the repository parent. `PRIVEXA_TOKEN` is mandatory: every `/plan` call requires `Authorization: Bearer <token>`. `/health` is unauthenticated and returns no configuration or secrets.

**Keep this service loopback-only.** Do not use `--host 0.0.0.0`, expose port 8765 through a reverse proxy, or set `OLLAMA_URL` to a LAN/public address. The server accepts only `http://127.0.0.1`, `http://localhost`, or `http://[::1]` Ollama URLs. If another local process needs access, use an OS-level local permission boundary rather than opening a network listener. The bearer token is an additional local boundary, not a substitute for loopback binding or TLS on a deliberately different deployment.

## Planner modes

`PRIVEXA_MODE=DEMO` (default) uses a deterministic, explicitly non-LLM policy: a `SCROLL_DOWN` goal scrolls first; otherwise focus the first empty control, then click only an available CONTINUE/NEXT/REVIEW/BACK/CANCEL button, otherwise return DONE. It never submits or saves.

`PRIVEXA_MODE=OLLAMA` requires an already-running local Ollama-compatible endpoint. Set `OLLAMA_MODEL` and optionally `OLLAMA_URL` (default `http://127.0.0.1:11434/api/generate`) and `OLLAMA_TIMEOUT` seconds. Only loopback HTTP URLs are accepted. Install/download the pinned offline model yourself in Ollama; no model download or remote network call is performed by this server. The request includes the exact `ModelPlan.model_json_schema()` and the action policy. Ollama receives that schema in `format` by default; set `OLLAMA_JSON_SCHEMA=0` only for an older local runtime that supports JSON mode but not schema mode. Model output must be strict JSON with exactly `requestId`, `revision`, and `actions`; malformed, stale, unknown-target, or unsafe output fails closed with 503 (never falls back to DEMO).

`POST /plan` has a 128 KiB bounded streamed request limit and no permissive CORS. The caller must preview and explicitly approve actions; this server only returns one validated action. Synchronous Ollama I/O runs in a threadpool so it does not block the FastAPI event loop.

Run tests from the repository parent:

```sh
pytest -q server/test_server.py
```
