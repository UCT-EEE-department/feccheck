/* UNSEAT Student Self-Service Degree Audit & Registration Planner (100% Local Pyodide) */

const STORAGE_KEY = "uct_eee_student_planner_v1";

let pyodideReady = false;
let pyodide = null;
let catalogMeta = null;
let checklistSpec = null;
let studentPromptCache = null;
let lastPlannerResult = null;

// courseState: { [code]: "passed_prior" | "passed_curr" | "supp" | "inprog" | "failed" }
let courseState = {};
let proposedSet = new Set();

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pcBadgeClass(pc) {
  if (pc === "QUAL" || pc === "FCH" || pc === "HONS") return "blue";
  if (pc === "CONT" || pc === "POTA" || pc === "POTS" || pc === "POTA/POTS") return "green";
  if (pc === "SUPP" || pc === "FECP" || pc === "QUAS") return "amber";
  return "red";
}

async function fetchWithFallback(paths) {
  for (const p of paths) {
    try {
      const r = await fetch(p, { cache: "no-cache" });
      if (r.ok) return await r.text();
    } catch (_) {}
  }
  throw new Error("Could not fetch asset from: " + paths.join(", "));
}

// ---------------------------------------------------------------------------
// LocalStorage persistence (student's own browser only)
// ---------------------------------------------------------------------------
function saveStudentState() {
  try {
    const payload = {
      program: document.getElementById("stuProgSelect").value,
      startYr: document.getElementById("stuStartYr").value,
      currYr: document.getElementById("stuCurrYr").value,
      gpa: document.getElementById("stuGpaInput").value,
      courseState,
      proposed: Array.from(proposedSet)
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {}
}

function loadStudentState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.program) document.getElementById("stuProgSelect").value = data.program;
    if (data.startYr) document.getElementById("stuStartYr").value = data.startYr;
    if (data.currYr) document.getElementById("stuCurrYr").value = data.currYr;
    if (data.gpa) document.getElementById("stuGpaInput").value = data.gpa;
    if (data.courseState && typeof data.courseState === "object") courseState = data.courseState;
    if (Array.isArray(data.proposed)) proposedSet = new Set(data.proposed);
    document.getElementById("compstudPassedCheck").checked = Boolean(courseState["AXL1301S"]);
  } catch (_) {}
}

function resetAllStudentData() {
  courseState = {};
  proposedSet = new Set();
  document.getElementById("compstudPassedCheck").checked = false;
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  refreshChecklistAndRun();
}

// ---------------------------------------------------------------------------
// Initialise Pyodide + feccheck Engine
// ---------------------------------------------------------------------------
async function initStudentEngine() {
  const pill = document.getElementById("engineStatus");
  try {
    pill.textContent = "Starting Python (1/3)…";
    pyodide = await loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"
    });
    pill.textContent = "Loading pandas/numpy (2/3)…";
    await pyodide.loadPackage(["numpy", "pandas"]);

    pill.textContent = "Loading EEE Rules (3/3)…";
    pyodide.FS.mkdirTree("/app");

    const files = [
      { dest: "/app/program_defs.py", urls: ["./py/program_defs.py", "../program_defs.py"] },
      { dest: "/app/crs_parser.py", urls: ["./py/crs_parser.py", "../crs_parser.py"] },
      { dest: "/app/fec_check.py", urls: ["./py/fec_check.py", "../fec_check.py"] },
      { dest: "/app/advise_student.py", urls: ["./py/advise_student.py", "../.agents/skills/staffadvisor/scripts/advise_student.py"] },
      { dest: "/app/timetable_schedule.json", urls: ["./py/timetable_schedule.json", "../timetable_schedule.json"] }
    ];
    await Promise.all(files.map(async (f) => {
      const content = await fetchWithFallback(f.urls);
      pyodide.FS.writeFile(f.dest, content, { encoding: "utf8" });
    }));

    await pyodide.runPythonAsync(`
import os, sys
os.environ["FECCHECK_DIR"] = "/app"
if "/app" not in sys.path:
    sys.path.insert(0, "/app")
import advise_student
`);

    catalogMeta = JSON.parse(await pyodide.runPythonAsync(`advise_student.get_catalog_metadata()`));
    populateDatalist();

    pyodideReady = true;
    pill.textContent = "Planner Ready ✓";
    pill.className = "pill ok";

    await refreshChecklistAndRun();
  } catch (err) {
    console.error(err);
    pill.textContent = "Engine Error";
    pill.className = "pill err";
    showStuError("Could not start browser planner engine: " + err.message);
  }
}

function showStuError(msg) {
  const b = document.getElementById("stuErrorBanner");
  if (!msg) { b.style.display = "none"; return; }
  b.style.display = "block";
  b.textContent = msg;
}

