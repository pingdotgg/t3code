import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeTest from "node:test";
import { createExtensionRuntime } from "../dist/index.js";
import { readPackage, readPackageMetadata } from "../dist/storage.js";

const NodeFSDefault = (await import("node:fs/promises")).default;
const digest = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
async function packageDir(root, bytes, version = "1.0.0", id = "asset.test") {
  const source = NodePath.join(root, "source-" + version);
  await NodeFSP.mkdir(NodePath.join(source, "vendor"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(source, "vendor", "x.wasm"), bytes);
  await NodeFSP.writeFile(
    NodePath.join(source, "client.mjs"),
    "export default function(){return {}}\n",
  );
  await NodeFSP.writeFile(
    NodePath.join(source, "t3-extension.json"),
    JSON.stringify({
      format: 4,
      manifest: { id, version, apiVersion: 1, surfaces: [] },
      clientEntry: "client.mjs",
      serverEntry: undefined,
      tools: [],
      dependencies: [],
      provides: [],
      requires: [],
      assets: [
        {
          path: "vendor/x.wasm",
          byteLength: bytes.length,
          sha256: digest(bytes),
          mediaType: "application/wasm",
        },
      ],
    }),
  );
  return source;
}
NodeTest.test(
  "format 4 readAsset verifies exact bytes, corruption, lifecycle and stale hashes",
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-"));
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
    const first = Buffer.from([1, 2, 3]);
    const source = await packageDir(root, first);
    const installed = await runtime.install(source, { projectIds: ["project"], capabilities: [] });
    const result = await runtime.readAsset(
      installed.id,
      installed.contentHash,
      "vendor/x.wasm",
      new AbortController().signal,
    );
    NodeAssert.deepEqual([...result.bytes], [...first]);
    NodeAssert.equal(result.sha256, digest(first));
    const installedAsset = NodePath.join(
      root,
      "state",
      "packages",
      installed.contentHash,
      "vendor",
      "x.wasm",
    );
    const native = await NodeFSP.stat(installedAsset);
    NodeAssert.equal(native.size, first.length);
    NodeAssert.equal(native.mode & 0o777, 0o400);
    await NodeFSP.chmod(installedAsset, 0o600);
    await NodeFSP.writeFile(installedAsset, Buffer.from([9, 9, 9]));
    await NodeAssert.rejects(
      runtime.readAsset(
        installed.id,
        installed.contentHash,
        "vendor/x.wasm",
        new AbortController().signal,
      ),
      /digest/,
    );
    await NodeAssert.rejects(
      runtime.readAsset(
        installed.id,
        installed.contentHash,
        "../secret",
        new AbortController().signal,
      ),
      /not declared/,
    );
    const aborted = new AbortController();
    aborted.abort();
    await NodeAssert.rejects(
      runtime.readAsset(installed.id, installed.contentHash, "vendor/x.wasm", aborted.signal),
      /cancelled/,
    );
    await runtime.disable(installed.id);
    await NodeAssert.rejects(
      runtime.readAsset(
        installed.id,
        installed.contentHash,
        "vendor/x.wasm",
        new AbortController().signal,
      ),
      /changed|disabled/,
    );
  },
);
NodeTest.test("format 4 update and rollback retain content identity and bytes", async (t) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-"));
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
  const a = Buffer.from([4, 5]),
    b = Buffer.from([6, 7, 8]);
  const installed = await runtime.install(await packageDir(root, a, "1.0.0"), {
    projectIds: ["project"],
    capabilities: [],
  });
  const updated = await runtime.update(installed.id, await packageDir(root, b, "2.0.0"));
  NodeAssert.deepEqual(
    [
      ...(
        await runtime.readAsset(
          updated.id,
          updated.contentHash,
          "vendor/x.wasm",
          new AbortController().signal,
        )
      ).bytes,
    ],
    [...b],
  );
  const rolled = await runtime.rollback(installed.id);
  NodeAssert.deepEqual(
    [
      ...(
        await runtime.readAsset(
          rolled.id,
          rolled.contentHash,
          "vendor/x.wasm",
          new AbortController().signal,
        )
      ).bytes,
    ],
    [...a],
  );
  await runtime.remove(installed.id);
  await NodeAssert.rejects(
    runtime.readAsset(
      installed.id,
      rolled.contentHash,
      "vendor/x.wasm",
      new AbortController().signal,
    ),
    /not installed/,
  );
});

