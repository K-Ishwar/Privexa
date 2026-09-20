# Evaluation benchmark template

This directory contains a small, labeled, synthetic fixture and a timing summarizer. It is a template only: no model was executed and no benchmark result is claimed. Replace `timings.template.json` with measurements collected from a local run; do not put raw page content or real PII in an evaluation file.

## Primary SIH metric formulas

The benchmark reports the five primary metrics below. Counts are taken from a labeled fixture and a run's predictions; undefined divisions are reported as `null`, never as a fabricated zero.

1. **Accuracy** = `(TP + TN) / (TP + TN + FP + FN)`
2. **Precision** = `TP / (TP + FP)`
3. **Recall (sensitivity)** = `TP / (TP + FN)`
4. **F1** = `2 × Precision × Recall / (Precision + Recall)`
5. **Latency** = report both **p50** and **p95** over valid non-negative request durations in milliseconds. For sorted values `x` and percentile `q`, the script uses linear interpolation at `q × (n − 1)`.

For action-planner evaluation, report these secondary safety/task measures alongside the five primary metrics when the run provides the fields: **safe-action rate** = `safe actions / total actions`, and **task success rate** = `successful tasks / total tasks`. These are intentionally not invented when absent.

## Files and commands

- `pii-fixture.json`: synthetic labeled cases, including Devanagari/Unicode Indian digits and hard negatives that resemble PII but are not PII.
- `timings.template.json`: empty input template. Add records shaped like `{"latency_ms": 42.5}` or `{"durationMs": 42.5}` from an actual run.
- `benchmark.py`: standard-library-only summarizer. It accepts one or more JSON or JSONL files and extracts timing records without echoing their content.

```sh
# No result is claimed for the empty template; this prints count=0 and null percentiles.
python evaluation/benchmark.py evaluation/timings.template.json

# After collecting real timings (never synthetic values), summarize all files.
python evaluation/benchmark.py run-1.json run-2.jsonl
```

The script emits compact JSON with `count`, `p50_ms`, and `p95_ms`. Invalid, negative, non-finite, or missing timing values are ignored and counted in `ignored`. It does not call Ollama or any remote service.
