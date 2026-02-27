#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PRODUCTION_ICON_SOURCE = path.join(repoRoot, "assets/macos-icon-1024.png");

const ARCH_CHOICES = new Set(["arm64", "x64", "universal"]);

function printUsage() {
  console.log(`Build a shareable macOS .dmg for T3 Code desktop.

Usage:
  node scripts/build-desktop-dmg.mjs [options]

Options:
  --arch <arm64|x64|universal>  Target arch (default: host arch if supported)
  --version <semver>            App version in DMG metadata (default: apps/server version)
  --output-dir <path>           Output folder for final artifacts (default: release)
  --skip-build                  Skip 'bun run build:desktop' (requires existing dist artifacts)
  --keep-stage                  Keep temporary staging directory
  --signed                      Allow automatic code signing discovery
  --help                        Show this message
`);
}

function fail(message) {
  console.error(`[desktop-dmg] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const defaultArch = process.arch === "arm64" || process.arch === "x64" ? process.arch : "arm64";
  const options = {
    arch: defaultArch,
    version: null,
    skipBuild: false,
    keepStage: false,
    signed: false,
    outputDir: path.join(repoRoot, "release"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--keep-stage") {
      options.keepStage = true;
      continue;
    }
    if (arg === "--signed") {
      options.signed = true;
      continue;
    }
    if (arg === "--arch" || arg === "--version" || arg === "--output-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        fail(`Missing value for ${arg}`);
      }
      i += 1;
      if (arg === "--arch") options.arch = value;
      if (arg === "--version") options.version = value;
      if (arg === "--output-dir") options.outputDir = path.resolve(repoRoot, value);
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (!ARCH_CHOICES.has(options.arch)) {
    fail(`Invalid arch '${options.arch}'. Expected one of: ${Array.from(ARCH_CHOICES).join(", ")}`);
  }

  return options;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, { cwd, env = process.env, stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited via signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function generateMacIconSet(sourcePng, targetIcns, tmpRoot) {
  const iconsetDir = path.join(tmpRoot, "icon.iconset");
  await fs.mkdir(iconsetDir, { recursive: true });

  const iconSizes = [16, 32, 128, 256, 512];
  for (const size of iconSizes) {
    await run(
      "sips",
      [
        "-z",
        String(size),
        String(size),
        sourcePng,
        "--out",
        path.join(iconsetDir, `icon_${size}x${size}.png`),
      ],
      { stdio: "ignore" },
    );
    const retinaSize = size * 2;
    await run(
      "sips",
      [
        "-z",
        String(retinaSize),
        String(retinaSize),
        sourcePng,
        "--out",
        path.join(iconsetDir, `icon_${size}x${size}@2x.png`),
      ],
      { stdio: "ignore" },
    );
  }

  await run("iconutil", ["-c", "icns", iconsetDir, "-o", targetIcns], { stdio: "ignore" });
}

async function stageProductionIcons(stageResourcesDir) {
  if (!(await exists(PRODUCTION_ICON_SOURCE))) {
    fail(`Production icon source is missing at ${PRODUCTION_ICON_SOURCE}`);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "t3code-icon-build-"));
  try {
    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");
    await run("sips", ["-z", "512", "512", PRODUCTION_ICON_SOURCE, "--out", iconPngPath], {
      stdio: "ignore",
    });
    await generateMacIconSet(PRODUCTION_ICON_SOURCE, iconIcnsPath, tmpRoot);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function validateBundledClientAssets(clientDir) {
  const indexPath = path.join(clientDir, "index.html");
  const indexHtml = await fs.readFile(indexPath, "utf8");
  const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]);
  const missing = [];

  for (const ref of refs) {
    const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
    if (!normalizedRef) continue;
    if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
    if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

    const ext = path.extname(normalizedRef);
    if (!ext) continue;

    const relativePath = normalizedRef.replace(/^\/+/, "");
    const assetPath = path.join(clientDir, relativePath);
    if (!(await exists(assetPath))) {
      missing.push(normalizedRef);
    }
  }

  if (missing.length > 0) {
    const preview = missing.slice(0, 6).join(", ");
    const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
    fail(
      `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
    );
  }
}

function readWorkspaceCatalog(rootPackageJson) {
  const workspaces = rootPackageJson?.workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) {
    return {};
  }

  const catalog = workspaces.catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return {};
  }

  return catalog;
}

