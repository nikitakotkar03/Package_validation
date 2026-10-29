// Reads the package details written in the //NOTES ... //END NOTES section.
//
//   //NOTES
//   Script Name	: TEST_Case18437534.pkg
//   Client Name	: Avenue Living Communities Limited
//   Created By	: Nikita Kotkar
//   Case		: 18437534
//   Description	: Package to fix align the charges.
//   /* Package is case specific */
//   //END NOTES
//
// Labels are case-insensitive; ":" or "=" separates the value (tabs/spaces around it are fine).
// Recognised: Script Name (or Package Name), Created By, Case (or Case Id / Number / No / #),
// Description. Other labels (Client Name, Date, ...) are ignored.
// A description may continue on following plain lines; comment lines (/* */, --, //, *) are never
// part of a value.

const FIELD_LABELS = [
  { field: "packageName", pattern: /^(script|package)\s*name$/i },
  { field: "username", pattern: /^created\s*by$/i },
  { field: "caseNumber", pattern: /^case\s*(id|number|no\.?|#)?$/i },
  { field: "description", pattern: /^(package\s*)?(description|desc)$/i },
];

const LABEL_LINE = /^([A-Za-z][A-Za-z #.]*?)\s*[:=]\s*(.*)$/;
const COMMENT_START = /^\s*(\/\*|\*|--|\/\/)/;

/** The lines between //NOTES and //END NOTES, or null if the section is missing or misordered. */
function notesLines(text) {
  const lines = text.split(/\r?\n/);
  const upper = lines.map((l) => l.trim().toUpperCase());
  const start = upper.indexOf("//NOTES");
  const end = upper.indexOf("//END NOTES");
  if (start === -1 || end === -1 || end < start) return null;
  return lines.slice(start + 1, end);
}

/**
 * @param {string} text full package text
 * @returns {{packageName: string, username: string, caseNumber: string, description: string}}
 *   empty string for anything not found
 */
function parseNotes(text) {
  const result = { packageName: "", username: "", caseNumber: "", description: "" };
  const lines = notesLines(text);
  if (!lines) return result;

  let current = null; // field whose value may continue on the next line

  for (const raw of lines) {
    const isComment = COMMENT_START.test(raw);
    const line = raw
      .replace(/^[\s\-*/]+/, "") // comment decoration in front
      .replace(/\s*\*\/\s*$/, "") // closing */ at the end
      .trim();

    if (!line) {
      // A blank line ends a value that already has text.
      if (current && result[current]) current = null;
      continue;
    }

    const labelled = LABEL_LINE.exec(line);
    if (labelled) {
      const known = FIELD_LABELS.find(({ pattern }) => pattern.test(labelled[1].trim()));
      current = known ? known.field : null;
      if (known && !result[known.field]) result[known.field] = labelled[2].trim();
      continue;
    }

    // Plain continuation of a description; comment lines never count.
    if (current === "description" && !isComment) {
      result.description = (result.description + " " + line).trim();
    }
  }

  // Case may be written as "#19306026" or "Case-19306026": keep the digits.
  const digits = /\d+/.exec(result.caseNumber);
  if (digits) result.caseNumber = digits[0];

  return result;
}

module.exports = { parseNotes };
