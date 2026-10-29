const { parseNotes } = require("../backend/notes");

const pkg = (notes) => `//NOTES\n${notes}\n//END NOTES\n//SQL\nselect 1\n//END SQL\n`;
const EMPTY = { packageName: "", username: "", caseNumber: "", description: "" };

describe("parseNotes", () => {
  test("reads the real notes layout: tab-separated labels and a trailing comment line", () => {
    const text = [
      "//NOTES",
      "Script Name\t: TEST_Case18437534.pkg",
      "Client Name\t: Avenue Living Communities Limited",
      "Client PIN\t: 100083920",
      "Created By\t: Nikita Kotkar",
      "Date\t\t: 15 May 2026",
      "Case\t\t: 18437534",
      "Description\t: Package to fix align the charges.",
      "/* Package is case specific */",
      "//END NOTES",
      "//SQL",
      "select 1",
      "//END SQL",
    ].join("\r\n");

    expect(parseNotes(text)).toEqual({
      packageName: "TEST_Case18437534.pkg",
      username: "Nikita Kotkar",
      caseNumber: "18437534",
      description: "Package to fix align the charges.",
    });
  });

  test("other labels in the notes are ignored", () => {
    const result = parseNotes(pkg("Client Name: Acme\nClient PIN: 123\nDate: 1 Jan 2026"));
    expect(result).toEqual(EMPTY);
  });

  test("reads script name, created by, case and description", () => {
    const result = parseNotes(
      pkg("Script Name: Fix.pkg\nCreated By: Jane Smith\nCase: 19306026\nDescription: Fix incorrect price discount records.")
    );
    expect(result).toEqual({
      packageName: "Fix.pkg",
      username: "Jane Smith",
      caseNumber: "19306026",
      description: "Fix incorrect price discount records.",
    });
  });

  test("accepts Package Name as well as Script Name", () => {
    expect(parseNotes(pkg("Package Name: Other.pkg")).packageName).toBe("Other.pkg");
  });

  test("labels are case-insensitive and accept = and spacing", () => {
    const result = parseNotes(pkg("CREATED BY = jsmith\ncase : 55\nDESCRIPTION :  Fix it"));
    expect(result).toMatchObject({ username: "jsmith", caseNumber: "55", description: "Fix it" });
  });

  test("accepts case number label variants and keeps only the digits", () => {
    for (const label of ["Case", "Case Id", "Case ID", "Case Number", "Case No", "Case #"]) {
      expect(parseNotes(pkg(`${label}: #19306026`)).caseNumber).toBe("19306026");
    }
    expect(parseNotes(pkg("Case: Case-123")).caseNumber).toBe("123");
  });

  test("ignores comment decorations in front of labels", () => {
    const result = parseNotes(pkg("-- Created By: Jane\n* Case: 7\n// Description: Fix\n/* Script Name: A.pkg */"));
    expect(result).toEqual({ packageName: "A.pkg", username: "Jane", caseNumber: "7", description: "Fix" });
  });

  test("comment lines are never added to the description", () => {
    const notes = "Description: Fix charges\n/* note */\n-- another\n// more\n* star";
    expect(parseNotes(pkg(notes)).description).toBe("Fix charges");
  });

  test("joins a multi-line description until a blank line or the next label", () => {
    const notes = [
      "Created By: Jane",
      "Description: Fix incorrect price",
      "discount records for tenants.",
      "",
      "stray text",
      "Case: 9",
    ].join("\n");
    expect(parseNotes(pkg(notes))).toMatchObject({
      username: "Jane",
      caseNumber: "9",
      description: "Fix incorrect price discount records for tenants.",
    });
  });

  test("description value may start on the next line", () => {
    expect(parseNotes(pkg("Description:\nFix tenants")).description).toBe("Fix tenants");
  });

  test("an unrelated label ends the description", () => {
    expect(parseNotes(pkg("Description: Fix\nDate: 2026-10-26\nmore")).description).toBe("Fix");
  });

  test("returns empty values when nothing is found or the section is missing", () => {
    expect(parseNotes(pkg("just some words"))).toEqual(EMPTY);
    expect(parseNotes("//SQL\nselect 1\n//END SQL")).toEqual(EMPTY);
    expect(parseNotes("//END NOTES\nCreated By: x\n//NOTES")).toEqual(EMPTY);
  });

  test("ignores labels outside the notes section", () => {
    const text = "//NOTES\nx\n//END NOTES\n//SQL\n-- Created By: Someone\n//END SQL";
    expect(parseNotes(text).username).toBe("");
  });
});
