const { resolveDetails, validateInput, checkPackage } = require("../backend/verify");

const makeFile = (name, content = "x") => ({
  originalname: name,
  size: Buffer.byteLength(content),
  buffer: Buffer.from(content),
});

const details = (overrides = {}) => ({
  username: "alice",
  caseNumber: "19306026",
  description: "Fix incorrect price discount records.",
  ...overrides,
});

const VALID_PACKAGE = [
  "//NOTES",
  "Fix discounts",
  "//END NOTES",
  "//SQL",
  "update t set a = 1;",
  "//END SQL",
].join("\n");

describe("resolveDetails", () => {
  const notesPkg = "//NOTES\nCreated By: Jane\nCase Id: 123\nDescription: From notes\n//END NOTES\n//SQL\n//END SQL";

  test("fills everything from the notes when the form is empty", () => {
    expect(resolveDetails({}, notesPkg)).toEqual({
      packageName: "",
      username: "Jane",
      caseNumber: "123",
      description: "From notes",
    });
  });

  test("form values win over the notes, field by field", () => {
    const result = resolveDetails({ username: "  Bob ", caseNumber: "", description: "  " }, notesPkg);
    expect(result).toEqual({ packageName: "", username: "Bob", caseNumber: "123", description: "From notes" });
  });

  test("the package name always comes from the notes Script Name", () => {
    const text = "//NOTES\nScript Name: Fix.pkg\n//END NOTES\n//SQL\n//END SQL";
    expect(resolveDetails({ packageName: "ignored.pkg" }, text).packageName).toBe("Fix.pkg");
  });

  test("returns empty values when neither source has them", () => {
    expect(resolveDetails({}, VALID_PACKAGE)).toEqual({
      packageName: "",
      username: "",
      caseNumber: "",
      description: "",
    });
  });
});

describe("validateInput", () => {
  test("accepts a .pkg with a user name", () => {
    expect(validateInput(details(), makeFile("a.pkg"))).toBeNull();
  });

  test("the package file is required", () => {
    expect(validateInput(details(), undefined)).toMatch(/Package File/);
  });

  test("case number and description are optional", () => {
    expect(validateInput(details({ caseNumber: "", description: "" }), makeFile("a.pkg"))).toBeNull();
  });

  test("a user name is still needed to attribute the validation", () => {
    expect(validateInput(details({ username: "" }), makeFile("a.pkg"))).toMatch(/User Name was not found.*Created By/);
  });

  test("a case number, when present, must be digits with an optional #", () => {
    expect(validateInput(details({ caseNumber: "abc" }), makeFile("a.pkg"))).toMatch(/digits/);
    expect(validateInput(details({ caseNumber: "#19306026" }), makeFile("a.pkg"))).toBeNull();
  });

  test.each(["a.sql", "a.txt", "a.zip", "a.exe", "a.pdf", "a.docx", "pkg"])("rejects %s", (name) => {
    expect(validateInput(details(), makeFile(name))).toBe("Invalid file type. Please select a .pkg package file.");
  });

  test("the file type is reported before missing details", () => {
    expect(validateInput(details({ username: "" }), makeFile("a.sql"))).toMatch(/Invalid file type/);
  });

  test("accepts .pkg case-insensitively", () => {
    expect(validateInput(details(), makeFile("A.PKG"))).toBeNull();
  });
});

describe("checkPackage", () => {
  test("passes with both sections", () => {
    expect(checkPackage(VALID_PACKAGE)).toEqual([]);
  });

  test("is case-insensitive, ignores whitespace and CRLF", () => {
    const text = "  //notes \r\nx\r\n//end notes\r\n//Sql\r\nx\r\n//End Sql  ";
    expect(checkPackage(text)).toEqual([]);
  });

  test("reports an empty package", () => {
    expect(checkPackage("  \n ")).toEqual(["Package file is empty."]);
  });

  test("reports a missing NOTES section", () => {
    expect(checkPackage("//SQL\nx\n//END SQL")).toEqual([
      "Missing //NOTES marker.",
      "Missing //END NOTES marker.",
    ]);
  });

  test("reports a missing end marker", () => {
    expect(checkPackage("//NOTES\nx\n//END NOTES\n//SQL\nx")).toEqual(["Missing //END SQL marker."]);
  });

  test("reports end marker before start marker", () => {
    expect(checkPackage("//END NOTES\n//NOTES\n//SQL\n//END SQL")).toEqual([
      "//END NOTES appears before //NOTES.",
    ]);
  });

  test("reports every problem at once", () => {
    expect(checkPackage("hello")).toHaveLength(4);
  });
});
