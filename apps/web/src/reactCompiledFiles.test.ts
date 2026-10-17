// @effect-diagnostics nodeBuiltinImport:off - compiles real source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { transform } from "oxc-transform-react";
import { describe, expect, it } from "vite-plus/test";
import { REACT_COMPILED_FILES } from "../reactCompiledFiles";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

function expandPattern(pattern: string): string[] {
  if (!pattern.endsWith("/**")) return [pattern];
  const directory = pattern.slice(0, -3);
  return NodeFS.readdirSync(NodePath.join(repoRoot, directory), { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file))
    .map((file) => `${directory}/${file}`);
}

// Lint reports most compiler bailouts, but not every one (try/finally, throw
// inside try). A skipped file still builds, just unmemoized, so check the output.
describe("React Compiler coverage", () => {
  it.each(REACT_COMPILED_FILES.flatMap(expandPattern))("compiles %s", async (file) => {
    const absolute = NodePath.join(repoRoot, file);
    const result = await transform(absolute, NodeFS.readFileSync(absolute, "utf8"), {
      jsx: { runtime: "automatic", development: false, refresh: false },
      reactCompiler: { reportDiagnostics: true },
    });
    const bailouts = result.errors.map((error) => error.codeframe ?? error.message);
    expect(bailouts).toEqual([]);
  });
}, 120_000);
