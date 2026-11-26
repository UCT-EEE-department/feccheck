# UCT EEE Progression Rules, Honours, Cycle Stages & CRS Parsing

Source of truth: [fec_check.py](../../../../fec_check.py) and [crs_parser.py](../../../../crs_parser.py).

## 1. Core Progression Variables
- **`aspect`**: `True` if any row in `ystats['preg']` has `'8'` as its 3rd character (`EB809`, `EB811`, `EB822`). Standard degree duration `N = 5` if `aspect` else `N = 4`.
- **`eedur`**: Count of unique years registered in `EEE_PROGS` (`EB009`, `EB809`, `EB011`, `EB811`, `EB022`, `EB822`).
- **`ubdrdur`**: Consecutive years of EEE registration leading up to the latest year.
- **`tfer` (Transfer Status)**:
  - `0`: Direct-entry into EEE at UCT (`yfreg == yfdreg`, no transfer credits).
  - `1`: Internal UCT transfer (`yfdreg > yfreg`).
  - `2`: External transfer (`CR`, `CX`, or `EX` credits in `yfdreg`).
  - `3`: Interrupted EEE registration (left EEE for another programme and returned).
- **`nstrikes`**: Count of historical EEE `ystats` rows where `pcode` is in `{'FECR', 'RACC', 'RENN'}`. Note: UCT EEE has **no rule** limiting how many times an individual course can be failed; progression depends on annual credit thresholds and `N+1`/`N+2` duration pace.

---

## 2. Annual Credit Thresholds (`ccrp` = Credits Passed in Current Year)

### A. Standard (Non-ASPECT) Students (`N = 4`)
- **First-Year Entering at UCT (`yfreg == cyear`)**:
  - `ccrp < 66` -> `RENN`
  - `66 <= ccrp < 96` -> `FECR`
  - `ccrp >= 96` -> `CONT`
- **First-Year Transferee (`tfer in {1, 2}` and `ubdrdur == 1`)**:
  - `ccrp < 96` and `nstrikes == 0` -> `FECR`
  - `ccrp < 96` and `nstrikes > 0` -> `RENN`
  - `ccrp >= 96` -> `CONT`
- **Returning Student**:
  - Threshold `RET_FECR` = **112 credits** (`rcurcr == 560`) or **116 credits** (`rcurcr >= 576`).
  - `ccrp < RET_FECR` and `nstrikes == 0` -> `FECR` (first default)
  - `ccrp < RET_FECR` and `nstrikes > 0` -> `RENN` (previous defaults)
  - `ccrp >= RET_FECR` -> `CONT`

### B. ASPECT Students (`N = 5`)
- **First-Year Entering at UCT (`yfreg == cyear`)**:
  - `ccrp < 48` -> `RENN`
  - `48 <= ccrp < 60` -> `FECR`
  - `ccrp >= 60` -> `CONT`
- **First-Year Transferee (`tfer in {1, 2}` and `ubdrdur == 1`)**:
  - `ccrp < 60` and `nstrikes == 0` -> `FECR`
  - `ccrp < 60` and `nstrikes > 0` -> `RENN`
  - `ccrp >= 60` -> `CONT`
- **Returning ASPECT Student**:
  - Threshold `RET_FECR` = **92 credits** (`rcurcr == 560`) or **96 credits** (`rcurcr >= 576`).
  - `ccrp < RET_FECR` and `nstrikes == 0` -> `FECR`
  - `ccrp < RET_FECR` and `nstrikes > 0` -> `RENN`
  - `ccrp >= RET_FECR` -> `CONT`

### C. N+1 and N+2 Duration Pace Indicators
- `creds_needed = max(0, rcurcr - totalcr)`
- `rem_years_np1 = (N + 1) - eedur` -> `np1crpy = creds_needed / rem_years_np1` (or `9999.0` if `rem_years_np1 <= 0` and `creds_needed > 0`).
- `rem_years_np2 = (N + 2) - eedur` -> `np2crpy = creds_needed / rem_years_np2` (or `9999.0` if `rem_years_np2 <= 0` and `creds_needed > 0`).