NodeTest.test(
  "complete verification rejects corruption through readClient, enable, and rollback",
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-complete-"));
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
    const installed = await runtime.install(await packageDir(root, Buffer.from([1, 2]), "1.0.0"), {
      projectIds: ["project"],
      capabilities: [],
    });
    const assetPath = (hash) => NodePath.join(root, "state", "packages", hash, "vendor", "x.wasm");
    await NodeFSP.chmod(assetPath(installed.contentHash), 0o600);
    await NodeFSP.writeFile(assetPath(installed.contentHash), Buffer.from([9, 9]));
    await NodeAssert.rejects(runtime.readClient(installed.id), /digest/);
    await runtime.disable(installed.id);
    await NodeAssert.rejects(runtime.enable(installed.id), /digest/);
    await NodeFSP.writeFile(assetPath(installed.contentHash), Buffer.from([1, 2]));
    const updated = await runtime.update(
      installed.id,
      await packageDir(root, Buffer.from([3, 4]), "2.0.0"),
    );
    await NodeFSP.chmod(assetPath(installed.contentHash), 0o600);
    await NodeFSP.writeFile(assetPath(installed.contentHash), Buffer.from([7, 7]));
    await NodeAssert.rejects(runtime.rollback(updated.id), /digest/);
  },
);

NodeTest.test(
  "metadata verification preserves legacy hash framing and avoids unrelated asset reads",
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-metadata-"));
    t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const source = await packageDir(root, Buffer.from([5, 6, 7]));
    const metadataBefore = await readPackageMetadata(source);
    const manifest = await NodeFSP.readFile(NodePath.join(source, "t3-extension.json"));
    const client = await NodeFSP.readFile(NodePath.join(source, "client.mjs"));
    const expected = NodeCrypto.createHash("sha256");
    for (const [name, bytes] of [
      ["client.mjs", client],
      ["t3-extension.json", manifest],
    ])
      expected.update(name + "\0" + bytes.length + "\0").update(bytes);
    NodeAssert.equal(metadataBefore.contentHash, expected.digest("hex"));
    await NodeFSP.writeFile(NodePath.join(source, "vendor", "x.wasm"), Buffer.from([8, 8, 8]));
    const metadataAfter = await readPackageMetadata(source);
    NodeAssert.equal(metadataAfter.contentHash, metadataBefore.contentHash);
    await NodeAssert.rejects(readPackage(source), /digest/);
  },
);

NodeTest.test("formats 1, 2, and 3 retain the original length-framed hash", async (t) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-legacy-hash-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  for (const format of [1, 2, 3]) {
    const directory = NodePath.join(root, "format-" + format);
    await NodeFSP.mkdir(directory);
    const manifest = Buffer.from(
      JSON.stringify({
        format,
        manifest: { id: "legacy." + format, version: "1.0.0", apiVersion: 1, surfaces: [] },
        clientEntry: "client.mjs",
        tools: [],
        ...(format >= 2 ? { dependencies: [], provides: [], requires: [] } : {}),
      }),
    );
    const client = Buffer.from("export default function() { return null; }\n");
    await NodeFSP.writeFile(NodePath.join(directory, "t3-extension.json"), manifest);
    await NodeFSP.writeFile(NodePath.join(directory, "client.mjs"), client);
    const snapshot = await readPackageMetadata(directory);
    const expected = NodeCrypto.createHash("sha256");
    for (const [name, bytes] of [
      ["client.mjs", client],
      ["t3-extension.json", manifest],
    ])
      expected.update(name + "\0" + bytes.length + "\0").update(bytes);
    NodeAssert.equal(snapshot.contentHash, expected.digest("hex"));
  }
});

