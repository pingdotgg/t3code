import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import {
  validateEnvironmentPackage,
  validateServerExtension,
} from "@t3tools/extension-sdk/environment";
const sdk = NodePath.resolve("node_modules/@t3tools/extension-sdk");
for (const name of ["README.md", "AUTHORING.md"]) {
  const contents = await NodeFSP.readFile(NodePath.join(sdk, name), "utf8");
  for (const match of contents.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    await NodeFSP.access(NodePath.resolve(sdk, NodePath.dirname(name), target));
  }
}
const manifests = [];
for (const name of [
  "installable-files",
  "installable-files-consumer",
  "installable-terminal-observer",
  "installable-terminal-output",
]) {
  const dir = NodePath.join(sdk, "examples", name);
  const manifest = validateEnvironmentPackage(
    JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "t3-extension.json"), "utf8")),
  );
  NodeAssert.equal(manifest.format, 2);
  const client = await import(NodeURL.pathToFileURL(NodePath.join(dir, manifest.clientEntry)));
  NodeAssert.equal(typeof client.default, "function");
  if (manifest.serverEntry) {
    const server = await import(NodeURL.pathToFileURL(NodePath.join(dir, manifest.serverEntry)));
    validateServerExtension(manifest, server.default);
  }
  manifests.push(manifest);
}
NodeAssert.equal(manifests[1].dependencies[0].pluginId, manifests[0].manifest.id);
NodeAssert.ok(manifests[2].requires.some((api) => api.id === "t3.terminal/sessions"));
NodeAssert.ok(manifests[3].requires.some((api) => api.id === "t3.terminal/output"));
NodeAssert.deepEqual(manifests[3].provides[0].methods[0].requiredGrants, [
  "t3.terminal/read-output",
]);
NodeAssert.ok(manifests[0].provides.some((api) => api.id === "t3.file/presentation"));
console.log(
  "Packaged format-2 provider/consumer and authoring links verified; host runtime behavior is a separate check.",
);

const streamPackages = [];
for (const name of [
  "installable-stream-provider",
  "installable-stream-consumer",
  "installable-terminal-live-output",
]) {
  const dir = NodePath.join(sdk, "examples", name);
  const pkg = validateEnvironmentPackage(
    JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "t3-extension.json"), "utf8")),
  );
  NodeAssert.equal(pkg.format, 3);
  const client = await import(NodeURL.pathToFileURL(NodePath.join(dir, pkg.clientEntry)));
  NodeAssert.equal(typeof client.default, "function");
  const server = await import(NodeURL.pathToFileURL(NodePath.join(dir, pkg.serverEntry)));
  validateServerExtension(pkg, server.default);
  streamPackages.push(pkg);
}
NodeAssert.equal(streamPackages[1].dependencies[0].pluginId, streamPackages[0].manifest.id);
NodeAssert.equal(streamPackages[2].requires[0].id, "t3.terminal/output-events");
NodeAssert.deepEqual(streamPackages[2].provides[0].streams[0].requiredGrants, [
  "t3.terminal/read-output",
]);
console.log(
  "Packaged format-3 provider/consumer declarations verified; worker/network proof remains separate.",
);

const assetDirectory = NodePath.join(sdk, "examples/installable-package-assets");
const assetPackage = validateEnvironmentPackage(
  JSON.parse(await NodeFSP.readFile(NodePath.join(assetDirectory, "t3-extension.json"), "utf8")),
);
NodeAssert.equal(assetPackage.format, 4);
const assetClient = await import(
  NodeURL.pathToFileURL(NodePath.join(assetDirectory, assetPackage.clientEntry))
);
NodeAssert.equal(typeof assetClient.default, "function");
const declared = assetPackage.assets[0];
const assetBytes = await NodeFSP.readFile(NodePath.join(assetDirectory, declared.path));
NodeAssert.equal(assetBytes.byteLength, declared.byteLength);
NodeAssert.equal(NodeCrypto.createHash("sha256").update(assetBytes).digest("hex"), declared.sha256);
const assetModule = await WebAssembly.instantiate(assetBytes);
NodeAssert.equal(assetModule.instance.exports.value(), 42);
console.log(
  "Published format-4 example contains a valid declared WASM asset; installed host proof remains separate.",
);

// The packed CLI builds authored assets into a verified format-4 package.
const authoredDir = NodePath.join(process.cwd(), "authored-assets-src");
await NodeFSP.cp(NodePath.join(sdk, "examples/authored-assets"), authoredDir, {
  recursive: true,
});
await NodeFSP.writeFile(
  NodePath.join(authoredDir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      lib: ["ES2022", "DOM"],
    },
    include: ["*.ts"],
  }),
);
const cli = NodePath.join(sdk, "bin/t3-extension.mjs");
function cliRun(args, expected = 0) {
  const result = NodeChildProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: authoredDir,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  if (result.status !== expected)
    throw new Error(
      `t3-extension ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
cliRun(["build", "."]);
const authoredOut = NodePath.join(authoredDir, ".t3-extension");
const authoredPackage = validateEnvironmentPackage(
  JSON.parse(await NodeFSP.readFile(NodePath.join(authoredOut, "t3-extension.json"), "utf8")),
);
NodeAssert.equal(authoredPackage.format, 4);
const authoredAsset = authoredPackage.assets[0];
const authoredBytes = await NodeFSP.readFile(NodePath.join(authoredDir, "assets/value.wasm"));
NodeAssert.equal(authoredAsset.byteLength, authoredBytes.byteLength);
NodeAssert.equal(
  authoredAsset.sha256,
  NodeCrypto.createHash("sha256").update(authoredBytes).digest("hex"),
);
cliRun(["check", ".t3-extension"]);
const packedAsset = NodePath.join(authoredOut, "assets/value.wasm");
const packedBytes = await NodeFSP.readFile(packedAsset);
await NodeFSP.writeFile(packedAsset, Buffer.alloc(packedBytes.length, 9));
cliRun(["check", ".t3-extension"], 1);
await NodeFSP.writeFile(packedAsset, packedBytes);
cliRun(["check", ".t3-extension"]);
console.log(
  "Packed CLI generated and verified authored format-4 assets; corrupted output rejected.",
);
