/* UNSEAT — Undergraduate Student Enrolment & Advising Tool (UCT EEE, Pyodide + IndexedDB) */

const EEE_PROGS = new Set(["EB009", "EB809", "EB011", "EB811", "EB022", "EB822"]);
const DB_NAME = "uct_eee_feccheck_db";
const STORE_NAME = "crs_cache";

let pyodideReady = false;
let pyodide = null;
let catalogMeta = null;
let staffPromptCache = null;

let parsedStudents = [];
let courseTitlesMap = {};
let currentStudentIdx = null;
let currentAuditPayload = null;

// Interactive simulation state for current student
let proposedSet = new Set();
let passOverrides = new Set();
let failOverrides = new Set();
let assumeAllPassed = false;

// ---------------------------------------------------------------------------
// IndexedDB local caching for CURRENT_ADVISING_CRS.csv
// ---------------------------------------------------------------------------
function openCrsDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveCrsToIdb(meta) {
  try {
    const db = await openCrsDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(meta, "latest");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) {
    console.warn("IndexedDB cache skipped:", e);
  }
}

async function loadCrsFromIdb() {
  try {
    const db = await openCrsDb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get("latest");
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => rej(req.error);
    });
  } catch (e) {
    return null;
  }
}

async function clearCachedCrs() {
  try {
    const db = await openCrsDb();
    await new Promise((res) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete("latest");
      tx.oncomplete = () => res();
    });
  } catch (_) {}
  parsedStudents = [];
  currentStudentIdx = null;
  document.getElementById("workspaceArea").style.display = "none";
  document.getElementById("clearCacheBtn").style.display = "none";
  document.getElementById("crsPill").textContent = "No CRS Loaded";
  document.getElementById("crsPill").className = "pill warn";
  document.getElementById("crsSummaryText").innerHTML =
    "<strong>1. Load Departmental CRS File:</strong> Cached CRS cleared. Click <em>Load / Update CRS CSV</em> to select <code>CURRENT_ADVISING_CRS.csv</code>.";
  document.getElementById("searchInput").disabled = true;
  document.getElementById("studentSelect").disabled = true;
  document.getElementById("studentSelect").innerHTML = '<option value="">-- Load CRS CSV first --</option>';
}

// ---------------------------------------------------------------------------
// Fetch helper supporting deployed GitHub Pages (./py/...) and local dev (../...)
// ---------------------------------------------------------------------------
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
// Boot Pyodide + feccheck Python modules
// ---------------------------------------------------------------------------
async function initEngine() {
  const pill = document.getElementById("engineStatus");
  try {
    pill.textContent = "Starting Python (1/3)…";
    pyodide = await loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"
    });
    pill.textContent = "Loading pandas/numpy (2/3)…";
    await pyodide.loadPackage(["numpy", "pandas"]);

    pill.textContent = "Loading FECCheck rules (3/3)…";
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

    const metaJson = await pyodide.runPythonAsync(`advise_student.get_catalog_metadata()`);
    catalogMeta = JSON.parse(metaJson);
    populateCourseDatalist();

    pyodideReady = true;
    pill.textContent = "FECCheck Engine Ready ✓";
    pill.className = "pill ok";

    if (currentStudentIdx !== null) {
      await rerunAudit();
    }
  } catch (err) {
    console.error(err);
    pill.textContent = "Engine Error";
    pill.className = "pill err";
    showAuditError("Failed to initialise browser Python engine: " + err.message);
  }
}

