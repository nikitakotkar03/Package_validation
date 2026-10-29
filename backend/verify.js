const path = require("path");
const { parseNotes } = require("./notes");

const ALLOWED_EXTENSIONS = [".pkg"];
const CASE_NUMBER_PATTERN = /^#?\d+$/;

// Each required section: a start marker and an end marker, each on its own line.
const REQUIRED_SECTIONS = [
  { start: "//NOTES", end: "//END NOTES" },
  { start: "//SQL", end: "//END SQL" },
];

/**
 * The package file is the only required input. The details come from //NOTES;
 * the form fields are read-only in the UI, but an API client may still send
 * username/caseNumber/description to override what the notes say.
 * packageName (Script Name) always comes from the notes.
 * @returns {{packageName: string, username: string, caseNumber: string, description: string}}
 */
function resolveDetails(fields, text) {
  const notes = parseNotes(text);
  const pick = (key) => (fields[key] || "").trim() || notes[key];
  return {
    packageName: notes.packageName,
    username: pick("username"),
    caseNumber: pick("caseNumber"),
    description: pick("description"),
  };
}

/**
 * Checks the file and the resolved details. A message means the submission
 * is malformed and nothing is validated or recorded.
 * @returns {string | null}
 */
function validateInput(details, file) {
  if (!file) return "Package File is required.";

  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return "Invalid file type. Please select a .pkg package file.";
  }

  // Needed to attribute the validation to someone.
  if (!details.username) {
    return "User Name was not found. Add a \"Created By\" line to the //NOTES section of the package.";
  }
  if (details.caseNumber && !CASE_NUMBER_PATTERN.test(details.caseNumber)) {
    return "Case Number must be digits only, optionally starting with #.";
  }
  return null;
}

/**
 * Checks the package content.
 * Marker lines are matched case-insensitively, ignoring surrounding whitespace.
 * @param {string} text
 * @returns {string[]} list of errors; empty when the package passes
 */
function checkPackage(text) {
  if (text.trim() === "") return ["Package file is empty."];

  const lines = text.split(/\r?\n/).map((l) => l.trim().toUpperCase());
  const errors = [];

  for (const { start, end } of REQUIRED_SECTIONS) {
    const startAt = lines.indexOf(start);
    const endAt = lines.indexOf(end);

    if (startAt === -1) errors.push(`Missing ${start} marker.`);
    if (endAt === -1) errors.push(`Missing ${end} marker.`);
    if (startAt !== -1 && endAt !== -1 && endAt < startAt) {
      errors.push(`${end} appears before ${start}.`);
    }
  }
  return errors;
}

module.exports = { resolveDetails, validateInput, checkPackage, ALLOWED_EXTENSIONS };
