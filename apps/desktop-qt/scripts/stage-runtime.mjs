import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { selectCliRuntimeExternalDependencies } from "../../../scripts/lib/cli-external-packages.ts";

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(scriptDir, "../../..");
const destinationArg = process.argv[2];

if (destinationArg === undefined) {
  throw new Error("Usage: stage-runtime.mjs <destination>");
}

const destination = NodePath.resolve(destinationArg);
const serverDist = NodePath.join(repoRoot, "apps/server/dist");
const serverManifest = JSON.parse(
  await NodeFS.readFile(NodePath.join(repoRoot, "apps/server/package.json"), "utf8"),
);
const rootManifest = JSON.parse(
  await NodeFS.readFile(NodePath.join(repoRoot, "package.json"), "utf8"),
);

await NodeFS.access(NodePath.join(serverDist, "bin.mjs"));
await NodeFS.access(NodePath.join(serverDist, "client/index.html"));
await NodeFS.rm(destination, { recursive: true, force: true });
await NodeFS.mkdir(NodePath.join(destination, "host"), { recursive: true });
await Promise.all([
  NodeFS.copyFile(
    NodePath.join(repoRoot, "apps/desktop-qt/host/main.ts"),
    NodePath.join(destination, "host/main.ts"),
  ),
  NodeFS.copyFile(
    NodePath.join(repoRoot, "apps/desktop-qt/host/pairingUrl.ts"),
    NodePath.join(destination, "host/pairingUrl.ts"),
  ),
  NodeFS.cp(serverDist, NodePath.join(destination, "server"), { recursive: true }),
]);

const dependencies = selectCliRuntimeExternalDependencies(serverManifest.dependencies);
await NodeFS.writeFile(
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
  `  os: [${process.platform}]`,
  `  cpu: [${process.arch}]`,
  ...(process.platform === "linux" ? ["  libc: [glibc]"] : []),
  "allowBuilds:",
  "  msgpackr-extract: true",
  "  node-pty: true",
  "nodeLinker: hoisted",
  "",
].join("\n");
await NodeFS.writeFile(NodePath.join(destination, "pnpm-workspace.yaml"), supportedArchitectures);

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
