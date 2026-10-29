// Static checks on the //SQL ... //END SQL section of a package.
// Nothing is executed: statements are split and inspected as text.

// Transaction tables that trigger the "recheck data / post month" warning.
const TRANSACTION_TABLES = ["trans", "camcharg"];
const RECORD_LIMIT = 25;

// An UPDATE or DELETE on these tables must carry `<column> <> 0`, so it never touches rows where it is 0.
const PROPERTY_TABLES = ["property"];
const PROPERTY_CONDITION_COLUMN = "iTypeStorage";

const NAME = String.raw`[\w#@.\[\]"]+`;
const STARTER = /^\s*(update|delete|insert|create|drop|alter|truncate|exec|declare|select)\b/i;

/**
 * The text between the //SQL and //END SQL lines, and the package line number (1-based) of its
 * first line. Null if the section is missing or misordered.
 */
function extractSql(text) {
  const lines = text.split(/\r?\n/);
  const upper = lines.map((l) => l.trim().toUpperCase());
  const start = upper.indexOf("//SQL");
  const end = upper.indexOf("//END SQL");
  if (start === -1 || end === -1 || end < start) return null;
  return { sql: lines.slice(start + 1, end).join("\n"), firstLine: start + 2 };
}

/**
 * Removes comments so only executable text is analyzed:
 *   -- line comments and nested block comments (the valid SQL styles), and
 *   // line comments, which are not valid SQL: they are removed too (so their text is ignored)
 *   but reported in `slashLines`, the 1-based line numbers within `sql` where they start.
 * Text inside 'strings' and [bracketed names] is left alone, so a `--` or `//` in a value
 * such as 'a -- b' or 'http://x' is not a comment. Comments are replaced by a space or dropped
 * up to the line break, so neighbouring words never run together.
 * @returns {{sql: string, slashLines: number[]}}
 */
function stripComments(sql) {
  let out = "";
  let i = 0;
  const slashLines = [];
  let closer = null; // "'" or "]" while inside a string or bracketed name

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (closer) {
      out += ch;
      i++;
      if (ch === closer) {
        if (closer === "'" && next === "'") {
          out += next; // '' is an escaped quote, still inside the string
          i++;
        } else {
          closer = null;
        }
      }
    } else if (ch === "'" || ch === "[") {
      closer = ch === "'" ? "'" : "]";
      out += ch;
      i++;
    } else if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++; // keep the line break itself
    } else if (ch === "/" && next === "/") {
      slashLines.push(sql.slice(0, i).split("\n").length);
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
    } else {
      out += ch;
      i++;
    }
  }
  return { sql: out, slashLines };
}

/** Anything left once comments, GO separators and bare semicolons are taken away. */
function hasExecutableSql(sqlWithoutComments) {
  return sqlWithoutComments.replace(/^\s*go\s*$/gim, "").replace(/;/g, "").trim() !== "";
}

/**
 * Splits into statements on GO lines, semicolons, and lines that begin a new
 * statement (UPDATE, DELETE, INSERT, ...) outside parentheses. T-SQL packages
 * often have no semicolons, so keyword starts are needed.
 */
