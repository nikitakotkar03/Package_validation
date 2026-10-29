const { analyzeSql, splitStatements } = require("../backend/sqlcheck");

const pkg = (sql) => `//NOTES\nnotes\n//END NOTES\n//SQL\n${sql}\n//END SQL\n`;

describe("backup table join rule", () => {
  test("UPDATE with INNER JOIN to its backup table passes", () => {
    const sql = `
      select * into backup_tenant_datafixhistory from tenant where hmy in (1,2,3)
      update t set t.sstatus = 'x'
      from tenant t
      inner join backup_tenant_datafixhistory b on b.hmy = t.hmy
    `;
    expect(analyzeSql(pkg(sql))).toEqual({ errors: [], warnings: [] });
  });

  test("DELETE with INNER JOIN to its backup table passes", () => {
    const sql = `
      delete t from tenant t
      inner join dbo.backup_tenant_datafixhistory b on b.hmy = t.hmy;
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test("UPDATE without the join fails", () => {
    const errors = analyzeSql(pkg("update tenant set sstatus = 'x' where hmy = 5")).errors;
    expect(errors).toEqual(["UPDATE on tenant must INNER JOIN backup_tenant_datafixhistory."]);
  });

  test("DELETE without the join fails", () => {
    const errors = analyzeSql(pkg("delete from tenant where hmy = 5")).errors;
    expect(errors).toEqual(["DELETE on tenant must INNER JOIN backup_tenant_datafixhistory."]);
  });

  test("joining a different table's backup fails", () => {
    const sql = "update t set a = 1 from tenant t inner join backup_unit_datafixhistory b on b.hmy = t.hmy";
    expect(analyzeSql(pkg(sql)).errors).toHaveLength(1);
  });

  test("LEFT JOIN to the backup does not count", () => {
    const sql = "update t set a = 1 from tenant t left join backup_tenant_datafixhistory b on b.hmy = t.hmy";
    expect(analyzeSql(pkg(sql)).errors).toHaveLength(1);
  });

  test("is case-insensitive and handles brackets and schema", () => {
    const sql = "UPDATE T SET A = 1 FROM [dbo].[Tenant] T INNER JOIN [dbo].[BACKUP_TENANT_DATAFIXHISTORY] B ON B.hmy = T.hmy";
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test("temp tables and comments are ignored", () => {
    const sql = `
      -- update tenant set x = 1
      /* delete from tenant */
      update #work set a = 1
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test("checks every statement and reports each table once", () => {
    const sql = `
      update tenant set a = 1 where hmy = 1
      update tenant set a = 2 where hmy = 2
      delete from unit where hmy = 3
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([
      "UPDATE on tenant must INNER JOIN backup_tenant_datafixhistory.",
      "DELETE on unit must INNER JOIN backup_unit_datafixhistory.",
    ]);
  });

  test("no SQL section means nothing to analyze", () => {
    expect(analyzeSql("//NOTES\nx\n//END NOTES")).toEqual({ errors: [], warnings: [] });
  });
});

describe("record count rule", () => {
  const list = (n) => Array.from({ length: n }, (_, i) => i + 1).join(",");

  test("backup and update with the same count pass", () => {
    const sql = `
      select * into backup_tenant_datafixhistory from tenant where hmy in (${list(20)})
      update t set a = 1 from tenant t inner join backup_tenant_datafixhistory b on b.hmy = t.hmy where t.hmy in (${list(20)})
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test("update covering fewer records than the backup fails", () => {
    const sql = `
      select * into backup_tenant_datafixhistory from tenant where hmy in (${list(20)})
      update t set a = 1 from tenant t inner join backup_tenant_datafixhistory b on b.hmy = t.hmy where t.hmy in (${list(19)})
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([
      "Only 19 of the 20 records in backup_tenant_datafixhistory are updated/deleted (not covered: 20).",
    ]);
  });

  test("update touching records that were not backed up fails", () => {
    const sql = `
      select * into backup_tenant_datafixhistory from tenant where hmy in (${list(20)})
      update t set a = 1 from tenant t inner join backup_tenant_datafixhistory b on b.hmy = t.hmy where t.hmy in (${list(21)})
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([
      "UPDATE on tenant touches 1 record(s) that are not in backup_tenant_datafixhistory (21).",
    ]);
  });

  const upd = (ids) =>
    `update t set a = 1 from trans t inner join backup_trans_datafixhistory b on b.hmy = t.hmy where t.hmy in (${ids})`;
  const del = (ids) =>
    `delete t from trans t inner join backup_trans_datafixhistory b on b.hmy = t.hmy where t.hmy in (${ids})`;
  const backup = (ids) => `insert into backup_trans_datafixhistory select * from trans where hmy in (${ids})`;

  describe("one backup shared by several statements", () => {
    test("update and delete that split the backed-up records pass", () => {
      const sql = [backup("1,2,3,4"), upd("1,2"), del("3,4")].join("\n");
      expect(analyzeSql(pkg(sql)).errors).toEqual([]);
    });

    test("update and delete that both use all backed-up records pass", () => {
      const sql = [backup("1,2,3,4"), upd("1,2,3,4"), del("1,2,3,4")].join("\n");
      expect(analyzeSql(pkg(sql)).errors).toEqual([]);
    });

    test("statements that together miss a backed-up record fail", () => {
      const sql = [backup("1,2,3,4"), upd("1,2"), del("3")].join("\n");
      expect(analyzeSql(pkg(sql)).errors).toEqual([
        "Only 3 of the 4 records in backup_trans_datafixhistory are updated/deleted (not covered: 4).",
      ]);
    });

    test("a statement touching a record outside the backup fails", () => {
      const sql = [backup("1,2,3,4"), upd("1,2"), del("3,4,9")].join("\n");
      expect(analyzeSql(pkg(sql)).errors).toEqual([
        "DELETE on trans touches 1 record(s) that are not in backup_trans_datafixhistory (9).",
      ]);
    });

    test("a join-only statement is assumed to cover the whole backup", () => {
      const joinOnly = "delete t from trans t inner join backup_trans_datafixhistory b on b.hmy = t.hmy";
      const sql = [backup("1,2,3,4"), upd("1,2"), joinOnly].join("\n");
      expect(analyzeSql(pkg(sql)).errors).toEqual([]);
    });

    test("two backup inserts in a row form one backup", () => {
      const sql = [backup("1,2"), backup("3,4"), upd("1,2,3,4")].join("\n");
      expect(analyzeSql(pkg(sql)).errors).toEqual([]);
    });
  });

  describe("a separate backup for each statement", () => {
    test("each update matching its own backup passes", () => {
      const sql = [backup("1,2"), upd("1,2"), backup("3,4,5"), del("3,4,5")].join("\n");
      expect(analyzeSql(pkg(sql)).errors).toEqual([]);
    });

    test("an update that uses the other backup's records fails", () => {
      const sql = [backup("1,2"), upd("1,2"), backup("3,4,5"), del("3,4")].join("\n");
      expect(analyzeSql(pkg(sql)).errors).toEqual([
        "Only 2 of the 3 records in backup_trans_datafixhistory are updated/deleted (not covered: 5).",
      ]);
      const crossed = [backup("1,2"), upd("1,2"), backup("3,4"), del("1,2")].join("\n");
      expect(analyzeSql(pkg(crossed)).errors.length).toBeGreaterThan(0);
    });

    test("record totals add up across backups for the Seniors warning", () => {
      const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i).join(",");
      const sql = [backup(ids(1, 15)), upd(ids(1, 15)), backup(ids(16, 30)), del(ids(16, 30))].join("\n");
      const { errors, warnings } = analyzeSql(pkg(sql));
      expect(errors).toEqual([]);
      expect(warnings[1]).toMatch(/30 records in trans.*Seniors/);
    });

    test("the same records backed up twice are counted once", () => {
      const ids = Array.from({ length: 15 }, (_, i) => i + 1).join(",");
      const sql = [backup(ids), upd(ids), backup(ids), del(ids)].join("\n");
      expect(analyzeSql(pkg(sql)).warnings).toHaveLength(1);
    });
  });

  test("unknown counts are not flagged", () => {
    const sql = `
      select * into backup_tenant_datafixhistory from tenant where hmy in (select hmy from x)
      update t set a = 1 from tenant t inner join backup_tenant_datafixhistory b on b.hmy = t.hmy
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });
});

describe("warnings", () => {
  const trans = (n) => {
    const ids = Array.from({ length: n }, (_, i) => i + 1).join(",");
    return `
      insert into backup_trans_datafixhistory select * from trans where hmy in (${ids})
      update t set t.stotal = 0 from trans t inner join backup_trans_datafixhistory b on b.hmy = t.hmy
    `;
  };

  test("updating trans warns to recheck data and post month", () => {
    const { errors, warnings } = analyzeSql(pkg(trans(10)));
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/check the data once again and check the post month/);
  });

  test("camcharg also warns", () => {
    const sql = "update c set a = 1 from camcharg c inner join backup_camcharg_datafixhistory b on b.hmy = c.hmy";
    expect(analyzeSql(pkg(sql)).warnings[0]).toMatch(/camcharg/);
  });

  test("exactly 25 records does not trigger the Seniors warning", () => {
    expect(analyzeSql(pkg(trans(25))).warnings).toHaveLength(1);
  });

  test("more than 25 records adds the Seniors warning", () => {
    const { warnings } = analyzeSql(pkg(trans(26)));
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/26 records in trans.*Seniors/);
  });

  test("non-transaction tables never warn", () => {
    const sql = "update t set a = 1 from tenant t inner join backup_tenant_datafixhistory b on b.hmy = t.hmy";
    expect(analyzeSql(pkg(sql)).warnings).toEqual([]);
  });
});

describe("SQL comments are ignored", () => {
  const JOIN = "inner join backup_tenant_datafixhistory b on b.hmy = t.hmy";
  const MISSING_JOIN = ["UPDATE on tenant must INNER JOIN backup_tenant_datafixhistory."];

  test("a statement inside a line or block comment is not analyzed", () => {
    const sql = `
      -- update tenant set a = 1
      /* delete from unit where hmy = 5 */
      /* update tenant
         set a = 2 */
      select 1
    `;
    expect(analyzeSql(pkg(sql))).toEqual({ errors: [], warnings: [] });
  });

  test("a join that is commented out does not count", () => {
    expect(analyzeSql(pkg(`update t set a = 1 from tenant t -- ${JOIN}`)).errors).toEqual(MISSING_JOIN);
    expect(analyzeSql(pkg(`update t set a = 1 from tenant t /* ${JOIN} */`)).errors).toEqual(MISSING_JOIN);
  });

  test("comments between the parts of a real statement do not break it", () => {
    const sql = `
      update t set a = 1 -- first change
      from tenant t /* the table */
      ${JOIN} /* the backup */ -- done
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test("block comments nest", () => {
    const sql = "/* outer /* inner */ delete from tenant where hmy = 1 */ update #work set a = 1";
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test("a comment never glues two words together", () => {
    expect(analyzeSql(pkg("update/**/tenant set a = 1")).errors).toEqual(MISSING_JOIN);
    expect(analyzeSql(pkg("update tenant set a = 1--note")).errors).toEqual(MISSING_JOIN);
  });

  test("comment markers inside strings or bracketed names are not comments", () => {
    const withString = `update t set t.note = 'x -- y' from tenant t ${JOIN}`;
    const withBlock = `update t set t.note = 'a /* b' from tenant t ${JOIN}`;
    const withEscapedQuote = `update t set t.note = 'it''s -- fine' from tenant t ${JOIN}`;
    const withBracket = `update t set [a--b] = 1 from tenant t ${JOIN}`;
    for (const sql of [withString, withBlock, withEscapedQuote, withBracket]) {
      expect(analyzeSql(pkg(sql)).errors).toEqual([]);
    }
  });

  test("commented-out statements raise no warnings either", () => {
    const sql = "-- update trans set a = 1\n/* delete from camcharg */\nselect 1";
    expect(analyzeSql(pkg(sql))).toEqual({ errors: [], warnings: [] });
  });
});

describe("the //SQL section must contain executable SQL", () => {
  const NO_SQL = "The //SQL section contains no executable SQL.";

  test.each([
    ["nothing at all", ""],
    ["only blank lines", "\n   \n\t\n"],
    ["only a -- comment", "-- nothing to run here"],
    ["only a /* */ comment", "/* update tenant set a = 1 */"],
    ["only a multi-line /* */ comment", "/*\n  delete from tenant\n*/"],
    ["only comments of both valid kinds", "-- a\n/* b */\n-- c"],
    ["only GO and semicolons", "GO\n;\n  go  \n;;"],
  ])("%s is an error", (_label, sql) => {
    expect(analyzeSql(pkg(sql))).toEqual({ errors: [NO_SQL], warnings: [] });
  });

  test("comments around a real statement are fine", () => {
    const sql = "/* header */\n-- note\nselect 1\n/* footer */";
    expect(analyzeSql(pkg(sql))).toEqual({ errors: [], warnings: [] });
  });

  test("the section directly followed by its end marker is empty", () => {
    expect(analyzeSql("//NOTES\nx\n//END NOTES\n//SQL\n//END SQL\n").errors).toEqual([NO_SQL]);
  });

  test("a missing //SQL section is left to the marker check, not reported here", () => {
    expect(analyzeSql("//NOTES\nx\n//END NOTES\n")).toEqual({ errors: [], warnings: [] });
  });

  test("an update inside the commented-out text is not analyzed, so nothing else is reported", () => {
    const errors = analyzeSql(pkg("/* update trans set a = 1 */")).errors;
    expect(errors).toEqual([NO_SQL]);
  });
});

describe("// is not a valid SQL comment, but /* */ and -- are", () => {
  const slash = (lines) =>
    `The //SQL section uses // for a comment on line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}, ` +
    "which is not valid SQL. Use -- or /* ... */ instead.";

  test("a // comment line is an error, with its line in the package", () => {
    // pkg(): //SQL is line 4, so the first SQL line is line 5.
    expect(analyzeSql(pkg("select 1\n// a note")).errors).toEqual([slash([6])]);
  });

  test("a // comment after a statement is an error too", () => {
    expect(analyzeSql(pkg("select 1 // trailing note")).errors).toEqual([slash([5])]);
  });

  test("every offending line is listed in one error", () => {
    expect(analyzeSql(pkg("// first\nselect 1\n// second\nselect 2 // third")).errors).toEqual([slash([5, 7, 8])]);
  });

  test("a section made only of // lines has both problems", () => {
    expect(analyzeSql(pkg("// nothing\n// to run")).errors).toEqual([
      slash([5, 6]),
      "The //SQL section contains no executable SQL.",
    ]);
  });

  test("the text of a // comment is ignored by the other checks", () => {
    const sql = "// update tenant set a = 1\n// delete from trans where hmy = 1\nselect 1";
    const { errors, warnings } = analyzeSql(pkg(sql));
    expect(errors).toEqual([slash([5, 6])]); // no missing-join error, no trans warning
    expect(warnings).toEqual([]);
  });

  test("real statements are still checked next to a // comment", () => {
    const errors = analyzeSql(pkg("// note\nupdate tenant set a = 1 where hmy = 1")).errors;
    expect(errors).toEqual([slash([5]), "UPDATE on tenant must INNER JOIN backup_tenant_datafixhistory."]);
  });

  test.each([
    ["a -- comment", "select 1 -- see http://example.com"],
    ["a /* */ comment", "select 1 /* see http://example.com */"],
    ["a multi-line /* */ comment", "/* line one\n   // looks like a comment\n   line three */\nselect 1"],
    ["a string", "select 'http://example.com'"],
    ["a bracketed name", "select [a//b] from t"],
    ["a -- comment holding //", "-- // not a slash comment\nselect 1"],
  ])("// inside %s is not an error", (_label, sql) => {
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test("block and line comments are accepted without any error", () => {
    const sql = "/* Created for case 123 */\n-- tenant fix\nselect 1\n/* end */";
    expect(analyzeSql(pkg(sql))).toEqual({ errors: [], warnings: [] });
  });

  test("the //END SQL marker line itself is never read as a comment", () => {
    expect(analyzeSql("//NOTES\nx\n//END NOTES\n//SQL\nselect 1\n//END SQL\n").errors).toEqual([]);
  });
});

describe("only trans and camcharg trigger the transaction warning", () => {
  const upd = (table) =>
    `update t set a = 1 from ${table} t inner join backup_${table}_datafixhistory b on b.hmy = t.hmy`;

  test.each(["trans", "camcharg"])("%s warns", (table) => {
    expect(analyzeSql(pkg(upd(table))).warnings).toHaveLength(1);
  });

  test.each(["camcharge", "transaction", "tenant", "unit"])("%s does not warn", (table) => {
    expect(analyzeSql(pkg(upd(table))).warnings).toEqual([]);
  });
});

describe("property UPDATE or DELETE must include iTypeStorage <> 0", () => {
  const join = "inner join backup_property_datafixhistory b on b.hmy = p.hmy";
  const MISSING = (type) => `${type} on property must include the condition iTypeStorage <> 0.`;

  test("an UPDATE with the condition passes", () => {
    const sql = `update p set p.sname = 'x' from property p ${join} where p.iTypeStorage <> 0`;
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test("a DELETE with the condition passes", () => {
    const sql = `delete p from property p ${join} where p.iTypeStorage <> 0`;
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test("an UPDATE or DELETE without the condition fails", () => {
    expect(analyzeSql(pkg(`update p set p.sname = 'x' from property p ${join}`)).errors).toEqual([MISSING("UPDATE")]);
    expect(analyzeSql(pkg(`delete p from property p ${join}`)).errors).toEqual([MISSING("DELETE")]);
  });

  test("a plain UPDATE on the table name is checked too, and both problems are reported", () => {
    const errors = analyzeSql(pkg("update property set sname = 'x' where hmy = 5")).errors;
    expect(errors).toEqual([
      "UPDATE on property must INNER JOIN backup_property_datafixhistory.",
      MISSING("UPDATE"),
    ]);
  });

  test.each([
    ["no spaces", "where p.iTypeStorage<>0"],
    ["!= instead of <>", "where p.iTypeStorage != 0"],
    ["upper case", "WHERE P.ITYPESTORAGE <> 0"],
    ["no alias", "where iTypeStorage <> 0 and p.hmy > 1"],
    ["brackets", "where p.[iTypeStorage] <> 0"],
    ["inside the join condition", ""],
  ])("the condition is recognised: %s", (_label, where) => {
    const onClause = where ? "" : " and p.iTypeStorage <> 0";
    const sql = `update p set a = 1 from property p inner join backup_property_datafixhistory b on b.hmy = p.hmy${onClause} ${where}`;
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });

  test.each([
    ["= 0", "where p.iTypeStorage = 0"],
    ["<> 1", "where p.iTypeStorage <> 1"],
    ["a longer number", "where p.iTypeStorage <> 05"],
    ["a different column", "where p.iTypeStorageX <> 0"],
    ["only a similar name", "where p.sTypeStorage <> 0"],
    ["the misspelt column iTypeStorge", "where p.iTypeStorge <> 0"],
  ])("the condition is not satisfied by %s", (_label, where) => {
    const sql = `update p set a = 1 from property p ${join} ${where}`;
    expect(analyzeSql(pkg(sql)).errors).toEqual([MISSING("UPDATE")]);
  });

  test("a commented-out condition does not count", () => {
    const line = `update p set a = 1 from property p ${join} -- where p.iTypeStorage <> 0`;
    const block = `update p set a = 1 from property p ${join} /* where p.iTypeStorage <> 0 */`;
    expect(analyzeSql(pkg(line)).errors).toEqual([MISSING("UPDATE")]);
    expect(analyzeSql(pkg(block)).errors).toEqual([MISSING("UPDATE")]);
  });

  test("each statement needs its own condition", () => {
    const sql = `
      update p set a = 1 from property p ${join} where p.iTypeStorage <> 0
      delete p from property p ${join}
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([MISSING("DELETE")]);
  });

  test("other tables are not affected, including names that only start with property", () => {
    const sql = `
      update t set a = 1 from tenant t inner join backup_tenant_datafixhistory b on b.hmy = t.hmy
      update x set a = 1 from propertyextra x inner join backup_propertyextra_datafixhistory b on b.hmy = x.hmy
    `;
    expect(analyzeSql(pkg(sql)).errors).toEqual([]);
  });
});

describe("splitStatements", () => {
  test("splits on keywords, semicolons and GO but not inside parentheses", () => {
    const parts = splitStatements(
      "update a set x = 1\nupdate b set y = (\nselect 1\n)\ngo\ndelete from c;\ninsert into d\nselect * from e"
    );
    expect(parts).toEqual([
      "update a set x = 1",
      "update b set y = ( select 1 )",
      "delete from c",
      "insert into d select * from e",
    ]);
  });
});
