#!/usr/bin/env python3
"""
Student-mode wrapper for the deterministic UCT EEE Student Advising CLI helper.

Automatically enforces `--student-mode` (single-student privacy guardrails and
prominent non-official planning aid disclaimer) while delegating all curriculum,
equivalency, progression, Additional Assessment, prerequisite, and timetable
clash calculations to the shared `feccheck` engine.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main() -> None:
    here = Path(__file__).resolve()
    staff_script = here.parents[2] / "staffadvisor" / "scripts" / "advise_student.py"
    if not staff_script.is_file():
        sys.exit(f"Error: Expected shared engine script at {staff_script}")

    argv = [sys.executable, str(staff_script), "--student-mode", *sys.argv[1:]]
    res = subprocess.run(argv, env=os.environ.copy())
    sys.exit(res.returncode)


if __name__ == "__main__":
    main()
