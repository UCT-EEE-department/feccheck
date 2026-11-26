#!/usr/bin/env python3
"""
generate_student_gpas.py
Extracts student GPAs and academic statistics from a Course Record System (CRS) CSV dump
and exports them to marked Excel (.xlsx) and CSV (.csv) spreadsheets.

Usage:
    python generate_student_gpas.py [path_to_crs_csv] [output_directory]
"""

import sys
import os
import re
from pathlib import Path
from typing import List, Dict, Any, Optional
import pandas as pd
import numpy as np

# Ensure feccheck modules are importable
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from crs_parser import parsecrsinput

EEE_PROGS = {'EB009', 'EB011', 'EB022', 'EB809', 'EB811', 'EB822'}


def extract_crs_run_date(crs_path: str) -> str:
    """Extract the Run Date from the CRS CSV file header."""
    try:
        with open(crs_path, 'r', encoding='latin-1') as f:
            for _ in range(20):
                line = f.readline()
                match = re.search(r'Run Date[,\s]+([0-9]{4}-[0-9]{2}-[0-9]{2})', line)
                if match:
                    return match.group(1)
    except Exception as e:
        print(f"Warning: could not extract run date from header: {e}")

    # Fallback to date in filename (e.g., '29 June 2026' or '20260629')
    stem = Path(crs_path).stem
    date_match = re.search(r'(\d{1,2}\s+[A-Za-z]+\s+\d{4})', stem)
    if date_match:
        return date_match.group(1)
    return 'unknown_date'


def generate_gpa_dataframe(crs_path: str, crs_date: str) -> pd.DataFrame:
    """Parse the CRS CSV file and extract student GPA and credit statistics."""
    print(f"Parsing CRS file: {crs_path}")
    stinfo, _ = parsecrsinput(crs_path)
    print(f"Loaded {len(stinfo)} student records.")

    rows = []
    # Determine the range of years across all students
    all_years = set()
    for s in stinfo:
        ys = s.get('ystats')
        if ys is not None and not ys.empty:
            all_years.update(ys['yr'].dropna().astype(int).tolist())
    
    sorted_years = sorted(list(all_years))
    # Focus on the most recent 7 years for yearly columns
    recent_years = sorted_years[-7:] if len(sorted_years) >= 7 else sorted_years

    for s in stinfo:
        sinfo = s.get('sinfo', [])
        ys = s.get('ystats')

        cid = sinfo[1] if len(sinfo) > 1 else ''
        name = sinfo[0] if len(sinfo) > 0 else ''
        emplid = sinfo[2] if len(sinfo) > 2 else ''
        prog = sinfo[3] if len(sinfo) > 3 else ''
        plan = sinfo[5] if len(sinfo) > 5 else ''
        lvl_start = sinfo[7] if len(sinfo) > 7 else ''
        lvl_end = sinfo[8] if len(sinfo) > 8 else ''
        finalist = sinfo[9] if len(sinfo) > 9 else ''

        if ys is not None and not ys.empty:
            fyreg = int(ys['yr'].min())
            cyear = int(ys['yr'].max())
            nyears = int(len(ys['yr'].unique()))

            last_row = ys.iloc[-1]
            cum_gpa = last_row.get('Cum', np.nan)
            wghtd_gpa = last_row.get('Wghtd', np.nan)
            term_gpa = last_row.get('Term', np.nan)

            # In some cases the final row is a 'W' (winter) or 'S' (supp) session with 0 GPA;
            # fall back to the regular 'R' term in that year if available.
            ys_curr_r = ys[(ys['yr'] == cyear) & (ys['tt'] == 'R')]
            if not ys_curr_r.empty and (term_gpa == 0.0 or pd.isna(term_gpa)):
                term_gpa = ys_curr_r.iloc[-1].get('Term', term_gpa)
                wghtd_gpa = ys_curr_r.iloc[-1].get('Wghtd', wghtd_gpa)

            # Latest progression code
            pcode = last_row.get('pcode', '')
            if not pcode or pd.isna(pcode):
                valid_pcodes = [str(c).strip() for c in ys['pcode'] if str(c).strip() and str(c).strip().lower() != 'nan']
                pcode = valid_pcodes[-1] if valid_pcodes else ''

            ce = last_row.get('CE', np.nan)
            te = last_row.get('TE', np.nan)

            # UCT FEC rule: pre-2016 use weighted GPA, 2016+ use cumulative GPA
            fec_gpa = wghtd_gpa if fyreg < 2016 else cum_gpa

            # Prior year (cyear - 1) cum GPA
            ys_prior = ys[ys['yr'] == (cyear - 1)]
            cum_gpa_prior = ys_prior.iloc[-1].get('Cum', np.nan) if not ys_prior.empty else np.nan
            gpa_change = round(cum_gpa - cum_gpa_prior, 2) if pd.notna(cum_gpa) and pd.notna(cum_gpa_prior) else np.nan

            # Yearly cumulative GPAs
            yearly_gpas = {}
            for yr in recent_years:
                ys_yr = ys[ys['yr'] == yr]
                yearly_gpas[f'Cum_GPA_{yr}'] = round(float(ys_yr.iloc[-1]['Cum']), 2) if not ys_yr.empty and pd.notna(ys_yr.iloc[-1]['Cum']) else np.nan
        else:
            fyreg, cyear, nyears = np.nan, np.nan, np.nan
            cum_gpa, wghtd_gpa, term_gpa, fec_gpa, cum_gpa_prior, gpa_change = np.nan, np.nan, np.nan, np.nan, np.nan, np.nan
            pcode, ce, te = '', np.nan, np.nan
            yearly_gpas = {f'Cum_GPA_{yr}': np.nan for yr in recent_years}

        row = {
            'CRS_Date': crs_date,
            'Campus_ID': cid,
            'Empl_ID': emplid,
            'Name': name,
            'Programme': prog,
            'Plan': plan,
            'Is_EEE': prog in EEE_PROGS,
            'Level_Start': lvl_start,
            'Level_End': lvl_end,
            'Finalist': finalist,
            'First_Year_Reg': fyreg,
            'Latest_Year_Reg': cyear,
            'Years_Reg': nyears,
            'Latest_PCode': pcode,
            'Cumulative_Credits': ce,
            'Latest_Term_Credits': te,
            'Cumulative_GPA': round(cum_gpa, 2) if pd.notna(cum_gpa) else np.nan,
            'Weighted_GPA': round(wghtd_gpa, 2) if pd.notna(wghtd_gpa) else np.nan,
            'Latest_Term_GPA': round(term_gpa, 2) if pd.notna(term_gpa) else np.nan,
            'FEC_GPA': round(fec_gpa, 2) if pd.notna(fec_gpa) else np.nan,
            f'Prior_Year_Cum_GPA_{cyear-1 if pd.notna(cyear) else "Prior"}': round(cum_gpa_prior, 2) if pd.notna(cum_gpa_prior) else np.nan,
            'GPA_Change_Prior_Year': gpa_change,
            **yearly_gpas
        }
        rows.append(row)

    df = pd.DataFrame(rows)
    return df


