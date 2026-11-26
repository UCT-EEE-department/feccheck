# UCT EEE 2026 Weekly Timetable Grids & Clash Rules

Source of truth: [program_defs.py](../../../../program_defs.py) and [query_timetable.py](../../../../query_timetable.py).

## Clash Classification Rules
1. **Hard Clash (PROHIBITED)**: Two lecture courses (neither suffixed with `_P`) occupy the same `[Period][Day]` in the same semester. Standard lectures are mandatory; students may not register for hard clashes.
2. **Soft Clash (Likelihood of Clash — Check Section Flexibility)**: Overlap involving at least one `_P` entry (practical, laboratory, tutorial, or drawing slot). Often run bi-weekly or in multiple afternoon sections; requires convener approval/section check.
3. **Unlisted Courses**: Non-EEE electives (e.g. Humanities `COMPSTUD` courses) must be checked against the central UCT timetable.

## Semester 1 Timetable (2026)
| Period | Time | Monday | Tuesday | Wednesday | Thursday | Friday |
|---|---|---|---|---|---|---|
| **Period 1** | 08:00 | EEE4117F, MAM1020F, MAM1023F, MAM2083F, MAM2085F | EEE4119F_P, EEE4126F, MAM1020F, MAM1023F, MAM2083F, MAM2085F | EEE4117F, MAM1020F, MAM1023F, MAM2083F, MAM2085F | EEE4126F, MAM1020F, MAM1023F, MAM2083F, MAM2085F | EEE4117F_P, MAM1020F, MAM1023F, MAM2083F, MAM2085F |
| **Period 2** | 09:00 | CSC2001F, CSC3002F, PHY1012F | CSC2001F, CSC3002F, PHY1012F | CSC2001F, CSC3002F, PHY1012F | CSC2001F, CSC3002F, PHY1012F | CSC2001F, CSC3002F, EEE4126F_P, PHY1012F |
| **Period 3** | 10:00 | EEE1008F, EEE2045F, EEE3090F, EEE4119F, EEE4121F | EEE2045F_P, EEE3088F, EEE4118F, PHY1014F | EEE2045F_P, EEE3091F, EEE4119F, EEE4121F, PHY1014F | EEE1008F, EEE2045F, EEE3090F, EEE4118F | EEE3090F_P, EEE3091F, EEE4120F, PHY1014F |
| **Period 4** | 11:00 | - | CSC1015F_P, PHY1014F_P | PHY1014F_P | - | PHY1014F_P |
| **Period 5** | 12:00 | EEE4118F_P, MEC1009F, MEC2047F | CML4607F, CSC1015F_P, MEC1009F, MEC2047F | CML4607F, MEC1009F, MEC2047F | CML4607F, MEC1009F, MEC2047F, PHY1014F | CML4607F |
| **Period M** | 13:00 | HUB4049F | HUB4049F | HUB4049F | - | - |
| **Period 6** | 14:00 | EEE1008F_P, EEE3089F, EEE4120F, MEC1003F_P, MEC1009F_P, MEC2047F_P, PHY1014F | EEE2046F, EEE3092F, EEE4114F, MAM1020F_P, MAM1023F_P, MAM2085F_P | CSC1015F, EEE3089F, EEE4113F, MAM2083F_P, PHY1014F_P | EEE2046F, EEE3092F, EEE4114F, PHY1012F_P, PHY1014F_P | CSC2001F_P, EEE1008F_P, EEE3090F_P, EEE4113F_P, MEC1003F |
| **Period 7** | 15:00 | - | - | - | - | - |
| **Period 8** | 16:00 | EEE3089F_P | EEE2046F_P, EEE3092F_P, EEE4120F_P | EEE3088F_P | EEE2046F_P, EEE3091F_P, EEE4120F_P | - |
| **Period 9** | 17:00 | - | - | - | PHY1012F_P | - |

## Semester 2 Timetable (2026)
| Period | Time | Monday | Tuesday | Wednesday | Thursday | Friday |
|---|---|---|---|---|---|---|
| **Period 1** | 08:00 | MAM1021S, MAM1024S | MAM1021S, MAM1024S, MAM2084S | MAM1021S, MAM1024S, MAM2084S | MAM1021S, MAM1024S, MAM2084S | MAM1021S, MAM1024S, MAM2084S |
| **Period 2** | 09:00 | CSC2002S, PHY1013S, PHY2010S | CSC2002S, PHY1013S, PHY2010S | CSC2002S, PHY1013S, PHY2010S | CSC2002S, PHY1013S, PHY2010S | CSC2002S, PHY1013S, PHY2010S |
| **Period 3** | 10:00 | EEE1009S, EEE2047S, EEE3094S | EEE2044S, EEE3096S, EEE3100S, PHY1015S | EEE2044S, EEE3096S, EEE3100S, PHY1015S | EEE1009S, EEE2047S, EEE3094S | EEE2048S, EEE3097S, EEE3098S, PHY1015S |
| **Period 4** | 11:00 | - | PHY1015S_P | PHY1015S_P | - | PHY1015S_P |
| **Period 5** | 12:00 | - | CSC1016S, MEC2045S | MEC2045S | MEC2045S, PHY1015S | - |
| **Period M** | 13:00 | - | - | - | - | - |
| **Period 6** | 14:00 | CSC2002S_P, EEE1009S_P, EEE2044S_P, MEC2045S_P, PHY1015S | EEE3093S, EEE4125C, MAM1021S_P, MAM1024S_P, MAM2084S_P | CSC1016S_P, EEE3094S_P, PHY1015S_P | EEE3093S, EEE3099S, EEE4125C, PHY1013S_P, PHY1015S_P | EEE1009S_P, EEE3096S_P, PHY2010S_P |
| **Period 7** | 15:00 | - | - | - | - | - |
| **Period 8** | 16:00 | - | EEE3093S_P | - | EEE3100S_P | - |
| **Period 9** | 17:00 | - | - | - | - | - |