function populateDatalist() {
  if (!catalogMeta) return;
  const dl = document.getElementById("allCoursesDatalist");
  dl.innerHTML = "";
  for (const c of catalogMeta.courses) {
    const opt = document.createElement("option");
    opt.value = c.code;
    opt.label = `${c.code} — ${c.title || c.code} (${c.credits} cr)`;
    dl.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Checklist & Transcript Import
// ---------------------------------------------------------------------------
async function onProfileChanged() {
  const startYr = Number(document.getElementById("stuStartYr").value);
  const currSel = document.getElementById("stuCurrYr");
  if (Number(currSel.value) < startYr) {
    currSel.value = String(startYr);
  }
  saveStudentState();
  await refreshChecklistAndRun();
}

async function refreshChecklistAndRun() {
  if (!pyodideReady) return;
  const prog = document.getElementById("stuProgSelect").value;
  const startYr = Number(document.getElementById("stuStartYr").value);
  pyodide.globals.set("_js_c_prog", prog);
  pyodide.globals.set("_js_c_yr", startYr);
  const chkJson = await pyodide.runPythonAsync(`advise_student.get_student_program_checklist(_js_c_prog, int(_js_c_yr))`);
  checklistSpec = JSON.parse(chkJson);
  renderChecklist();
  await runPlanner();
}

function setCourseStatus(code, status) {
  if (!status) delete courseState[code];
  else courseState[code] = status;
  saveStudentState();
  renderExtraPills();
  runPlanner();
}

function markGroupPassed(groupKey, mode) {
  if (!checklistSpec) return;
  const items = checklistSpec.groups[groupKey] || [];
  for (const it of items) {
    if (mode === "clear") delete courseState[it.code];
    else courseState[it.code] = mode;
  }
  saveStudentState();
  renderChecklist();
  runPlanner();
}

function toggleCompstudPassed() {
  const checked = document.getElementById("compstudPassedCheck").checked;
  if (checked) courseState["AXL1301S"] = "passed_prior";
  else delete courseState["AXL1301S"];
  saveStudentState();
  renderExtraPills();
  runPlanner();
}

function addExtraCourse() {
  const inp = document.getElementById("extraPassedInput");
  const code = inp.value.trim().toUpperCase();
  if (!code) return;
  courseState[code] = "passed_prior";
  inp.value = "";
  saveStudentState();
  renderChecklist();
  renderExtraPills();
  runPlanner();
}

function renderChecklist() {
  if (!checklistSpec) return;
  const sections = [
    ["year1", "Year 1 Core Courses"],
    ["year2", "Year 2 Core Courses"],
    ["year3", "Year 3 Core Courses"],
    ["year4", "Year 4 Core & Capstone Courses"],
    ["electives", "Specialist & 48-Credit Basket Electives"]
  ];

  const html = sections.map(([key, label]) => {
    const items = checklistSpec.groups[key] || [];
    if (!items.length) return "";
    const rows = items.map((it) => {
      const st = courseState[it.code] || "";
      return `<tr>
        <td><code>${escapeHtml(it.code)}</code></td>
        <td>${escapeHtml(it.title)}</td>
        <td>${it.credits}</td>
        <td>
          <select onchange="setCourseStatus('${it.code}', this.value)" style="padding:0.25rem 0.45rem; font-size:0.82rem;">
            <option value="" ${st === "" ? "selected" : ""}>Not taken yet</option>
            <option value="passed_prior" ${st === "passed_prior" ? "selected" : ""}>✓ Passed (Prior Year)</option>
            <option value="passed_curr" ${st === "passed_curr" ? "selected" : ""}>✓ Passed (This Year)</option>
            <option value="inprog" ${st === "inprog" ? "selected" : ""}>⏳ Registered / In Progress</option>
            <option value="supp" ${st === "supp" ? "selected" : ""}>⚠ Supp / DE Pending</option>
            <option value="failed" ${st === "failed" ? "selected" : ""}>✗ Failed (This Year)</option>
          </select>
        </td>
      </tr>`;
    }).join("");

    return `<div style="margin-bottom:0.9rem;">
      <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
        <h3 style="margin:0;">${label}</h3>
        <div class="controls-row">
          <button class="secondary small" onclick="markGroupPassed('${key}','passed_prior')">Mark All Passed (Prior Yr)</button>
          <button class="secondary small" onclick="markGroupPassed('${key}','passed_curr')">Mark All Passed (This Yr)</button>
          <button class="secondary small" onclick="markGroupPassed('${key}','clear')">Clear Group</button>
        </div>
      </div>
      <table>
        <thead><tr><th style="width:110px;">Code</th><th>Course Title</th><th style="width:60px;">Cr</th><th style="width:220px;">Your Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join("");

  document.getElementById("checklistContainer").innerHTML = html;
  renderExtraPills();
}

function renderExtraPills() {
  if (!checklistSpec) return;
  const listed = new Set();
  Object.values(checklistSpec.groups).forEach((arr) => arr.forEach((x) => listed.add(x.code)));
  const extras = Object.keys(courseState).filter((c) => !listed.has(c));
  const box = document.getElementById("extraCoursesPills");
  box.innerHTML = extras.map((code) =>
    `<span class="badge green" style="display:inline-flex; align-items:center; gap:0.35rem;">
      ${escapeHtml(code)} (${escapeHtml(courseState[code])})
      <button class="secondary small" style="padding:0 0.35rem;" onclick="setCourseStatus('${code}','')">×</button>
    </span>`
  ).join("");
}

async function importFromPastedText() {
  if (!pyodideReady) return;
  const raw = document.getElementById("pasteTranscriptBox").value;
  const msg = document.getElementById("importStatusMsg");
  msg.textContent = "Parsing…";
  pyodide.globals.set("_js_paste_txt", raw);
  pyodide.globals.set("_js_def_prog", document.getElementById("stuProgSelect").value);
  pyodide.globals.set("_js_def_yr", Number(document.getElementById("stuStartYr").value));
  pyodide.globals.set("_js_def_gpa", Number(document.getElementById("stuGpaInput").value) || 65);

  const resJson = await pyodide.runPythonAsync(`
advise_student.parse_pasted_student_text(_js_paste_txt, _js_def_prog, int(_js_def_yr), float(_js_def_gpa))
`);
  const res = JSON.parse(resJson);
  if (res.error) {
    msg.style.color = "#991b1b";
    msg.textContent = res.error;
    return;
  }

  document.getElementById("stuProgSelect").value = res.program;
  const startStr = String(Math.max(2020, Math.min(2026, res.first_eee_reg)));
  if ([...document.getElementById("stuStartYr").options].some((o) => o.value === startStr)) {
    document.getElementById("stuStartYr").value = startStr;
  }
  document.getElementById("stuCurrYr").value = res.current_year >= 2026 ? "2026" : "2025";
  document.getElementById("stuGpaInput").value = String(res.gpa);

  courseState = {};
  const maxYr = res.current_year;
  for (const c of res.courses) {
    const numP = Number(c.perc);
    const isPass = (!Number.isNaN(numP) && numP >= 50) || ["PA", "UP", "50C", "EX", "CR"].includes(c.perc) || c.symbol === "PA";
    const isSupp = (c.perc && c.perc.endsWith("S") && c.perc.length > 1) || ["FS", "SF", "OSS", "DE", "OS"].includes(c.symbol);
    if (isPass) {
      courseState[c.course] = c.yt >= maxYr ? "passed_curr" : "passed_prior";
    } else if (isSupp && c.yt >= maxYr) {
      courseState[c.course] = "supp";
    } else if (c.perc === "" && c.symbol === "" && c.yt >= maxYr) {
      courseState[c.course] = "inprog";
    } else if (c.yt >= maxYr) {
      courseState[c.course] = "failed";
    }
  }

  msg.style.color = "#15803d";
  msg.textContent = `Imported ${Object.keys(courseState).length} courses! Check Tab 2 for your Degree Audit.`;
  saveStudentState();
  await refreshChecklistAndRun();
}

// ---------------------------------------------------------------------------
// Build Synthetic Course Payload & Run Deterministic Audit
// ---------------------------------------------------------------------------
function buildCoursesPayload() {
  const startYr = Number(document.getElementById("stuStartYr").value);
  const currYr = Math.max(startYr, Number(document.getElementById("stuCurrYr").value));
  const priorYr = Math.max(startYr, currYr - 1);

  const out = [];
  for (const [code, st] of Object.entries(courseState)) {
    if (st === "passed_prior") {
      out.push({ course: code, yt: priorYr, perc: "PA", symbol: "PA" });
    } else if (st === "passed_curr") {
      out.push({ course: code, yt: currYr, perc: "PA", symbol: "PA" });
    } else if (st === "inprog") {
      out.push({ course: code, yt: currYr, perc: "", symbol: "" });
    } else if (st === "supp") {
      out.push({ course: code, yt: currYr, perc: "46S", symbol: "FS" });
    } else if (st === "failed") {
      out.push({ course: code, yt: currYr, perc: "UF", symbol: "F" });
    }
  }
  return out;
}

async function runPlanner() {
  if (!pyodideReady) return;
  showStuError("");

  const reqObj = {
    program: document.getElementById("stuProgSelect").value,
    first_eee_reg: Number(document.getElementById("stuStartYr").value),
    current_year: Number(document.getElementById("stuCurrYr").value),
    gpa: Number(document.getElementById("stuGpaInput").value) || 65.0,
    courses: buildCoursesPayload(),
    propose_courses: Array.from(proposedSet)
  };

  pyodide.globals.set("_js_stu_req", JSON.stringify(reqObj));
  const resJson = await pyodide.runPythonAsync(`advise_student.run_student_planner_audit(_js_stu_req)`);
  const res = JSON.parse(resJson);
  if (res.error) {
    showStuError(res.error);
    return;
  }
  lastPlannerResult = res;
  renderProgressTab();
  renderStudentPlanTab();
  renderStudentDraftSheet();
}

// ---------------------------------------------------------------------------
// Tab 2: Student Degree Progress
// ---------------------------------------------------------------------------
function renderProgressTab() {
  if (!lastPlannerResult) return;
  if (lastPlannerResult.empty_record) {
    document.getElementById("stuStandingHeader").innerHTML = `
      <h2 style="margin:0;">Welcome! Tick Your Completed Courses in Tab 1</h2>
      <p style="color:#475569; margin:0.35rem 0 0;">
        You haven't marked any completed or current courses yet (${escapeHtml(lastPlannerResult.program_code)}, ${lastPlannerResult.required_credits} cr degree).
        If you are an incoming 1st-year student, jump straight to <strong>Tab 3</strong> to test your 1st-year timetable!
      </p>
    `;
    document.getElementById("stuStandingStats").innerHTML = "";
    document.getElementById("stuStandingBanners").innerHTML = "";
    document.getElementById("stuDegreeChecklist").innerHTML = "<p>Mark your passed courses in Tab 1 to see your remaining Core and Elective checklist.</p>";
    document.getElementById("stuScenariosCard").style.display = "none";
    return;
  }

  document.getElementById("stuScenariosCard").style.display = "block";
  const { audit } = lastPlannerResult;
  const p = audit.profile;
  const s = audit.standing;
  const c = audit.certification;

  const cls = pcBadgeClass(s.fec_decision_pc);
  document.getElementById("stuStandingHeader").innerHTML = `
    <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:0.5rem;">
      <div>
        <h2 style="margin:0;">Your Estimated Standing (${escapeHtml(p.program_code)})</h2>
        <div style="color:#475569; font-size:0.88rem;">
          ${escapeHtml(p.program_name)} • Started EEE: <strong>${p.first_eee_reg}</strong> • Year ${p.eedur} of N=${s.N}
        </div>
      </div>
      <div style="text-align:right;">
        <span class="badge ${cls}" style="font-size:1rem; padding:0.35rem 0.75rem;">
          Estimated Status: ${escapeHtml(s.fec_decision_pc)}
        </span>
        <div style="font-size:0.82rem; color:#475569; margin-top:0.2rem;">${escapeHtml(s.fec_decision_pmess || "On track / Good standing")}</div>
      </div>
    </div>
  `;

  document.getElementById("stuStandingStats").innerHTML = `
    <div class="stat-box">
      <div class="lbl">Your EEE Credits</div>
      <div class="val">${s.totalcr} / ${s.rcurcr}</div>
      <div class="note">${Math.max(0, s.rcurcr - s.totalcr)} cr left to graduate</div>
    </div>
    <div class="stat-box">
      <div class="lbl">Entered GPA</div>
      <div class="val">${s.gpa.toFixed(1)}%</div>
      <div class="note">Rounded: ${s.gpa_rounded}%</div>
    </div>
    <div class="stat-box">
      <div class="lbl">This Year's Passed Cr</div>
      <div class="val">${s.ccrp} cr</div>
      <div class="note">Counted in ${p.current_year}</div>
    </div>
    <div class="stat-box">
      <div class="lbl">N+1 Pace (${s.N + 1} yrs)</div>
      <div class="val">${s.rem_years_np1 > 0 ? Math.ceil(s.np1crpy) + " cr/yr" : "Past N+1"}</div>
      <div class="note">${s.rem_years_np1} yr(s) remaining</div>
    </div>
    <div class="stat-box">
      <div class="lbl">N+2 Limit (${s.N + 2} yrs)</div>
      <div class="val">${s.rem_years_np2 > 0 ? Math.ceil(s.np2crpy) + " cr/yr" : "At/Past N+2"}</div>
      <div class="note">${s.rem_years_np2} yr(s) remaining</div>
    </div>
  `;

  let banners = "";
  if (["RENN", "FECR"].includes(s.fec_decision_pc)) {
    banners += `<div class="banner err"><strong>Important — Speak With an Academic Advisor:</strong> Based on the credits entered, this triggers a progression flag (<code>${escapeHtml(s.fec_decision_pc)}: ${escapeHtml(s.fec_decision_pmess)}</code>). Please meet with a UCT EEE Academic Advisor to review your official record and options.</div>`;
  }
  if (s.aa_course && s.aa_course !== "None") {
    banners += `<div class="banner warn"><strong>Additional Assessment Rule:</strong> Only one failed exam course (<code>${escapeHtml(s.aa_course)}</code>) appears to stand between you and graduating—ask your Academic Advisor / Faculty Office about Additional Assessment eligibility.</div>`;
  }
  banners += `<div class="banner info"><strong>Honours Eligibility Track:</strong> ${escapeHtml(s.honours_eligibility)}</div>`;
  document.getElementById("stuStandingBanners").innerHTML = banners;

  const outCores = c.outstanding_cores.map((x) =>
    `<li><code>${escapeHtml(x.code)}</code> — ${escapeHtml(x.title)} (${x.credits} cr) • Prereqs: <code>${escapeHtml(x.prereqs)}</code></li>`
  ).join("");
  const neHtml = c.necore.map((g) =>
    `<li><strong>Specialist Electives (${g.id})</strong>: ${g.passed_count} of ${g.required_count} passed <span class="badge ${g.satisfied ? "green" : "amber"}">${g.satisfied ? "Complete ✓" : "Still Needed"}</span> — Options: <code>${escapeHtml(g.options.join(", "))}</code></li>`
  ).join("");
  const ceHtml = c.cecore.map((g) =>
    `<li><strong>48-Credit Elective Basket</strong>: ${g.earned_credits} of ${g.required_credits} cr earned <span class="badge ${g.satisfied ? "green" : "amber"}">${g.satisfied ? "Complete ✓" : "Still Needed"}</span> — Eligible basket: <code>${escapeHtml(g.options.join(", "))}</code></li>`
  ).join("");

  document.getElementById("stuDegreeChecklist").innerHTML = `
    <p style="margin-top:0;"><strong>Core Courses Completed:</strong> ${c.core_passed_count} / ${c.core_total_count}</p>
    <h3>Remaining Core Courses (${c.outstanding_cores.length})</h3>
    <ul>${outCores || "<li>None — all core requirements satisfied or in progress!</li>"}</ul>
    <h3>Your Specialist &amp; Credit Electives</h3>
    <ul>${neHtml}${ceHtml}</ul>
  `;

  const scenRows = audit.scenarios.slice(0, 5).map((sc) => `<tr>
    <td><strong>${escapeHtml(sc.scenario)}</strong><div style="font-size:0.76rem;color:#475569;">${escapeHtml(sc.conditions)}</div></td>
    <td><span class="badge ${pcBadgeClass(sc.pc)}">${escapeHtml(sc.pc)}</span></td>
    <td>${escapeHtml(sc.pmess || "Good standing")}</td>
    <td>${sc.totalcr}</td>
  </tr>`).join("");
  document.getElementById("stuScenariosTable").innerHTML = `
    <table>
      <thead><tr><th>Scenario</th><th>Estimated Code</th><th>Notes</th><th>Total Credits</th></tr></thead>
      <tbody>${scenRows}</tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Tab 3: Student Registration & Clash Planner
// ---------------------------------------------------------------------------
function toggleStuProposed(code) {
  const c = code.trim().toUpperCase();
  if (!c) return;
  if (proposedSet.has(c)) proposedSet.delete(c);
  else proposedSet.add(c);
  saveStudentState();
  runPlanner();
}

function addStudentCustomProp() {
  const inp = document.getElementById("stuCustomPropInput");
  const c = inp.value.trim().toUpperCase();
  if (!c) return;
  proposedSet.add(c);
  inp.value = "";
  saveStudentState();
  runPlanner();
}

function clearStudentProposed() {
  proposedSet.clear();
  saveStudentState();
  runPlanner();
}

async function autoPickStudentCores() {
  if (!lastPlannerResult) return;
  const coreCodes = lastPlannerResult.candidates
    .filter((c) => c.category.includes("Core"))
    .map((c) => c.code);

  const reqObj = {
    program: document.getElementById("stuProgSelect").value,
    first_eee_reg: Number(document.getElementById("stuStartYr").value),
    current_year: Number(document.getElementById("stuCurrYr").value),
    gpa: Number(document.getElementById("stuGpaInput").value) || 65.0,
    courses: buildCoursesPayload(),
    propose_courses: coreCodes
  };
  pyodide.globals.set("_js_stu_req", JSON.stringify(reqObj));
  const testRes = JSON.parse(await pyodide.runPythonAsync(`advise_student.run_student_planner_audit(_js_stu_req)`));
  const pv = testRes.empty_record ? testRes.proposal_validation : testRes.audit?.proposal_validation;
  if (pv) {
    proposedSet.clear();
    let crSum = 0;
    for (const chk of pv.course_checks) {
      if (chk.prereqs_ok && !chk.already_satisfied && crSum + chk.credits <= 152) {
        proposedSet.add(chk.course);
        crSum += chk.credits;
      }
    }
    saveStudentState();
    await runPlanner();
  }
}

function renderStudentPlanTab() {
  if (!lastPlannerResult) return;
  const pv = lastPlannerResult.empty_record
    ? lastPlannerResult.proposal_validation
    : lastPlannerResult.audit.proposal_validation;
  const candidates = lastPlannerResult.candidates || [];
  const titles = catalogMeta?.titles || {};

  const candCodes = new Set(candidates.map((x) => x.code));
  const extras = Array.from(proposedSet)
    .filter((c) => !candCodes.has(c))
    .map((c) => ({
      code: c,
      title: titles[c] || c,
      credits: (catalogMeta?.courses.find((x) => x.code === c)?.credits) ?? 16,
      category: "Added",
      note: "Custom selection"
    }));

  const allCands = [...extras, ...candidates];
  document.getElementById("stuCandidateList").innerHTML = allCands.map((it) => {
    const checked = proposedSet.has(it.code) ? "checked" : "";
    return `<label class="cand-item">
      <input type="checkbox" ${checked} onchange="toggleStuProposed('${it.code}')" />
      <div>
        <div><span class="cand-code">${escapeHtml(it.code)}</span> — ${escapeHtml(it.title)} <strong>(${it.credits} cr)</strong></div>
        <div class="cand-meta">${escapeHtml(it.category)} • ${escapeHtml(it.note)}</div>
      </div>
    </label>`;
  }).join("");

  let meterCls = pv.total_proposed_credits === 0 ? "info" : "ok";
  let meterMsg = pv.total_proposed_credits === 0
    ? "Tick courses on the left (or click Auto-Pick Eligible Cores) to test your registration plan."
    : "Good balanced load—check prerequisites and timetable grid below.";
  if (pv.total_proposed_credits > 160) {
    meterCls = "warn";
    meterMsg = "Over 160 annual credits—requires strong GPA and an HoD overload concession.";
  }
  document.getElementById("stuCreditMeter").innerHTML = `
    <div class="banner ${meterCls}">
      <strong>Planned Credits: ${pv.total_proposed_credits} cr</strong>
      (Sem 1: <strong>${pv.s1_credits} cr</strong> • Sem 2: <strong>${pv.s2_credits} cr</strong>) — ${escapeHtml(meterMsg)}
    </div>
  `;

  if (!pv.course_checks.length) {
    document.getElementById("stuProposalTable").innerHTML = "";
  } else {
    const rows = pv.course_checks.map((chk) => {
      const msgs = [];
      if (!chk.prereqs_ok) msgs.push(`<span class="badge red">Unmet Prereq: ${escapeHtml(chk.missing_prereqs.join("; "))}</span>`);
      if (!chk.coreqs_ok) msgs.push(`<span class="badge red">Unmet Coreq: ${escapeHtml(chk.missing_coreqs.join("; "))}</span>`);
      for (const w of chk.warnings) msgs.push(`<span class="badge amber">${escapeHtml(w)}</span>`);
      return `<tr>
        <td><code>${escapeHtml(chk.course)}</code></td>
        <td>${escapeHtml(titles[chk.course] || chk.course)}</td>
        <td>${chk.credits}</td>
        <td>${msgs.length ? msgs.join("<br/>") : '<span class="badge green">Prerequisites Met ✓</span>'}</td>
        <td><button class="secondary small" onclick="toggleStuProposed('${chk.course}')">Remove</button></td>
      </tr>`;
    }).join("");
    document.getElementById("stuProposalTable").innerHTML = `
      <table>
        <thead><tr><th>Course</th><th>Title</th><th>Cr</th><th>Eligibility Check</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  const tt = pv.timetable;
  let banner = "";
  if (tt.hard_clashes?.length) {
    banner += `<div class="banner err"><strong>Hard Lecture Clash (${tt.hard_clashes.length}):</strong> ${escapeHtml(tt.hard_clashes.map((c) => `Sem ${c.semester} ${c.day} P${c.period} (${c.entries.join(" vs ")})`).join("; "))} — Lecture clashes are not permitted!</div>`;
  } else if (pv.course_checks.length) {
    banner += `<div class="banner ok"><strong>No Hard Lecture Clashes ✓</strong></div>`;
  }
  if (tt.soft_clashes?.length) {
    banner += `<div class="banner warn"><strong>Afternoon Practical/Tut Overlap (<code>_P</code>):</strong> ${escapeHtml(tt.soft_clashes.map((c) => `Sem ${c.semester} ${c.day} P${c.period} (${c.entries.join("/")})`).join("; "))} — Usually resolved by choosing alternate tutorial/lab days.</div>`;
  }
  document.getElementById("stuClashBanner").innerHTML = banner;
  document.getElementById("stuTtSem1").innerHTML = buildStuTimetable(1, tt);
  document.getElementById("stuTtSem2").innerHTML = buildStuTimetable(2, tt);
}

function buildStuTimetable(semNum, tt) {
  if (!catalogMeta) return "";
  const days = catalogMeta.day_labels;
  const periods = catalogMeta.period_labels;
  const slotMap = {};
  for (const sl of (tt.schedule_slots || [])) {
    if (sl.semester !== semNum) continue;
    const k = `${sl.period}_${sl.day}`;
    if (!slotMap[k]) slotMap[k] = [];
    slotMap[k].push(sl.entry);
  }
  const hardSet = new Set((tt.hard_clashes || []).filter((c) => c.semester === semNum).map((c) => `${c.period}_${c.day}`));
  const softSet = new Set((tt.soft_clashes || []).filter((c) => c.semester === semNum).map((c) => `${c.period}_${c.day}`));

  const rows = periods.map(([pLbl, pTime]) => {
    const cells = days.map((d) => {
      const k = `${pLbl}_${d}`;
      const entries = slotMap[k] || [];
      let cls = "";
      if (hardSet.has(k)) cls = "tt-cell-hard";
      else if (softSet.has(k)) cls = "tt-cell-soft";
      else if (entries.length) cls = "tt-cell-ok";
      return `<td class="${cls}">${entries.map(escapeHtml).join("<br/>")}</td>`;
    }).join("");
    return `<tr><th>P${pLbl} <span style="font-weight:400;color:#475569;">(${pTime})</span></th>${cells}</tr>`;
  }).join("");

  return `<table class="tt-grid"><thead><tr><th>Period</th>${days.map((d) => `<th>${d}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Tab 4: Student Advising Prep Draft & Free AI Handoff
// ---------------------------------------------------------------------------
function renderStudentDraftSheet() {
  if (!lastPlannerResult) return;
  const pv = lastPlannerResult.empty_record
    ? lastPlannerResult.proposal_validation
    : lastPlannerResult.audit.proposal_validation;
  const titles = catalogMeta?.titles || {};
  const stuName = document.getElementById("stuNameInput").value.trim() || "[Student Name]";
  const stuCid = document.getElementById("stuCidInput").value.trim().toUpperCase() || "[Campus ID]";
  const planYr = document.getElementById("stuPlanYear").value;
  const notes = document.getElementById("stuNotesInput").value.trim();
  const prog = document.getElementById("stuProgSelect").value;
  const startYr = document.getElementById("stuStartYr").value;

  const standingLine = lastPlannerResult.empty_record
    ? `0 / ${lastPlannerResult.required_credits} cr entered (New Planner Draft)`
    : `${lastPlannerResult.audit.standing.totalcr} / ${lastPlannerResult.audit.standing.rcurcr} cr • Est. Standing: ${lastPlannerResult.audit.standing.fec_decision_pc}`;

  const rows = pv.course_checks.map((chk) => {
    const flag = (chk.prereqs_ok && chk.coreqs_ok) ? "Prerequisites Met ✓" : "Needs Advisor / Concession Review";
    return `<tr>
      <td><code>${escapeHtml(chk.course)}</code></td>
      <td>${escapeHtml(titles[chk.course] || chk.course)}</td>
      <td>${chk.credits}</td>
      <td>${flag}</td>
    </tr>`;
  }).join("");

  document.getElementById("certificatePreview").innerHTML = `
    <div class="cert-header" style="border-color:#0f4c5c;">
      <div>
        <h2 style="color:#0f4c5c;">UCT EEE — Student Registration Planning Draft (${escapeHtml(planYr)})</h2>
        <div style="font-size:0.82rem; color:#92400e; font-weight:600; margin-top:0.2rem;">
          NON-OFFICIAL STUDENT PLANNING SHEET — FOR REVIEW WITH AN ACADEMIC ADVISOR
        </div>
      </div>
      <div style="text-align:right; font-size:0.82rem;">
        <div><strong>Date:</strong> ${escapeHtml(new Date().toLocaleDateString("en-ZA"))}</div>
        <div><span class="badge amber">STUDENT DRAFT</span></div>
      </div>
    </div>

    <table>
      <tbody>
        <tr><th>Student Name</th><td>${escapeHtml(stuName)}</td><th>Campus ID</th><td><code>${escapeHtml(stuCid)}</code></td></tr>
        <tr><th>Programme</th><td>${escapeHtml(prog)} (Started EEE: ${escapeHtml(startYr)})</td><th>Self-Entered Standing</th><td>${escapeHtml(standingLine)}</td></tr>
      </tbody>
    </table>

    <h3>Proposed ${escapeHtml(planYr)} Courses (${pv.total_proposed_credits} Credits: S1=${pv.s1_credits}, S2=${pv.s2_credits})</h3>
    <table>
      <thead><tr><th>Course</th><th>Title</th><th>Cr</th><th>Rule Check</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4"><em>No proposed courses ticked in Tab 3 yet.</em></td></tr>'}</tbody>
    </table>

    <p style="font-size:0.84rem;">
      <strong>Timetable Check:</strong> ${(pv.timetable.hard_clashes?.length || 0) === 0 ? "0 Hard Clashes" : pv.timetable.hard_clashes.length + " Hard Clash(es)"} •
      ${(pv.timetable.soft_clashes?.length || 0) === 0 ? "0 Soft Overlaps" : pv.timetable.soft_clashes.length + " Soft Practical/Tut Overlap(s)"}
    </p>
    ${notes ? `<h3>Questions / Notes for Advisor</h3><div style="border:1px solid #cbd5e1; padding:0.6rem; border-radius:6px; white-space:pre-wrap;">${escapeHtml(notes)}</div>` : ""}
  `;
}

async function copyStudentSummaryForAdvisor() {
  if (!lastPlannerResult) return;
  const pv = lastPlannerResult.empty_record ? lastPlannerResult.proposal_validation : lastPlannerResult.audit.proposal_validation;
  const stuName = document.getElementById("stuNameInput").value.trim() || "[Name]";
  const stuCid = document.getElementById("stuCidInput").value.trim().toUpperCase() || "[Campus ID]";
  const prog = document.getElementById("stuProgSelect").value;
  const planYr = document.getElementById("stuPlanYear").value;
  const notes = document.getElementById("stuNotesInput").value.trim();

  const lines = [
    `UCT EEE STUDENT REGISTRATION PLANNING DRAFT (${planYr})`,
    `Student: ${stuName} (${stuCid}) | Stream: ${prog}`,
    `Proposed Courses (${pv.total_proposed_credits} cr: S1=${pv.s1_credits}, S2=${pv.s2_credits}):`,
    ...pv.course_checks.map((c) => `  - ${c.course} (${c.credits} cr): ${c.prereqs_ok && c.coreqs_ok ? "Prereqs OK" : "NEEDS CONCESSION REVIEW"}`),
    `Hard Clashes: ${pv.timetable.hard_clashes?.length || 0} | Soft Overlaps: ${pv.timetable.soft_clashes?.length || 0}`,
    ...(notes ? [``, `Questions for Advisor: ${notes}`] : [])
  ];
  await navigator.clipboard.writeText(lines.join("\n"));
  const m = document.getElementById("stuDraftCopyMsg");
  m.textContent = "Copied summary to clipboard!";
  setTimeout(() => { m.textContent = ""; }, 3000);
}

async function copyStudentAiPrompt() {
  if (!lastPlannerResult) return;
  const msg = document.getElementById("stuAiCopyMsg");
  msg.textContent = "Preparing…";
  try {
    if (!studentPromptCache) {
      studentPromptCache = await fetchWithFallback([
        "./py/uct_ee_studentadvisor.md",
        "../uct_ee_studentadvisor.md",
        "https://raw.githubusercontent.com/UCT-EEE-department/feccheck/main/uct_ee_studentadvisor.md"
      ]);
    }
    const q = document.getElementById("stuAiQuestion").value.trim();
    const payload = [
      studentPromptCache,
      "\n---\n",
      "Here is my anonymised degree audit and proposed course check already computed by UCT EEE's deterministic `feccheck` planner:\n",
      lastPlannerResult.student_markdown,
      q ? `\n---\n**My Question:** ${q}` : "\n---\nPlease review my progress and proposed courses in supportive, clear language and highlight anything I should discuss with my Academic Advisor."
    ].join("\n");
    await navigator.clipboard.writeText(payload);
    msg.textContent = "Copied! Open any free AI below and paste (Ctrl+V / Cmd+V).";
  } catch (err) {
    msg.textContent = "Copy failed: " + err.message;
  }
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === tabId));
}

window.addEventListener("DOMContentLoaded", () => {
  loadStudentState();
  initStudentEngine();
});
