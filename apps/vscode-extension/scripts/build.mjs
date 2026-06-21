import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

import { filterPackagedDependencies } from "./package-dependencies.mjs";

const extensionDir = NodePath.dirname(
  NodeURL.fileURLToPath(new URL("../package.json", import.meta.url)),
);
const repoRoot = NodePath.join(extensionDir, "../..");
const packageJson = JSON.parse(
  NodeFS.readFileSync(NodePath.join(extensionDir, "package.json"), "utf8"),
);

function isWindowsHost() {
  return process.env.OS === "Windows_NT";
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
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
  for (const entry of NodeFS.readdirSync(rootDir)) {
    const entryPath = NodePath.join(rootDir, entry);
    const stat = NodeFS.statSync(entryPath);
    if (stat.isDirectory()) {
      rewriteWebviewBundleAssetPaths(entryPath);
      continue;
    }
    if (!/\.(?:html|js)$/.test(entryPath)) {
      continue;
    }

    const before = NodeFS.readFileSync(entryPath, "utf8");
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
      NodeFS.writeFileSync(entryPath, after);
    }
  }
}

const distDir = NodePath.join(extensionDir, "dist");
NodeFS.rmSync(NodePath.join(distDir, "webview"), { force: true, recursive: true });
NodeFS.rmSync(NodePath.join(distDir, "server"), { force: true, recursive: true });
NodeFS.rmSync(NodePath.join(distDir, "node_modules"), { force: true, recursive: true });

run("pnpm", ["run", "build", "--", "--base", "./"], {
  cwd: NodePath.join(repoRoot, "apps/web"),
});
run("pnpm", ["run", "build:extension"], {
  cwd: extensionDir,
});

NodeFS.cpSync(NodePath.join(repoRoot, "apps/web/dist"), NodePath.join(distDir, "webview"), {
  recursive: true,
});
rewriteWebviewBundleAssetPaths(NodePath.join(distDir, "webview"));

NodeFS.writeFileSync(
  NodePath.join(distDir, "package.json"),
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
