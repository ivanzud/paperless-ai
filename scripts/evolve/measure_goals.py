#!/usr/bin/env python3
"""Fallback goal measurer when `ao goals measure` is unavailable."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import time
from pathlib import Path

import yaml


def run_check(cmd: str, timeout_s: int) -> tuple[str, int | None, int, str]:
    started = time.time()
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            timeout=timeout_s,
            capture_output=True,
            text=True,
            check=False,
        )
        duration_ms = int((time.time() - started) * 1000)
        if proc.returncode == 0:
            result = "pass"
        else:
            result = "fail"
        output = (proc.stdout or proc.stderr or "").strip()
        return result, proc.returncode, duration_ms, output
    except subprocess.TimeoutExpired as exc:
        duration_ms = int((time.time() - started) * 1000)
        output = (exc.stdout or exc.stderr or "").strip() if isinstance(exc.stdout, str) else ""
        return "skip", None, duration_ms, output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--goals-file", default="GOALS.yaml")
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--goal", default=None, help="Measure only one goal id")
    args = parser.parse_args()

    goals_path = Path(args.goals_file)
    if not goals_path.exists():
        raise SystemExit(f"Missing goals file: {goals_path}")

    data = yaml.safe_load(goals_path.read_text())
    goals = data.get("goals", [])

    if args.goal:
        goals = [g for g in goals if g.get("id") == args.goal]

    measured = []
    for goal in goals:
        result, exit_code, duration_ms, output = run_check(goal["check"], args.timeout)
        measured.append(
            {
                "id": goal["id"],
                "description": goal.get("description", ""),
                "check": goal["check"],
                "weight": int(goal.get("weight", 1)),
                "result": result,
                "exit_code": exit_code,
                "duration_ms": duration_ms,
                "value": None,
                "threshold": None,
                "output": output[:4000],
            }
        )

    measured.sort(key=lambda g: (-g["weight"], g["id"]))

    snapshot = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "goals": measured,
    }
    print(json.dumps(snapshot, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