function populateCourseDatalist() {
  if (!catalogMeta) return;
  const dl = document.getElementById("allCoursesDatalist");
  dl.innerHTML = "";
  for (const c of catalogMeta.courses) {
    const opt = document.createElement("option");
    opt.value = c.code;
    const title = courseTitlesMap[c.code] ? ` — ${courseTitlesMap[c.code]}` : "";
    opt.label = `${c.code} (${c.credits} cr)${title}`;
    dl.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Fast Local CRS CSV Splitting & Indexing
// ---------------------------------------------------------------------------
function parseCsvRow(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function indexCrsText(rawText, fileName, lastModifiedMs) {
  const lines = rawText.split(/\r?\n/);
  const students = [];
  const titles = {};
  let current = null;
  const cidRe = /^[A-Z]{6}[0-9]{3}$/;
  const courseRe = /^[A-Z]{3}[0-9]{4}[A-Z]$/;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const cleaned = rawLine.replace(/""(.*?)""/g, '"$1"').trim().replace(/;+$/, "").replace(/^"+|"+$/g, "");
    if (!cleaned) continue;
    const row = parseCsvRow(cleaned);

    if (row.length > 2 && cidRe.test((row[2] || "").trim())) {
      if (current) {
        if (!current.hasFooter) current.lines.push(",Passed:,,,,");
        students.push(current);
      }
      const surname = (row[0] || "").trim();
      const first = (row[1] || "").trim();
      const cid = (row[2] || "").trim().toUpperCase();
      const prog = (row[4] || "").trim().toUpperCase();
      current = {
        name: `${surname}, ${first}`,
        campusId: cid,
        program: prog,
        lines: [rawLine],
        hasFooter: false
      };
    } else if (current) {
      current.lines.push(rawLine);
      // Update latest programme code from yearly header rows if present
      if (/^[0-9]{4}$/.test((row[0] || "").trim()) && row[2]) {
        current.program = row[2].trim().toUpperCase();
      }
      // Harvest course titles cleanly
      for (let k = 0; k + 5 < row.length; k += 8) {
        const ccode = (row[k] || "").trim();
        const cname = (row[k + 2] || "").trim();
        if (courseRe.test(ccode) && cname && !titles[ccode]) {
          titles[ccode] = cname;
        }
      }
      if (rawLine.includes("Passed:")) {
        current.hasFooter = true;
        students.push(current);
        current = null;
      }
    }
  }
  if (current) {
    if (!current.hasFooter) current.lines.push(",Passed:,,,,");
    students.push(current);
  }

  parsedStudents = students.map((s) => ({
    name: s.name,
    campusId: s.campusId,
    program: s.program,
    rawBlock: s.lines.join("\n")
  }));
  courseTitlesMap = { ...courseTitlesMap, ...titles };
  populateCourseDatalist();

  const eeeCount = parsedStudents.filter((s) => EEE_PROGS.has(s.program)).length;
  const dateStr = lastModifiedMs
    ? new Date(lastModifiedMs).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })
    : "Unknown date";

  const pill = document.getElementById("crsPill");
  pill.textContent = `CRS: ${dateStr} (${eeeCount} EEE)`;
  pill.className = "pill ok";

  document.getElementById("crsSummaryText").innerHTML =
    `<strong>CRS Ready:</strong> <code>${escapeHtml(fileName)}</code> • File date: <strong>${dateStr}</strong> • ` +
    `<strong>${eeeCount}</strong> EEE students (${parsedStudents.length.toLocaleString()} total EBE records cached locally in browser).`;
  document.getElementById("clearCacheBtn").style.display = "inline-flex";

  const warnBanner = document.getElementById("crsWarningBanner");
  const upperName = fileName.toUpperCase();
  if (upperName.includes("GPA") || upperName.includes("POTS") || upperName.includes("SUPP") || eeeCount < 150) {
    warnBanner.style.display = "block";
    warnBanner.innerHTML =
      `<strong>Warning — Possible Partial or GPA File:</strong> <code>${escapeHtml(fileName)}</code> only contains ${eeeCount} EEE records. ` +
      `For advising, please select <code>CURRENT_ADVISING_CRS.csv</code> in <code>EE Department/FEC</code>.`;
  } else {
    warnBanner.style.display = "none";
  }

  document.getElementById("searchInput").disabled = false;
  document.getElementById("studentSelect").disabled = false;
  filterStudents();
}

function handleFilePicked(file) {
  if (!file) return;
  document.getElementById("crsPill").textContent = "Reading CRS…";
  const reader = new FileReader();
  reader.onload = async (e) => {
    const rawText = e.target.result;
    indexCrsText(rawText, file.name, file.lastModified);
    await saveCrsToIdb({
      rawText,
      fileName: file.name,
      lastModified: file.lastModified
    });
  };
  reader.readAsText(file, "ISO-8859-1");
}

function filterStudents() {
  const q = document.getElementById("searchInput").value.trim().toUpperCase();
  const eeeOnly = document.getElementById("eeeOnlyCheck").checked;
  const sel = document.getElementById("studentSelect");
  sel.innerHTML = '<option value="">-- Select student --</option>';

  const matches = [];
  for (let i = 0; i < parsedStudents.length; i++) {
    const s = parsedStudents[i];
    if (eeeOnly && !EEE_PROGS.has(s.program)) continue;
    if (!q || s.campusId.includes(q) || s.name.toUpperCase().includes(q)) {
      matches.push({ idx: i, s });
      if (matches.length >= 80) break;
    }
  }

  for (const m of matches) {
    const opt = document.createElement("option");
    opt.value = String(m.idx);
    opt.textContent = `${m.s.campusId} — ${m.s.name} (${m.s.program || "?"})`;
    sel.appendChild(opt);
  }

  if (q && matches.length === 1) {
    sel.value = String(matches[0].idx);
    onStudentSelected();
  }
}

async function onStudentSelected() {
  const val = document.getElementById("studentSelect").value;
  if (val === "") {
    currentStudentIdx = null;
    document.getElementById("workspaceArea").style.display = "none";
    return;
  }
  currentStudentIdx = Number(val);
  proposedSet = new Set();
  passOverrides = new Set();
  failOverrides = new Set();
  assumeAllPassed = false;
  document.getElementById("asProgramSelect").value = "";
  document.getElementById("asProgramSelect").disabled = false;
  document.getElementById("assumePassAllBtn").disabled = false;
  document.getElementById("resetSimBtn").disabled = false;
  updateAssumeBtnLabel();

  await rerunAudit(true);
}

// ---------------------------------------------------------------------------
// Run Deterministic FECCheck Audit in Pyodide
// ---------------------------------------------------------------------------
function showAuditError(msg) {
  const el = document.getElementById("auditErrorBanner");
  if (!msg) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.textContent = msg;
}

