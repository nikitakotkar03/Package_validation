const path = require("path");
const express = require("express");
const multer = require("multer");
const { resolveDetails, validateInput, checkPackage } = require("./verify");
const { parseNotes } = require("./notes");
const { syncExcel, getStatus: getExcelStatus } = require("./excel");
const { analyzeSql } = require("./sqlcheck");
const {
  recordValidation,
  acknowledge,
  listHistory,
  getHistoryRecord,
  listUsers,
  listPkgTestingLog,
} = require("./store");

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

const app = express();

// Serve the front-end from the same origin so no CORS setup is needed.
app.use(express.static(path.join(__dirname, "..", "frontend")));

app.post("/api/verify", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_SIZE" ? "File is larger than 5 MB." : err.message;
      return res.status(400).json({ valid: false, message });
    }
    if (err) {
      return res.status(500).json({ valid: false, message: "Upload failed." });
    }

    // Form values win; anything left blank is read from the package's //NOTES section.
    const text = req.file ? req.file.buffer.toString("utf8") : "";
    const details = resolveDetails(req.body, text);

    // Malformed input: report it, but don't record a validation.
    const inputError = validateInput(details, req.file);
    if (inputError) {
      return res.status(422).json({ valid: false, message: inputError });
    }

    try {
      const sql = analyzeSql(text);
      const errors = [...checkPackage(text), ...sql.errors];
      const record = recordValidation({
        username: details.username,
        caseNumber: details.caseNumber,
        description: details.description,
        // Script Name from //NOTES is the package name; fall back to the uploaded file's name.
        fileName: details.packageName || req.file.originalname,
        errors,
        warnings: sql.warnings,
      });
      syncExcel(); // runs in the background; the result page doesn't wait for it
      res.json({
        valid: errors.length === 0,
        message: errors.length === 0 ? "Package passed validation." : "Package failed validation.",
        errors,
        warnings: sql.warnings,
        recordId: record.id,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ valid: false, message: "Could not save the validation result." });
    }
  });
});

// Used by the form to auto-fill User Name, Case Number and Description after a file is chosen.
app.post("/api/package-info", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message = err.code === "LIMIT_FILE_SIZE" ? "File is larger than 5 MB." : "Upload failed.";
      return res.status(400).json({ message });
    }
    if (!req.file) return res.status(400).json({ message: "Package File is required." });
    res.json(parseNotes(req.file.buffer.toString("utf8")));
  });
});

function safe(handler) {
  return (req, res) => {
    try {
      handler(req, res);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: "Could not read or save validation data." });
    }
  };
}

// Tab 1: every validation, optionally for one user (?username=)
app.get("/api/history", safe((req, res) => {
  res.json(listHistory(req.query.username));
}));

app.get("/api/history/:id", safe((req, res) => {
  const record = getHistoryRecord(Number(req.params.id));
  if (!record) return res.status(404).json({ message: "Record not found." });
  res.json(record);
}));

// The user confirmed they rechecked the warnings shown in the popup.
app.post("/api/history/:id/acknowledge", safe((req, res) => {
  const record = acknowledge(Number(req.params.id));
  if (!record) return res.status(404).json({ message: "Record not found." });
  syncExcel(); // writes the acknowledgement time into the Excel row
  res.json(record);
}));

// Whether the Excel file is up to date, so the results page can warn if it isn't.
app.get("/api/excel-status", (_req, res) => {
  res.json(getExcelStatus());
});

// Tab 2: one row per user
app.get("/api/users", safe((_req, res) => {
  res.json(listUsers());
}));

// Tab 3: PkgTesting_Utility_Log (one row per user + package)
app.get("/api/pkg-testing-log", safe((_req, res) => {
  res.json(listPkgTestingLog());
}));

module.exports = app;