NodeTest.test(
  "asset leaf and nested-directory symlinks are rejected on install and read",
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-symlinks-"));
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-outside-"));
    const runtime = await createExtensionRuntime({
      rootDir: NodePath.join(root, "state"),
      environmentId: "env",
      services: [],
      authorize: () => true,
    });
    t.after(async () => {
      await runtime.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
      await NodeFSP.rm(outside, { recursive: true, force: true });
    });
    const leafSource = await packageDir(root, Buffer.from([1, 2, 3]), "1.0.1");
    await NodeFSP.writeFile(NodePath.join(outside, "leaf.wasm"), Buffer.from([1, 2, 3]));
    await NodeFSP.rm(NodePath.join(leafSource, "vendor", "x.wasm"));
    await NodeFSP.symlink(
      NodePath.join(outside, "leaf.wasm"),
      NodePath.join(leafSource, "vendor", "x.wasm"),
    );
    await NodeAssert.rejects(runtime.install(leafSource), /symlink/);

    const nestedSource = await packageDir(root, Buffer.from([4, 5, 6]), "1.0.2");
    await NodeFSP.rm(NodePath.join(nestedSource, "vendor"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(outside, "nested"));
    await NodeFSP.writeFile(NodePath.join(outside, "nested", "x.wasm"), Buffer.from([4, 5, 6]));
    await NodeFSP.symlink(NodePath.join(outside, "nested"), NodePath.join(nestedSource, "vendor"));
    await NodeAssert.rejects(readPackage(nestedSource), /symlink/);

    const installed = await runtime.install(
      await packageDir(root, Buffer.from([7, 8, 9]), "1.0.3"),
      { projectIds: ["project"], capabilities: [] },
    );
    const installedVendor = NodePath.join(
      root,
      "state",
      "packages",
      installed.contentHash,
      "vendor",
    );
    const installedAsset = NodePath.join(installedVendor, "x.wasm");
    await NodeFSP.rm(installedAsset);
    await NodeFSP.symlink(NodePath.join(outside, "leaf.wasm"), installedAsset);
    await NodeAssert.rejects(
      runtime.readAsset(
        installed.id,
        installed.contentHash,
        "vendor/x.wasm",
        new AbortController().signal,
      ),
      /symlink/,
    );
  },
);

NodeTest.test("asset reads reject results after an update or removal is committed", async (t) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-gated-lifecycle-"));
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
  const installed = await runtime.install(
    await packageDir(root, Buffer.alloc(4 * 1024 * 1024, 1), "1.0.4"),
    { projectIds: ["project"], capabilities: [] },
  );
  const originalOpen = NodeFSDefault.open;
  const installedAsset = NodePath.join(
    root,
    "state",
    "packages",
    installed.contentHash,
    "vendor",
    "x.wasm",
  );
  let release;
  let acquired;
  let acquiredResolve;
  let restore = () => {};
  const gate = (target) => {
    acquired = new Promise((resolve) => {
      acquiredResolve = resolve;
    });
    const releasePromise = new Promise((resolve) => {
      release = resolve;
    });
    const wrappedOpen = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== target) return handle;
      const wrapped = Object.create(handle);
      wrapped.stat = handle.stat.bind(handle);
      wrapped.close = handle.close.bind(handle);
      wrapped.read = async (...readArgs) => {
        acquiredResolve();
        await releasePromise;
        return handle.read(...readArgs);
      };
      return wrapped;
    };
    NodeFSDefault.open = wrappedOpen;
    NodeModule.syncBuiltinESMExports();
    restore = () => {
      NodeFSDefault.open = originalOpen;
      NodeModule.syncBuiltinESMExports();
    };
  };
  try {
    gate(installedAsset);
    const pending = runtime.readAsset(
      installed.id,
      installed.contentHash,
      "vendor/x.wasm",
      new AbortController().signal,
    );
    await acquired;
    const updated = await runtime.update(
      installed.id,
      await packageDir(root, Buffer.from([2]), "1.0.5"),
    );
    release();
    await NodeAssert.rejects(pending, /changed|digest/);
    restore();
    gate(NodePath.join(root, "state", "packages", updated.contentHash, "vendor", "x.wasm"));
    const pendingRemoval = runtime.readAsset(
      updated.id,
      updated.contentHash,
      "vendor/x.wasm",
      new AbortController().signal,
    );
    await acquired;
    await runtime.remove(updated.id);
    release();
    await NodeAssert.rejects(pendingRemoval, /changed|not installed|digest/);
  } finally {
    release?.();
    restore();
  }
});

