import { describe, expect, it } from "vitest";
import { mariaDbPreview } from "./mariaDbPreview.js";

describe("mariaDbPreview", () => {
  it("shows SQL before output is fetched and adds returned rows when available", () => {
    expect(
      mariaDbPreview("mariadb.execute_sql", { sql: "SELECT  * FROM users" }, undefined, false),
    ).toBe("SELECT * FROM users");
    expect(
      mariaDbPreview(
        "mariadb.execute_sql",
        { sql: "SELECT * FROM users" },
        { structuredContent: { rows: [{ id: 1 }] } },
        false,
      ),
    ).toBe("SELECT * FROM users · 1 row");
  });
  it("summarizes connections and table columns from text results", () => {
    expect(
      mariaDbPreview(
        "mariadb.list_connections",
        {},
        { structuredContent: { connections: ["dev", "prod"], active: "dev" } },
        false,
      ),
    ).toBe("2 connections · dev active");
    expect(
      mariaDbPreview(
        "mariadb.describe_table",
        { database: "app", table: "users" },
        { content: [{ text: '{"columns":[{},{}]}' }] },
        false,
      ),
    ).toBe("app.users · 2 columns");
  });
  it("preserves SQL errors and leaves other servers alone", () => {
    expect(
      mariaDbPreview("mariadb.execute_sql", {}, { content: [{ text: "syntax error" }] }, true),
    ).toBe("syntax error");
    expect(
      mariaDbPreview("other.execute_sql", { sql: "SELECT 1" }, undefined, false),
    ).toBeUndefined();
  });
});
