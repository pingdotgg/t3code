import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import { createExtensionRuntime } from "../dist/index.js";

const sdk = NodeURL.fileURLToPath(new URL("../../extension-sdk", import.meta.url));
const example = NodePath.join(sdk, "examples/authored-assets");
const cli = NodePath.join(sdk, "bin/t3-extension.mjs");

function run(args, cwd, expected = 0) {
  const result = NodeChildProcess.spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  if (result.status !== expected)
    throw new Error(
      "t3-extension " +
        args.join(" ") +
        " exited " +
        result.status +
        "\n" +
        result.stdout +
        "\n" +
        result.stderr,
    );
  return result.stdout;
}

async function project(root, name) {
  const dir = NodePath.join(root, name);
  await NodeFSP.cp(example, dir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(dir, "tsconfig.json"),
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
  const scope = NodePath.join(dir, "node_modules/@t3tools");
  await NodeFSP.mkdir(scope, { recursive: true });
  await NodeFSP.symlink(sdk, NodePath.join(scope, "extension-sdk"), "dir");
  return dir;
}

NodeTest.test(
  "CLI packs defineExtension assets with generated hashes; install, read and corruption are verified",
  async (t) => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-authored-assets-")),
    );
    const runtime = await createExtensionRuntime({
      rootDir: NodePath.join(root, "state"),
      environmentId: "env",
      services: [],
      authorize: () => true,
    });
    t.after(async () => {
      await runtime.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
    });
    const dir = await project(root, "assets-project");
    run([cli, "build", dir], root);
    const out = NodePath.join(dir, ".t3-extension");
    const pkg = JSON.parse(await NodeFSP.readFile(NodePath.join(out, "t3-extension.json"), "utf8"));
    NodeAssert.equal(pkg.format, 4);
    NodeAssert.equal(pkg.manifest.id, "example.authored-assets");
    const wasm = await NodeFSP.readFile(NodePath.join(example, "assets/value.wasm"));
    NodeAssert.deepEqual(pkg.assets, [
      {
        path: "assets/value.wasm",
        byteLength: wasm.length,
        sha256: NodeCrypto.createHash("sha256").update(wasm).digest("hex"),
        mediaType: "application/wasm",
      },
    ]);
    run([cli, "check", out], root);
    const receipt = JSON.parse(await NodeFSP.readFile(NodePath.join(out, "receipt.json"), "utf8"));
    NodeAssert.equal(receipt.hashes["assets/value.wasm"], pkg.assets[0].sha256);

    const installed = await runtime.install(out, {
      projectIds: ["project"],
      capabilities: [],
    });
    const result = await runtime.readAsset(
      installed.id,
      installed.contentHash,
      "assets/value.wasm",
      new AbortController().signal,
    );
    NodeAssert.deepEqual([...result.bytes], [...wasm]);
    const module = await WebAssembly.compile(result.bytes);
    NodeAssert.equal(new WebAssembly.Instance(module).exports.value(), 42);

    const installedAsset = NodePath.join(
      root,
      "state",
      "packages",
      installed.contentHash,
      "assets",
      "value.wasm",
    );
    await NodeFSP.chmod(installedAsset, 0o600);
    await NodeFSP.writeFile(installedAsset, Buffer.alloc(wasm.length, 9));
    await NodeAssert.rejects(
      runtime.readAsset(
        installed.id,
        installed.contentHash,
        "assets/value.wasm",
        new AbortController().signal,
      ),
      /digest/,
    );
    await NodeAssert.rejects(runtime.readClient(installed.id), /digest/);
  },
);

NodeTest.test("CLI rejects symlinked and missing asset sources", async (t) => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-authored-assets-")),
  );
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const outside = NodePath.join(root, "outside.wasm");
  await NodeFSP.writeFile(outside, Buffer.from([1, 2, 3]));
  const linked = await project(root, "linked");
  await NodeFSP.rm(NodePath.join(linked, "assets/value.wasm"));
  await NodeFSP.symlink(outside, NodePath.join(linked, "assets/value.wasm"));
  run([cli, "build", linked], root, 1);
  const missing = await project(root, "missing");
  await NodeFSP.rm(NodePath.join(missing, "assets/value.wasm"));
  run([cli, "build", missing], root, 1);
});