NodeTest.test(
  "format 4 asset reads enforce per-installation concurrency and release after rejection",
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-concurrency-"));
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
    const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
    const installed = await runtime.install(await packageDir(root, bytes, "1.0.0"), {
      projectIds: ["project"],
      capabilities: [],
    });
    const reads = Array.from({ length: 5 }, () =>
      runtime.readAsset(
        installed.id,
        installed.contentHash,
        "vendor/x.wasm",
        new AbortController().signal,
      ),
    );
    const settled = await Promise.allSettled(reads);
    NodeAssert.equal(settled.filter((item) => item.status === "fulfilled").length, 4);
    NodeAssert.equal(
      settled.filter(
        (item) =>
          item.status === "rejected" &&
          /Installation asset read limit reached/.test(item.reason.message),
      ).length,
      1,
    );
    for (const item of settled.filter((item) => item.status === "fulfilled"))
      NodeAssert.equal(item.value.bytes.length, bytes.length);
    const after = await runtime.readAsset(
      installed.id,
      installed.contentHash,
      "vendor/x.wasm",
      new AbortController().signal,
    );
    NodeAssert.equal(after.bytes.length, bytes.length);
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const cancelled = controllers.map((controller) =>
      runtime.readAsset(installed.id, installed.contentHash, "vendor/x.wasm", controller.signal),
    );
    for (const controller of controllers) controller.abort();
    const cancelledResults = await Promise.allSettled(cancelled);
    NodeAssert.equal(
      cancelledResults.filter(
        (item) => item.status === "rejected" && /cancelled/.test(item.reason.message),
      ).length,
      4,
    );
    const fresh = await Promise.all(
      Array.from({ length: 4 }, () =>
        runtime.readAsset(
          installed.id,
          installed.contentHash,
          "vendor/x.wasm",
          new AbortController().signal,
        ),
      ),
    );
    NodeAssert.equal(fresh.length, 4);
    const installedAsset = NodePath.join(
      root,
      "state",
      "packages",
      installed.contentHash,
      "vendor",
      "x.wasm",
    );
    await NodeFSP.chmod(installedAsset, 0o600);
    await NodeFSP.writeFile(installedAsset, Buffer.alloc(bytes.length, 8));
    const corrupt = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        runtime.readAsset(
          installed.id,
          installed.contentHash,
          "vendor/x.wasm",
          new AbortController().signal,
        ),
      ),
    );
    NodeAssert.equal(
      corrupt.filter((item) => item.status === "rejected" && /digest/.test(item.reason.message))
        .length,
      4,
    );
    await NodeFSP.writeFile(installedAsset, bytes);
    const recovered = await Promise.all(
      Array.from({ length: 4 }, () =>
        runtime.readAsset(
          installed.id,
          installed.contentHash,
          "vendor/x.wasm",
          new AbortController().signal,
        ),
      ),
    );
    NodeAssert.equal(recovered.length, 4);
  },
);

NodeTest.test("format 4 asset remains readable after runtime restart", async (t) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-restart-"));
  const state = NodePath.join(root, "state");
  const first = await createExtensionRuntime({
    rootDir: state,
    environmentId: "env",
    services: [],
    authorize: () => true,
  });
  const bytes = Buffer.from([8, 9, 10]);
  const installed = await first.install(await packageDir(root, bytes, "1.0.0"), {
    projectIds: ["project"],
    capabilities: [],
  });
  await first.dispose();
  const second = await createExtensionRuntime({
    rootDir: state,
    environmentId: "env",
    services: [],
    authorize: () => true,
  });
  t.after(async () => {
    await second.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });
  const result = await second.readAsset(
    installed.id,
    installed.contentHash,
    "vendor/x.wasm",
    new AbortController().signal,
  );
  NodeAssert.deepEqual([...result.bytes], [...bytes]);
});

NodeTest.test("format 4 asset reads enforce the global concurrency bound", async (t) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-assets-global-"));
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
  const bytes = Buffer.alloc(4 * 1024 * 1024, 3);
  const records = [];
  for (let i = 0; i < 5; i++)
    records.push(
      await runtime.install(await packageDir(root, bytes, "1.0.0", "asset.test." + i), {
        projectIds: ["project"],
        capabilities: [],
      }),
    );
  const reads = records.flatMap((record) =>
    Array.from({ length: 4 }, () =>
      runtime.readAsset(
        record.id,
        record.contentHash,
        "vendor/x.wasm",
        new AbortController().signal,
      ),
    ),
  );
  const settled = await Promise.allSettled(reads);
  NodeAssert.equal(settled.filter((item) => item.status === "fulfilled").length, 16);
  NodeAssert.equal(
    settled.filter(
      (item) => item.status === "rejected" && /Asset read limit reached/.test(item.reason.message),
    ).length,
    4,
  );
  for (const item of settled.filter((item) => item.status === "fulfilled"))
    NodeAssert.equal(item.value.bytes.length, bytes.length);
  let afterCount = 0;
  for (const record of records) {
    const after = await Promise.all(
      Array.from({ length: 4 }, () =>
        runtime.readAsset(
          record.id,
          record.contentHash,
          "vendor/x.wasm",
          new AbortController().signal,
        ),
      ),
    );
    afterCount += after.length;
  }
  NodeAssert.equal(afterCount, 20);
});
