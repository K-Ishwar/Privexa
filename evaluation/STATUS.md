# Verification record — 8 September 2026

- Extension source: bundled successfully for Chrome and Firefox with esbuild.
- Server: 11 pytest tests passed, including mocked Ollama structured output. One dependency deprecation warning; no test failures.
- Chromium 141 headless: 8 content-script messaging-harness checks passed. The eighth called the actual local FastAPI DEMO endpoint and executed its returned action in the test page. Detailed check names: `browser-results.json`.
- Fixed integration defects found during development: content-runtime initialization order, character-data mutation invalidation, JS runtime asset copying, versioned BlazeFace download location, and action replay prevention.

## Not validated

Installed extension permissions/popup/CSP, Firefox runtime, face model inference, actual Ollama inference, OCR, contextual NER, target-device resource consumption, cold/warm latency percentiles and held-out SIH accuracy. Model weights are intentionally absent from the archive and need explicit setup. The eight browser checks are functional regressions, not benchmark scores.

The server tests can be rerun with `python -m pytest -q server/test_server.py`. Build and browser-test instructions are in the root README. The synthetic PII fixture is exploratory and includes a deliberately invalid mobile-shaped placeholder; refine/annotate the dataset before claiming a precision/recall score.
