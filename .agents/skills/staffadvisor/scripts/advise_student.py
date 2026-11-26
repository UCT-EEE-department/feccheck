#!/usr/bin/env python3
"""
Deterministic UCT EEE Student Advising & Progression CLI Helper.

Wraps the source-of-truth `feccheck` engine (`crs_parser.py`, `program_defs.py`,
`fec_check.py`, and `timetable_schedule.json`) to provide zero-hallucination:
  1. Student record lookup (by Campus ID / Name in CRS CSVs, pasted CRS excerpts,
     or synthetic JSON course lists for conversational queries).
  2. Complete qualification, core/elective (`tcert`), equivalency, Honours,
     N+1/N+2, Additional Assessment (`aa_course`), and 7-scenario What-If audits.
  3. Registration proposal validation: Prerequisites, Corequisites, Capstone
     (`EEE4022S/F`) rules, Hard vs Soft (`_P`) Timetable Clashes, and credit load.
  4. Cohort triage across a CRS dump (staff mode only).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple


def _find_feccheck_dir() -> Path:
    env_dir = os.environ.get("FECCHECK_DIR")
    if env_dir and (Path(env_dir) / "fec_check.py").is_file():
        return Path(env_dir).resolve()

    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "fec_check.py").is_file() and (parent / "program_defs.py").is_file():
            return parent
        candidate = parent / "feccheck"
        if (candidate / "fec_check.py").is_file() and (candidate / "program_defs.py").is_file():
            return candidate

    cwd = Path.cwd().resolve()
    for base in [cwd, cwd / "feccheck", *cwd.parents]:
        if (base / "fec_check.py").is_file():
            return base
    raise FileNotFoundError("Could not locate feccheck directory containing fec_check.py and program_defs.py")


FECCHECK_DIR = _find_feccheck_dir()
if str(FECCHECK_DIR) not in sys.path:
    sys.path.insert(0, str(FECCHECK_DIR))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from crs_parser import SREC_HEADERS, YSTATS_HEADERS, apply_update, parsecrsinput  # noqa: E402
from fec_check import EEE_PROGS, FECCheck  # noqa: E402
from program_defs import (  # noqa: E402
    COURSE_COREQUISITES,
    COURSE_CREDITS,
    COURSE_EQUIVALENCIES,
    COURSE_PREREQUISITES,
    PROGRAM_SPECS,
    TIMETABLE_SEMESTER_1,
    TIMETABLE_SEMESTER_2,
)

PROG_DESCRIPTIONS = {
    "EB009": "BSc(Eng) in Electrical Engineering",
    "EB809": "BSc(Eng) in Electrical Engineering (ASPECT)",
    "EB011": "BSc(Eng) in Mechatronics",
    "EB811": "BSc(Eng) in Mechatronics (ASPECT)",
    "EB022": "BSc(Eng) in Electrical & Computer Engineering",
    "EB822": "BSc(Eng) in Electrical & Computer Engineering (ASPECT)",
}

TFER_DESCRIPTIONS = {
    0: "Standard direct-entry (tfer = 0)",
    1: "Internal UCT transfer (tfer = 1)",
    2: "External transfer with credits (tfer = 2)",
    3: "Interrupted / left & returned to EEE (tfer = 3)",
    -1: "Non-EEE / unclassified (tfer = -1)",
}

PERIOD_LABELS = [
    ("1", "08:00"),
    ("2", "09:00"),
    ("3", "10:00"),
    ("4", "11:00"),
    ("5", "12:00"),
    ("M", "13:00"),
    ("6", "14:00"),
    ("7", "15:00"),
    ("8", "16:00"),
    ("9", "17:00"),
]
DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]


def discover_default_crs_files() -> List[Path]:
    """Find candidate CRS CSV dumps in feccheck/ and its parent workspace."""
    candidates: List[Path] = []
    search_dirs = [FECCHECK_DIR, FECCHECK_DIR.parent]
    seen: Set[Path] = set()
    for d in search_dirs:
        if not d.is_dir():
            continue
        for p in d.glob("*.csv"):
            rp = p.resolve()
            if rp in seen:
                continue
            name_upper = p.name.upper()
            if "GPA" in name_upper:
                continue
            if "CSV" in name_upper or "CRS" in name_upper:
                seen.add(rp)
                candidates.append(rp)
    # Sort newest modified/largest recent dumps first, preferring UG FULL CSV June 2026 then March 2026
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates


def load_course_titles() -> Dict[str, str]:
    """Build a course-code -> course-title map from available CRS CSVs if fast, or fallback."""
    titles: Dict[str, str] = {}
    for csv_path in discover_default_crs_files():
        try:
            stinfo, _ = parsecrsinput(str(csv_path), maxrec=80)
            for rec in stinfo:
                srec = rec.get("srec")
                if isinstance(srec, pd.DataFrame) and not srec.empty:
                    for _, r in srec.iterrows():
                        code = str(r["course"]).strip()
                        title = str(r["coursen"]).strip()
                        if code and title and code not in titles and title != "Updated/New Course":
                            titles[code] = title
            if len(titles) > 40:
                break
        except Exception:
            continue
    return titles


def ensure_crs_excerpt_parseable(raw_text: str) -> str:
    """Ensure a pasted CRS snippet has a valid header and trailing ',Passed:' marker."""
    lines = [ln for ln in raw_text.splitlines() if ln.strip()]
    if not lines:
        return raw_text
    has_passed = any("Passed:" in ln for ln in lines)
    if not has_passed:
        lines.append(",Passed:,,,,")
    return "\n".join(lines) + "\n"


def extract_student_slice_from_csv(csv_path: Path, campus_id: Optional[str], name_query: Optional[str]) -> List[Dict[str, Any]]:
    """
    Fast scan of a potentially huge CRS CSV to extract only matching student blocks
    before invoking parsecrsinput, avoiding parsing thousands of unrelated records.
    """
    cid_upper = campus_id.strip().upper() if campus_id else None
    name_upper = name_query.strip().upper() if name_query else None

    header_re = re.compile(r"[A-Z]{6}[0-9]{3}")
    matched_blocks: List[str] = []
    current_block: List[str] = []
    in_match = False

    with open(csv_path, "r", encoding="latin-1", errors="replace") as f:
        for line in f:
            # Check if this line starts a new student record
            if header_re.search(line):
                # Verify via lightweight CSV split like crs_parser
                cleaned = re.sub(r'""(.*?)""', r'"\1"', line).strip().rstrip(";").strip('"')
                try:
                    import csv as _csv
                    row = next(_csv.reader(io.StringIO(cleaned)))
                except Exception:
                    row = []
                if len(row) > 2 and re.match(r"^[A-Z]{6}[0-9]{3}$", row[2].strip()):
                    if in_match and current_block:
                        matched_blocks.append("".join(current_block))
                    current_block = []
                    rec_cid = row[2].strip().upper()
                    rec_empl = row[3].strip().upper() if len(row) > 3 else ""
                    rec_name = f"{row[0]},{row[1]}".upper()
                    if cid_upper:
                        in_match = (rec_cid == cid_upper) or (rec_empl == cid_upper)
                    elif name_upper:
                        in_match = name_upper in rec_name
                    else:
                        in_match = False

            if in_match:
                current_block.append(line)
                if "Passed:" in line:
                    matched_blocks.append("".join(current_block))
                    current_block = []
                    in_match = False

    if in_match and current_block:
        matched_blocks.append(ensure_crs_excerpt_parseable("".join(current_block)))

    if not matched_blocks:
        return []

    combined_text = "\n".join(matched_blocks)
    with tempfile.NamedTemporaryFile("w", suffix=".csv", encoding="latin-1", delete=False) as tf:
        tf.write(combined_text)
        temp_path = tf.name
    try:
        stinfo, _ = parsecrsinput(temp_path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
    return stinfo


def build_synthetic_record(spec: Dict[str, Any]) -> Dict[str, Any]:
    """
    Construct a FECCheck-compatible `strec` from a JSON dictionary for conversational
    advising queries where no raw CRS dump is available.
    """
    cid = str(spec.get("campus_id", "SYNTH001")).strip().upper()
    name = str(spec.get("name", "Student, Synthetic")).strip()
    emplid = str(spec.get("empl_id", "0000000")).strip()
    prog = str(spec.get("program", "EB009")).strip().upper()

    courses_in = spec.get("courses", [])
    years_in = spec.get("years", [])

    # Infer years from courses if years_in omitted
    if not years_in:
        inferred_years = sorted({int(c.get("yt", 2026)) for c in courses_in} or {2026})
        for idx, yr in enumerate(inferred_years, start=1):
            ayos_names = {1: "First Year", 2: "Second Yr", 3: "Third Year", 4: "Fourth Yr", 5: "Fifth Year"}
            years_in.append({
                "yr": yr,
                "tt": "R",
                "preg": prog,
                "pnam": PROG_DESCRIPTIONS.get(prog, prog),
                "ayosn": ayos_names.get(idx, f"Year {idx}"),
                "pcode": "CONT" if idx < len(inferred_years) else "",
                "Cum": float(spec.get("gpa", 60.0)),
                "Wghtd": float(spec.get("gpa", 60.0)),
                "Term": float(spec.get("term_gpa", spec.get("gpa", 60.0))),
            })

    srec_rows = []
    for c in courses_in:
        code = str(c["course"]).strip().upper()
        yt = int(c.get("yt", years_in[-1]["yr"]))
        perc = str(c.get("perc", "")).strip()
        symbol = str(c.get("symbol", "")).strip()
        default_cr = float(COURSE_CREDITS.get(code, COURSE_CREDITS.get(code[:7], 16)))
        crt = float(c.get("crt", default_cr))

        num_perc = pd.to_numeric(perc, errors="coerce")
        is_pass = (
            (pd.notna(num_perc) and float(num_perc) >= 50.0)
            or perc in {"PA", "UP", "50C", "CX", "EX", "CR"}
        )
        if not symbol:
            if is_pass:
                symbol = "PA"
            elif perc.endswith("S") and len(perc) > 1:
                symbol = "FS"
            elif perc in {"UF", "F"} or (pd.notna(num_perc) and float(num_perc) < 50.0):
                symbol = "F"
        cre = float(c["cre"]) if "cre" in c else (crt if is_pass else 0.0)
        title = str(c.get("coursen", c.get("title", code)))
        srec_rows.append([code, yt, perc, symbol, cre, crt, title])

    srec_df = pd.DataFrame(srec_rows, columns=SREC_HEADERS)
    if not srec_df.empty:
        srec_df = srec_df.drop_duplicates(subset=["course", "yt"], keep="first")

    ystats_rows = []
    cum_credits = 0.0
    for y in years_in:
        yr = int(y["yr"])
        yr_cre = float(srec_df[srec_df["yt"] == yr]["cre"].sum()) if not srec_df.empty else 0.0
        yr_crt = float(srec_df[srec_df["yt"] == yr]["crt"].sum()) if not srec_df.empty else 0.0
        cum_credits += yr_cre
        te = float(y.get("TE", yr_crt))
        ce = float(y.get("CE", cum_credits))
        wghtd = float(y.get("Wghtd", spec.get("gpa", 60.0)))
        term = float(y.get("Term", spec.get("term_gpa", wghtd)))
        cum = float(y.get("Cum", spec.get("gpa", wghtd)))
        ystats_rows.append([
            yr,
            str(y.get("tt", "R")),
            str(y.get("preg", prog)).upper(),
            str(y.get("pnam", PROG_DESCRIPTIONS.get(prog, prog))),
            str(y.get("ayosn", "First Year")),
            str(y.get("pcode", "")).upper(),
            str(y.get("progc", "")),
            0.0, 0.0, 0.0, 0.0, yr_crt, te, ce, wghtd, term, cum,
        ])

    ystats_df = pd.DataFrame(ystats_rows, columns=YSTATS_HEADERS)
    sinfo = [name, cid, emplid, prog, "", prog, "", "", "", ""]
    return {"sinfo": sinfo, "ystats": ystats_df, "srec": srec_df}


def apply_custom_overrides(
    strec: Dict[str, Any],
    as_program: Optional[str] = None,
    pass_courses: Optional[List[str]] = None,
    fail_courses: Optional[List[str]] = None,
    add_courses: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Clone `strec` and apply optional program override or custom course simulations."""
    out = {
        "sinfo": list(strec["sinfo"]),
        "ystats": strec["ystats"].copy(deep=True),
        "srec": strec["srec"].copy(deep=True),
    }
    if strec.get("leavmess"):
        out["leavmess"] = strec["leavmess"]

    cyear = int(out["ystats"]["yr"].max()) if not out["ystats"].empty else 2026

    if as_program:
        prog = as_program.strip().upper()
        out["sinfo"][3] = prog
        if not out["ystats"].empty:
            # Set latest year program to simulated EEE program if not already in EEE
            last_idx = out["ystats"].index[-1]
            if out["ystats"].loc[last_idx, "preg"] not in EEE_PROGS or prog in EEE_PROGS:
                out["ystats"].loc[last_idx, "preg"] = prog

    srec_df = out["srec"]

    if add_courses:
        for raw in add_courses:
            code = raw.strip().upper()
            if not code:
                continue
            exists = ((srec_df["course"] == code) & (srec_df["yt"] == cyear)).any()
            if not exists:
                cr = float(COURSE_CREDITS.get(code, COURSE_CREDITS.get(code[:7], 16)))
                new_row = pd.DataFrame(
                    [[code, cyear, "", "", 0.0, cr, "Simulated Registration"]],
                    columns=SREC_HEADERS,
                )
                srec_df = pd.concat([srec_df, new_row], ignore_index=True)

    if pass_courses:
        for item in pass_courses:
            if ":" in item:
                code, mark = item.split(":", 1)
                code, mark = code.strip().upper(), mark.strip()
            else:
                code, mark = item.strip().upper(), "PA"
            if not code:
                continue
            mask = (srec_df["course"] == code) & (srec_df["yt"] == cyear)
            if not mask.any():
                cr = float(COURSE_CREDITS.get(code, COURSE_CREDITS.get(code[:7], 16)))
                new_row = pd.DataFrame(
                    [[code, cyear, mark, "PA", cr, cr, "Simulated Pass"]],
                    columns=SREC_HEADERS,
                )
                srec_df = pd.concat([srec_df, new_row], ignore_index=True)
            else:
                srec_df.loc[mask, "perc"] = mark
                srec_df.loc[mask, "symbol"] = "PA"
                srec_df.loc[mask, "cre"] = srec_df.loc[mask, "crt"]

    if fail_courses:
        for raw in fail_courses:
            code = raw.strip().upper()
            if not code:
                continue
            mask = (srec_df["course"] == code) & (srec_df["yt"] == cyear)
            if mask.any():
                srec_df.loc[mask, "perc"] = "UF"
                srec_df.loc[mask, "symbol"] = "F"
                srec_df.loc[mask, "cre"] = 0.0

    out["srec"] = srec_df
    return out


