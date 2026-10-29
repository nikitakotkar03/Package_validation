const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const { syncExcel } = require("../backend/excel");

const VALID_PACKAGE = "//NOTES\nfix\n//END NOTES\n//SQL\nselect 1;\n//END SQL\n";

let tmpDir;
let app;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-test-"));
  process.env.DATA_FILE = path.join(tmpDir, "db.json");
  app = require("../backend/app");
});

afterEach(async () => {
  await syncExcel(); // let any background Excel update finish before its folder is deleted
  delete process.env.DATA_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const send = (file, name, extra = {}) => {
  const req = request(app)
    .post("/api/verify")
    .field("username", extra.username ?? "alice")
    .field("caseNumber", extra.caseNumber ?? "#19306026")
    .field("description", extra.description ?? "Fix price discount records.");
  return file === null ? req : req.attach("file", file, name);
};

describe("POST /api/verify", () => {
  test("valid package passes and is recorded", async () => {
    const res = await send(Buffer.from(VALID_PACKAGE), "fix.pkg");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, errors: [], recordId: 1 });
  });

  test("package without required sections fails but is still recorded", async () => {
    const res = await send(Buffer.from("select 1;"), "fix.pkg");
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toHaveLength(4);
    expect(res.body.recordId).toBe(1);
  });

  test("non-.pkg file is rejected and not recorded", async () => {
    const res = await send(Buffer.from("select 1"), "fix.sql");
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Invalid file type/);
    expect((await request(app).get("/api/history")).body).toEqual([]);
  });

  test("a missing file is rejected", async () => {
    const res = await send(null);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Package File/);
  });

  test("description and case number are optional", async () => {
    const res = await send(Buffer.from(VALID_PACKAGE), "a.pkg", { description: "", caseNumber: "" });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });
});

const NOTES_PACKAGE = [
  "//NOTES",
  "Created By: Jane Smith",
  "Case Id: #19306026",
  "Description: Fix incorrect price discount records.",
  "//END NOTES",
  "//SQL",
  "select 1;",
  "//END SQL",
  "",
].join("\n");

describe("//SQL content rules through the API", () => {
  const withSql = (sql) => `//NOTES\nCreated By: Jane\n//END NOTES\n//SQL\n${sql}\n//END SQL\n`;
  const submit = (sql) => request(app).post("/api/verify").attach("file", Buffer.from(withSql(sql)), "fix.pkg");

  test("a //SQL section with only comments fails and is recorded", async () => {
    const res = await submit("/* nothing to run */\n-- really");
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(["The //SQL section contains no executable SQL."]);
    expect((await request(app).get("/api/history/1")).body.status).toBe("Failed");
  });

  test("a // comment fails, naming its line", async () => {
    const res = await submit("select 1\n// not valid in SQL");
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual([
      "The //SQL section uses // for a comment on line 6, which is not valid SQL. Use -- or /* ... */ instead.",
    ]);
  });

  test("/* */ and -- comments next to real SQL pass", async () => {
    const res = await submit("/* header */\nselect 1 -- note");
    expect(res.body.valid).toBe(true);
    expect(res.body.errors).toEqual([]);
  });
});

