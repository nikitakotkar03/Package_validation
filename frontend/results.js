const latestEl = document.getElementById("latest");
const userFilter = document.getElementById("user-filter");
const historyBody = document.getElementById("history-body");
const historyCount = document.getElementById("history-count");
const logBody = document.getElementById("log-body");
const logCount = document.getElementById("log-count");

const tabs = {
  history: { tab: document.getElementById("tab-history"), panel: document.getElementById("panel-history") },
  log: { tab: document.getElementById("tab-log"), panel: document.getElementById("panel-log") },
};

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error((await response.json()).message || "Request failed.");
  return response.json();
}

const formatDate = (iso) => new Date(iso).toLocaleString();

// Builds a row using textContent only, so stored values can't inject HTML.
function addRow(tbody, cells) {
  const tr = document.createElement("tr");
  for (const cell of cells) {
    const td = document.createElement("td");
    if (cell instanceof Node) td.appendChild(cell);
    else td.textContent = cell;
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

function emptyRow(tbody, colSpan, text) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colSpan;
  td.className = "empty";
  td.textContent = text;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function statusBadge(status) {
  const span = document.createElement("span");
  span.className = "badge " + (status === "Passed" ? "pass" : "fail");
  span.textContent = status;
  return span;
}

function errorList(errors) {
  if (!errors.length) return "—";
  const ul = document.createElement("ul");
  ul.className = "error-list";
  for (const message of errors) {
    const li = document.createElement("li");
    li.textContent = message;
    ul.appendChild(li);
  }
  return ul;
}

function warningList(record) {
  const warnings = record.warnings || [];
  if (!warnings.length) return "—";

  const wrapper = document.createElement("div");
  wrapper.appendChild(errorList(warnings));
  const ack = document.createElement("small");
  ack.className = record.acknowledgedAt ? "ack" : "no-ack";
  ack.textContent = record.acknowledgedAt
    ? "Acknowledged " + formatDate(record.acknowledgedAt)
    : "Not acknowledged";
  wrapper.appendChild(ack);
  return wrapper;
}

function showLatest(record) {
  latestEl.hidden = false;
  latestEl.className = "result " + (record.status === "Passed" ? "success" : "failure");
  latestEl.replaceChildren();

  const title = document.createElement("strong");
  title.textContent =
    `${record.fileName}${record.caseNumber ? ` (case #${record.caseNumber})` : ""} — ${record.status === "Passed" ? "passed validation" : "failed validation"}`;
  latestEl.appendChild(title);

  if (record.errors.length) latestEl.appendChild(errorList(record.errors));
  if ((record.warnings || []).length) {
    const heading = document.createElement("div");
    heading.className = "latest-warnings";
    heading.textContent = "Warnings:";
    latestEl.appendChild(heading);
    latestEl.appendChild(warningList(record));
  }
}

let historyRows = [];

// Fills the user dropdown with each distinct user in the history (names compared ignoring case).
function fillUserFilter() {
  const selected = userFilter.value;
  const seen = new Map();
  for (const r of historyRows) {
    const key = r.username.toLowerCase();
    if (!seen.has(key)) seen.set(key, r.username);
  }
  userFilter.replaceChildren(new Option("All users", ""));
  for (const name of [...seen.values()].sort((a, b) => a.localeCompare(b))) {
    userFilter.appendChild(new Option(name, name));
  }
  userFilter.value = selected;
}

async function loadHistory() {
  historyRows = await getJson("/api/history");
  fillUserFilter();
  renderHistory();
}

function renderHistory() {
  const username = userFilter.value.toLowerCase();
  const rows = username ? historyRows.filter((r) => r.username.toLowerCase() === username) : historyRows;

  historyBody.replaceChildren();
  historyCount.textContent = `${rows.length} validation${rows.length === 1 ? "" : "s"}`;
  if (!rows.length) return emptyRow(historyBody, 8, "No validations yet.");

  for (const r of rows) {
    addRow(historyBody, [
      String(r.id), r.username, r.caseNumber ? "#" + r.caseNumber : "—", formatDate(r.validatedAt),
      r.fileName, statusBadge(r.status), errorList(r.errors), warningList(r),
    ]);
  }
}

async function loadLog() {
  const rows = await getJson("/api/pkg-testing-log");

  logBody.replaceChildren();
  logCount.textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  if (!rows.length) return emptyRow(logBody, 4, "No packages tested yet.");
  for (const r of rows) {
    addRow(logBody, [r.UserName, r.PkgName, String(r.TotalValidations), formatDate(r.TestDate)]);
  }
}

function selectTab(name) {
  for (const [key, { tab, panel }] of Object.entries(tabs)) {
    const active = key === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    panel.hidden = !active;
  }
}

tabs.history.tab.addEventListener("click", () => selectTab("history"));
tabs.log.tab.addEventListener("click", () => selectTab("log"));
userFilter.addEventListener("change", renderHistory);

function showLoadError(err) {
  latestEl.hidden = false;
  latestEl.className = "result failure";
  latestEl.textContent = "Could not load data: " + err.message;
}

// The Excel file updates in the background, so check once now and again shortly after.
async function checkExcel() {
  const note = document.getElementById("excel-note");
  try {
    const { lastError } = await getJson("/api/excel-status");
    note.hidden = !lastError;
    note.textContent = lastError || "";
  } catch (err) {
    note.hidden = true; // the status is only a courtesy; the tabs below still work
  }
}

async function init() {
  setTimeout(checkExcel, 1500);
  const id = new URLSearchParams(location.search).get("id");
  if (id) {
    try {
      showLatest(await getJson("/api/history/" + encodeURIComponent(id)));
    } catch (err) {
      showLoadError(err);
    }
  }
  try {
    await loadHistory();
    await loadLog();
  } catch (err) {
    showLoadError(err);
  }
}

init();