# ---------------------------------------------------------------------------
# Prerequisite, Corequisite, Equivalence & Timetable Clash Checking
# ---------------------------------------------------------------------------

def is_req_token_satisfied(req_token: str, passed_set: Set[str]) -> Tuple[bool, str]:
    """
    Check if a prerequisite/corequisite token (which may be 7-char prefix like 'MAM1020'
    or full 8-char code like 'EEE2045F') is satisfied by `passed_set` directly or via
    `COURSE_EQUIVALENCIES`.
    """
    req_token = req_token.strip().upper()
    # 1. Exact match
    if req_token in passed_set:
        return True, req_token

    # 2. Prefix match if token has 7 chars (no term suffix, e.g., 'MAM1020' matches 'MAM1020F'/'MAM1020S')
    if len(req_token) == 7:
        for p in sorted(passed_set):
            if p[:7] == req_token:
                return True, p

    # 3. Equivalencies check (for exact token or any 8-char variant matching a 7-char prefix)
    for eq_entry in COURSE_EQUIVALENCIES:
        lhs = str(eq_entry[0]).upper()
        lhs_matches = (lhs == req_token) or (len(req_token) == 7 and lhs[:7] == req_token)
        if not lhs_matches:
            continue
        for alt in eq_entry[1:]:
            if isinstance(alt, (list, tuple)):
                sub_ev = []
                ok = True
                for sub in alt:
                    sub_u = str(sub).upper()
                    if sub_u in passed_set:
                        sub_ev.append(sub_u)
                    else:
                        ok = False
                        break
                if ok:
                    return True, "+".join(sub_ev)
            else:
                alt_u = str(alt).upper()
                if alt_u in passed_set:
                    return True, alt_u
                if len(alt_u) == 7:
                    for p in sorted(passed_set):
                        if p[:7] == alt_u:
                            return True, p

    return False, ""


