// @effect-diagnostics nodeBuiltinImport:off -- The grep converter is read synchronously from the installed SDK chunk.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

// The SDK does not export its grep result converter, so find it in the installed build's chunks.
const loadInstalledCursorGrepResultConverter = (build: "esm" | "cjs") => {
  const sdkEntry = NodeModule.createRequire(import.meta.url).resolve("@cursor/sdk");
  const buildDir = NodePath.join(NodePath.dirname(sdkEntry), "..", build);
  const anchorPattern =
    /function [\w$]+\(e\)\{if\(e\?\.result\?\.case\)switch\(e\.result\.case\)\{case"content":return\{type:"content"/;
  const chunk = NodeFS.readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => NodeFS.readFileSync(NodePath.join(buildDir, name), "utf8"))
    .find((source) => anchorPattern.test(source));
  assert.isDefined(chunk, `Cursor SDK grep result converter not found in ${buildDir}`);
  const anchor = chunk.search(anchorPattern);
  let depth = 0;
  let end = chunk.indexOf("{", anchor);
  for (; end < chunk.length; end++) {
    if (chunk[end] === "{") depth++;
    if (chunk[end] === "}" && --depth === 0) break;
  }
  return new Function(`return (${chunk.slice(anchor, end + 1)})`)() as (result: unknown) => unknown;
};

describe("Cursor SDK patch", () => {
  it.each(["esm", "cjs"] as const)(
    "keeps grouped grep content match text, lines, and totals in the %s Cursor SDK build",
    (build) => {
      const convertGrepResult = loadInstalledCursorGrepResultConverter(build);

      assert.deepEqual(
        convertGrepResult({
          result: {
            case: "content",
            value: {
              matches: [
                {
                  file: "src/one.ts",
                  matches: [
                    { lineNumber: 10, content: "before one", isContextLine: true },
                    { lineNumber: 11, content: "needle one", isContextLine: false },
                    { lineNumber: 12, content: "after one", isContextLine: true },
                  ],
                },
                {
                  file: "src/two.ts",
                  matches: [{ lineNumber: 3, content: "needle two", isContextLine: false }],
                },
              ],
              totalLines: 4,
              totalMatchedLines: 7,
              clientTruncated: true,
              ripgrepTruncated: false,
            },
          },
        }),
        {
          type: "content",
          output: {
            matches: [
              {
                file: "src/one.ts",
                lineNumber: 11,
                line: "needle one",
                beforeContext: ["before one"],
                afterContext: ["after one"],
              },
              { file: "src/two.ts", lineNumber: 3, line: "needle two" },
            ],
            totalMatches: 7,
          },
        },
      );
    },
  );
});