async function rerunAudit(autoSeedCourses = false) {
  if (currentStudentIdx === null) return;
  if (!pyodideReady) {
    showAuditError("Python engine is still finishing initial load — audit will run automatically in a moment…");
    return;
  }
  showAuditError("");

  const student = parsedStudents[currentStudentIdx];
  const asProg = document.getElementById("asProgramSelect").value || null;

  pyodide.globals.set("_js_req_json", JSON.stringify({
    excerpt: student.rawBlock,
    as_program: asProg,
    pass_courses: Array.from(passOverrides),
    fail_courses: Array.from(failOverrides),
    propose_courses: Array.from(proposedSet),
    course_titles: courseTitlesMap
  }));

  const resJson = await pyodide.runPythonAsync(`
import json as _json
_req = _json.loads(_js_req_json)
advise_student.run_browser_audit(
    _req["excerpt"],
    as_program=_req["as_program"],
    pass_courses=_req["pass_courses"],
    fail_courses=_req["fail_courses"],
    propose_courses=_req["propose_courses"],
    course_titles=_req["course_titles"],
)
`);
  const parsed = JSON.parse(resJson);
  if (parsed.error) {
    showAuditError(parsed.error);
    document.getElementById("workspaceArea").style.display = "none";
    return;
  }

  currentAuditPayload = parsed;
  document.getElementById("workspaceArea").style.display = "block";

  if (autoSeedCourses && proposedSet.size === 0) {
    // Do not auto-add clashes blindly, just render clean; advisor can click "Auto-Pick Eligible Cores"
  }

  renderStandingAndAudit();
  renderRegistrationTab();
  renderCertificate();
  renderAiTab();
}

function toggleAssumeAllCurrentPassed() {
  if (!currentAuditPayload) return;
  assumeAllPassed = !assumeAllPassed;
  passOverrides = new Set();
  failOverrides = new Set();
  if (assumeAllPassed) {
    for (const r of currentAuditPayload.audit.current_year_courses) {
      if (r.status !== "Passed" && r.status !== "Failed") {
        passOverrides.add(r.course);
      }
    }
  }
  updateAssumeBtnLabel();
  rerunAudit();
}

function updateAssumeBtnLabel() {
  const btn = document.getElementById("assumePassAllBtn");
  btn.classList.toggle("active-ovr", assumeAllPassed);
  btn.textContent = assumeAllPassed ? "✓ Assuming Pending/Current Passed" : "Assume Current/Pending Passed";
}

function toggleCourseOverride(code, mode) {
  assumeAllPassed = false;
  updateAssumeBtnLabel();
  if (mode === "pass") {
    failOverrides.delete(code);
    if (passOverrides.has(code)) passOverrides.delete(code);
    else passOverrides.add(code);
  } else if (mode === "fail") {
    passOverrides.delete(code);
    if (failOverrides.has(code)) failOverrides.delete(code);
    else failOverrides.add(code);
  }
  rerunAudit();
}

function resetOverrides() {
  passOverrides = new Set();
  failOverrides = new Set();
  assumeAllPassed = false;
  document.getElementById("asProgramSelect").value = "";
  updateAssumeBtnLabel();
  rerunAudit();
}

// ---------------------------------------------------------------------------
// Rendering Helpers
// ---------------------------------------------------------------------------
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

