import { describe, expect, it } from "@effect/vitest";

import { decodeSourceMap, symbolicateStack, type CompactSourceMap } from "./sourceMap.ts";

// Real `hermesc -O -output-source-map` output and the stack its VM printed: a frame's column is the
// map's 0-based generated column. In `t.js`, alpha throws at 2:18, beta calls it at 5:19, gamma calls
// beta at 8:13, and the top level calls gamma at 10:6.
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

describe("symbolicateStack", () => {
  it("rewrites Hermes bundle frames to their original locations and keeps the rest", () => {
    const map = decodeSourceMap(HERMES_MAP) as CompactSourceMap;
    const result = symbolicateStack(
      `${HERMES_STACK}\n    at apply (native)\n    at tryCallOne (address at InternalBytecode.js:1:89)`,
      map,
      Number.POSITIVE_INFINITY,
    );
    expect(result).toEqual({
      stack: [
        "Error: boom",
        "    at alpha (t.js:2:18)",
        "    at beta (t.js:5:19)",
        "    at gamma (t.js:8:13)",
        "    at global (t.js:10:6)",
        "    at apply (native)",
        "    at tryCallOne (address at InternalBytecode.js:1:89)",
      ].join("\n"),
      bundleFrames: 4,
      mappedFrames: 4,
      growth: -50,
    });
  });
});

describe("decodeSourceMap", () => {
  it("fits a map as large as our iOS release map, read from an OTA bundle's path", () => {
    // 2.1M segments, every other one repeating its predecessor's position, like Hermes output.
    const mappings = `AAAA,${"CAAC,CAAA,".repeat(1_050_000)}CAAC`;
    const map = decodeSourceMap({ version: 3, sources: ["src/App.tsx"], mappings });
    const frame =
      "    at render (address at /var/mobile/Containers/Data/Application/A1/Library/" +
      "Application Support/.expo-internal/bundle:1:4)";
    expect(symbolicateStack(frame, map as CompactSourceMap, Number.POSITIVE_INFINITY).stack).toBe(
      "    at render (src/App.tsx:1:3)",
    );
  });
});
