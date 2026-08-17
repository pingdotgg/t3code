// @effect-diagnostics nodeBuiltinImport:off - Static architecture test scans source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const sourceRoot = NodePath.resolve(import.meta.dirname, "..");
const forbiddenImport =
  /from\s+["'][^"']*(?:ProviderService|ProviderSessionDirectory|ProviderSessionReaper|ProviderCommandReactor|ProviderRuntimeIngestion)[^"']*["']/;
const retiredAgentRuntimePaths = [
  "orchestration/Layers/ProviderCommandReactor.ts",
  "orchestration/Layers/ProviderRuntimeIngestion.ts",
  "orchestration/Services/ProviderCommandReactor.ts",
  "orchestration/Services/ProviderRuntimeIngestion.ts",
] as const;

function productionTypeScriptFiles(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "legacy" ? [] : productionTypeScriptFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

it("retains the application data plane without restoring the V1 agent runtime", () => {
  for (const relativePath of retiredAgentRuntimePaths) {
    assert.isFalse(NodeFS.existsSync(NodePath.join(sourceRoot, relativePath)));
  }
  const violations = productionTypeScriptFiles(sourceRoot).flatMap((path) => {
    const source = NodeFS.readFileSync(path, "utf8");
    return forbiddenImport.test(source) ? [NodePath.relative(sourceRoot, path)] : [];
  });
  assert.deepEqual(violations, []);
});