def find_prereq_rule(course_code: str) -> Optional[List[Any]]:
    """Find matching prerequisite rule in COURSE_PREREQUISITES (exact 8-char or 7-char prefix)."""
    code = course_code.strip().upper()
    for rule in COURSE_PREREQUISITES:
        lhs = str(rule[0]).upper()
        if lhs == code or (len(lhs) == 7 and code[:7] == lhs):
            return rule[1:]
    return None


def find_coreq_rules(course_code: str) -> List[List[Any]]:
    code = course_code.strip().upper()
    matches = []
    for rule in COURSE_COREQUISITES:
        lhs = str(rule[0]).upper()
        if lhs == code or (len(lhs) == 7 and code[:7] == lhs):
            matches.append(rule[1:])
    return matches


def check_timetable_clashes(proposed_courses: Sequence[str]) -> Dict[str, Any]:
    """
    Evaluate Semester 1 and Semester 2 timetable slots and detect:
      - Hard Clashes: Lecture vs Lecture in same [Semester, Period, Day]
      - Soft Clashes: Practical/Tutorial (`_P`) overlap in same [Semester, Period, Day]
      - Unlisted courses: Not in TIMETABLE_SEMESTER_1 / TIMETABLE_SEMESTER_2
    """
    prop_clean = [c.strip().upper() for c in proposed_courses if c.strip()]
    prop_set = set(prop_clean)

    all_grid_courses: Set[str] = set()
    for grid in (TIMETABLE_SEMESTER_1, TIMETABLE_SEMESTER_2):
        for period_row in grid:
            for day_cell in period_row:
                for token in day_cell:
                    all_grid_courses.add(token.replace("_P", "").upper())

    hard_clashes: List[Dict[str, Any]] = []
    soft_clashes: List[Dict[str, Any]] = []
    schedule_slots: List[Dict[str, Any]] = []

    for sem_num, grid in ((1, TIMETABLE_SEMESTER_1), (2, TIMETABLE_SEMESTER_2)):
        for p_idx, period_row in enumerate(grid):
            p_label, p_time = PERIOD_LABELS[p_idx]
            for d_idx, day_cell in enumerate(period_row):
                day_name = DAY_LABELS[d_idx]
                present_tokens = [
                    tok for tok in day_cell if tok.replace("_P", "").upper() in prop_set
                ]
                for tok in present_tokens:
                    schedule_slots.append({
                        "semester": sem_num,
                        "period": p_label,
                        "time": p_time,
                        "day": day_name,
                        "entry": tok,
                        "is_practical": tok.endswith("_P"),
                    })
                # Distinct base courses occupying this exact slot
                base_courses = {tok.replace("_P", "").upper() for tok in present_tokens}
                if len(base_courses) > 1:
                    lecture_tokens = [tok for tok in present_tokens if not tok.endswith("_P")]
                    lecture_bases = {tok.upper() for tok in lecture_tokens}
                    clash_item = {
                        "semester": sem_num,
                        "period": p_label,
                        "time": p_time,
                        "day": day_name,
                        "entries": present_tokens,
                    }
                    if len(lecture_bases) >= 2:
                        hard_clashes.append(clash_item)
                    else:
                        soft_clashes.append(clash_item)

    unlisted = []
    for c in prop_clean:
        if c in {"EEE1000X", "EEE3000X", "EEE4022S", "EEE4022F", "EEE4124C"}:
            continue
        if c not in all_grid_courses:
            unlisted.append(c)

    return {
        "proposed_courses": prop_clean,
        "hard_clashes": hard_clashes,
        "soft_clashes": soft_clashes,
        "unlisted_in_eee_grid": unlisted,
        "schedule_slots": schedule_slots,
    }