function renderStandingAndAudit() {
  const { audit } = currentAuditPayload;
  const p = audit.profile;
  const s = audit.standing;
  const c = audit.certification;

  const badgeCls = pcBadgeClass(s.fec_decision_pc);
  document.getElementById("standingHeader").innerHTML = `
    <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:0.5rem;">
      <div>
        <h2 style="margin:0;">${escapeHtml(p.name)} (<code>${escapeHtml(p.campus_id)}</code>)</h2>
        <div style="color:#475569; font-size:0.88rem;">
          <strong>${escapeHtml(p.program_code)}</strong> — ${escapeHtml(p.program_name)} •
          First EEE Reg: <strong>${p.first_eee_reg}</strong> (${escapeHtml(p.tfer_description)}) •
          EEE Duration: <strong>Year ${p.eedur}</strong> (N=${s.N}) • Strikes: <strong>${p.nstrikes}</strong>
        </div>
      </div>
      <div style="text-align:right;">
        <span class="badge ${badgeCls}" style="font-size:1rem; padding:0.35rem 0.75rem;">
          FECCheck: ${escapeHtml(s.fec_decision_pc)}
        </span>
        <div style="font-size:0.82rem; color:#475569; margin-top:0.2rem;">${escapeHtml(s.fec_decision_pmess || "Good standing")}</div>
      </div>
    </div>
  `;

  document.getElementById("standingStats").innerHTML = `
    <div class="stat-box">
      <div class="lbl">EEE Credits Earned</div>
      <div class="val">${s.totalcr} / ${s.rcurcr}</div>
      <div class="note">${Math.max(0, s.rcurcr - s.totalcr)} cr remaining</div>
    </div>
    <div class="stat-box">
      <div class="lbl">FEC GPA</div>
      <div class="val">${s.gpa.toFixed(2)}%</div>
      <div class="note">Rounded: ${s.gpa_rounded}%</div>
    </div>
    <div class="stat-box">
      <div class="lbl">Current Year Passed</div>
      <div class="val">${s.ccrp} cr</div>
      <div class="note">Prior year: ${s.lcrp} cr</div>
    </div>
    <div class="stat-box">
      <div class="lbl">N+1 Pace Target</div>
      <div class="val">${s.rem_years_np1 > 0 ? Math.ceil(s.np1crpy) + " cr/yr" : "Exceeded"}</div>
      <div class="note">${s.rem_years_np1} yr(s) left in N+1 (${s.N + 1} yrs)</div>
    </div>
    <div class="stat-box">
      <div class="lbl">N+2 Hard Limit Pace</div>
      <div class="val">${s.rem_years_np2 > 0 ? Math.ceil(s.np2crpy) + " cr/yr" : "At/Past Limit"}</div>
      <div class="note">${s.rem_years_np2} yr(s) left in N+2 (${s.N + 2} yrs)</div>
    </div>
  `;

  let banners = "";
  if (s.aa_course && s.aa_course !== "None") {
    banners += `<div class="banner warn"><strong>Additional Assessment Eligible:</strong> Student is blocked from graduating by a single failed exam course (<code>${escapeHtml(s.aa_course)}</code>). Flag for FEC Additional Assessment!</div>`;
  }
  banners += `<div class="banner info"><strong>Honours Status:</strong> ${escapeHtml(s.honours_eligibility)}</div>`;
  if (p.comments) {
    banners += `<div style="font-size:0.82rem; color:#475569; margin-top:0.35rem;"><strong>Spec &amp; Equivalencies Trace:</strong> ${escapeHtml(p.comments)}</div>`;
  }
  document.getElementById("honoursAndAaBanner").innerHTML = banners;

  // Current year courses with simulation buttons
  const currRows = audit.current_year_courses.map((r) => {
    const isP = passOverrides.has(r.course);
    const isF = failOverrides.has(r.course);
    const stCls = r.status === "Passed" ? "green" : (r.status === "Failed" ? "red" : "amber");
    return `<tr>
      <td><code>${escapeHtml(r.course)}</code></td>
      <td>${escapeHtml(r.title)}</td>
      <td>${r.cre}/${r.crt}</td>
      <td><code>${escapeHtml(r.perc || "-")}</code> (${escapeHtml(r.symbol || "-")})</td>
      <td><span class="badge ${stCls}">${escapeHtml(r.status)}</span></td>
      <td>
        <button class="secondary small ${isP ? "active-ovr" : ""}" onclick="toggleCourseOverride('${r.course}','pass')">Sim Pass</button>
        <button class="secondary small ${isF ? "active-ovr" : ""}" onclick="toggleCourseOverride('${r.course}','fail')">Sim Fail</button>
      </td>
    </tr>`;
  }).join("");
  document.getElementById("currentCoursesTable").innerHTML = `
    <table>
      <thead><tr><th>Course</th><th>Title</th><th>Cr</th><th>Mark (Sym)</th><th>Status (${p.current_year})</th><th>What-If Override</th></tr></thead>
      <tbody>${currRows || '<tr><td colspan="6">No courses in current year.</td></tr>'}</tbody>
    </table>
  `;

  // Scenarios
  const scenRows = audit.scenarios.map((sc) => `<tr>
    <td><strong>${escapeHtml(sc.scenario)}</strong><div style="font-size:0.76rem;color:#475569;">${escapeHtml(sc.conditions)}</div></td>
    <td><span class="badge ${pcBadgeClass(sc.pc)}">${escapeHtml(sc.pc)}</span></td>
    <td>${escapeHtml(sc.pmess || "-")}</td>
    <td>${sc.totalcr}</td>
    <td>${sc.ccrp}</td>
    <td>${sc.gpa.toFixed(2)}%</td>
  </tr>`).join("");
  document.getElementById("scenariosTable").innerHTML = `
    <table>
      <thead><tr><th>Scenario</th><th>Code</th><th>Reason / Trigger</th><th>Total Cr</th><th>Yr Cr</th><th>GPA</th></tr></thead>
      <tbody>${scenRows}</tbody>
    </table>
  `;

  // Degree audit checklist
  const outCores = c.outstanding_cores.map((x) =>
    `<li><code>${escapeHtml(x.code)}</code> — ${escapeHtml(x.title)} (${x.credits} cr) • <span style="color:#991b1b;">Outstanding</span> • Prereqs: <code>${escapeHtml(x.prereqs)}</code></li>`
  ).join("");
  const actCores = c.active_cores.map((x) =>
    `<li><code>${escapeHtml(x.code)}</code> — ${escapeHtml(x.title)} (${x.credits} cr) • <span style="color:#92400e;">${escapeHtml(x.status)}</span></li>`
  ).join("");
  const neHtml = c.necore.map((g) =>
    `<li><strong>${g.id}</strong> (${g.passed_count}/${g.required_count} required): <span class="badge ${g.satisfied ? "green" : "amber"}">${g.satisfied ? "Satisfied" : "Incomplete"}</span> — Passed: <code>${escapeHtml(g.evidence || "None")}</code> • Options: <code>${escapeHtml(g.options.join(", "))}</code></li>`
  ).join("");
  const ceHtml = c.cecore.map((g) =>
    `<li><strong>48-Credit Elective Basket</strong> (${g.earned_credits}/${g.required_credits} cr): <span class="badge ${g.satisfied ? "green" : "amber"}">${g.satisfied ? "Satisfied" : "Incomplete"}</span> — Earned from: <code>${escapeHtml(g.evidence || "None")}</code></li>`
  ).join("");

  document.getElementById("degreeAuditContent").innerHTML = `
    <p style="margin-top:0;"><strong>Core Courses Passed:</strong> ${c.core_passed_count} / ${c.core_total_count}</p>
    <h3>Outstanding Core Courses (${c.outstanding_cores.length})</h3>
    <ul>${outCores || "<li>None — all core courses passed or currently registered!</li>"}</ul>
    <h3>Currently Registered Unpassed Cores (${c.active_cores.length})</h3>
    <ul>${actCores || "<li>None</li>"}</ul>
    <h3>Specialist &amp; Credit Electives</h3>
    <ul>${neHtml}${ceHtml}</ul>
  `;
}

