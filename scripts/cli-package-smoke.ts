import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePnpmWorkspaceConfig } from "./lib/pnpm-workspace.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = resolve(repoRoot, "apps/server");
const serverManifestPath = resolve(serverDir, "package.json");
let tempDir: string | undefined;
let originalManifest: string | undefined;

function run(command: string, args: ReadonlyArray<string>, cwd: string) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_ignore_scripts: "true",
      npm_config_update_notifier: "false",
    },
  });
}

function assertContains(output: string, value: string) {
  if (!output.includes(value)) {
    throw new Error(`Expected packaged CLI output to contain ${JSON.stringify(value)}.`);
  }
}

try {
  originalManifest = readFileSync(serverManifestPath, "utf8");
  tempDir = mkdtempSync(join(repoRoot, "t3-cli-package-smoke-"));
  run(process.execPath, ["apps/server/scripts/cli.ts", "build"], repoRoot);
  const manifest = JSON.parse(originalManifest) as {
    readonly dependencies: Record<string, string>;
  };
  const workspace = parsePnpmWorkspaceConfig(
    readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  writeFileSync(
    serverManifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        dependencies: resolveCatalogDependencies(
          manifest.dependencies,
          workspace.catalog,
          "apps/server",
        ),
      },
      null,
      2,
    )}\n`,
  );
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", tempDir], serverDir),
  ) as ReadonlyArray<{
    readonly filename: string;
  }>;
  if (!packed[0]?.filename) {
    throw new Error("npm pack did not produce a CLI tarball.");
  }
  const tarball = resolve(tempDir, packed[0].filename);

  run("npm", ["init", "--yes"], tempDir);
  run("npm", ["install", "--ignore-scripts", "--no-package-lock", tarball], tempDir);

  for (const args of [
    ["t3", "connect", "--help"],
    ["t3", "connect", "login", "--headless", "--help"],
    ["t3", "connect", "link", "--headless", "--help"],
    ["t3", "connect", "status", "--help"],
  ]) {
    const output = run("npx", ["--offline", "--no-install", ...args], tempDir);
    assertContains(output, "t3 connect");
  }
  assertContains(
    run("npx", ["--offline", "--no-install", "t3", "connect", "--help"], tempDir),
    "logout",
  );
  console.log("Packaged T3 Connect CLI smoke passed.");
} finally {
  if (originalManifest !== undefined) {
    writeFileSync(serverManifestPath, originalManifest);
  }
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
