/** Build the audited Duo prototype outside the checkout. Usage: node scripts/build-duo-device-hub.ts /absolute/output-directory */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const commit = "bb265b11c13b395e5302d121458e2d42224a2e9f";
const hubVersion = "0.9.0";
const prototypeVersion = `${hubVersion}-duo.${commit.slice(0, 12)}`;
const output = NodePath.resolve(process.argv[2] ?? "/tmp/t3-duo-build");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build entry point, not a server service.
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The pinned native simulator build requires Apple Silicon macOS with Xcode.");
NodeFS.mkdirSync(output, { recursive: true });
const source = NodePath.join(output, "serve-sim");
function run(command: string, args: string[], cwd = output, capture = false) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed with ${result.status}: ${result.stderr ?? ""}`);
  return result.stdout;
}
// Reusing a build requires the exact source revision and a clean tracked tree.
try {
  run("git", ["rev-parse", "--git-dir"], source, true);
} catch {
  run("git", [
    "clone",
    "--filter=blob:none",
    "https://github.com/krystofwoldrich-agent/serve-sim.git",
    source,
  ]);
}
run("git", ["fetch", "origin", commit], source);
run("git", ["checkout", "--detach", commit], source);
if (run("git", ["status", "--porcelain", "--untracked-files=no"], source, true).trim())
  throw new Error("Upstream source has tracked edits. Refusing an unpinned build.");
run("bun", ["install", "--frozen-lockfile"], source);
run("bun", ["run", "build"], NodePath.join(source, "packages/serve-sim"));
const packed = JSON.parse(
  run("npm", ["pack", `expo-device-hub@${hubVersion}`, "--json"], output, true),
);
const staging = NodePath.join(output, "hub-package");
NodeFS.rmSync(staging, { recursive: true, force: true });
NodeFS.mkdirSync(staging);
run("tar", ["-xzf", NodePath.join(output, packed[0].filename), "-C", staging]);
const hub = NodePath.join(staging, "package");
const vendor = NodePath.join(hub, "vendor/serve-sim");
NodeFS.rmSync(NodePath.join(vendor, "dist"), { recursive: true, force: true });
NodeFS.cpSync(NodePath.join(source, "packages/serve-sim/dist"), NodePath.join(vendor, "dist"), {
  recursive: true,
});
// Preserve upstream licensing with the native and JS artifacts.
for (const name of ["LICENSE", "NOTICE"])
  NodeFS.cpSync(NodePath.join(source, "packages/serve-sim", name), NodePath.join(vendor, name));
const manifestPath = NodePath.join(hub, "package.json");
const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
manifest.version = prototypeVersion;
manifest.t3DeviceHubBuild = {
  serveSimCommit: commit,
  hubVersion,
  hubIntegrity: packed[0].integrity,
};
NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const archive = JSON.parse(
  run("npm", ["pack", hub, "--pack-destination", output, "--json"], output, true),
)[0];
console.log(
  `\nPinned build: ${NodePath.join(output, archive.filename)}\nStart T3 with T3CODE_DEVICE_HUB_ARCHIVE set to this absolute path. SSH device hosts continue using the official release.`,
);
