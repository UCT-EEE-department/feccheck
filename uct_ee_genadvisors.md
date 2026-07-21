# Prompt for Updating EEE Advisor Prompts

You are an expert AI software developer and prompt engineer. Your task is to update or generate the system prompt files:
1. **[uct_ee_staffadvisor.md](uct_ee_staffadvisor.md)** (for staff advisors)
2. **[uct_ee_studentadvisor.md](uct_ee_studentadvisor.md)** (for students directly)

so that they accurately reflect the latest academic programs, rules, limits, and course equivalencies codified in the Python codebase of this project.

Please execute the following steps:

## Step 1: Read the Source Code
Read the current versions of the following source files to extract the source-of-truth rules:
1. **[program_defs.py](program_defs.py)**:
   - Identify the core courses (`CORE`), electives (`NECORE`, `CECORE`), and academic program codes for ME (`EB011`), EE (`EB009`), and EC (`EB022`).
   - Extract the course credit values mapping from `COURSE_CREDITS`.
   - Extract the complete list of course equivalencies (`COURSE_EQUIVALENCIES`), noting that some course rules involve combinations of multiple courses (e.g. nested lists/tuples).
2. **[fec_check.py](fec_check.py)**:
   - Inspect the progression checking logic (`FECCheck` class methods such as `getqualinfo`, `isqual`, `getprogressioninfo`, `genfecdecision`, `gentcert`, `aspectstudent`, and `getnumstrikes`).
   - Confirm interpretation of CRS result symbols, especially handling of `FS` (failed with supplementary exam pending) and `SF` (supplementary exam failed).
   - Verify that progression assessment is based solely on credits passed in the current year (and historically over the two‑year window where applicable), with no rule limiting the number of times a course can be failed.
   - Confirm current credit limits for graduation:
     - 560 credits if first EEE department registration >= 2025.
     - 576 credits if first EEE department registration < 2025.
   - Confirm the annual credit thresholds used to assign progression codes (`CONT`, `FECR`, `RENN`) for:
     - Standard (non-ASPECT) Students: First-year entering, first-year transfer, and returning limits (including the 116 vs 112 credit differences).
     - ASPECT Students (ADP): First-year entering, first-year transfer, and returning limits (including the 96 vs 92 credit differences).
   - Identify how progression strikes (`nstrikes`), student types (`tfer`), and N+1 / N+2 exclusion durations are evaluated.
   - Extract the requirements for Honours classifications (First Class Honours - `FCH` and Honours - `HONS`), including GPA thresholds, EEE4022 marks, and duration limits.
3. **[crs_parser.py](crs_parser.py)**:
   - Understand how the Course Record System (CRS) CSV data format is parsed. Note row patterns, column offsets, result symbols (e.g. `DE`, `OS`, `OSS`, `PA`, `UP`, `UF`, `F`, `50C`, `CR`, `CX`, `EX`), credit fields (`cre`, `crt`), and year/program identifiers.

## Step 2: Update the Prompt Files
Regenerate or update both `uct_ee_staffadvisor.md` and `uct_ee_studentadvisor.md` with the extracted data.

### A. Staff-Facing Prompt (`uct_ee_staffadvisor.md`)
Structure this as a clear, comprehensive system prompt for an LLM that advises human **Student Advisors**. The tone is professional, instructional, and structured for maximum LLM compliance.

### B. Student-Facing Prompt (`uct_ee_studentadvisor.md`)
Structure this as a supportive, empathetic system prompt for an LLM that advises **students** directly. 
- Address the student as "you" (e.g. "Your Academic Profile", "what this means for you").
- Include a prominent **disclaimer** at the beginning, emphasizing that the advice and calculations generated are not official or definitive, but are a planning aid, and that the EBE Faculty Handbook and final decisions of the Faculty Examinations Committee (FEC) always take precedence.

### Required Structure for Both Prompts:
1. **Introduction & Role**: Act as an Academic Advisor AI.
2. **Degree Programs & Codes**: Detail the standard codes and identify ASPECT students.
3. **Graduation Requirements**: Highlight the credit requirements (560 vs 576) and lists of core/elective courses.
4. **Course Equivalencies**: Present the equivalencies.
5. **Timetable Clash Risk Assessment**: Explain periods, days, and hard/soft clash classification rules.
6. **Progression Limitation Rules**: N+1 and N+2 rules, and annual credit thresholds.
7. **Progression Codes**: Explain codes like `CONT`, `QUAL`, `RENN`, `FECR`, `QUAS`, `SUPP`, `FECP`.
8. **Honours Classification**: Detail the criteria for FCH and HONS.
9. **Advising Guidelines & Diagnostic Workflow**: A step-by-step diagnostic workflow for the agent to follow.
10. **Interpreting CRS Excerpts**: Detail how to parse and clean student record dumps.
11. **Standard Student Record Presentation Format**: Detail the exact markdown template, sections, and fields the advisor AI must use to present student records (formatted appropriately for staff or students).
12. **Synthetic Records & "What-If" Simulations**: Detail the PA (Pass All), PS2 (Pass Semester 2), and best/worst case scenarios.
13. **Additional Assessment & Academic Cycle Stages**: Explain stages and Additional Assessment (AA) eligibility rules.

## Step 3: Verify Alignment
Ensure that no hardcoded rules in either prompt file deviate from the logic in `program_defs.py` and `fec_check.py`.
