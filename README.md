# Yardi Package Validation

Enter the package details, upload a `.pkg` file, and the backend validates it, records the result, and shows a results page.

## Structure

```
frontend/   index.html (form), results.html (history + users tabs), style.css, script.js, results.js
backend/    app.js (routes), server.js, verify.js (rules), store.js (storage)
data/       db.json — created automatically on the first validation
tests/      verify.test.js, api.test.js  (Jest + Supertest)
```

## Run

```
npm install
npm start          # http://localhost:3000
npm test
```

## Flow

1. User selects the `.pkg` file on `index.html` (the only input). Package Name, User Name, Case Number and Description are read from the package's `//NOTES` section into fields that are disabled, so they can't be edited. Submit.
2. Backend validates the package and records the result (pass or fail).
3. Browser navigates to `results.html?id=<record id>`, which shows the latest result and two tabs:
   - **Validation History** — every validation: user, case number, date, package, status, errors, warnings. Filter by user; shows how many times that user validated.
   - **PkgTesting_Utility_Log** — one row per user and package, with the total validations and the date of the last test.

### Details read from `//NOTES` (`backend/notes.js`)

```
//NOTES
Script Name	: TEST_Case18437534.pkg                -> Package Name (also "Package Name")
Client Name	: Avenue Living Communities Limited    -> ignored
Client PIN	: 100083920                            -> ignored
Created By	: TEST TEST                         -> User Name
Date		: 15 May 2026                          -> ignored
Case		: 18437111                             -> Case Number (also "Case Id", "Case Number", "Case No", "Case #"; digits are kept)
Description	: Package to fix align the charges.    -> Description (may continue on plain lines until a blank line or the next label)
/* Package is case specific */                     -> comment lines are never part of a value
//END NOTES
```

Labels are case-insensitive and `:` or `=` separates the value (tabs/spaces around it are fine). The form fields are disabled, so the notes are the only source. The **Script Name** is used as the package name in history, the Users tab and PkgTesting_Utility_Log; if it's missing, the uploaded file's name is used. Only the package file is required, except that a **User Name** (`Created By`) must be present in the notes, because every validation is attributed to a user. Case and Description may be blank. (The API still accepts optional `username`/`caseNumber`/`description` fields that override the notes; the web form never sends them.)

## Package rules

The package must contain, each marker on its own line (case-insensitive, whitespace ignored):

```
//NOTES
...
//END NOTES
//SQL
...
//END SQL
```

All problems are reported together: missing markers, or an end marker appearing before its start marker. An empty file is also a failure. Failed packages are recorded in history with their errors.

### SQL rules (`backend/sqlcheck.js`)

The `//SQL` section is inspected as text (nothing is executed):

- **Executable SQL (error):** the `//SQL` section must contain something that would run. If it holds only comments, blank lines, `GO` or semicolons (or nothing at all), the package fails with "The //SQL section contains no executable SQL."
- **Comment style (error for `//`):** `--` line comments and `/* ... */` block comments are valid and never raise an error. A `//` comment is not valid SQL, so the package fails with "The //SQL section uses // for a comment on line N, which is not valid SQL. Use -- or /* ... */ instead." (N is the line in the package; all offending lines are listed). The text of a `//` comment is still ignored by the other checks. `//` inside a `'string'`, `[bracketed name]` or another comment is not a comment, so `'http://x'` is safe.
- **Comments are ignored (everywhere below):** `-- line` and `/* block */` comments (block comments nest) are removed before anything is analyzed. A statement that is commented out is not checked, and a join or condition that is commented out does not count. Text inside `'strings'` and `[bracketed names]` is not treated as a comment, so `'a -- b'` is safe.
- **Backup join (error):** every `UPDATE`/`DELETE` on a table must `INNER JOIN` its backup table `backup_<table>_datafixhistory` (e.g. `tenant` → `backup_tenant_datafixhistory`). A plain `JOIN` is accepted; `LEFT`/`RIGHT`/`FULL`/`CROSS` do not count. Temp tables (`#x`, `@x`) are skipped.
- **Property condition (error):** an `UPDATE`/`DELETE` on `property` must include the condition `iTypeStorage <> 0` (`!= 0` also works; an alias or brackets such as `p.iTypeStorage` are fine; matching ignores case). `= 0`, `<> 1` or a different column do not satisfy it. Each statement needs its own condition. The column name and table are constants at the top of `backend/sqlcheck.js`.
- **Record count (error):** a backup and the `UPDATE`/`DELETE` statements after it form a group. When the records are listed as `hmy IN (1,2,3,...)`, no statement may touch a record that is not in the backup, and (if every statement lists its records) together they must cover every backed-up record. This covers one backup shared by several statements and a separate backup for each statement. When a list can't be read (e.g. a subquery) the check is skipped, because counts can't be known without running against a database.
- **Transaction tables (warning):** an `UPDATE`/`DELETE` on `trans` or `camcharg` (only these two tables) shows a popup: check the data once again and check the post month. (The table list is `TRANSACTION_TABLES` in `backend/sqlcheck.js`.)
- **More than 25 records (warning):** for those tables, a count over 25 adds: check this package with Seniors once.

