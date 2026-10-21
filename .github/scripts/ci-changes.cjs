// Unknown paths run every job; recognized packages pull in their dependents.
// scripts/check-changed.ts shares these decisions so local checks match CI.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

const INERT = [
  /^docs\//,
  /^\.(agents|cursor|vscode|devcontainer|macroscope|repos)\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
];

// Shared test setup and vendored mobile dependencies affect every package.
const RUNS_EVERYTHING = [
  /^packages\/shared\/src\/(HostProcess|testing\/longTempDir)\.ts$/,
  /^apps\/mobile\/deps\//,
];

// Includes cross-package reads absent from package.json dependencies.
const EXTRA_OWNERS = [
  // Vite configs and tsconfigs of these apps import scripts/lib directly.
  [/^scripts\/lib\//, ["@t3tools/desktop", "@t3tools/mobile", "@t3tools/web", "t3"]],
  // scripts/build-desktop-artifact.ts reads the GNOME extension manifest.
  [/^apps\/desktop\/gnome-extension\//, ["@t3tools/scripts"]],
  [/^native\/browser-secret\//, ["@t3tools/desktop"]],
  [/^native\/kde-snap-shot\//, ["@t3tools/desktop"]],
  [/^native\/libghostty-vt\//, ["@t3tools/web"]],
];
const RUST = /^native\/(resource-monitor|kde-snap-shot|hyprland-snap-shot)\//;

// These tests read other packages without declaring dependencies.
const TEST_ONLY_DEPS = {
  "@t3tools/provider-pi": ["@t3tools/client-runtime"],
  "@t3tools/scripts": [
    "@t3tools/desktop",
    "@t3tools/mobile",
    "@t3tools/web",
    "t3",
    "@t3tools/provider-cursor",
  ],
};
// The server bundles the web build without importing it.
const BUILD_ONLY_DEPS = { t3: ["@t3tools/web"] };

const MOBILE_NATIVE =
  /^apps\/mobile\/.*\.(swift|kt|kts)$|^apps\/mobile\/(\.swiftlint\.yml|detekt\.yml|\.editorconfig|Brewfile)$|^scripts\/mobile-native-static-check\.ts$|^package\.json$|^\.github\/workflows\/ci\.yml$|^\.github\/scripts\/ci-changes\.cjs$|^\.github\/actions\/ci-changes\//;

const OWN_TEST_JOB = new Set(["t3", "@t3tools/web", "@t3tools/monorepo"]);

function readWorkspace() {
  const patterns = [];
  let inPackages = false;
  for (const line of fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
    if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
    const entry = inPackages && line.match(/^\s+-\s+["']?([^"'\s]+)/);
    if (entry) patterns.push(entry[1]);
  }

  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return fs.readdirSync(path.join(root, parent)).map((name) => `${parent}/${name}`);
  });

  const packages = [];
  for (const dir of dirs) {
    const manifestPath = path.join(root, dir, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    packages.push({
      name: manifest.name,
      dir,
      hasTest: Boolean(manifest.scripts?.test),
      deps: Object.keys(deps).filter(
        (dep) =>
          String(deps[dep]).startsWith("workspace:") &&
          !BUILD_ONLY_DEPS[manifest.name]?.includes(dep),
      ),
    });
  }
  return packages;
}

// [] means inert; null means unknown and requires every job.
function ownersOf(file, packages) {
  if (INERT.some((pattern) => pattern.test(file))) return [];
  // A manifest can change dependencies or versions other packages read.
  if (path.posix.basename(file) === "package.json") return null;
  if (RUNS_EVERYTHING.some((pattern) => pattern.test(file))) return null;
  const extra = EXTRA_OWNERS.flatMap(([pattern, names]) => (pattern.test(file) ? names : []));
  // scripts/build-desktop-artifact.test.ts reads the crates' sources.
  if (RUST.test(file)) return ["@t3tools/scripts", ...extra];

  const owner = packages
    .filter((pkg) => file.startsWith(`${pkg.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (owner) return [owner.name, ...extra];
  return extra.length > 0 ? extra : null;
}

function decide(files, packages, full) {
  const all = new Set(packages.map((pkg) => pkg.name));
  let affected = new Set();
  let everything = full || files === null;
  let rust = false;

  for (const file of files ?? []) {
    if (RUST.test(file)) rust = true;
    const owners = ownersOf(file, packages);
    if (owners === null) {
      everything = true;
      console.error(`Runs everything: ${file}`);
    } else {
      for (const owner of owners) affected.add(owner);
    }
  }

  // Release smoke reads scripts/ itself, not what the scripts tests read.
  let scriptsChanged = everything;
  if (everything) {
    affected = all;
  } else {
    let grew = true;
    while (grew) {
      grew = false;
      for (const pkg of packages) {
        if (!affected.has(pkg.name) && pkg.deps.some((dep) => affected.has(dep))) {
          affected.add(pkg.name);
          grew = true;
        }
      }
    }
    scriptsChanged = affected.has("@t3tools/scripts");
    for (const [name, deps] of Object.entries(TEST_ONLY_DEPS)) {
      if (deps.some((dep) => affected.has(dep))) affected.add(name);
    }
  }

  const tested = packages.filter(
    (pkg) => pkg.hasTest && !OWN_TEST_JOB.has(pkg.name) && affected.has(pkg.name),
  );
  const has = (name) => affected.has(name);

  return {
    affected: [...affected].sort(),
    outputs: {
      typecheck: affected.size > 0,
      build: has("@t3tools/desktop") || has("t3") || has("@t3tools/web"),
      test: tested.length > 0,
      // Empty means every package the Test job covers.
      test_packages: everything ? "" : tested.map((pkg) => pkg.name).join(" "),
      test_web: has("@t3tools/web"),
      test_server: has("t3"),
      rust: everything || rust,
      release_smoke: scriptsChanged,
      mobile_native: files === null || files.some((file) => MOBILE_NATIVE.test(file)),
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const pathsIndex = args.indexOf("--paths");
  const files =
    pathsIndex === -1
      ? null
      : fs
          .readFileSync(args[pathsIndex + 1], "utf8")
          .split("\n")
          .filter(Boolean);
  const { affected, outputs } = decide(files, readWorkspace(), args.includes("--full"));

  console.error(`Affected packages: ${affected.join(", ") || "none"}`);
  for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
}

module.exports = { readWorkspace, decide };

if (require.main === module) main();
