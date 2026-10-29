const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");
// Required once, not per test: loading ExcelJS twice (jest.resetModules) breaks its streams.
const store = require("../backend/store");
const excel = require("../backend/excel");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "excel-test-"));
  process.env.DATA_FILE = path.join(tmpDir, "db.json");
  delete process.env.EXCEL_FILE;
});

afterEach(() => {
  delete process.env.DATA_FILE;
  delete process.env.EXCEL_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const xlsxPath = () => path.join(tmpDir, "PkgTesting_Utility_Log.xlsx");

const record = (overrides = {}) =>
  store.recordValidation({
    username: "Nikita Kotkar",
    caseNumber: "18437534",
    description: "Package to fix align the charges.",
    fileName: "TEST_Case18437534.pkg",
    errors: [],
    warnings: [],
    ...overrides,
  });

async function readWorkbook() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath());
  return workbook;
}

const rowValues = (sheet, n) => sheet.getRow(n).values.slice(1); // ExcelJS rows are 1-based

describe("Excel file", () => {
  test("is created next to db.json with both sheets and header rows", async () => {
    record();
    await excel.syncExcel();

    const workbook = await readWorkbook();
    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Validation History", "PkgTesting_Utility_Log"]);
    expect(rowValues(workbook.getWorksheet("Validation History"), 1).slice(0, 6)).toEqual([
      "#", "User", "Case Number", "Date", "Package", "Status",
    ]);
    expect(rowValues(workbook.getWorksheet("PkgTesting_Utility_Log"), 1)).toEqual([
      "User Name", "Package Name", "Total Validations", "Date of Package Testing",
    ]);
  });

  test("adds a row for every validation, with errors and warnings on separate lines", async () => {
    record();
    record({ username: "Bob", caseNumber: "99", fileName: "Other.pkg", errors: ["Missing //NOTES marker.", "Missing //SQL marker."], warnings: ["Check the post month."] });
    await excel.syncExcel();

    const sheet = (await readWorkbook()).getWorksheet("Validation History");
    expect(sheet.rowCount).toBe(3);

    const first = rowValues(sheet, 2);
    expect(first[0]).toBe(1);
    expect(first[1]).toBe("Nikita Kotkar");
    expect(first[2]).toBe(18437534); // numeric, so Excel can sort and filter it
    expect(first[3]).toBeInstanceOf(Date);
    expect(first[4]).toBe("TEST_Case18437534.pkg");
    expect(first[5]).toBe("Passed");
    expect(first[9]).toBe("Package to fix align the charges.");

    const second = rowValues(sheet, 3);
    expect(second[5]).toBe("Failed");
    expect(second[6]).toBe("Missing //NOTES marker.\nMissing //SQL marker.");
    expect(second[7]).toBe("Check the post month.");
  });

  test("shows local clock time, not UTC", async () => {
    record();
    await excel.syncExcel();

    const cell = (await readWorkbook()).getWorksheet("Validation History").getRow(2).getCell(4).value;
    const saved = new Date(store.listHistory()[0].validatedAt);
    // The cell holds the local wall-clock time written as if it were UTC.
    expect(cell.getUTCHours()).toBe(saved.getHours());
    expect(cell.getUTCMinutes()).toBe(saved.getMinutes());
  });

  test("syncing again does not duplicate rows", async () => {
    record();
    await excel.syncExcel();
    await excel.syncExcel();
    record({ fileName: "Second.pkg" });
    await excel.syncExcel();
    await excel.syncExcel();

    const workbook = await readWorkbook();
    expect(workbook.getWorksheet("Validation History").rowCount).toBe(3);
    expect(workbook.getWorksheet("PkgTesting_Utility_Log").rowCount).toBe(3);
  });

  test("the log sheet keeps one row per user and package and updates the count in place", async () => {
    record();
    await excel.syncExcel();
    record({ username: "nikita kotkar", fileName: "test_case18437534.pkg" }); // same user and package, different case
    record({ fileName: "Other.pkg" });
    await excel.syncExcel();

    const sheet = (await readWorkbook()).getWorksheet("PkgTesting_Utility_Log");
    expect(sheet.rowCount).toBe(3);
    const first = rowValues(sheet, 2);
    expect(first.slice(0, 3)).toEqual(["Nikita Kotkar", "TEST_Case18437534.pkg", 2]);
    expect(first[3]).toBeInstanceOf(Date);
    expect(rowValues(sheet, 3).slice(0, 3)).toEqual(["Nikita Kotkar", "Other.pkg", 1]);
  });

  test("the acknowledgement time is written into the existing row", async () => {
    const r = record({ warnings: ["Check the post month."] });
    await excel.syncExcel();
    expect(rowValues((await readWorkbook()).getWorksheet("Validation History"), 2)[8]).toBeUndefined();

    store.acknowledge(r.id);
    await excel.syncExcel();

    const sheet = (await readWorkbook()).getWorksheet("Validation History");
    expect(sheet.rowCount).toBe(2);
    expect(rowValues(sheet, 2)[8]).toBeInstanceOf(Date);
  });

  test("records saved before the Excel file existed are added", async () => {
    const dbFile = process.env.DATA_FILE;
    fs.writeFileSync(
      dbFile,
      JSON.stringify({
        history: [
          { id: 1, username: "Old", caseNumber: "5", description: "", fileName: "Old.pkg", validatedAt: "2026-10-19T05:42:58.805Z", status: "Passed", errors: [] },
        ],
        users: {},
        PkgTesting_Utility_Log: { "old|old.pkg": { UserName: "Old", PkgName: "Old.pkg", TotalValidations: 1, TestDate: "2026-10-19T05:42:58.805Z" } },
      })
    );
    await excel.syncExcel();

    const workbook = await readWorkbook();
    expect(rowValues(workbook.getWorksheet("Validation History"), 2)[1]).toBe("Old");
    expect(rowValues(workbook.getWorksheet("PkgTesting_Utility_Log"), 2).slice(0, 3)).toEqual(["Old", "Old.pkg", 1]);
  });

  test("rows and columns the manager changes are preserved, and deleted rows stay deleted", async () => {
    record();
    record({ fileName: "Two.pkg" });
    await excel.syncExcel();

    // The manager adds a note column and deletes the first validation row.
    let workbook = await readWorkbook();
    let sheet = workbook.getWorksheet("Validation History");
    sheet.getRow(3).getCell(11).value = "Reviewed by manager";
    sheet.spliceRows(2, 1);
    await workbook.xlsx.writeFile(xlsxPath());

    record({ fileName: "Three.pkg" });
    await excel.syncExcel();

    workbook = await readWorkbook();
    sheet = workbook.getWorksheet("Validation History");
    expect(sheet.rowCount).toBe(3); // header + Two + Three; One did not come back
    expect(rowValues(sheet, 2)[4]).toBe("Two.pkg");
    expect(rowValues(sheet, 2)[10]).toBe("Reviewed by manager");
    expect(rowValues(sheet, 3)[4]).toBe("Three.pkg");
  });

  test("a file that can't be updated leaves nothing lost and is retried next time", async () => {
    record();
    fs.writeFileSync(xlsxPath(), "this is not a workbook"); // unreadable, so it must not be overwritten

    await excel.syncExcel();
    expect(excel.getStatus().lastError).toMatch(/could not be updated/);
    expect(fs.readFileSync(xlsxPath(), "utf8")).toBe("this is not a workbook");
    expect(store.getExcelPending().history).toHaveLength(1); // still waiting

    fs.rmSync(xlsxPath());
    await excel.syncExcel();
    expect(excel.getStatus().lastError).toBeNull();
    expect((await readWorkbook()).getWorksheet("Validation History").rowCount).toBe(2);
    expect(store.getExcelPending().history).toHaveLength(0);
  });

  test("two syncs started together are applied in turn without losing rows", async () => {
    record();
    const first = excel.syncExcel();
    record({ fileName: "Two.pkg" });
    const second = excel.syncExcel();
    await Promise.all([first, second]);

    expect((await readWorkbook()).getWorksheet("Validation History").rowCount).toBe(3);
  });

  test("EXCEL_FILE chooses where the workbook is saved", async () => {
    process.env.EXCEL_FILE = path.join(tmpDir, "shared", "Manager.xlsx");
    record();
    await excel.syncExcel();
    expect(fs.existsSync(process.env.EXCEL_FILE)).toBe(true);
    expect(fs.existsSync(xlsxPath())).toBe(false);
  });
});