describe("details read from the package //NOTES", () => {
  test("a file on its own is enough: user, case and description come from the notes", async () => {
    const res = await request(app).post("/api/verify").attach("file", Buffer.from(NOTES_PACKAGE), "fix.pkg");
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);

    const record = (await request(app).get("/api/history/1")).body;
    expect(record).toMatchObject({
      username: "Jane Smith",
      caseNumber: "19306026",
      description: "Fix incorrect price discount records.",
    });
  });

  test("values typed on the form override the notes", async () => {
    const res = await request(app)
      .post("/api/verify")
      .field("username", "Bob")
      .attach("file", Buffer.from(NOTES_PACKAGE), "fix.pkg");
    expect(res.status).toBe(200);

    const record = (await request(app).get("/api/history/1")).body;
    expect(record.username).toBe("Bob");
    expect(record.caseNumber).toBe("19306026"); // still from the notes
  });

  test("no user name on the form or in the notes is rejected and not recorded", async () => {
    const res = await request(app).post("/api/verify").attach("file", Buffer.from(VALID_PACKAGE), "fix.pkg");
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/User Name was not found.*Created By/);
    expect((await request(app).get("/api/history")).body).toEqual([]);
  });

  test("the notes Script Name becomes the package name in history, users and the log", async () => {
    const pkg = [
      "//NOTES",
      "Script Name\t: TEST_Case18437534.pkg",
      "Created By\t: Nikita Kotkar",
      "Case\t\t: 18437534",
      "Description\t: Package to fix align the charges.",
      "/* Package is case specific */",
      "//END NOTES",
      "//SQL",
      "select 1;",
      "//END SQL",
      "",
    ].join("\r\n");
    // Uploaded under a different file name on purpose.
    const res = await request(app).post("/api/verify").attach("file", Buffer.from(pkg), "renamed copy.pkg");
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);

    const record = (await request(app).get("/api/history/1")).body;
    expect(record).toMatchObject({
      fileName: "TEST_Case18437534.pkg",
      username: "Nikita Kotkar",
      caseNumber: "18437534",
      description: "Package to fix align the charges.",
    });
    expect((await request(app).get("/api/users")).body[0].packageName).toBe("TEST_Case18437534.pkg");
    expect((await request(app).get("/api/pkg-testing-log")).body[0].PkgName).toBe("TEST_Case18437534.pkg");
  });

  test("without a Script Name the uploaded file name is used", async () => {
    const res = await request(app).post("/api/verify").attach("file", Buffer.from(NOTES_PACKAGE), "upload.pkg");
    expect(res.status).toBe(200);
    expect((await request(app).get("/api/history/1")).body.fileName).toBe("upload.pkg");
  });

  test("a package without a case id or description is stored with blanks", async () => {
    const pkg = "//NOTES\nCreated By: Jane\n//END NOTES\n//SQL\nselect 1;\n//END SQL\n";
    const res = await request(app).post("/api/verify").attach("file", Buffer.from(pkg), "fix.pkg");
    expect(res.status).toBe(200);
    const record = (await request(app).get("/api/history/1")).body;
    expect(record).toMatchObject({ username: "Jane", caseNumber: "", description: "" });
  });
});

describe("Excel updates through the API", () => {
  test("a validation is added to the Excel file, and the status endpoint reports it", async () => {
    await request(app).post("/api/verify").attach("file", Buffer.from(NOTES_PACKAGE), "fix.pkg");
    await syncExcel(); // waits for the background update the request started

    const xlsx = path.join(tmpDir, "PkgTesting_Utility_Log.xlsx");
    expect(fs.existsSync(xlsx)).toBe(true);

    const status = (await request(app).get("/api/excel-status")).body;
    expect(status.file).toBe(xlsx);
    expect(status.lastError).toBeNull();
    expect(status.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("acknowledging warnings fills the acknowledgement cell", async () => {
    const pkg = TRANS_PACKAGE.replace("//NOTES\nfix", "//NOTES\nCreated By: Jane\nfix");
    await request(app).post("/api/verify").attach("file", Buffer.from(pkg), "trans.pkg");
    await syncExcel();
    await request(app).post("/api/history/1/acknowledge");
    await syncExcel();

    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(tmpDir, "PkgTesting_Utility_Log.xlsx"));
    expect(workbook.getWorksheet("Validation History").getRow(2).getCell(9).value).toBeInstanceOf(Date);
  });
});

describe("POST /api/package-info", () => {
  test("returns the details found in the notes", async () => {
    const res = await request(app).post("/api/package-info").attach("file", Buffer.from(NOTES_PACKAGE), "fix.pkg");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      packageName: "",
      username: "Jane Smith",
      caseNumber: "19306026",
      description: "Fix incorrect price discount records.",
    });
  });

  test("returns empty values when the notes have no details, without recording anything", async () => {
    const res = await request(app).post("/api/package-info").attach("file", Buffer.from(VALID_PACKAGE), "fix.pkg");
    expect(res.body).toEqual({ packageName: "", username: "", caseNumber: "", description: "" });
    expect((await request(app).get("/api/history")).body).toEqual([]);
  });

  test("400 when no file is sent", async () => {
    expect((await request(app).post("/api/package-info")).status).toBe(400);
  });
});

