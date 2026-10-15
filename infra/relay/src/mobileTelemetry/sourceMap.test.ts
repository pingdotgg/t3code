import { describe, expect, it } from "@effect/vitest";

import { decodeSourceMap, originalPositionFor, symbolicateStack } from "./sourceMap.ts";

/**
 * `hermesc -O -emit-binary -output-source-map` output for HERMES_SOURCE, and
 * the stack the Hermes VM printed running it. Real Hermes output pins the
 * convention that a frame's column is the map's 0-based generated column.
 */
const HERMES_SOURCE = [
  "function alpha() {",
  '  throw new Error("boom");',
  "}",
  "function beta() {",
  "  return 1 + alpha();",
  "}",
  "function gamma() {",
  "  try { beta(); } catch (e) { print(e.stack); }",
  "}",
  "gamma();",
].join("\n");
const HERMES_MAP = {
  version: 3,
  sources: ["t.js"],
  mappings:
    "AAAA,iBAAA,OAAA,MAAA,KAAA,MAAA,KAAA,MASA,OAAK,IAAE,EATP,EACY,MAAK,KAAA,WAAA,IAAA,IAAf,EAEF,EACa,OAAK,OAAT,IAAP,EAEF,AACE,EAAM,OAAI,IAAI,EAAE,IAAY,MAAO,OAAF,KAAW,EAC9C;",
  x_hermes_function_offsets: { "0": [0, 65, 99, 121] },
};
const HERMES_STACK = [
  "Error: boom",
  "    at alpha (address at t.hbc:1:89)",
  "    at beta (address at t.hbc:1:108)",
  "    at gamma (address at t.hbc:1:130)",
  "    at global (address at t.hbc:1:59)",
].join("\n");

const sourceLine = (line: number) => HERMES_SOURCE.split("\n")[line - 1]!;

describe("decodeSourceMap", () => {
  it("resolves Hermes bytecode offsets to the calls that threw", () => {
    const map = decodeSourceMap(HERMES_MAP)!;
    const alpha = originalPositionFor(map, 1, 89)!;
    expect(alpha).toEqual({ source: "t.js", line: 2, column: 17 });
    expect(sourceLine(alpha.line).slice(alpha.column)).toBe('("boom");');
    const beta = originalPositionFor(map, 1, 108)!;
    expect(sourceLine(beta.line).slice(beta.column)).toBe("();");
  });

  it("takes the first segment when a column is mapped twice", () => {
    // Offset 121 starts `gamma`: mapped to the declaration, then to `try`.
    const map = decodeSourceMap(HERMES_MAP)!;
    expect(originalPositionFor(map, 1, 121)).toEqual({ source: "t.js", line: 7, column: 0 });
    expect(originalPositionFor(map, 1, 122)).toEqual({ source: "t.js", line: 8, column: 2 });
  });

  it("decodes maps with several generated lines and a source root", () => {
    // Line 1: col 0 -> a.js 1:0. Line 3: col 4 -> b.js 3:2, then a column with no source.
    const map = decodeSourceMap({
      version: 3,
      sourceRoot: "/app",
      sources: ["a.js", "b.js"],
      mappings: "AAAA;;ICEE,E",
    })!;
    expect(originalPositionFor(map, 1, 10)).toEqual({ source: "/app/a.js", line: 1, column: 0 });
    expect(originalPositionFor(map, 2, 0)).toBeUndefined();
    expect(originalPositionFor(map, 3, 3)).toBeUndefined();
    expect(originalPositionFor(map, 3, 5)).toEqual({ source: "/app/b.js", line: 3, column: 2 });
    expect(originalPositionFor(map, 3, 6)).toBeUndefined();
    expect(originalPositionFor(map, 4, 0)).toBeUndefined();
  });

  it("rejects what is not a version 3 map", () => {
    expect(decodeSourceMap(undefined)).toBeUndefined();
    expect(decodeSourceMap({ version: 2, sources: [], mappings: "" })).toBeUndefined();
    expect(decodeSourceMap({ version: 3, sections: [] })).toBeUndefined();
    expect(decodeSourceMap({ version: 3, sources: ["a.js"], mappings: "AA!A" })).toBeUndefined();
    expect(decodeSourceMap({ version: 3, sources: ["a.js"], mappings: "AAA" })).toBeUndefined();
  });
});

describe("symbolicateStack", () => {
  it("rewrites bundle frames to original locations and keeps everything else", () => {
    const map = decodeSourceMap(HERMES_MAP)!;
    const result = symbolicateStack(
      `${HERMES_STACK}\n    at apply (native)\n    at loop (InternalBytecode.js:1:1)`,
      map,
    );
    expect(result).toEqual({
      stack: [
        "Error: boom",
        "    at alpha (t.js:2:18)",
        "    at beta (t.js:5:19)",
        "    at gamma (t.js:8:13)",
        "    at global (t.js:10:6)",
        "    at apply (native)",
        "    at loop (InternalBytecode.js:1:1)",
      ].join("\n"),
      bundleFrames: 4,
      mappedFrames: 4,
    });
  });

  it("leaves frames the map does not cover as they were", () => {
    const map = decodeSourceMap({ version: 3, sources: ["a.js"], mappings: "kBAAA" })!;
    const stack = "Error\n    at f (address at index.android.bundle:1:3)";
    expect(symbolicateStack(stack, map)).toEqual({ stack, bundleFrames: 1, mappedFrames: 0 });
  });
});
