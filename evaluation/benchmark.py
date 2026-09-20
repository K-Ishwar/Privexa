#!/usr/bin/env python3
"""Summarize measured latency JSON/JSONL files without fabricating benchmark data."""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Iterable

TIMING_KEYS = ("latency_ms", "latencyMs", "duration_ms", "durationMs")


def _records(path: Path) -> Iterable[Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".jsonl":
        for line_number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON") from exc
        return
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: invalid JSON") from exc
    if isinstance(value, list):
        yield from value
    elif isinstance(value, dict) and isinstance(value.get("records"), list):
        yield from value["records"]
    else:
        raise ValueError(f"{path}: expected a JSON array or an object with records[]")


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = q * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def summarize(paths: list[Path]) -> dict[str, Any]:
    durations: list[float] = []
    ignored = 0
    files = 0
    for path in paths:
        files += 1
        for record in _records(path):
            if not isinstance(record, dict):
                ignored += 1
                continue
            value = next((record.get(key) for key in TIMING_KEYS if key in record), None)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                ignored += 1
                continue
            duration = float(value)
            if not math.isfinite(duration) or duration < 0:
                ignored += 1
                continue
            durations.append(duration)
    return {
        "files": files,
        "count": len(durations),
        "ignored": ignored,
        "p50_ms": _percentile(durations, 0.50),
        "p95_ms": _percentile(durations, 0.95),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize measured timing JSON files")
    parser.add_argument("files", nargs="+", type=Path, help="JSON array/object or JSONL measurement files")
    args = parser.parse_args()
    try:
        result = summarize(args.files)
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, separators=(",", ":")), file=sys.stderr)
        return 2
    print(json.dumps(result, separators=(",", ":"), allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
