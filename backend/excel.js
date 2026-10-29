// Keeps an Excel workbook up to date with the validations, for the manager to review.
//
//   Sheet "Validation History":      one row per validation (appended, never rewritten)
//   Sheet "PkgTesting_Utility_Log":  one row per user + package (count and date updated in place)
//
// db.json stays the source of truth. Each record carries a "synced" marker, so a row is added to
// Excel once: rows or columns the manager deletes or adds are left alone. If the file can't be
// written (for example it is open in Excel), nothing is lost: the next sync adds what is missing.

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { getExcelPending, markExcelSynced, dataDir } = require("./store");

const HISTORY_SHEET = "Validation History";
const LOG_SHEET = "PkgTesting_Utility_Log";

const HISTORY_COLUMNS = [
  { header: "#", width: 7 },
  { header: "User", width: 22 },
  { header: "Case Number", width: 14 },
  { header: "Date", width: 20 },
  { header: "Package", width: 34 },
  { header: "Status", width: 10 },
  { header: "Errors", width: 50 },
  { header: "Warnings", width: 50 },
  { header: "Warnings Acknowledged", width: 22 },
  { header: "Description", width: 50 },
];
const ACK_COLUMN = 9;

const LOG_COLUMNS = [
  { header: "User Name", width: 24 },
  { header: "Package Name", width: 36 },
  { header: "Total Validations", width: 18 },
  { header: "Date of Package Testing", width: 24 },
];

const DATE_FORMAT = "yyyy-mm-dd hh:mm";

const excelFile = () => process.env.EXCEL_FILE || path.join(dataDir(), "PkgTesting_Utility_Log.xlsx");

// Excel has no time zones, and ExcelJS writes the UTC clock time. Shift so the sheet shows local time.
const localDate = (iso) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000);
};

const caseCell = (value) => (/^\d{1,15}$/.test(value) ? Number(value) : value || null);
const lines = (items) => (items && items.length ? items.join("\n") : null);

const status = { file: null, lastSyncAt: null, lastError: null };
let queue = Promise.resolve();

function openSheet(workbook, name, columns, { filter = false } = {}) {
  let sheet = workbook.getWorksheet(name);
  if (sheet) return sheet;

  sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map(({ header, width }) => ({ header, width }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
  header.alignment = { vertical: "middle" };
  if (filter) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

const wrap = (cell) => {
  cell.alignment = { wrapText: true, vertical: "top" };
};

/** Row number for each validation id already on the sheet. */
function historyRowsById(sheet) {
  const rows = new Map();
  for (let n = 2; n <= sheet.rowCount; n++) {
    const id = Number(sheet.getRow(n).getCell(1).value);
    if (Number.isInteger(id)) rows.set(id, n);
  }
  return rows;
}

/** Row number for each user|package already on the sheet. */
function logRowsByKey(sheet) {
  const rows = new Map();
  for (let n = 2; n <= sheet.rowCount; n++) {
    const row = sheet.getRow(n);
    const user = row.getCell(1).value;
    const pkg = row.getCell(2).value;
    if (user && pkg) rows.set(`${user}|${pkg}`.toLowerCase(), n);
  }
  return rows;
}

function describeError(err) {
  if (["EBUSY", "EPERM", "EACCES"].includes(err.code)) {
    return (
      "The Excel file could not be updated, probably because it is open in Excel. " +
      "Close it; the missing rows will be added at the next validation."
    );
  }
  return "The Excel file could not be updated: " + err.message;
}

async function writeWorkbook(workbook, file) {
  const tmp = file + ".tmp";
  try {
    await workbook.xlsx.writeFile(tmp);
    fs.renameSync(tmp, file); // fails if Excel has the file open, leaving the real file untouched
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

async function doSync() {
  const file = excelFile();
  status.file = file;

  try {
    const pending = getExcelPending();
    if (!pending.history.length && !pending.acks.length && !pending.log.length) {
      status.lastError = null;
      return status;
    }

    const workbook = new ExcelJS.Workbook();
    // A file that can't be read (corrupt, or not a workbook) is never overwritten.
    if (fs.existsSync(file)) await workbook.xlsx.readFile(file);
    else fs.mkdirSync(path.dirname(file), { recursive: true });

    const history = openSheet(workbook, HISTORY_SHEET, HISTORY_COLUMNS, { filter: true });
    const log = openSheet(workbook, LOG_SHEET, LOG_COLUMNS);
    const done = { history: [], acks: [], log: {} };

    for (const r of pending.history) {
      const row = history.addRow([
        r.id,
        r.username,
        caseCell(r.caseNumber),
        localDate(r.validatedAt),
        r.fileName,
        r.status,
        lines(r.errors),
        lines(r.warnings),
        r.acknowledgedAt ? localDate(r.acknowledgedAt) : null,
        r.description || null,
      ]);
      row.getCell(3).numFmt = "0";
      row.getCell(3).alignment = { horizontal: "left", vertical: "top" };
      row.getCell(4).numFmt = DATE_FORMAT;
      row.getCell(ACK_COLUMN).numFmt = DATE_FORMAT;
      row.getCell(6).font = { bold: true, color: { argb: r.status === "Passed" ? "FF166534" : "FF991B1B" } };
      [5, 7, 8, 10].forEach((c) => wrap(row.getCell(c)));
      done.history.push({ id: r.id, acked: Boolean(r.acknowledgedAt) });
    }

    if (pending.acks.length) {
      const rowsById = historyRowsById(history);
      for (const r of pending.acks) {
        const n = rowsById.get(r.id);
        if (n) {
          const cell = history.getRow(n).getCell(ACK_COLUMN);
          cell.value = localDate(r.acknowledgedAt);
          cell.numFmt = DATE_FORMAT;
        } // else the manager deleted the row: nothing to update
        done.acks.push(r.id);
      }
    }

    if (pending.log.length) {
      const rowsByKey = logRowsByKey(log);
      for (const entry of pending.log) {
        const n = rowsByKey.get(`${entry.UserName}|${entry.PkgName}`.toLowerCase());
        const row = n ? log.getRow(n) : log.addRow([entry.UserName, entry.PkgName]);
        row.getCell(3).value = entry.TotalValidations;
        row.getCell(4).value = localDate(entry.TestDate);
        row.getCell(4).numFmt = DATE_FORMAT;
        done.log[entry.key] = entry.TotalValidations;
      }
    }

    await writeWorkbook(workbook, file);
    markExcelSynced(done);
    status.lastSyncAt = new Date().toISOString();
    status.lastError = null;
  } catch (err) {
    console.error("Excel update failed:", err.message);
    status.lastError = describeError(err);
  }
  return status;
}

/**
 * Brings the Excel file up to date. Calls are queued so two validations at the same moment
 * never write the file at the same time. Never rejects: a failure is kept in getStatus().
 */
function syncExcel() {
  const run = queue.then(doSync);
  queue = run.catch(() => {});
  return run.catch(() => status);
}

const getStatus = () => ({ ...status, file: excelFile() });

module.exports = { syncExcel, getStatus, HISTORY_SHEET, LOG_SHEET };
