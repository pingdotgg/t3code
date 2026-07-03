import { describe, expect, it } from "vite-plus/test";

import { prepareSourceFileDocument } from "./source-file-document";

describe("prepareSourceFileDocument", () => {
  it("normalizes and serializes source rows once for repeated consumers", () => {
    const first = prepareSourceFileDocument("const value = 1;\r\n\tvalue;\r");
    const second = prepareSourceFileDocument("const value = 1;\r\n\tvalue;\r");
    const rows = JSON.parse(first.rowsJson) as ReadonlyArray<{ readonly content: string }>;

    expect(first.contents).toBe("const value = 1;\n\tvalue;\n");
    expect(first.lines).toEqual(["const value = 1;", "\tvalue;", ""]);
    expect(rows.map((row) => row.content)).toEqual(["const value = 1;", "    value;", ""]);
    expect(second).toBe(first);
  });
});