def evaluate_registration_proposal(
    proposed_courses: Sequence[str],
    passed_courses: Set[str],
    program_code: Optional[str] = None,
    yfdreg: int = 2026,
    assume_s1_passed_for_s2: bool = True,
) -> Dict[str, Any]:
    """Validate prerequisites, corequisites, capstone constraints, credits, and clashes."""
    prop_list = [c.strip().upper() for c in proposed_courses if c.strip()]
    prop_set = set(prop_list)

    s1_proposed = {c for c in prop_list if len(c) >= 8 and c[7] in {"F", "A"}}

    course_checks: List[Dict[str, Any]] = []
    total_credits = 0
    s1_credits = 0
    s2_credits = 0

    for code in prop_list:
        cr = COURSE_CREDITS.get(code, COURSE_CREDITS.get(code[:7], 16))
        total_credits += cr
        term_char = code[7] if len(code) >= 8 else ""
        if term_char in {"F", "A"}:
            s1_credits += cr
        elif term_char in {"S", "C"}:
            s2_credits += cr

        already_sat, already_ev = is_req_token_satisfied(code, passed_courses)

        # Effective passed set for S2 courses can optionally assume proposed S1 courses pass
        effective_passed = set(passed_courses)
        assumed_s1_used: List[str] = []
        if assume_s1_passed_for_s2 and term_char in {"S", "C"}:
            effective_passed |= s1_proposed

        prereq_rule = find_prereq_rule(code)
        missing_prereqs: List[str] = []
        satisfied_prereqs: List[str] = []
        if prereq_rule:
            for item in prereq_rule:
                if isinstance(item, (list, tuple)):
                    group_sat = False
                    for opt in item:
                        ok, ev = is_req_token_satisfied(str(opt), passed_courses)
                        if ok:
                            satisfied_prereqs.append(f"[{' OR '.join(item)}] via {ev}")
                            group_sat = True
                            break
                        if assume_s1_passed_for_s2 and term_char in {"S", "C"}:
                            ok_s1, ev_s1 = is_req_token_satisfied(str(opt), effective_passed)
                            if ok_s1:
                                satisfied_prereqs.append(f"[{' OR '.join(item)}] via {ev_s1} (requires S1 pass)")
                                assumed_s1_used.append(ev_s1)
                                group_sat = True
                                break
                    if not group_sat:
                        missing_prereqs.append(f"One of ({' OR '.join(str(x) for x in item)})")
                else:
                    ok, ev = is_req_token_satisfied(str(item), passed_courses)
                    if ok:
                        satisfied_prereqs.append(f"{item} via {ev}")
                    elif assume_s1_passed_for_s2 and term_char in {"S", "C"}:
                        ok_s1, ev_s1 = is_req_token_satisfied(str(item), effective_passed)
                        if ok_s1:
                            satisfied_prereqs.append(f"{item} via {ev_s1} (requires S1 pass)")
                            assumed_s1_used.append(ev_s1)
                        else:
                            missing_prereqs.append(str(item))
                    else:
                        missing_prereqs.append(str(item))

        coreq_rules = find_coreq_rules(code)
        missing_coreqs: List[str] = []
        pool_with_coreg = effective_passed | prop_set
        for crule in coreq_rules:
            for item in crule:
                if isinstance(item, (list, tuple)):
                    if not any(is_req_token_satisfied(str(opt), pool_with_coreg)[0] for opt in item):
                        missing_coreqs.append(f"Coreq: one of ({' OR '.join(str(x) for x in item)})")
                else:
                    if not is_req_token_satisfied(str(item), pool_with_coreg)[0]:
                        missing_coreqs.append(f"Coreq: {item}")

        warnings: List[str] = []
        if already_sat:
            warnings.append(f"Already satisfied via {already_ev}")
        if assumed_s1_used:
            warnings.append(f"Conditional on passing S1 course(s): {', '.join(sorted(set(assumed_s1_used)))}")

        # Special EEE4022S / EEE4022F capstone checks (Handbook rules)
        if code in {"EEE4022S", "EEE4022F"}:
            same_sem_other_cr = (s2_credits - cr) if code == "EEE4022S" else (s1_credits - cr)
            if same_sem_other_cr > 32:
                warnings.append(
                    f"Handbook EEE4022 co-registration limit: {same_sem_other_cr} other credits in same semester (> 32 cr max without HoD concession)"
                )
            if program_code:
                std_prog = program_code[:2] + "0" + program_code[3:]
                specs = [
                    p for p in PROGRAM_SPECS
                    if p["code"] == std_prog and p["start_year"] <= yfdreg <= p["end_year"]
                ]
                if specs:
                    yr123_cores = [
                        c for c in specs[0]["core"]
                        if c not in {"EEE4113F", "CML4607F", "EEE4125C", "EEE4124C", "EEE4022S", "EEE1000X", "EEE3000X", "COMPSTUD"}
                    ]
                    unmet_123 = [
                        c for c in yr123_cores if not is_req_token_satisfied(c, effective_passed)[0]
                    ]
                    if unmet_123:
                        warnings.append(
                            f"Handbook EEE4022 rule requires all 1st–3rd year cores passed; unmet: {', '.join(unmet_123)}"
                        )

        course_checks.append({
            "course": code,
            "credits": cr,
            "already_satisfied": already_sat,
            "prereqs_ok": len(missing_prereqs) == 0,
            "missing_prereqs": missing_prereqs,
            "satisfied_prereqs": satisfied_prereqs,
            "coreqs_ok": len(missing_coreqs) == 0,
            "missing_coreqs": missing_coreqs,
            "warnings": warnings,
        })

    clash_report = check_timetable_clashes(prop_list)
    return {
        "total_proposed_credits": total_credits,
        "s1_credits": s1_credits,
        "s2_credits": s2_credits,
        "course_checks": course_checks,
        "timetable": clash_report,
    }


# ---------------------------------------------------------------------------
# Full Student Audit Assembly & Formatting
# ---------------------------------------------------------------------------