Warnings don't fail the package. The popup on the form requires ticking "I have rechecked" before continuing; the acknowledgement time is saved in history. Choosing "Back to form" leaves the record marked "Not acknowledged".

### PkgTesting_Utility_Log

One row per user + package: `UserName`, `PkgName`, `TotalValidations` (how many times that user validated that package, passed or failed), `TestDate` (most recent test). Shown as the third tab and stored in `data/db.json` under `PkgTesting_Utility_Log`.

Malformed submissions (missing field, bad case number, non-`.pkg` file) are rejected with 422 and are **not** recorded.

## Excel file for the manager (`backend/excel.js`)

Every validation is also written to an Excel workbook, `data/PkgTesting_Utility_Log.xlsx` (next to `db.json`). Set the `EXCEL_FILE` environment variable to save it somewhere else, e.g. a shared folder the manager can open.

| Sheet | Rows |
| --- | --- |
| **Validation History** | One row per validation: #, User, Case Number, Date, Package, Status, Errors, Warnings, Warnings Acknowledged, Description. Rows are only appended. |
| **PkgTesting_Utility_Log** | One row per user + package: User Name, Package Name, Total Validations, Date of Package Testing. The count and date are updated in place. |

- It updates by itself after each validation (and when the warnings popup is acknowledged), and on server start for anything saved earlier. Dates are in the server's local time.
- `db.json` is still what the web pages read; Excel is a report copy.
- **If the file is open in Excel, it can't be written.** Nothing is lost: the validation is saved, the results page shows a notice, and the missing rows are added at the next validation (or server restart). Closing the file is enough. A file that isn't a valid workbook is never overwritten.
- Each row is added once. The manager can add columns to the right (they're kept), sort, filter or delete rows (deleted rows don't come back). A log row is updated again only when that user validates that package again.

## API

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/package-info` | multipart: `file`. Returns `{ username, caseNumber, description }` read from `//NOTES` (empty strings when not found). Records nothing |
| POST | `/api/verify` | multipart: `file` (required); `username`, `caseNumber`, `description` optional overrides. Returns `{ valid, message, errors, warnings, recordId }` (200) or `{ valid:false, message }` (422 / 400) |
| GET | `/api/history?username=` | History rows, newest first |
| GET | `/api/history/:id` | One history row |
| POST | `/api/history/:id/acknowledge` | Records that the user confirmed the warnings |
| GET | `/api/users` | One row per user |
| GET | `/api/pkg-testing-log` | PkgTesting_Utility_Log rows |
| GET | `/api/excel-status` | `{ file, lastSyncAt, lastError }` for the Excel file |

## Storage

`backend/store.js` keeps data in `data/db.json` (override with the `DATA_FILE` env var). It is single-process and fine for a small internal tool; to use a real database, replace only `store.js`. User names are matched case-insensitively (`Alice` and `alice` are one user).
