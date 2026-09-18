import { describe, expect, it } from "vite-plus/test";

import { boundedSelectableSourceTokens, prepareSourceFileDocument } from "./source-file-document";

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

it("bounds selectable highlighting without allocating spans for huge files", () => {
  const token = { content: "text", color: "#fff", fontStyle: null };
  const small = [[token]];
  expect(boundedSelectableSourceTokens(small)).toBe(small);
  expect(boundedSelectableSourceTokens(null)).toBeNull();
  expect(boundedSelectableSourceTokens(Array.from({ length: 20_000 }, () => [token]))).toBeNull();
  expect(boundedSelectableSourceTokens([Array.from({ length: 2_000 }, () => token)])).toBeNull();
  const longPlainText = "full contents\n".repeat(50_000);
  expect(prepareSourceFileDocument(longPlainText).contents).toBe(longPlainText);
});