// ---------------------------------------------------------------------------
// Tab 2: Interactive SEAT Registration & Clash Builder
// ---------------------------------------------------------------------------
function toggleProposedCourse(code) {
  const c = code.trim().toUpperCase();
  if (!c) return;
  if (proposedSet.has(c)) proposedSet.delete(c);
  else proposedSet.add(c);
  rerunAudit();
}

function addCustomCourse() {
  const inp = document.getElementById("customCourseInput");
  const code = inp.value.trim().toUpperCase();
  if (!code) return;
  proposedSet.add(code);
  inp.value = "";
  rerunAudit();
}

function clearProposed() {
  proposedSet.clear();
  rerunAudit();
}

async function autoSelectEligibleCores() {
  if (!currentAuditPayload) return;
  // Temporarily test all candidate Core courses and keep those with prereqs met and no hard clashes
  const coreCodes = currentAuditPayload.candidates
    .filter((c) => c.category === "Core")
    .map((c) => c.code);

  const student = parsedStudents[currentStudentIdx];
  const asProg = document.getElementById("asProgramSelect").value || null;
  pyodide.globals.set("_js_req_json", JSON.stringify({
    excerpt: student.rawBlock,
    as_program: asProg,
    pass_courses: Array.from(passOverrides),
    fail_courses: Array.from(failOverrides),
    propose_courses: coreCodes,
    course_titles: courseTitlesMap
  }));

  const testJson = await pyodide.runPythonAsync(`
import json as _json
_req = _json.loads(_js_req_json)
advise_student.run_browser_audit(
    _req["excerpt"],
    as_program=_req["as_program"],
    pass_courses=_req["pass_courses"],
    fail_courses=_req["fail_courses"],
    propose_courses=_req["propose_courses"],
    course_titles=_req["course_titles"],
)
`);
  const res = JSON.parse(testJson);
  if (res.audit && res.audit.proposal_validation) {
    proposedSet.clear();
    let runningCr = 0;
    for (const chk of res.audit.proposal_validation.course_checks) {
      if (chk.prereqs_ok && !chk.already_satisfied && runningCr + chk.credits <= 156) {
        proposedSet.add(chk.course);
        runningCr += chk.credits;
      }
    }
  }
  await rerunAudit();
}

