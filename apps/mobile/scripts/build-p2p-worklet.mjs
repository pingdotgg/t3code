// Bundles the Bare P2P worklet with bare-pack for every mobile host and
// writes src/p2p/worklet/p2p-worklet.bundle.mjs — an ES module that
// default-exports the bundle text, which the gateway feeds to
// react-native-bare-kit's Worklet.start. Native addons (udx-native,
// sodium-native, bare-tcp, …) are `--linked`: their prebuilt binaries ship
// inside the npm packages and are linked into the app by react-native-bare-kit
// at build time. Re-run after changing the worklet sources or bumping the
// Holepunch dependencies:
//
//   node scripts/build-p2p-worklet.mjs
//
// bare-pack resolves the module graph by walking node_modules directories
// without following pnpm's symlinks, so packing straight out of the workspace
// fails on hyperdht's transitive imports. The worklet sources are staged next
// to pnpm's hidden flat hoist (node_modules/.pnpm/node_modules), where every
// package resolves as a plain sibling.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const mobileRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const repoRoot = NodePath.resolve(mobileRoot, "..", "..");
const workletDir = NodePath.join(mobileRoot, "src", "p2p", "worklet");

const HOSTS = ["ios-arm64", "ios-arm64-simulator", "android-arm64", "android-arm", "android-x64"];

const stage = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-p2p-worklet-")),
);
try {
  for (const file of ["p2p-worklet.mjs", "p2p-worklet-core.mjs"]) {
    NodeFS.cpSync(NodePath.join(workletDir, file), NodePath.join(stage, file));
  }
  NodeFS.symlinkSync(
    NodePath.join(repoRoot, "node_modules", ".pnpm", "node_modules"),
    NodePath.join(stage, "node_modules"),
  );

  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(mobileRoot, "node_modules", "bare-pack", "bin.js"),
      ...HOSTS.flatMap((host) => ["--host", host]),
      "--linked",
      "--base",
      stage,
      "--out",
      NodePath.join(workletDir, "p2p-worklet.bundle.mjs"),
      NodePath.join(stage, "p2p-worklet.mjs"),
    ],
    { cwd: stage, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
} finally {
  NodeFS.rmSync(stage, { recursive: true, force: true });
}
