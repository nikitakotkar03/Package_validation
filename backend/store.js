const fs = require("fs");
const path = require("path");

// Read lazily so tests can point DATA_FILE at a temp file.
const dataFile = () => process.env.DATA_FILE || path.join(__dirname, "..", "data", "db.json");

function load() {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(dataFile(), "utf8"));
  } catch (err) {
    // A missing file just means nothing has been recorded yet. Anything else
    // (e.g. corrupt JSON) must surface rather than be overwritten with an empty db.
    if (err.code !== "ENOENT") throw err;
    db = {};
  }
  // Fill in collections that older data files don't have yet.
  db.history = db.history || [];
  db.users = db.users || {};
  db.PkgTesting_Utility_Log = db.PkgTesting_Utility_Log || {};
  return db;
}

function save(db) {
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Appends one history row, creates/updates the user's single summary row, and
 * updates the PkgTesting_Utility_Log row for this user + package.
 * @param {{username: string, caseNumber: string, description: string, fileName: string, errors: string[], warnings?: string[]}} entry
 */
function recordValidation(entry) {
  const db = load();
  const now = new Date().toISOString();
  const username = entry.username.trim();
  const key = username.toLowerCase();

  const record = {
    id: db.history.reduce((max, r) => Math.max(max, r.id), 0) + 1,
    username,
    caseNumber: entry.caseNumber.trim().replace(/^#/, ""),
    description: entry.description.trim(),
    fileName: entry.fileName,
    validatedAt: now,
    status: entry.errors.length === 0 ? "Passed" : "Failed",
    errors: entry.errors,
    warnings: entry.warnings || [],
    acknowledgedAt: null,
    excelSynced: false, // row has been added to the Excel file
    excelAckSynced: false, // the acknowledgement time has been written to that row
  };
  db.history.push(record);

  const user = db.users[key] || { username, firstSeen: now, totalValidations: 0 };
  user.lastSeen = now;
  user.totalValidations += 1;
  db.users[key] = user;

  // One row per user + package; the count is how many times that user validated that package.
  const logKey = `${key}|${entry.fileName.toLowerCase()}`;
  const log = db.PkgTesting_Utility_Log[logKey] || {
    UserName: username,
    PkgName: entry.fileName,
    TotalValidations: 0,
  };
  log.TotalValidations += 1;
  log.TestDate = now;
  db.PkgTesting_Utility_Log[logKey] = log;

  save(db);
  return record;
}

/** Marks a record's warnings as acknowledged. Returns the record, or null if it doesn't exist. */
function acknowledge(id) {
  const db = load();
  const record = db.history.find((r) => r.id === id);
  if (!record) return null;
  if (!record.acknowledgedAt) {
    record.acknowledgedAt = new Date().toISOString();
    save(db);
  }
  return record;
}

/** History rows, newest first, optionally limited to one user (case-insensitive). */
function listHistory(username) {
  const rows = load().history;
  const filtered = username
    ? rows.filter((r) => r.username.toLowerCase() === username.trim().toLowerCase())
    : rows;
  return filtered.slice().reverse();
}

function getHistoryRecord(id) {
  return load().history.find((r) => r.id === id) || null;
}

/** One row per user, most recently active first, with the package they tested last. */
function listUsers() {
  const db = load();
  return Object.entries(db.users)
    .map(([key, user]) => {
      // History is in id order, so the last match is the user's latest test.
      const latest = db.history.filter((r) => r.username.toLowerCase() === key).pop();
      return {
        ...user,
        packageName: latest ? latest.fileName : null,
        testDate: latest ? latest.validatedAt : null,
      };
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** PkgTesting_Utility_Log rows, most recently tested first. */
function listPkgTestingLog() {
  return Object.values(load().PkgTesting_Utility_Log).sort((a, b) => b.TestDate.localeCompare(a.TestDate));
}

/**
 * What the Excel file is missing, so a failed or skipped update is simply retried next time:
 *  - history: validations not yet added as a row (this also covers records saved before Excel existed)
 *  - acks: rows already in Excel whose acknowledgement time hasn't been written
 *  - log: user+package entries whose validation count differs from what Excel last received
 */
function getExcelPending() {
  const db = load();
  return {
    history: db.history.filter((r) => !r.excelSynced),
    acks: db.history.filter((r) => r.excelSynced && r.acknowledgedAt && !r.excelAckSynced),
    log: Object.entries(db.PkgTesting_Utility_Log)
      .filter(([, entry]) => entry.TotalValidations !== (entry.excelSyncedCount || 0))
      .map(([key, entry]) => ({ key, ...entry })),
  };
}

/**
 * Records what was written to Excel. Reads the file fresh, so anything saved while the Excel
 * write was running (a newer validation or acknowledgement) is left pending.
 * @param {{history?: {id: number, acked: boolean}[], acks?: number[], log?: Record<string, number>}} done
 */
function markExcelSynced({ history = [], acks = [], log = {} }) {
  const db = load();
  for (const { id, acked } of history) {
    const record = db.history.find((r) => r.id === id);
    if (record) {
      record.excelSynced = true;
      record.excelAckSynced = acked;
    }
  }
  for (const id of acks) {
    const record = db.history.find((r) => r.id === id);
    if (record) record.excelAckSynced = true;
  }
  for (const [key, count] of Object.entries(log)) {
    if (db.PkgTesting_Utility_Log[key]) db.PkgTesting_Utility_Log[key].excelSyncedCount = count;
  }
  save(db);
}

/** Folder holding db.json; the Excel file lives next to it unless EXCEL_FILE says otherwise. */
const dataDir = () => path.dirname(dataFile());

module.exports = {
  recordValidation,
  acknowledge,
  listHistory,
  getHistoryRecord,
  listUsers,
  listPkgTestingLog,
  getExcelPending,
  markExcelSynced,
  dataDir,
};
