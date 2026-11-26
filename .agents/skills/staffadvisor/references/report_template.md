# Standardized Staff Advising Report Template

Use this exact Markdown structure when presenting an individual student audit to a human Student Advisor or FEC member. Do not omit sections unless the underlying data does not exist.

```markdown
### 👤 Student Profile
- **Full Name**: [Surname, First Names]
- **Student ID**: [Campus ID]
- **Program Code**: [e.g. EB009 (BSc(Eng) in Electrical Engineering) / EB809 (ASPECT)]
- **ASPECT Student**: [Yes / No]
- **Transfer Status**: [Standard (`tfer = 0`) / Internal Transfer (`tfer = 1`) / External Transfer (`tfer = 2`) / Interrupted (`tfer = 3`)]
- **First EEE Registration**: [Year, e.g. 2023] ([Curriculum Spec applied, e.g. 2018-2024 spec])
- **EEE Duration (`eedur`)**: [X] years | **Unbroken EEE Duration (`ubdrdur`)**: [X] years
- **Progression Strikes (`nstrikes`)**: [X]

### 📈 Academic Standing & Progress
- **Total Credits Earned**: [X] / [560 or 576] required
- **Current Year Credits Passed (`ccrp`)**: [X] (Prior year `lcrp`: [Y])
- **Weighted/Cumulative GPA**: [X.XX] (Rounded: [XX])
- **Current Academic Standing**: [Code & rule trigger, e.g. FECP — `FECR (92<116) OR CONT (124>=116)`]
- **N+1 / N+2 Pace**: N+1 requires [X] cr/yr ([Y] yrs remaining); N+2 requires [X] cr/yr ([Z] yrs remaining)
- **Additional Assessment Eligibility**: [Course code or None — state reason if excluded]
- **Honours Eligibility**: [FCH / HONS / None / Not yet qualifying — specify duration, GPA, and EEE4022 status]

### 📋 Course Certification Status
- **Core Courses**: [X] / [Total] passed (note across-variant equivalencies used)
- **Number-Based Electives (`necore`)**: [Status & courses passed vs requirement]
- **Credit-Based Electives (`cecore`)**: [X] / 48 credits passed ([list courses & credits])

#### 🔄 Current Progress vs. Requirements (Core Courses)
- **Passed Core Courses**: [Codes, noting equivalents in brackets]
- **Active/Outstanding Core Courses**: [Codes not yet passed]

#### 🎓 Future Requirements to Graduate (Core & Electives)
| Code | Course Name | Requirement Type | Status | Credits | Notes |
|---|---|---|---|---|---|
| [Code] | [Title] | [Core / necore / cecore] | [Registered / Outstanding] | [Cr] | [Prerequisites / clash / capstone notes] |

### 📚 Current Year Registrations ([Year])
| Course Code | Title | Credits | Result | Status |
|---|---|---|---|---|
| [Code] | [Title] | [Cr] | [Mark/Symbol] | [Passed / Failed / Pending / In Progress] |

### 🔮 Simulation Scenarios (What-If Outcomes)
| Scenario | Assumed Conditions | Predicted Status | Recalculated Credits | Notes |
|---|---|---|---|---|
| **Current Actual (`Curr`)** | Pending/blank/supps treated as failed | [PCode] | [Credits] | [Rule trigger] |
| **Pass All Current (`PA` / `PY`)** | Passes all currently registered courses | [PCode] | [Credits] | [e.g. POTA/QUAL or missing items] |
| **Pass Semester 2 (`PS2`)** | Passes all S2 (`S`/`C`) courses | [PCode] | [Credits] | [Notes] |
| **Best Case (Supps Passed)** | Passes awarded supps/DE + remaining | [PCode] | [Credits] | [Notes] |
| **Worst Case (Supps Failed)** | Fails pending/supplementary exams (`UF`) | [PCode] | [Credits] | [Notes] |

### 🧭 Staff Advisor Recommendations & Action Items
- **Progression / FEC Risk**: [Concise assessment: RAC appeal prep if `SUPP`/`RENN`, AA nomination, practical training submission, etc.]
- **Recommended Registration Plan**: [Semester 1 & Semester 2 courses with total credits, prerequisite verification, and Hard/Soft (`_P`) timetable clash check]
```