function resolveCatalogDependencies(dependencies, catalog, dependencySourceLabel) {
  return Object.fromEntries(
    Object.entries(dependencies).map(([dependencyName, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [dependencyName, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      const lookupKey = catalogKey.length > 0 ? catalogKey : dependencyName;
      const resolvedSpec = catalog[lookupKey];
      if (typeof resolvedSpec !== "string" || resolvedSpec.length === 0) {
        fail(
          `Unable to resolve '${spec}' for ${dependencySourceLabel} dependency '${dependencyName}'. ` +
            `Expected key '${lookupKey}' in root workspace catalog.`,
        );
      }

      return [dependencyName, resolvedSpec];
    }),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (process.platform !== "darwin") {
    fail("This script only builds macOS .dmg artifacts and must run on macOS.");
  }

  const rootPkg = await readJson(path.join(repoRoot, "package.json"));
  const desktopPkg = await readJson(path.join(repoRoot, "apps/desktop/package.json"));
  const serverPkg = await readJson(path.join(repoRoot, "apps/server/package.json"));

  const electronVersion = desktopPkg.dependencies?.electron;
  if (typeof electronVersion !== "string" || electronVersion.length === 0) {
    fail("Could not resolve apps/desktop electron dependency version.");
  }

  const dependencies = serverPkg.dependencies;
  if (!dependencies || Object.keys(dependencies).length === 0) {
    fail("Could not resolve production dependencies from apps/server/package.json.");
  }
  const resolvedDependencies = resolveCatalogDependencies(
    dependencies,
    readWorkspaceCatalog(rootPkg),
    "apps/server",
  );

  const appVersion = options.version ?? serverPkg.version ?? "0.1.0";
  const stageRoot = path.join(os.tmpdir(), "t3code-desktop-dmg-stage");
  const stageAppDir = path.join(stageRoot, "app");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    console.log("[desktop-dmg] Building desktop/server/web artifacts...");
    await run("bun", ["run", "build:desktop"], { cwd: repoRoot });
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(await exists(dir))) {
      fail(`Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`);
    }
  }
  if (!(await exists(bundledClientEntry))) {
    fail(
      `Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`,
    );
  }
  await validateBundledClientAssets(path.dirname(bundledClientEntry));

  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  await fs.mkdir(path.join(stageAppDir, "apps/server"), { recursive: true });

  console.log("[desktop-dmg] Staging release app...");
  await fs.cp(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"), {
    recursive: true,
  });
  await fs.cp(distDirs.desktopResources, path.join(stageAppDir, "apps/desktop/resources"), {
    recursive: true,
  });
  await fs.cp(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"), { recursive: true });
  await stageProductionIcons(path.join(stageAppDir, "apps/desktop/resources"));

  const stagePackageJson = {
    name: "t3-code-desktop",
    version: appVersion,
    private: true,
    description: "T3 Code desktop build",
    author: "T3 Tools",
    main: "apps/desktop/dist-electron/main.js",
    build: {
      appId: "com.t3tools.t3code",
      productName: desktopPkg.productName ?? "T3 Code",
      artifactName: "T3-Code-${version}-${arch}.${ext}",
      directories: {
        buildResources: "apps/desktop/resources",
      },
      mac: {
        target: ["dmg"],
        icon: "icon.icns",
        category: "public.app-category.developer-tools",
      },
    },
    dependencies: resolvedDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  await fs.writeFile(
    path.join(stageAppDir, "package.json"),
    `${JSON.stringify(stagePackageJson, null, 2)}\n`,
    "utf8",
  );

  console.log("[desktop-dmg] Installing staged production dependencies...");
  await run("bun", ["install", "--production"], { cwd: stageAppDir });

  const buildEnv = {
    ...process.env,
  };
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  }

  const buildArgs = ["--bun", "electron-builder", "--mac", "dmg", `--${options.arch}`];
  console.log(`[desktop-dmg] Building .dmg (arch=${options.arch}, version=${appVersion})...`);
  await run("bunx", buildArgs, { cwd: stageAppDir, env: buildEnv });

  const stageDistDir = path.join(stageAppDir, "dist");
  const stageFiles = await fs.readdir(stageDistDir);
  const dmgFiles = stageFiles.filter((file) => file.endsWith(".dmg"));
  if (dmgFiles.length === 0) {
    fail(`Build completed but no .dmg found in ${stageDistDir}`);
  }

  await fs.mkdir(options.outputDir, { recursive: true });
  const copiedArtifacts = [];
  for (const file of stageFiles) {
    if (!file.endsWith(".dmg") && !file.endsWith(".dmg.blockmap")) continue;
    const from = path.join(stageDistDir, file);
    const to = path.join(options.outputDir, file);
    await fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (!options.keepStage) {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }

  console.log("[desktop-dmg] Done. Artifacts:");
  for (const artifact of copiedArtifacts) {
    console.log(`  - ${artifact}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