### D. Practical Training Special Rule (`QUAS`)
If `totalcr >= rcurcr` and the **only** unsatisfied `tcert` requirements are `EEE1000X` and/or `EEE3000X`, the student is assigned **`QUAS`** with message `"Outstanding Practical Training"` (plus `; FCH` or `; HONS` if Honours-eligible), overriding credit-based exclusion rules.

---

## 3. Conditional Progression Codes & Honours
- **`QUAL`**: All `tcert` rows satisfied AND `totalcr >= rcurcr`.
- **`QUAS`**: Qualify Assumed (either Practical Training only outstanding, OR passing pending `S`/`OSS`/`DE`/`OS` exams yields `QUAL`).
- **`SUPP`**: Worst-case `Curr` is `RENN`, best-case `pcsp` (supps/DE passed) is `CONT`. High priority: advise preparing a Readmission Appeal Committee (RAC) submission as backup.
- **`FECP`**: Worst-case `FECR` -> best-case `CONT`, OR worst-case `RENN` -> best-case `FECR` (or unresolved grades at `eoy-final`).
- **Honours Classification (`isqual`)**:
  - Maximum EEE duration `mtime = 5` if `aspect` else `4`.
  - **First Class Honours (`FCH`)**: `round(gpa) >= 75` AND `EEE4022 >= 75` AND `eedur <= mtime`.
  - **Honours (`HONS`)**: `round(gpa) >= 65` AND `EEE4022 >= 60` AND `eedur <= mtime`.
  - GPA basis: `Cum` if `yfreg >= 2016`, `Wghtd` if `yfreg < 2016`.

---

## 4. Academic Cycle Stages & Additional Assessment (`aa_course`)
1. **`snapshot`**: Pre-registration baseline (`Curr`).
2. **`cleanup`**: Post-registration audit. Checks if passing registered courses yields April graduation (`POTA`, has `S`/`W` courses), September graduation (`POTS`, S1 only), or still excludes (`RENN`/`FECR`).
3. **`midyear-exam`**: Post-S1 exams (`QUAL`, `QUAS` on S1 supps/DE, and mid-year S1 Additional Assessment check).
4. **`midyear-supp`**: Post-S1 supplementary/deferred exams.
5. **`eoy-exam`**: Main November/December FEC (`QUAL`, `QUAS`, `SUPP`, `FECP`, `CONT`, `FECR`, `RENN`, plus EOY Additional Assessment check).
6. **`eoy-final`**: Final FEC after January supps/deferreds.

**Additional Assessment (`check_additional_assessment`)**:
- Student does not yet qualify (even treating `EEE1000X`/`EEE3000X` as passed), and simulating a `50 / PA` pass in **exactly one** failed course makes them `QUAL`.
- **Exclusions**: Never granted for `EEE4022F`/`EEE4022S`, courses ending in `C`, `X`, `L`, `Z`, courses with an already-awarded supp/DE in `cyear` (`[0-9]*S`, `OSS`, `DE`, `OS`), courses with `DPR` in `cyear`, or courses already satisfied via an equivalent.

---

## 5. CRS Excerpt & Symbol Rules (`crs_parser.py`)
- **Duplicate Cleaning**: Drop duplicate `(course, yt)` rows within the same year (`keep='first'`) caused by dual-registration printouts.
- **Passed (`getsrecp`)**: Numeric `perc >= 50`, or `perc` in `{'PA', 'UP', '50C', 'CX', 'EX', 'CR'}`. (Note: `credpassed(cyear)` counts `>=50`, `PA`, `UP`, `50C` — transfer credits `CX/EX/CR` do not inflate annual `ccrp`.)
- **Pending / Supp / Deferred**: `perc` matching `[0-9].*S` (or symbol `FS`), `OSS`, `DE`, `OS`. Symbol `SF` means supplementary exam already written and failed.
- **In Progress**: Blank `perc` and blank `symbol` (`""`).
