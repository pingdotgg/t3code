// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledCliPath = resolve(serverRoot, "dist/bin.mjs");

if (!existsSync(bundledCliPath)) {
  throw new Error(`Missing bundled CLI at ${bundledCliPath}. Run the server build first.`);
}

const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-bundle-smoke-base-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-bundle-smoke-workspace-"));

try {
  const output = execFileSync(
    process.execPath,
    [
      bundledCliPath,
      "project",
      "add",
      workspaceRoot,
      "--title",
      "Bundle Smoke",
      "--base-dir",
      baseDir,
    ],
    {
      cwd: serverRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  if (!output.includes("Added project")) {
    throw new Error(`Bundled CLI smoke did not add a project. Output:\n${output}`);
  }

  Effect.runSync(Console.log("Bundled CLI smoke checks passed."));
} finally {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