function splitStatements(sql) {
  const statements = [];

  for (const batch of sql.split(/^\s*go\s*$/gim)) {
    let current = [];
    let depth = 0;

    const flush = () => {
      const text = current.join(" ").replace(/\s+/g, " ").trim();
      if (text) statements.push(text);
      current = [];
    };

    for (const line of batch.split(/\r?\n/)) {
      const starter = STARTER.exec(line);
      if (starter && depth === 0 && current.length) {
        const joined = current.join(" ");
        const first = (/^\s*(\w+)/.exec(joined) || [])[1];
        const continuesPrevious =
          starter[1].toLowerCase() === "select" &&
          ((first || "").toLowerCase() === "insert" || /\bunion(\s+all)?\s*$/i.test(joined));
        if (!continuesPrevious) flush();
      }

      current.push(line.replace(/;\s*$/, ""));

      depth += (line.replace(/'[^']*'/g, "").match(/\(/g) || []).length;
      depth -= (line.replace(/'[^']*'/g, "").match(/\)/g) || []).length;
      if (depth < 0) depth = 0;

      if (/;\s*$/.test(line) && depth === 0) flush();
    }
    flush();
  }
  return statements;
}

const bareName = (raw) => raw.replace(/[\[\]"]/g, "").split(".").pop().toLowerCase();

/** The table an UPDATE/DELETE changes, resolving `update t ... from tenant t`. Null for other statements. */
function parseModification(stmt) {
  const top = String.raw`(?:top\s*\(?\s*\d+\s*\)?\s*(?:percent\s+)?)?`;
  let type;
  let match = new RegExp(String.raw`^update\s+${top}(${NAME})`, "i").exec(stmt);
  if (match) type = "UPDATE";
  else {
    match = new RegExp(String.raw`^delete\s+${top}(?:from\s+)?(${NAME})`, "i").exec(stmt);
    if (match) type = "DELETE";
  }
  if (!match) return null;

  const target = match[1];
  let table = bareName(target);

  if (!target.includes(".")) {
    const aliasPattern = new RegExp(String.raw`\b(?:from|join)\s+(${NAME})\s+(?:as\s+)?(\w+)`, "gi");
    for (const m of stmt.matchAll(aliasPattern)) {
      if (m[2].toLowerCase() === table) {
        table = bareName(m[1]);
        break;
      }
    }
  }
  return { type, table };
}

/** True if the statement INNER JOINs (or plainly JOINs) the table's backup table. */
function joinsBackup(stmt, table) {
  const pattern = new RegExp(
    String.raw`(?:\b(left|right|full|cross|inner)\s+(?:outer\s+)?)?\bjoin\s+(?:[\w\[\]"]+\.)*\[?"?backup_${table}_datafixhistory\b`,
    "gi"
  );
  for (const m of stmt.matchAll(pattern)) {
    if (!m[1] || m[1].toLowerCase() === "inner") return true;
  }
  return false;
}

/**
 * True if the statement contains `<column> <> 0` (or `!= 0`), with an optional alias or
 * brackets (`p.iTypeStorage <> 0`, `[iTypeStorage]<>0`). Comments are already removed, so a
 * commented-out condition does not count.
 */
function hasPropertyCondition(stmt) {
  const pattern = new RegExp(
    String.raw`(?:^|[^\w])(?:[\w\[\]"]+\.)*\[?"?${PROPERTY_CONDITION_COLUMN}\]?"?\s*(?:<>|!=)\s*0(?![\w.])`,
    "i"
  );
  return pattern.test(stmt);
}

/** The values in the first `hmy IN (1,2,3)` list; null when absent or a subquery. */
function explicitHmyIds(stmt) {
  const match = /\bhmy\s+in\s*\(([^()]*)\)/i.exec(stmt);
  if (!match) return null;
  const ids = match[1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, "").toLowerCase())
    .filter(Boolean);
  return ids.length ? ids : null;
}

/** For `SELECT ... INTO` / `INSERT INTO backup_<table>_datafixhistory`, the <table>; otherwise null. */
function backupTarget(stmt) {
  if (!/^(select|insert)\b/i.test(stmt)) return null;
  const into = new RegExp(String.raw`\binto\s+(${NAME})`, "i").exec(stmt);
  if (!into) return null;
  const named = /^backup_(\w+)_datafixhistory$/.exec(bareName(into[1]));
  return named ? named[1] : null;
}

const preview = (ids) => {
  const shown = ids.slice(0, 5).join(", ");
  return ids.length > 5 ? `${shown}, ...` : shown;
};

/**
 * Compares each backup with the UPDATE/DELETE statements that use it.
 *
 * A "group" is a backup plus the modifications after it, up to the next backup
 * that follows a modification. This covers both layouts:
 *   - one backup, several update/delete statements (they share the group), and
 *   - a separate backup for each update (each starts its own group).
 * Several backup inserts in a row, before any modification, also share a group.
 *
 * Within a group, when hmy lists are explicit: no statement may touch a record
 * that was not backed up, and if every statement is explicit, together they
 * must cover every backed-up record.
 */
function checkGroups(table, groups, errors) {
  for (const group of groups) {
    if (!group.backupKnown) continue; // backup written with a subquery: nothing to compare

    for (const mod of group.mods) {
      if (!mod.ids) continue;
      const extra = [...mod.ids].filter((id) => !group.backup.has(id));
      if (extra.length) {
        errors.add(
          `${mod.type} on ${table} touches ${extra.length} record(s) that are not in ` +
            `backup_${table}_datafixhistory (${preview(extra)}).`
        );
      }
    }

    if (group.mods.length && group.mods.every((m) => m.ids)) {
      const covered = new Set(group.mods.flatMap((m) => [...m.ids]));
      const missing = [...group.backup].filter((id) => !covered.has(id));
      if (missing.length) {
        errors.add(
          `Only ${group.backup.size - missing.length} of the ${group.backup.size} records in ` +
            `backup_${table}_datafixhistory are updated/deleted (not covered: ${preview(missing)}).`
        );
      }
    }
  }
}

/**
 * @param {string} text full package text
 * @returns {{errors: string[], warnings: string[]}}
 */
function analyzeSql(text) {
  const section = extractSql(text);
  if (section === null) return { errors: [], warnings: [] }; // structure errors are reported elsewhere

  const stripped = stripComments(section.sql);
  const errors = new Set();

  // `//` is not a SQL comment. It is ignored for the rest of the analysis, but reported.
  if (stripped.slashLines.length) {
    const lines = stripped.slashLines.map((n) => section.firstLine + n - 1);
    errors.add(
      `The //SQL section uses // for a comment on line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}, ` +
        "which is not valid SQL. Use -- or /* ... */ instead."
    );
  }

  // Only comments, blank lines or GO: nothing would run.
  if (!hasExecutableSql(stripped.sql)) {
    errors.add("The //SQL section contains no executable SQL.");
    return { errors: [...errors], warnings: [] };
  }

  const statements = splitStatements(stripped.sql);
  const warnings = [];
  const groups = {}; // table -> backup groups, in package order
  const touched = new Set(); // transaction tables with an UPDATE/DELETE

  for (const stmt of statements) {
    const backedUpTable = backupTarget(stmt);
    if (backedUpTable) {
      const list = (groups[backedUpTable] = groups[backedUpTable] || []);
      let group = list[list.length - 1];
      if (!group || group.mods.length) {
        group = { backup: new Set(), backupKnown: true, mods: [] };
        list.push(group);
      }
      const ids = explicitHmyIds(stmt);
      if (ids) ids.forEach((id) => group.backup.add(id));
      else group.backupKnown = false;
      continue;
    }

    const mod = parseModification(stmt);
    if (!mod) continue;
    const { type, table } = mod;
    if (/^[#@]/.test(table) || table.startsWith("backup_")) continue; // temp objects and backups themselves

    if (!joinsBackup(stmt, table)) {
      errors.add(`${type} on ${table} must INNER JOIN backup_${table}_datafixhistory.`);
    }
    if (PROPERTY_TABLES.includes(table) && !hasPropertyCondition(stmt)) {
      errors.add(`${type} on ${table} must include the condition ${PROPERTY_CONDITION_COLUMN} <> 0.`);
    }
    if (TRANSACTION_TABLES.includes(table)) touched.add(table);

    const list = (groups[table] = groups[table] || []);
    if (!list.length) list.push({ backup: new Set(), backupKnown: false, mods: [] }); // no backup seen first
    const ids = explicitHmyIds(stmt);
    list[list.length - 1].mods.push({ type, ids: ids ? new Set(ids) : null });
  }

  for (const [table, list] of Object.entries(groups)) checkGroups(table, list, errors);

  // Distinct records known to be changed per transaction table, across all backup groups.
  const totals = {};
  for (const table of touched) {
    const ids = new Set();
    for (const group of groups[table] || []) {
      group.backup.forEach((id) => ids.add(id));
      group.mods.forEach((m) => m.ids && m.ids.forEach((id) => ids.add(id)));
    }
    totals[table] = ids.size;
  }

  if (touched.size) {
    warnings.push(
      `The package updates/deletes transaction records in ${[...touched].join(", ")}. ` +
        "Please check the data once again and check the post month."
    );
  }
  for (const table of touched) {
    if (totals[table] > RECORD_LIMIT) {
      warnings.push(
        `The package updates/deletes ${totals[table]} records in ${table} ` +
          `(more than ${RECORD_LIMIT}). Please check this package with Seniors once.`
      );
    }
  }

  return { errors: [...errors], warnings };
}

module.exports = { analyzeSql, extractSql, splitStatements, TRANSACTION_TABLES, RECORD_LIMIT };
