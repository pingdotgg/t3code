import { describe, expect, it } from "vite-plus/test";
import { filePreviewDelimiter, parseDelimitedPreview } from "./delimitedPreview.ts";

describe("delimited file previews", () => {
  it("respects a specific MIME type before the extension", () => {
    expect(filePreviewDelimiter({ name: "data.CSV", mimeType: "text/plain" })).toBe(",");
    expect(filePreviewDelimiter({ name: "data.csv", mimeType: "application/pdf" })).toBeNull();
  });
  it("preserves quoted separators, escaped quotes, blank cells and line breaks", () => {
    expect(
      parseDelimitedPreview('\ufeffname,notes,empty\r\n"A, B","say ""hi""\nagain",\r\n', ","),
    ).toEqual({
      rows: [
        ["name", "notes", "empty"],
        ["A, B", 'say "hi"\nagain', ""],
      ],
      truncated: false,
    });
    expect(parseDelimitedPreview("one\ttwo\n\tthree", "\t").rows).toEqual([
      ["one", "two"],
      ["", "three"],
    ]);
  });
  describe.each([",", "\t"] as const)("with delimiter %j", (delimiter) => {
    it("preserves a final quoted empty record without requiring a line ending", () => {
      for (const ending of ["", "\n", "\r\n"]) {
        expect(parseDelimitedPreview(`name\r\nAlice\r\n""${ending}`, delimiter)).toEqual({
          rows: [["name"], ["Alice"], [""]],
          truncated: false,
        });
      }
      expect(parseDelimitedPreview('""', delimiter)).toEqual({
        rows: [[""]],
        truncated: false,
      });
    });
    it("does not invent records for empty input or a trailing line ending", () => {
      for (const prefix of ["", "\ufeff"]) {
        expect(parseDelimitedPreview(prefix, delimiter).rows).toEqual([]);
        expect(parseDelimitedPreview(`${prefix}name\r\n`, delimiter).rows).toEqual([["name"]]);
        expect(parseDelimitedPreview(`${prefix}""`, delimiter).rows).toEqual([[""]]);
      }
    });
    it("keeps a quoted empty record at the row limit", () => {
      const text = `${"name\n".repeat(99)}""`;
      const preview = parseDelimitedPreview(text, delimiter);
      expect(preview.rows).toHaveLength(100);
      expect(preview.rows.at(-1)).toEqual([""]);
      expect(preview.truncated).toBe(false);
      expect(parseDelimitedPreview(`${text}\nextra`, delimiter).truncated).toBe(true);
    });
  });
  it("bounds rows, columns and cell length and reports partial content", () => {
    const table = parseDelimitedPreview(
      Array.from({ length: 101 }, () =>
        Array.from({ length: 31 }, () => "x".repeat(2001)).join(","),
      ).join("\n"),
      ",",
    );
    expect(table.truncated).toBe(true);
    expect(table.rows).toHaveLength(100);
    expect(table.rows[0]).toHaveLength(30);
    expect(table.rows[0]?.[0]).toHaveLength(2000);
    expect(parseDelimitedPreview('a,"unfinished', ",").truncated).toBe(true);
  });
});