const TRANS_PACKAGE = [
  "//NOTES", "fix", "//END NOTES", "//SQL",
  "insert into backup_trans_datafixhistory select * from trans where hmy in (1,2,3)",
  "update t set t.stotal = 0 from trans t inner join backup_trans_datafixhistory b on b.hmy = t.hmy",
  "//END SQL", "",
].join("\n");

describe("SQL rules over the API", () => {
  test("update without the backup join fails and is recorded", async () => {
    const pkg = "//NOTES\nx\n//END NOTES\n//SQL\nupdate tenant set a = 1 where hmy = 1\n//END SQL\n";
    const res = await send(Buffer.from(pkg), "nojoin.pkg");
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(["UPDATE on tenant must INNER JOIN backup_tenant_datafixhistory."]);
  });

  test("trans package passes with a warning that can be acknowledged", async () => {
    const res = await send(Buffer.from(TRANS_PACKAGE), "trans.pkg");
    expect(res.body.valid).toBe(true);
    expect(res.body.warnings).toHaveLength(1);

    const before = (await request(app).get("/api/history/1")).body;
    expect(before.acknowledgedAt).toBeNull();

    const ack = await request(app).post("/api/history/1/acknowledge");
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await request(app).post("/api/history/99/acknowledge")).status).toBe(404);
  });
});

describe("PkgTesting_Utility_Log", () => {
  test("keeps one row per user and package with a running count", async () => {
    await send(Buffer.from(VALID_PACKAGE), "Fix.pkg", { username: "Alice" });
    await send(Buffer.from("bad"), "fix.pkg", { username: "alice" });
    await send(Buffer.from(VALID_PACKAGE), "other.pkg", { username: "alice" });
    await send(Buffer.from(VALID_PACKAGE), "fix.pkg", { username: "bob" });

    const { body } = await request(app).get("/api/pkg-testing-log");
    expect(body).toHaveLength(3);
    const row = body.find((r) => r.UserName === "Alice" && r.PkgName.toLowerCase() === "fix.pkg");
    expect(row.TotalValidations).toBe(2);
    expect(row.TestDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("history and users", () => {
  test("history is newest first, with case number, date and errors", async () => {
    await send(Buffer.from(VALID_PACKAGE), "one.pkg", { caseNumber: "111" });
    await send(Buffer.from("bad"), "two.pkg", { caseNumber: "#222" });

    const { body } = await request(app).get("/api/history");
    expect(body.map((r) => r.caseNumber)).toEqual(["222", "111"]);
    expect(body[0].status).toBe("Failed");
    expect(body[0].errors.length).toBeGreaterThan(0);
    expect(body[0].validatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body[1].status).toBe("Passed");
  });

  test("history can be filtered by user, case-insensitively", async () => {
    await send(Buffer.from(VALID_PACKAGE), "a.pkg", { username: "Alice" });
    await send(Buffer.from(VALID_PACKAGE), "b.pkg", { username: "bob" });

    const { body } = await request(app).get("/api/history").query({ username: "ALICE" });
    expect(body).toHaveLength(1);
    expect(body[0].username).toBe("Alice");
  });

  test("users keeps exactly one row per user with a validation count", async () => {
    await send(Buffer.from(VALID_PACKAGE), "a.pkg", { username: "Alice" });
    await send(Buffer.from("bad"), "b.pkg", { username: "alice" });
    await send(Buffer.from(VALID_PACKAGE), "c.pkg", { username: "bob" });

    const { body } = await request(app).get("/api/users");
    expect(body).toHaveLength(2);
    const alice = body.find((u) => u.username === "Alice");
    expect(alice.totalValidations).toBe(2);
    expect(alice.packageName).toBe("b.pkg"); // the package Alice tested last
    expect(alice.testDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("single record lookup and 404", async () => {
    await send(Buffer.from(VALID_PACKAGE), "a.pkg");
    expect((await request(app).get("/api/history/1")).body.fileName).toBe("a.pkg");
    expect((await request(app).get("/api/history/99")).status).toBe(404);
  });
});
