import { readFileSync } from "node:fs";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";

function readPackageScripts(relativePath: string): Record<string, string> {
  const packageJsonPath = path.resolve(import.meta.dirname, "..", relativePath);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };

  return packageJson.scripts ?? {};
}

describe("package scripts", () => {
  it("uses a Node-compatible TypeScript runner for the server dev script", () => {
    const scripts = readPackageScripts("apps/server/package.json");

    assert.equal(
      scripts.dev,
      "tsx src/bin.ts",
      `apps/server dev script should use the exact Windows-safe runtime entrypoint: ${scripts.dev}`,
    );
  });
});