function renderRegistrationTab() {
  const { audit, candidates } = currentAuditPayload;
  const pv = audit.proposal_validation;
  const p = audit.profile;
  const s = audit.standing;

  // Candidate list (include any custom-added courses at top if not in candidates)
  const candCodes = new Set(candidates.map((c) => c.code));
  const extraItems = Array.from(proposedSet)
    .filter((code) => !candCodes.has(code))
    .map((code) => ({
      code,
      title: courseTitlesMap[code] || code,
      credits: (catalogMeta?.courses.find((x) => x.code === code)?.credits) ?? 16,
      category: "Custom Added",
      note: "Added manually"
    }));

  const allCands = [...extraItems, ...candidates];
  document.getElementById("candidateList").innerHTML = allCands.length
    ? allCands.map((item) => {
        const checked = proposedSet.has(item.code) ? "checked" : "";
        return `<label class="cand-item">
          <input type="checkbox" ${checked} onchange="toggleProposedCourse('${item.code}')" />
          <div>
            <div><span class="cand-code">${escapeHtml(item.code)}</span> — ${escapeHtml(item.title)} <strong>(${item.credits} cr)</strong></div>
            <div class="cand-meta">${escapeHtml(item.category)} • ${escapeHtml(item.note)}</div>
          </div>
        </label>`;
      }).join("")
    : `<div style="padding:0.75rem; color:#475569;">No outstanding degree courses remaining! Use "Add Any Course Code" below if needed.</div>`;

  // Credit load meter
  const contMin = p.aspect ? (p.eedur <= 1 ? 60 : 92) : (p.eedur <= 1 ? 96 : 112);
  const remToGrad = Math.max(0, s.rcurcr - s.totalcr);
  const effectiveMin = Math.min(contMin, remToGrad);
  let loadClass = "ok";
  let loadNote = `Meets standard annual continuation pace (>= ${effectiveMin} cr).`;
  if (pv.total_proposed_credits === 0) {
    loadClass = "info";
    loadNote = "Tick candidate courses on the left (or click Auto-Pick Eligible Cores) to validate a registration plan.";
  } else if (pv.total_proposed_credits > 160 || pv.s1_credits > 84 || pv.s2_credits > 84) {
    loadClass = "warn";
    loadNote = `High credit load (${pv.total_proposed_credits} cr total; S1=${pv.s1_credits}, S2=${pv.s2_credits}) — check whether HoD overload concession is required.`;
  } else if (pv.total_proposed_credits < effectiveMin) {
    loadClass = "warn";
    loadNote = `Below normal CONT annual threshold (${effectiveMin} cr) — verify reduced-load / readmission concession or final-year completion.`;
  }

  document.getElementById("creditMeterBox").innerHTML = `
    <div class="banner ${loadClass}">
      <strong>Proposed Load: ${pv.total_proposed_credits} credits</strong>
      (Sem 1: <strong>${pv.s1_credits} cr</strong> • Sem 2: <strong>${pv.s2_credits} cr</strong>) — ${escapeHtml(loadNote)}
    </div>
  `;

  // Course checks table
  if (!pv.course_checks.length) {
    document.getElementById("proposalChecksTable").innerHTML = "";
  } else {
    const rows = pv.course_checks.map((chk) => {
      const issues = [];
      if (!chk.prereqs_ok) issues.push(`<span class="badge red">Missing Prereq: ${escapeHtml(chk.missing_prereqs.join("; "))}</span>`);
      if (!chk.coreqs_ok) issues.push(`<span class="badge red">Missing Coreq: ${escapeHtml(chk.missing_coreqs.join("; "))}</span>`);
      for (const w of chk.warnings) {
        issues.push(`<span class="badge amber">${escapeHtml(w)}</span>`);
      }
      const statusHtml = issues.length ? issues.join("<br/>") : `<span class="badge green">Eligible ✓</span>`;
      return `<tr>
        <td><code>${escapeHtml(chk.course)}</code></td>
        <td>${escapeHtml(courseTitlesMap[chk.course] || chk.course)}</td>
        <td>${chk.credits}</td>
        <td>${statusHtml}</td>
        <td><button class="secondary small" onclick="toggleProposedCourse('${chk.course}')">Remove</button></td>
      </tr>`;
    }).join("");
    document.getElementById("proposalChecksTable").innerHTML = `
      <table>
        <thead><tr><th>Course</th><th>Title</th><th>Cr</th><th>Prerequisite / Corequisite / Handbook Check</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // Timetable Grids
  const tt = pv.timetable;
  let clashBanner = "";
  if (tt.hard_clashes && tt.hard_clashes.length) {
    const list = tt.hard_clashes.map((c) => `Sem ${c.semester} ${c.day} P${c.period} (${c.entries.join(" vs ")})`).join("; ");
    clashBanner += `<div class="banner err"><strong>HARD LECTURE CLASH (${tt.hard_clashes.length}):</strong> ${escapeHtml(list)} — Prohibited without concession!</div>`;
  } else if (pv.course_checks.length) {
    clashBanner += `<div class="banner ok"><strong>Zero Hard Lecture Clashes ✓</strong></div>`;
  }
  if (tt.soft_clashes && tt.soft_clashes.length) {
    const list = tt.soft_clashes.map((c) => `Sem ${c.semester} ${c.day} P${c.period} (${c.entries.join(" / ")})`).join("; ");
    clashBanner += `<div class="banner warn"><strong>Soft Practical/Tut Overlaps (<code>_P</code>):</strong> ${escapeHtml(list)} — Check alternate tut/lab afternoon allocation.</div>`;
  }
  if (tt.unlisted_courses && tt.unlisted_courses.length) {
    clashBanner += `<div class="banner info"><strong>External / Unlisted Timetable Courses:</strong> <code>${escapeHtml(tt.unlisted_courses.join(", "))}</code> — Verify slot manually on UCT timetable.</div>`;
  }
  document.getElementById("clashSummaryBanner").innerHTML = clashBanner;

  document.getElementById("ttSem1").innerHTML = buildTimetableHtml(1, tt);
  document.getElementById("ttSem2").innerHTML = buildTimetableHtml(2, tt);
}

function buildTimetableHtml(semNum, tt) {
  if (!catalogMeta) return "";
  const days = catalogMeta.day_labels;
  const periods = catalogMeta.period_labels;
  const slotMap = {};
  for (const sl of (tt.schedule_slots || [])) {
    if (sl.semester !== semNum) continue;
    const key = `${sl.period}_${sl.day}`;
    if (!slotMap[key]) slotMap[key] = [];
    slotMap[key].push(sl.entry);
  }
  const hardSet = new Set((tt.hard_clashes || []).filter((c) => c.semester === semNum).map((c) => `${c.period}_${c.day}`));
  const softSet = new Set((tt.soft_clashes || []).filter((c) => c.semester === semNum).map((c) => `${c.period}_${c.day}`));

  const rows = periods.map(([pLbl, pTime]) => {
    const cells = days.map((d) => {
      const key = `${pLbl}_${d}`;
      const entries = slotMap[key] || [];
      let cls = "";
      if (hardSet.has(key)) cls = "tt-cell-hard";
      else if (softSet.has(key)) cls = "tt-cell-soft";
      else if (entries.length) cls = "tt-cell-ok";
      return `<td class="${cls}">${entries.map(escapeHtml).join("<br/>")}</td>`;
    }).join("");
    return `<tr><th>P${pLbl} <span style="font-weight:400;color:#475569;">(${pTime})</span></th>${cells}</tr>`;
  }).join("");

  return `<table class="tt-grid">
    <thead><tr><th>Period</th>${days.map((d) => `<th>${d}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// Tab 3: PeopleSoft Provisional Registration Certificate & Concessions
// ---------------------------------------------------------------------------
function collectConcessions(audit) {
  const pv = audit.proposal_validation;
  const s = audit.standing;
  const concessions = [];

  if (["RENN", "FECR"].includes(s.fec_decision_pc)) {
    concessions.push(`Readmission / RAC Progression Clearance Required (Current FECCheck code: ${s.fec_decision_pc} — ${s.fec_decision_pmess})`);
  } else if (["SUPP", "FECP"].includes(s.fec_decision_pc)) {
    concessions.push(`Provisional pending Supplementary/DE exam results (Current FECCheck code: ${s.fec_decision_pc})`);
  }

  for (const chk of pv.course_checks) {
    if (!chk.prereqs_ok) {
      concessions.push(`Prerequisite Concession for ${chk.course}: missing ${chk.missing_prereqs.join(", ")}`);
    }
    if (!chk.coreqs_ok) {
      concessions.push(`Corequisite Concession for ${chk.course}: missing ${chk.missing_coreqs.join(", ")}`);
    }
    for (const w of chk.warnings) {
      if (w.includes("EEE4022")) {
        concessions.push(`HoD Capstone Concession (${chk.course}): ${w}`);
      }
    }
  }

  if (pv.timetable.hard_clashes && pv.timetable.hard_clashes.length) {
    for (const c of pv.timetable.hard_clashes) {
      concessions.push(`Timetable Clash Concession: Sem ${c.semester} ${c.day} Period ${c.period} (${c.entries.join(" vs ")})`);
    }
  }
  if (pv.total_proposed_credits > 160) {
    concessions.push(`Curriculum Overload Concession: ${pv.total_proposed_credits} annual credits (> 160 cr)`);
  }
  return concessions;
}

function saveAdvisorMeta() {
  try {
    localStorage.setItem("uct_eee_advisor_name", document.getElementById("advisorName").value);
    localStorage.setItem("uct_eee_advisor_email", document.getElementById("advisorEmail").value);
  } catch (_) {}
}

function loadAdvisorMeta() {
  try {
    document.getElementById("advisorName").value = localStorage.getItem("uct_eee_advisor_name") || "";
    document.getElementById("advisorEmail").value = localStorage.getItem("uct_eee_advisor_email") || "";
  } catch (_) {}
}

function renderCertificate() {
  if (!currentAuditPayload) return;
  const { audit } = currentAuditPayload;
  const p = audit.profile;
  const s = audit.standing;
  const pv = audit.proposal_validation;

  const advName = document.getElementById("advisorName").value.trim() || "[Advisor Name]";
  const advEmail = document.getElementById("advisorEmail").value.trim() || "[Advisor Email]";
  const regYear = document.getElementById("regYearSelect").value;
  const notes = document.getElementById("advisorNotes").value.trim();
  const concessions = collectConcessions(audit);
  const nowStr = new Date().toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });

  const isClean = concessions.length === 0 && pv.course_checks.length > 0;
  const simNote = (passOverrides.size || failOverrides.size)
    ? ` (Simulated What-If overrides active — Pass: ${Array.from(passOverrides).join(", ") || "none"}; Fail: ${Array.from(failOverrides).join(", ") || "none"})`
    : "";

  const courseRows = pv.course_checks.map((chk) => {
    const sem = chk.course.endsWith("F") ? "Sem 1 (F)" : (chk.course.endsWith("S") || chk.course.endsWith("C") ? "Sem 2 (S/C)" : "Year/Prac");
    const status = (chk.prereqs_ok && chk.coreqs_ok) ? "Met ✓" : "Concession Required";
    return `<tr>
      <td><code>${escapeHtml(chk.course)}</code></td>
      <td>${escapeHtml(courseTitlesMap[chk.course] || chk.course)}</td>
      <td>${sem}</td>
      <td>${chk.credits}</td>
      <td>${status}</td>
    </tr>`;
  }).join("");

  document.getElementById("certificatePreview").innerHTML = `
    <div class="cert-header">
      <div>
        <h2>UCT Department of Electrical Engineering</h2>
        <div style="font-weight:600; margin-top:0.15rem;">UNSEAT Provisional Curriculum &amp; Advising Verification (${escapeHtml(regYear)} Registration)</div>
        <div style="font-size:0.8rem; color:#475569;">Undergraduate Student Enrolment &amp; Advising Tool — PeopleSoft registration / concession attachment</div>
      </div>
      <div style="text-align:right; font-size:0.82rem;">
        <div><strong>Date:</strong> ${escapeHtml(nowStr)}</div>
        <div><strong>Status:</strong> ${isClean ? '<span class="badge green">STANDARD / CLEAN</span>' : '<span class="badge amber">PROVISIONAL / CONCESSION</span>'}</div>
      </div>
    </div>

    <table>
      <tbody>
        <tr>
          <th>Student Name</th><td><strong>${escapeHtml(p.name)}</strong></td>
          <th>Campus ID</th><td><code>${escapeHtml(p.campus_id)}</code></td>
        </tr>
        <tr>
          <th>Programme</th><td>${escapeHtml(p.program_code)} — ${escapeHtml(p.program_name)}</td>
          <th>First EEE Reg / Dur</th><td>${p.first_eee_reg} (Year ${p.eedur} of N=${s.N})</td>
        </tr>
        <tr>
          <th>FECCheck Standing</th><td><strong>${escapeHtml(s.fec_decision_pc)}</strong> (${escapeHtml(s.fec_decision_pmess || "Good standing")})${escapeHtml(simNote)}</td>
          <th>Credits &amp; GPA</th><td>${s.totalcr} / ${s.rcurcr} cr • GPA ${s.gpa.toFixed(2)}%</td>
        </tr>
      </tbody>
    </table>

    <h3>Approved / Proposed ${escapeHtml(regYear)} Courses (${pv.total_proposed_credits} Credits: S1=${pv.s1_credits}, S2=${pv.s2_credits})</h3>
    <table>
      <thead><tr><th>Course Code</th><th>Course Title</th><th>Term</th><th>Credits</th><th>Rule Check</th></tr></thead>
      <tbody>${courseRows || '<tr><td colspan="5"><em>No proposed courses selected yet — tick courses in Tab 2.</em></td></tr>'}</tbody>
    </table>

    <h3>Timetable &amp; Concession Check</h3>
    <ul>
      <li><strong>Hard Lecture Clashes:</strong> ${(pv.timetable.hard_clashes?.length || 0) === 0 ? "None (0 hard clashes)" : pv.timetable.hard_clashes.length + " hard clash(es) — see below"}</li>
      <li><strong>Soft Practical/Tut Overlaps (<code>_P</code>):</strong> ${(pv.timetable.soft_clashes?.length || 0) === 0 ? "None" : pv.timetable.soft_clashes.map((c) => `Sem ${c.semester} ${c.day} P${c.period} (${c.entries.join("/")})`).join("; ")}</li>
      ${concessions.length
        ? concessions.map((c) => `<li style="color:#991b1b;"><strong>Flag / Concession:</strong> ${escapeHtml(c)}</li>`).join("")
        : `<li style="color:#166534;"><strong>No Curriculum Concessions Triggered:</strong> Eligible for standard PeopleSoft / programme enrolment.</li>`}
    </ul>

    ${notes ? `<h3>Advisor Notes / Concession Motivation</h3><div style="border:1px solid #cbd5e1; padding:0.65rem; border-radius:6px; white-space:pre-wrap;">${escapeHtml(notes)}</div>` : ""}

    <div class="sign-grid">
      <div>
        <div><strong>Academic Advisor:</strong> ${escapeHtml(advName)}</div>
        <div><strong>Email:</strong> ${escapeHtml(advEmail)}</div>
      </div>
      <div>
        <div><strong>Advisor Signature / PeopleSoft Certification:</strong></div>
        <div style="margin-top:1.3rem; border-bottom:1px solid #334155; width:85%;"></div>
      </div>
    </div>
  `;
}

async function copyCertificateText() {
  if (!currentAuditPayload) return;
  const { audit } = currentAuditPayload;
  const p = audit.profile;
  const s = audit.standing;
  const pv = audit.proposal_validation;
  const advName = document.getElementById("advisorName").value.trim() || "[Advisor]";
  const regYear = document.getElementById("regYearSelect").value;
  const notes = document.getElementById("advisorNotes").value.trim();
  const concessions = collectConcessions(audit);

  const lines = [
    `UCT EEE PROVISIONAL REGISTRATION SUMMARY — UNSEAT (${regYear})`,
    `Student: ${p.name} (${p.campus_id}) | Programme: ${p.program_code} | Entry: ${p.first_eee_reg}`,
    `FECCheck Standing: ${s.fec_decision_pc} | EEE Credits: ${s.totalcr}/${s.rcurcr} | GPA: ${s.gpa.toFixed(2)}%`,
    ``,
    `Proposed ${regYear} Courses (${pv.total_proposed_credits} cr: S1=${pv.s1_credits}, S2=${pv.s2_credits}):`,
    ...pv.course_checks.map((c) => `  - ${c.course} (${c.credits} cr): ${c.prereqs_ok && c.coreqs_ok ? "OK" : "CONCESSION NEEDED"}`),
    ``,
    `Concessions / Flags:`,
    ...(concessions.length ? concessions.map((x) => `  * ${x}`) : [`  * None — standard registration eligible.`]),
    ...(notes ? [``, `Advisor Notes: ${notes}`] : []),
    ``,
    `Certified by Advisor: ${advName} (${new Date().toISOString().slice(0, 10)})`
  ];
  await navigator.clipboard.writeText(lines.join("\n"));
  const st = document.getElementById("certCopyStatus");
  st.textContent = "Copied summary to clipboard!";
  setTimeout(() => { st.textContent = ""; }, 3000);
}

// ---------------------------------------------------------------------------
// Tab 4: Free AI Handoff (Prompt + Anonymised Deterministic Audit)
// ---------------------------------------------------------------------------
function renderAiTab() {
  if (!currentAuditPayload) return;
  document.getElementById("aiAnonPreview").textContent = currentAuditPayload.anonymized_markdown;
}

async function copyAiBundle() {
  if (!currentAuditPayload) return;
  const st = document.getElementById("aiCopyStatus");
  st.textContent = "Preparing prompt…";
  try {
    if (!staffPromptCache) {
      staffPromptCache = await fetchWithFallback([
        "./py/uct_ee_staffadvisor.md",
        "../uct_ee_staffadvisor.md",
        "https://raw.githubusercontent.com/UCT-EEE-department/feccheck/main/uct_ee_staffadvisor.md"
      ]);
    }
    const extraQ = document.getElementById("aiQuestionInput").value.trim();
    const payload = [
      staffPromptCache,
      "\n---\n",
      "Below is the EXACT deterministic FECCheck & 2026 Timetable/Prerequisite audit already computed by `feccheck` (student identity redacted for POPIA). Do NOT recalculate credits from scratch—use these verified figures to advise the staff member:\n",
      currentAuditPayload.anonymized_markdown,
      extraQ ? `\n---\n**Specific Advisor Request:** ${extraQ}` : "\n---\nPlease provide concise registration & FEC advising recommendations and flag any required concessions."
    ].join("\n");

    await navigator.clipboard.writeText(payload);
    st.textContent = "Copied! Click any AI button below and paste (Ctrl+V / Cmd+V).";
  } catch (err) {
    st.textContent = "Copy failed: " + err.message;
  }
}

// ---------------------------------------------------------------------------
// Tab Navigation & Page Init
// ---------------------------------------------------------------------------
function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === tabId));
}

window.addEventListener("DOMContentLoaded", async () => {
  loadAdvisorMeta();
  initEngine();
  const cached = await loadCrsFromIdb();
  if (cached && cached.rawText) {
    indexCrsText(cached.rawText, cached.fileName || "CURRENT_ADVISING_CRS.csv", cached.lastModified);
  }
});