def build_audit_dict(
    feco: FECCheck,
    strec: Dict[str, Any],
    course_titles: Dict[str, str],
    propose_courses: Optional[List[str]] = None,
    include_full_history: bool = False,
) -> Dict[str, Any]:
    cpcs = feco.gencondprogs(strec)
    pcres = feco.genfecdecision(strec)
    pcs = cpcs["pcs_curr"]
    pcsp = pcres["pcsp"]

    sinfo = strec["sinfo"]
    ystats: pd.DataFrame = strec["ystats"]
    srec: pd.DataFrame = strec["srec"]

    prog_code = str(sinfo[3]).strip()
    std_prog = prog_code[:2] + "0" + prog_code[3:]
    yfdreg = int(pcs["yfdreg"])
    cyear = int(ystats["yr"].max())
    ubdrdur = int(feco.unbrokendeptregdur(strec))

    # Locate matched program spec for necore / cecore descriptions
    spec_matches = [
        p for p in PROGRAM_SPECS
        if p["code"] == std_prog and p["start_year"] <= yfdreg <= p["end_year"]
    ] or [p for p in PROGRAM_SPECS if p["code"] == std_prog]
    prog_spec = spec_matches[0] if spec_matches else {}

    tcert: pd.DataFrame = pcs["tcert"]
    core_rows = tcert[~tcert["Req"].str.startswith(("ECnum", "ECcred"))] if not tcert.empty else pd.DataFrame()
    ecnum_rows = tcert[tcert["Req"].str.startswith("ECnum")] if not tcert.empty else pd.DataFrame()
    eccred_rows = tcert[tcert["Req"].str.startswith("ECcred")] if not tcert.empty else pd.DataFrame()

    # Current year registrations
    curr_reg_df = srec[srec["yt"] == cyear].copy()
    curr_reg_codes = set(curr_reg_df["course"].astype(str).tolist())

    srecp_df, _ = feco.getsrecp(srec)
    passed_codes = set(srecp_df["course"].astype(str).tolist())

    passed_cores = []
    active_cores = []
    outstanding_cores = []
    for _, row in core_rows.iterrows():
        req = str(row["Req"])
        if bool(row["Sat"]):
            ev = str(row["Satev"])
            passed_cores.append({"req": req, "evidence": ev})
        else:
            # Check if req or an equivalent is currently registered in cyear
            is_reg = req in curr_reg_codes
            reg_as = req if is_reg else ""
            if not is_reg:
                for eq in COURSE_EQUIVALENCIES:
                    if eq[0] == req:
                        for alt in eq[1:]:
                            if isinstance(alt, str) and alt in curr_reg_codes:
                                is_reg = True
                                reg_as = alt
                                break
            cr = COURSE_CREDITS.get(req, 16)
            prule = find_prereq_rule(req)
            prereq_str = (
                ", ".join(f"[{' OR '.join(x)}]" if isinstance(x, list) else str(x) for x in prule)
                if prule else "None"
            )
            entry = {
                "code": req,
                "title": course_titles.get(req, req),
                "credits": cr,
                "status": f"Registered in {cyear}" + (f" (as {reg_as})" if reg_as and reg_as != req else "") if is_reg else "Outstanding (Not Registered)",
                "prereqs": prereq_str,
            }
            if is_reg:
                active_cores.append(entry)
            else:
                outstanding_cores.append(entry)

    # Elective details
    necore_summary = []
    for idx, rule in enumerate(prog_spec.get("necore", [])):
        req_n = rule[0]
        opts = rule[1:]
        row_match = ecnum_rows[ecnum_rows["Req"] == f"ECnum{idx + 1}"]
        sat = bool(row_match.iloc[0]["Sat"]) if not row_match.empty else False
        ev = str(row_match.iloc[0]["Satev"]) if not row_match.empty else ""
        passed_n = len([x for x in ev.split(",") if x.strip()]) if ev else 0
        necore_summary.append({
            "id": f"ECnum{idx + 1}",
            "required_count": req_n,
            "passed_count": passed_n,
            "satisfied": sat,
            "evidence": ev,
            "options": opts,
        })

    cecore_summary = []
    for idx, rule in enumerate(prog_spec.get("cecore", [])):
        req_cr = rule[0]
        opts = rule[1:]
        row_match = eccred_rows[eccred_rows["Req"] == f"ECcred{idx + 1}"]
        sat = bool(row_match.iloc[0]["Sat"]) if not row_match.empty else False
        ev = str(row_match.iloc[0]["Satev"]) if not row_match.empty else ""
        # Sum earned credits from evidence courses
        ev_codes = [x.split("(")[0].strip() for x in ev.split(",") if x.strip()]
        earned_cr = float(srecp_df[srecp_df["course"].isin(ev_codes)]["cre"].sum()) if ev_codes else 0.0
        cecore_summary.append({
            "id": f"ECcred{idx + 1}",
            "required_credits": req_cr,
            "earned_credits": earned_cr,
            "satisfied": sat,
            "evidence": ev,
            "options": opts,
        })

    # Honours diagnostics
    aspect = bool(pcs["aspect"])
    mtime = 5 if aspect else 4
    eedur = int(pcs["eedur"])
    gpa_val = float(pcs["gpa"])
    gpa_rounded = round(gpa_val)
    res4022 = float(pcs["res4022"])
    if pcs["qualf"]:
        hons_status = pcs["hons"] or "None (Pass without Honours)"
    else:
        reasons = []
        if eedur > mtime:
            reasons.append(f"eedur ({eedur}) > max Honours duration ({mtime})")
        elif eedur == mtime:
            reasons.append(f"currently in final Honours-eligible year ({eedur}/{mtime})")
        if gpa_rounded >= 75:
            reasons.append(f"rounded GPA {gpa_rounded} meets FCH (>=75), requires EEE4022 >=75 and qualification within {mtime} yrs")
        elif gpa_rounded >= 65:
            reasons.append(f"rounded GPA {gpa_rounded} meets HONS (>=65), requires EEE4022 >=60 and qualification within {mtime} yrs")
        else:
            reasons.append(f"rounded GPA {gpa_rounded} currently below HONS threshold (65)")
        hons_status = "Not yet qualified (" + "; ".join(reasons) + ")"

    # Current year registration rows
    curr_courses = []
    for _, r in curr_reg_df.iterrows():
        code = str(r["course"])
        perc = str(r["perc"]).strip()
        sym = str(r["symbol"]).strip()
        num_p = pd.to_numeric(perc, errors="coerce")
        if (pd.notna(num_p) and num_p >= 50) or perc in {"PA", "UP", "50C", "CX", "EX", "CR"}:
            st_label = "Passed"
        elif (perc.endswith("S") and len(perc) > 1) or sym == "FS" or perc in {"DE", "OS", "OSS"}:
            st_label = "Pending (Supp/DE/OS)"
        elif perc == "" and sym == "":
            st_label = "Registered (In Progress)"
        else:
            st_label = "Failed"
        curr_courses.append({
            "course": code,
            "title": str(r["coursen"]).strip() or course_titles.get(code, code),
            "cre": float(r["cre"]),
            "crt": float(r["crt"]),
            "perc": perc,
            "symbol": sym,
            "status": st_label,
        })

    # Scenarios summary
    def _scen(p_obj: Dict[str, Any], label: str, cond: str) -> Dict[str, Any]:
        return {
            "scenario": label,
            "conditions": cond,
            "pc": p_obj["pc"],
            "pmess": p_obj["pmess"],
            "totalcr": float(p_obj["totalcr"]),
            "ccrp": float(p_obj["ccrp"]),
            "gpa": round(float(p_obj["gpa"]), 2),
            "cmissing": list(p_obj["cmissing"]),
        }

    scenarios = [
        _scen(cpcs["pcs_curr"], "Current Actual (Curr)", "Worst-case: pending/blank/supps/DE treated as 0 cr"),
        _scen(cpcs["pcs_pY"], "Pass All Current (PA / PY)", f"All {cyear} registered courses passed (PA)"),
        _scen(cpcs["pcs_pS2"], "Pass Semester 2 (PS2)", f"All {cyear} S2 ('S'/'C') courses passed (PA)"),
        _scen(pcsp, "Awarded Supps/DE Passed (pcsp)", "Currently awarded S/OSS/DE/OS passed + vacwork passed"),
        _scen(cpcs["pcs_pspremb"], "Best Case Pass (PsPremB)", "Supps at 50% + remaining blank/OS/DE at 100% + vacwork"),
        _scen(cpcs["pcs_pspremw"], "Worst Case Pass (PsPremW)", "Supps at 50% + remaining blank/OS/DE at 50%"),
        _scen(cpcs["pcs_fspremb"], "Supps Failed, Rest Passed (FsPremB)", "Supps/OS/DE failed + blank in-progress passed at 100%"),
        _scen(cpcs["pcs_fsfrem"], "Worst Case Fail All Pending (FsFrem)", "All supps/OS/DE and blank in-progress failed (UF)"),
    ]

    N = 5 if aspect else 4
    audit = {
        "profile": {
            "name": str(sinfo[0]),
            "campus_id": str(sinfo[1]),
            "empl_id": str(sinfo[2]) if len(sinfo) > 2 else "",
            "program_code": prog_code,
            "program_name": PROG_DESCRIPTIONS.get(prog_code, prog_code),
            "aspect": aspect,
            "tfer": int(pcs["tfer"]),
            "tfer_description": TFER_DESCRIPTIONS.get(int(pcs["tfer"]), str(pcs["tfer"])),
            "first_uct_reg": int(pcs["yfreg"]),
            "first_eee_reg": yfdreg,
            "current_year": cyear,
            "eedur": eedur,
            "ubdrdur": ubdrdur,
            "ubdreg": bool(pcs["ubdreg"]),
            "single_sem_reg": bool(pcs["ssreg"]),
            "nstrikes": int(pcs["nstrikes"]),
            "crs_ayos": str(ystats.iloc[-1]["ayosn"]) if not ystats.empty else "",
            "est_ayos": int(pcs["est_ayos"]),
            "comments": pcs.get("comments", ""),
        },
        "standing": {
            "totalcr": float(pcs["totalcr"]),
            "rcurcr": int(pcs["rcurcr"]),
            "ccrp": float(pcs["ccrp"]),
            "lcrp": float(pcs["lcrp"]),
            "gpa": round(gpa_val, 2),
            "gpa_rounded": gpa_rounded,
            "res4022": res4022,
            "actual_pc": pcs["pc"],
            "actual_pmess": pcs["pmess"],
            "fec_decision_pc": pcres["pc"],
            "fec_decision_pmess": pcres["pmess"],
            "honours_eligibility": hons_status,
            "N": N,
            "rem_years_np1": (N + 1) - eedur,
            "np1crpy": float(pcs["np1crpy"]),
            "rem_years_np2": (N + 2) - eedur,
            "np2crpy": float(pcs["np2crpy"]),
            "aa_course": pcres["aa_course"] or "None",
            "outstanding_supps": list(pcs["suppdes"]),
            "failed_current_year": list(pcs["ccyfailed"]),
        },
        "stages": {
            "snapshot": {"code": pcres["cur_code"], "message": pcres["cur_message"]},
            "cleanup_fec_raw": {"code": pcres["cleanup_code"], "message": pcres["cleanup_message"]},
            "cleanup_py_check": {
                "code": "POTA/POTS" if cpcs["pcs_pY"]["pc"] == "QUAL" else cpcs["pcs_pY"]["pc"],
                "message": cpcs["pcs_pY"]["pmess"],
            },
            "midyear_exam": {"code": pcres["midyear_exam_code"], "message": pcres["midyear_exam_message"]},
            "midyear_supp": {"code": pcres["midyear_supp_code"], "message": pcres["midyear_supp_message"]},
            "eoy_exam": {"code": pcres["eoy_exam_code"], "message": pcres["eoy_exam_message"]},
            "eoy_final": {"code": pcres["eoy_final_code"], "message": pcres["eoy_final_message"]},
        },
        "certification": {
            "core_passed_count": len(passed_cores),
            "core_total_count": len(core_rows),
            "passed_cores": passed_cores,
            "active_cores": active_cores,
            "outstanding_cores": outstanding_cores,
            "necore": necore_summary,
            "cecore": cecore_summary,
            "cmissing_raw": list(pcs["cmissing"]),
        },
        "yearly_summary": ystats[["yr", "tt", "preg", "ayosn", "pcode", "TE", "CE", "Term", "Cum", "Wghtd"]].to_dict(orient="records"),
        "current_year_courses": curr_courses,
        "scenarios": scenarios,
    }

    if include_full_history:
        audit["full_srec"] = srec.to_dict(orient="records")

    if propose_courses:
        audit["proposal_validation"] = evaluate_registration_proposal(
            propose_courses,
            passed_courses=passed_codes,
            program_code=prog_code,
            yfdreg=yfdreg,
        )

    return audit


