import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { selectCliRuntimeExternalDependencies } from "../../../scripts/lib/cli-external-packages.ts";

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(scriptDir, "../../..");
const destinationArg = process.argv[2];
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaging script has no Effect runtime.
const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaging script has no Effect runtime.
const hostArchitecture = NodeOS.arch();

if (destinationArg === undefined) {
  throw new Error("Usage: stage-runtime.mjs <destination>");
}

const destination = NodePath.resolve(destinationArg);
const serverDist = NodePath.join(repoRoot, "apps/server/dist");
const nodePrefix = NodePath.resolve(NodePath.dirname(process.execPath), "..");
const nodeLicense = NodePath.join(nodePrefix, "LICENSE");
const nodeExecutableName = hostPlatform === "win32" ? "node.exe" : "node";
const serverManifest = JSON.parse(
  await NodeFSP.readFile(NodePath.join(repoRoot, "apps/server/package.json"), "utf8"),
);
const rootManifest = JSON.parse(
  await NodeFSP.readFile(NodePath.join(repoRoot, "package.json"), "utf8"),
);

await NodeFSP.access(NodePath.join(serverDist, "bin.mjs"));
await NodeFSP.access(NodePath.join(serverDist, "client/index.html"));
await NodeFSP.access(nodeLicense);
await NodeFSP.rm(destination, { recursive: true, force: true });
await Promise.all([
  NodeFSP.mkdir(NodePath.join(destination, "host"), { recursive: true }),
  NodeFSP.mkdir(NodePath.join(destination, "bin"), { recursive: true }),
  NodeFSP.mkdir(NodePath.join(destination, "licenses/node"), { recursive: true }),
]);
await Promise.all([
  NodeFSP.copyFile(
    NodePath.join(repoRoot, "apps/desktop-qt/host/main.ts"),
    NodePath.join(destination, "host/main.ts"),
  ),
  NodeFSP.copyFile(
    NodePath.join(repoRoot, "apps/desktop-qt/host/pairingUrl.ts"),
    NodePath.join(destination, "host/pairingUrl.ts"),
  ),
  NodeFSP.cp(serverDist, NodePath.join(destination, "server"), { recursive: true }),
  NodeFSP.copyFile(process.execPath, NodePath.join(destination, "bin", nodeExecutableName)),
  NodeFSP.copyFile(nodeLicense, NodePath.join(destination, "licenses/node/LICENSE")),
]);
if (hostPlatform !== "win32") {
  await NodeFSP.chmod(NodePath.join(destination, "bin", nodeExecutableName), 0o755);
}

const dependencies = selectCliRuntimeExternalDependencies(serverManifest.dependencies);
await NodeFSP.writeFile(
  NodePath.join(destination, "package.json"),
  `${JSON.stringify(
    {
      name: "t3code-qt-runtime",
      version: serverManifest.version,
      private: true,
      type: "module",
      packageManager: rootManifest.packageManager,
      dependencies,
    },
    null,
    2,
  )}\n`,
);

const supportedArchitectures = [
  "supportedArchitectures:",
  `  os: [${hostPlatform}]`,
  `  cpu: [${hostArchitecture}]`,
  ...(hostPlatform === "linux" ? ["  libc: [glibc]"] : []),
  "allowBuilds:",
  "  msgpackr-extract: true",
  "  node-pty: true",
  "nodeLinker: hoisted",
  "",
].join("\n");
await NodeFSP.writeFile(NodePath.join(destination, "pnpm-workspace.yaml"), supportedArchitectures);

const install = NodeChildProcess.spawnSync("vp", ["install", "--prod"], {
  cwd: destination,
  stdio: "inherit",
});
if (install.error) {
  throw install.error;
}
if (install.status !== 0) {
  throw new Error(`vp install --prod exited with ${String(install.status)}`);
}
