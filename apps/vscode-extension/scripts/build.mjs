import { cpSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { filterPackagedDependencies } from "./package-dependencies.mjs";

const extensionDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = join(extensionDir, "../..");
const packageJson = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));

function isWindowsHost() {
  return process.env.OS === "Windows_NT";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    shell: isWindowsHost(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function rewriteWebviewBundleAssetPaths(rootDir) {
  for (const entry of readdirSync(rootDir)) {
    const entryPath = join(rootDir, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      rewriteWebviewBundleAssetPaths(entryPath);
      continue;
    }
    if (!/\.(?:html|js)$/.test(entryPath)) {
      continue;
    }

    const before = readFileSync(entryPath, "utf8");
    const after = before
      .replaceAll('"/apple-touch-icon.png"', '"./apple-touch-icon.png"')
      .replaceAll("'/apple-touch-icon.png'", "'./apple-touch-icon.png'")
      .replaceAll("`/apple-touch-icon.png`", "`./apple-touch-icon.png`")
      .replaceAll('"/favicon.ico"', '"./favicon.ico"')
      .replaceAll("'/favicon.ico'", "'./favicon.ico'")
      .replaceAll("`/favicon.ico`", "`./favicon.ico`")
      .replaceAll('"/assets/', '"./assets/')
      .replaceAll("'/assets/", "'./assets/")
      .replaceAll("`/assets/", "`./assets/");
    if (after !== before) {
      writeFileSync(entryPath, after);
    }
  }
}

const distDir = join(extensionDir, "dist");
rmSync(join(distDir, "webview"), { force: true, recursive: true });
rmSync(join(distDir, "server"), { force: true, recursive: true });
rmSync(join(distDir, "node_modules"), { force: true, recursive: true });

run("pnpm", ["run", "build", "--", "--base", "./"], {
  cwd: join(repoRoot, "apps/web"),
});
run("pnpm", ["run", "build:extension"], {
  cwd: extensionDir,
});

cpSync(join(repoRoot, "apps/web/dist"), join(distDir, "webview"), { recursive: true });
rewriteWebviewBundleAssetPaths(join(distDir, "webview"));

writeFileSync(
  join(distDir, "package.json"),
  `${JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: filterPackagedDependencies(packageJson.dependencies),
    },
    null,
    2,
  )}\n`,
);
run("pnpm", ["install", "--prod", "--config.node-linker=hoisted", "--ignore-workspace"], {
  cwd: distDir,
});