def render_audit_markdown(audit: Dict[str, Any], student_mode: bool = False) -> str:
    p = audit["profile"]
    s = audit["standing"]
    c = audit["certification"]
    lines: List[str] = []

    if student_mode:
        lines.append("> [!IMPORTANT]")
        lines.append("> **Non-Official Planning Aid**: Calculations below are generated from the `feccheck` advising engine. Official rules in the UCT EBE Faculty Handbook and FEC decisions take precedence.\n")

    lines.append(f"# FECCheck Deterministic Audit: {p['name']} ({p['campus_id']})")
    lines.append("")
    lines.append("## 1. Profile & Duration")
    lines.append(f"- **Program**: `{p['program_code']}` — {p['program_name']} | **ASPECT**: `{'Yes' if p['aspect'] else 'No'}`")
    lines.append(f"- **Transfer Status**: {p['tfer_description']}")
    lines.append(f"- **First UCT Reg**: `{p['first_uct_reg']}` | **First EEE Reg (`yfdreg`)**: `{p['first_eee_reg']}` | **Latest Year**: `{p['current_year']}`")
    lines.append(f"- **EEE Duration (`eedur`)**: `{p['eedur']}` yrs | **Unbroken EEE Duration (`ubdrdur`)**: `{p['ubdrdur']}` yrs | **CRS AYOS**: `{p['crs_ayos']}` (Est. AYOS: `{p['est_ayos']}`)")
    lines.append(f"- **Previous Strikes (`nstrikes`)**: `{p['nstrikes']}` | **Single-Semester Reg**: `{p['single_sem_reg']}`")
    lines.append(f"- **Spec & Equivalency Trace**: {p['comments']}")
    lines.append("")

    lines.append("## 2. Standing, Credits, Honours & Additional Assessment")
    lines.append(f"- **EEE Credits Earned (`totalcr` / `rcurcr`)**: `{s['totalcr']:.0f} / {s['rcurcr']}`")
    lines.append(f"- **Current Year Credits Passed (`ccrp`)**: `{s['ccrp']:.0f}` | **Prior Year (`lcrp`)**: `{s['lcrp']:.0f}`")
    lines.append(f"- **FEC GPA**: `{s['gpa']:.2f}` (rounded `{s['gpa_rounded']}`) | **EEE4022 Mark**: `{s['res4022'] if s['res4022'] >= 0 else 'N/A'}`")
    lines.append(f"- **Actual Worst-Case Standing (`Curr`)**: **`{s['actual_pc']}`** (`{s['actual_pmess']}`)")
    lines.append(f"- **Conditional FEC Decision (`pcres`)**: **`{s['fec_decision_pc']}`** (`{s['fec_decision_pmess']}`)")
    lines.append(f"- **Honours Check**: {s['honours_eligibility']}")
    lines.append(f"- **N+1 Pace** (`N={s['N']}`, `{s['rem_years_np1']}` yrs left after `{p['current_year']}`): `{s['np1crpy']}` cr/yr | **N+2 Pace** (`{s['rem_years_np2']}` yrs left): `{s['np2crpy']}` cr/yr")
    lines.append(f"- **Additional Assessment (`aa_course`)**: `{s['aa_course']}`")
    lines.append(f"- **Pending Supps/DE (`suppdes`)**: `{', '.join(s['outstanding_supps']) or 'None'}` | **Failed in {p['current_year']}**: `{', '.join(s['failed_current_year']) or 'None'}`")
    lines.append("")

    lines.append("## 3. Certification (`tcert`)")
    lines.append(f"- **Core Courses**: `{c['core_passed_count']} / {c['core_total_count']}` passed")
    for ne in c["necore"]:
        lines.append(
            f"- **`{ne['id']}` (Need >= {ne['required_count']} from {', '.join(ne['options'])})**: "
            f"`{'SATISFIED' if ne['satisfied'] else 'UNSATISFIED'}` ({ne['passed_count']} passed: {ne['evidence'] or 'none'})"
        )
    for ce in c["cecore"]:
        lines.append(
            f"- **`{ce['id']}` (Need >= {ce['required_credits']} cr from {', '.join(ce['options'])})**: "
            f"`{'SATISFIED' if ce['satisfied'] else 'UNSATISFIED'}` ({ce['earned_credits']:.0f}/{ce['required_credits']} cr: {ce['evidence'] or 'none'})"
        )

    passed_fmt = ", ".join(
        f"{x['req']}" + (f" [via {x['evidence']}]" if x["req"] not in x["evidence"] else f" ({x['evidence']})")
        for x in c["passed_cores"]
    )
    lines.append(f"- **Passed Cores**: {passed_fmt or 'None'}")
    if c["active_cores"]:
        lines.append("- **Active (Registered Current Year) Cores**: " + ", ".join(
            f"{x['code']} ({x['credits']} cr, Prereqs: {x['prereqs']})" for x in c["active_cores"]
        ))
    if c["outstanding_cores"]:
        lines.append("- **Outstanding (Unregistered/Failed) Cores**: " + ", ".join(
            f"{x['code']} ({x['credits']} cr, Prereqs: {x['prereqs']})" for x in c["outstanding_cores"]
        ))
    lines.append("")

    lines.append(f"## 4. Current Year ({p['current_year']}) Course Registrations")
    lines.append("| Course | Title | Earned / Total Cr | Mark | Symbol | Status |")
    lines.append("|---|---|---|---|---|---|")
    for r in audit["current_year_courses"]:
        lines.append(f"| `{r['course']}` | {r['title']} | {r['cre']:.0f} / {r['crt']:.0f} | `{r['perc'] or '-'}` | `{r['symbol'] or '-'}` | {r['status']} |")
    lines.append("")

    lines.append("## 5. Yearly Progression History (`ystats`)")
    lines.append("| Year | Term | Prog | AYOS | PCode | TE | CE | Term GPA | Cum GPA |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for y in audit["yearly_summary"]:
        lines.append(
            f"| {y['yr']} | {y['tt']} | `{y['preg']}` | {y['ayosn']} | `{y['pcode'] or '-'}` | "
            f"{y['TE']:.0f} | {y['CE']:.0f} | {y['Term']:.2f} | {y['Cum']:.2f} |"
        )
    lines.append("")

    lines.append("## 6. Simulation Scenarios (What-If Outcomes)")
    lines.append("| Scenario | Conditions | PCode | Message | Total Cr | Year Cr (`ccrp`) | Missing Reqs |")
    lines.append("|---|---|---|---|---|---|---|")
    for sc in audit["scenarios"]:
        miss_str = ", ".join(sc["cmissing"]) if len(sc["cmissing"]) <= 6 else f"{len(sc['cmissing'])} items ({', '.join(sc['cmissing'][:5])}, ...)"
        lines.append(
            f"| **{sc['scenario']}** | {sc['conditions']} | **`{sc['pc']}`** | {sc['pmess'] or '-'} | "
            f"{sc['totalcr']:.0f} | {sc['ccrp']:.0f} | {miss_str or 'None'} |"
        )
    lines.append("")

    if "proposal_validation" in audit:
        lines.append(render_proposal_markdown(audit["proposal_validation"]))

    return "\n".join(lines)


def render_proposal_markdown(pv: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("## Proposed Registration Validation")
    lines.append(
        f"- **Proposed Total Credits**: `{pv['total_proposed_credits']}` cr "
        f"(Semester 1: `{pv['s1_credits']}` cr | Semester 2: `{pv['s2_credits']}` cr)"
    )
    lines.append("")
    lines.append("### Prerequisite & Corequisite Check")
    lines.append("| Course | Credits | Prereqs OK? | Missing Prereqs / Coreqs | Satisfied Evidence & Warnings |")
    lines.append("|---|---|---|---|---|")
    for chk in pv["course_checks"]:
        ok_flag = "YES" if (chk["prereqs_ok"] and chk["coreqs_ok"]) else "NO"
        missing_all = chk["missing_prereqs"] + chk["missing_coreqs"]
        notes = chk["satisfied_prereqs"] + chk["warnings"]
        lines.append(
            f"| `{chk['course']}` | {chk['credits']} | **{ok_flag}** | "
            f"{'; '.join(missing_all) or 'None'} | {'; '.join(notes) or '-'} |"
        )
    lines.append("")

    tt = pv["timetable"]
    lines.append("### Timetable Clash Check (2026 Grid)")
    if tt["hard_clashes"]:
        lines.append("- **HARD CLASHES (PROHIBITED — Lecture vs Lecture)**:")
        for hc in tt["hard_clashes"]:
            lines.append(f"  - Semester {hc['semester']} | {hc['day']} Period {hc['period']} ({hc['time']}): `{', '.join(hc['entries'])}`")
    else:
        lines.append("- **Hard Clashes**: None")

    if tt["soft_clashes"]:
        lines.append("- **SOFT CLASHES (Practical/Tutorial `_P` overlap — check section flexibility)**:")
        for sc in tt["soft_clashes"]:
            lines.append(f"  - Semester {sc['semester']} | {sc['day']} Period {sc['period']} ({sc['time']}): `{', '.join(sc['entries'])}`")
    else:
        lines.append("- **Soft Clashes**: None")

    if tt["unlisted_in_eee_grid"]:
        lines.append(
            f"- **Not in EEE Timetable Grid (verify on central UCT timetable)**: `{', '.join(tt['unlisted_in_eee_grid'])}`"
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Deterministic UCT EEE Student Advising & Progression CLI Helper (powered by feccheck)."
    )
    parser.add_argument("--crs", help="Path to CRS CSV dump (auto-discovers newest workspace CRS CSV if omitted).")
    parser.add_argument("--updates", default="", help="Optional Excel updates file (for crs_parser.apply_update).")
    parser.add_argument("--id", dest="campus_id", help="Lookup student by Campus ID (e.g. ABCDEF001) or Empl ID.")
    parser.add_argument("--name", help="Lookup student by name substring (staff mode only).")
    parser.add_argument("--crs-text", help="Path to file (or '-' for stdin) containing a pasted CRS text excerpt.")
    parser.add_argument("--synthetic-json", help="JSON string or path to .json file defining a synthetic student record.")
    parser.add_argument("--as-program", help="Override/simulate student under an EEE program code (e.g. EB009, EB011, EB022, EB809).")
    parser.add_argument("--phase", default="eoy-exam", help="Academic cycle phase label (default: eoy-exam).")
    parser.add_argument("--pass-courses", help="Comma-separated courses to simulate as passed in current year (e.g. EEE3094S,EEE3096S:65).")
    parser.add_argument("--fail-courses", help="Comma-separated courses to simulate as failed (UF) in current year.")
    parser.add_argument("--add-courses", help="Comma-separated courses to append as in-progress registrations in current year.")
    parser.add_argument("--propose", help="Comma-separated candidate courses to check for prerequisites, corequisites, and timetable clashes.")
    parser.add_argument("--passed-list", help="Comma-separated already-passed courses when running --propose without a student record.")
    parser.add_argument("--cohort-summary", action="store_true", help="Run cohort-wide FEC summary/triage on --crs (staff mode only).")
    parser.add_argument("--filter-code", help="Comma-separated progression codes to filter in --cohort-summary (e.g. RENN,FECR,SUPP,FECP,QUAS).")
    parser.add_argument("--only-aa", action="store_true", help="In --cohort-summary, show only students eligible for Additional Assessment.")
    parser.add_argument("--full-history", action="store_true", help="Include full multi-year srec list in JSON output.")
    parser.add_argument("--student-mode", action="store_true", help="Enforce single-student privacy guardrails and student disclaimer.")
    parser.add_argument("--anonymize", action="store_true", help="Redact student name, Campus ID, and Empl ID from all outputs (POPIA-safe).")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown", help="Output format (default: markdown).")

    args = parser.parse_args()

    if args.student_mode and (args.cohort_summary or args.name):
        sys.exit("Error: --cohort-summary and --name substring searches are disabled in --student-mode for student privacy.")

    propose_list = [x.strip() for x in args.propose.split(",") if x.strip()] if args.propose else None
    pass_list = [x.strip() for x in args.pass_courses.split(",") if x.strip()] if args.pass_courses else None
    fail_list = [x.strip() for x in args.fail_courses.split(",") if x.strip()] if args.fail_courses else None
    add_list = [x.strip() for x in args.add_courses.split(",") if x.strip()] if args.add_courses else None

    # Standalone proposal check (no student record required)
    if propose_list and not any([args.campus_id, args.name, args.crs_text, args.synthetic_json, args.cohort_summary]):
        passed_set = {x.strip().upper() for x in (args.passed_list or "").split(",") if x.strip()}
        pv = evaluate_registration_proposal(
            propose_list,
            passed_courses=passed_set,
            program_code=args.as_program,
        )
        if args.format == "json":
            print(json.dumps(pv, indent=2))
        else:
            print(render_proposal_markdown(pv))
        return

    # Cohort summary mode (staff only)
    if args.cohort_summary:
        crs_files = [Path(args.crs)] if args.crs else discover_default_crs_files()
        if not crs_files or not crs_files[0].is_file():
            sys.exit("Error: No CRS CSV file found. Pass --crs <path>.")
        crs_target = crs_files[0]
        stinfo, _ = parsecrsinput(str(crs_target), ufname=args.updates or "")
        feco = FECCheck(stinfo, phase=args.phase)
        filter_codes = {c.strip().upper() for c in args.filter_code.split(",") if c.strip()} if args.filter_code else set()
        counts: Dict[str, int] = {}
        matched_rows = []
        for s in feco.stinfo:
            pcres = feco.genfecdecision(s)
            code = pcres["pc"]
            counts[code] = counts.get(code, 0) + 1
            if args.only_aa and not pcres["aa_course"]:
                continue
            if filter_codes and code not in filter_codes and pcres["eoy_exam_code"] not in filter_codes and pcres["cleanup_code"] not in filter_codes:
                continue
            if filter_codes or args.only_aa:
                idx = len(matched_rows) + 1
                matched_rows.append({
                    "campus_id": f"ANON_{idx:03d}" if args.anonymize else s["sinfo"][1],
                    "name": "[REDACTED]" if args.anonymize else s["sinfo"][0],
                    "program": s["sinfo"][3],
                    "pc": code,
                    "pmess": pcres["pmess"],
                    "cleanup": pcres["cleanup_code"],
                    "aa_course": pcres["aa_course"],
                    "suppdes": ",".join(pcres["suppdes"]),
                    "totalcr": float(pcres["pcs"]["totalcr"]),
                    "ccrp": float(pcres["pcs"]["ccrp"]),
                })
        summary_out = {
            "crs_file": str(crs_target),
            "total_eee_students": len(feco.stinfo),
            "counts_by_pc": counts,
            "matched_count": len(matched_rows),
            "students": matched_rows,
        }
        if args.format == "json":
            print(json.dumps(summary_out, indent=2))
        else:
            print(f"# Cohort FEC Summary (`{crs_target.name}` — {len(feco.stinfo)} EEE students)\n")
            print("## Progression Code Counts")
            for k, v in sorted(counts.items()):
                print(f"- **`{k}`**: {v}")
            if matched_rows:
                print(f"\n## Filtered Students ({len(matched_rows)})")
                print("| Campus ID | Name | Prog | PCode | Message | Cleanup | AA Course | Pending Supps | Total Cr | Year Cr |")
                print("|---|---|---|---|---|---|---|---|---|---|")
                for r in matched_rows:
                    print(
                        f"| `{r['campus_id']}` | {r['name']} | `{r['program']}` | **`{r['pc']}`** | {r['pmess'] or '-'} | "
                        f"`{r['cleanup']}` | `{r['aa_course'] or '-'}` | `{r['suppdes'] or '-'}` | {r['totalcr']:.0f} | {r['ccrp']:.0f} |"
                    )
        return

    # Single-student load
    matched_records: List[Dict[str, Any]] = []
    source_label = ""

    if args.synthetic_json:
        raw_json = args.synthetic_json
        if os.path.isfile(raw_json):
            with open(raw_json, "r", encoding="utf-8") as f:
                spec = json.load(f)
        else:
            spec = json.loads(raw_json)
        matched_records = [build_synthetic_record(spec)]
        source_label = "synthetic-json"

    elif args.crs_text:
        if args.crs_text == "-":
            raw_text = sys.stdin.read()
        else:
            with open(args.crs_text, "r", encoding="utf-8", errors="replace") as f:
                raw_text = f.read()
        fixed_text = ensure_crs_excerpt_parseable(raw_text)
        with tempfile.NamedTemporaryFile("w", suffix=".csv", encoding="latin-1", delete=False) as tf:
            tf.write(fixed_text)
            tmp_name = tf.name
        try:
            matched_records, _ = parsecrsinput(tmp_name, ufname=args.updates or "")
        finally:
            if os.path.exists(tmp_name):
                os.remove(tmp_name)
        source_label = "crs-text"

    elif args.campus_id or args.name:
        crs_files = [Path(args.crs)] if args.crs else discover_default_crs_files()
        if not crs_files:
            sys.exit("Error: No CRS CSV files found in workspace. Provide --crs <path>, --crs-text, or --synthetic-json.")
        for cf in crs_files:
            if not cf.is_file():
                continue
            recs = extract_student_slice_from_csv(cf, args.campus_id, args.name)
            if recs:
                if args.updates:
                    recs = apply_update(recs, args.updates)
                matched_records = recs
                source_label = str(cf)
                break
    else:
        parser.print_help()
        sys.exit(1)

    if not matched_records:
        sys.exit("No matching student record found.")

    if len(matched_records) > 1 and not args.campus_id:
        print(f"Multiple students matched ({len(matched_records)}). Re-run with --id <CAMPUS_ID>:")
        if not args.anonymize:
            for r in matched_records[:25]:
                print(f"  - {r['sinfo'][1]}: {r['sinfo'][0]} ({r['sinfo'][3]})")
        sys.exit(0)

    target = apply_custom_overrides(
        matched_records[0],
        as_program=args.as_program,
        pass_courses=pass_list,
        fail_courses=fail_list,
        add_courses=add_list,
    )

    if target["sinfo"][3] not in EEE_PROGS:
        label = "STUDENT_ANON" if args.anonymize else target["sinfo"][1]
        sys.exit(
            f"Student {label} is currently in non-EEE program '{target['sinfo'][3]}'. "
            "Pass --as-program EB009 (or EB011 / EB022 / EB809 / EB811 / EB822) to simulate transfer into EEE."
        )

    feco = FECCheck([target], phase=args.phase)
    if not feco.stinfo:
        sys.exit("Record has no valid EEE course entries after filtering.")

    course_titles = load_course_titles()
    audit = build_audit_dict(
        feco,
        feco.stinfo[0],
        course_titles=course_titles,
        propose_courses=propose_list,
        include_full_history=args.full_history,
    )
    audit["data_source"] = "[REDACTED]" if args.anonymize else source_label
    if args.anonymize:
        audit["profile"]["name"] = "[REDACTED]"
        audit["profile"]["campus_id"] = "STUDENT_ANON"
        audit["profile"]["empl_id"] = ""

    if args.format == "json":
        print(json.dumps(audit, indent=2))
    else:
        print(render_audit_markdown(audit, student_mode=args.student_mode))


if __name__ == "__main__":
    main()