def generate_program_summary(df: pd.DataFrame) -> pd.DataFrame:
    """Generate aggregate GPA statistics by programme."""
    summary = df.groupby('Programme', as_index=False).agg(
        Total_Students=('Campus_ID', 'count'),
        Mean_Cum_GPA=('Cumulative_GPA', 'mean'),
        Median_Cum_GPA=('Cumulative_GPA', 'median'),
        Std_Cum_GPA=('Cumulative_GPA', 'std'),
        Min_Cum_GPA=('Cumulative_GPA', 'min'),
        Max_Cum_GPA=('Cumulative_GPA', 'max'),
        Mean_Term_GPA=('Latest_Term_GPA', 'mean'),
        Mean_Cumulative_Credits=('Cumulative_Credits', 'mean')
    )
    for col in ['Mean_Cum_GPA', 'Median_Cum_GPA', 'Std_Cum_GPA', 'Min_Cum_GPA', 'Max_Cum_GPA', 'Mean_Term_GPA', 'Mean_Cumulative_Credits']:
        summary[col] = summary[col].round(2)
    return summary


def export_spreadsheets(df: pd.DataFrame, crs_date: str, output_dirs: List[Path]):
    """Export the GPA data into Excel and CSV files in target directories."""
    df_eee = df[df['Is_EEE']].copy()
    summary_df = generate_program_summary(df)

    # Date strings for filenames
    date_tag_iso = crs_date.replace('-', '')
    date_tag_text = crs_date

    for out_dir in output_dirs:
        out_dir.mkdir(parents=True, exist_ok=True)

        # 1. Excel workbook with multiple tabs
        xlsx_name = f"Student_GPAs_{date_tag_iso}.xlsx"
        xlsx_path = out_dir / xlsx_name
        xlsx_pretty_name = f"Student GPAs {date_tag_text}.xlsx"
        xlsx_pretty_path = out_dir / xlsx_pretty_name

        print(f"Writing Excel workbook to: {xlsx_path}")
        with pd.ExcelWriter(xlsx_path, engine='openpyxl') as writer:
            df.to_excel(writer, sheet_name='All_Students_GPA', index=False)
            df_eee.to_excel(writer, sheet_name='EEE_Students_GPA', index=False)
            summary_df.to_excel(writer, sheet_name='Programme_Summary', index=False)

        # Also write the pretty name if different
        if xlsx_pretty_path != xlsx_path:
            import shutil
            shutil.copy2(xlsx_path, xlsx_pretty_path)

        # 2. Main CSV with all student GPAs
        csv_name = f"Student_GPAs_{date_tag_iso}.csv"
        csv_path = out_dir / csv_name
        csv_pretty_name = f"Student GPAs {date_tag_text}.csv"
        csv_pretty_path = out_dir / csv_pretty_name

        print(f"Writing CSV to: {csv_path}")
        df.to_csv(csv_path, index=False)
        if csv_pretty_path != csv_path:
            df.to_csv(csv_pretty_path, index=False)

        # 3. EEE CSV
        eee_csv_name = f"Student_GPAs_EEE_{date_tag_iso}.csv"
        eee_csv_path = out_dir / eee_csv_name
        df_eee.to_csv(eee_csv_path, index=False)


def main():
    default_input = '/Users/nicolls/proj/eleceng/UG FULL CSV _ 29 June 2026.csv'
    crs_path = sys.argv[1] if len(sys.argv) > 1 else default_input

    if not os.path.isfile(crs_path):
        fallback_input = '/Users/nicolls/OneDrive - University of Cape Town/EE Department/FEC/2026/UNDERGRADUATE/UG EBE FEC 6 July 2026/UG FULL CSV _ 29 June 2026.csv'
        if os.path.isfile(fallback_input):
            crs_path = fallback_input
        else:
            print(f"Error: input file not found: {crs_path}")
            sys.exit(1)

    crs_date = extract_crs_run_date(crs_path)
    print(f"Detected CRS Run Date: {crs_date}")

    df = generate_gpa_dataframe(crs_path, crs_date)

    output_dirs = [
        Path('/Users/nicolls/proj/eleceng'),
        Path('/Users/nicolls/OneDrive - University of Cape Town/EE Department/FEC/2026/UNDERGRADUATE/UG EBE FEC 6 July 2026')
    ]

    export_spreadsheets(df, crs_date, output_dirs)
    print("GPA spreadsheet generation complete.")


if __name__ == '__main__':
    main()
