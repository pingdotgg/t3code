import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createExtensionRuntime } from "../dist/index.js";
import { textEditsApi, textEditsApiV1 } from "@t3tools/extension-sdk/catalogue";

const MAX = 24000;
const utf8 = (value) => new TextEncoder().encode(value).length;
const revision = "c".repeat(64);
const grants = {
  capabilities: ["t3.workspace/read-text", "t3.workspace/write-text"],
  projectIds: ["project"],
};
const context = {
  resource: {
    namespace: "test.resource",
    id: "editor",
    environmentId: "env",
    projectId: "project",
  },
  client: "web",
};
const signal = () => new AbortController().signal;
const metadata = (id, { provides = [], requires = [] } = {}) => ({
  format: 2,
  manifest: { id, apiVersion: 1, version: "1.0.0", surfaces: [] },
  serverEntry: "server.mjs",
  tools: [],
  provides,
  requires,
  dependencies: [],
});

/**
 * An independent provider: its own server.mjs enforces the byte bound with a
 * plain Buffer.byteLength check — no SDK validator — so these tests exercise
 * the contract against code that is not the first-party host.
 */
const textEditsProviderSource = `export default {tools:[],apis:[{
  id: "t3.workspace/text-edits",
  methods: [
    { name: "readSnapshot", invoke: async (input) => ({
      kind: "editable",
      relativePath: input.relativePath,
      contents: input.relativePath === "big.txt" ? "x".repeat(${MAX + 1}) : "ok",
      revision: "${"b".repeat(64)}",
    }) },
    { name: "save", invoke: async (input) => {
      if (Buffer.byteLength(input.contents, "utf8") > ${MAX})
        throw new Error("independent provider: contents exceed the ${MAX}-byte editable bound");
      return { kind: "saved", relativePath: input.relativePath, revision: "${revision}" };
    } },
  ],
}]};`;

async function fixture(t) {
  // The runtime root rejects symlinked paths; macOS tmpdir is one.
  const directory = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-text-edits-bounds-")),
  );
  const options = {
    rootDir: NodePath.join(directory, "state"),
    environmentId: "env",
    services: [],
    authorize: () => true,
    timeoutMs: 3000,
  };
  const runtime = await createExtensionRuntime(options);
  t.after(async () => {
    await runtime.dispose();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  const install = async (pkg, code) => {
    const dir = NodePath.join(directory, "source-" + pkg.manifest.id);
    await NodeFSP.mkdir(dir);
    await NodeFSP.writeFile(NodePath.join(dir, "t3-extension.json"), JSON.stringify(pkg));
    await NodeFSP.writeFile(NodePath.join(dir, "server.mjs"), code);
    return runtime.install(dir, grants);
  };
  const consumer = async () =>
    install(
      metadata("test.consumer", {
        requires: [{ id: "t3.workspace/text-edits", versionRange: "^1.0.0" }],
      }),
      "export default {tools:[],apis:[]};",
    );
  const call = (record, method, input, versionRange = "^1.0.0") =>
    runtime.invokeApi(
      record.id,
      record.contentHash,
      {
        id: "t3.workspace/text-edits",
        versionRange,
        method,
        input,
        context,
      },
      signal(),
    );
  return { install, consumer, call };
}

NodeTest.test(
  "independent provider honours the byte bound at the boundary for every content class",
  async (t) => {
    const f = await fixture(t);
    await f.install(
      metadata("test.edits-provider", { provides: [textEditsApi.definition] }),
      textEditsProviderSource,
    );
    const consumer = await f.consumer();
    const save = (contents) =>
      f.call(consumer, "save", { relativePath: "doc.txt", expectedRevision: revision, contents });
    const atBound = (unit, unitBytes) => {
      const count = Math.floor(MAX / unitBytes);
      return {
        ok: unit.repeat(count) + "a".repeat(MAX - count * unitBytes),
        over: unit.repeat(count + 1),
      };
    };
    for (const [label, unit, unitBytes] of [
      ["ascii", "a", 1],
      ["two-byte", "é", 2],
      ["three-byte", "界", 3],
      ["astral", "\u{1F600}", 4],
      ["escape-heavy", '\n\t"\\\r', 5],
    ]) {
      const { ok, over } = atBound(unit, unitBytes);
      NodeAssert.equal(utf8(ok), MAX, label);
      NodeAssert.deepEqual(
        await save(ok),
        { kind: "saved", relativePath: "doc.txt", revision },
        label,
      );
      await NodeAssert.rejects(save(over), /24000|byte/i, label);
    }
  },
);

NodeTest.test("a 30000-character save is rejected with the advertised bound named", async (t) => {
  const f = await fixture(t);
  await f.install(
    metadata("test.edits-provider", { provides: [textEditsApi.definition] }),
    textEditsProviderSource,
  );
  const consumer = await f.consumer();
  await NodeAssert.rejects(
    f.call(consumer, "save", {
      relativePath: "doc.txt",
      expectedRevision: revision,
      contents: "x".repeat(30000),
    }),
    /contents.*24000|24000.*contents/i,
  );
});

NodeTest.test(
  "schema-admissible but byte-oversized saves reach the provider and fail clearly",
  async (t) => {
    const f = await fixture(t);
    await f.install(
      metadata("test.edits-provider", { provides: [textEditsApi.definition] }),
      textEditsProviderSource,
    );
    const consumer = await f.consumer();
    // 12001 three-byte characters: 12001 UTF-16 units (passes maxLength) but
    // 36003 UTF-8 bytes — the provider's own byte check must reject it.
    const contents = "界".repeat(12001);
    NodeAssert.equal(utf8(contents), 36003);
    await NodeAssert.rejects(
      f.call(consumer, "save", { relativePath: "doc.txt", expectedRevision: revision, contents }),
      /24000-byte editable bound/,
    );
  },
);

NodeTest.test("over-bound independent provider output is rejected by output schema", async (t) => {
  const f = await fixture(t);
  await f.install(
    metadata("test.edits-provider", { provides: [textEditsApi.definition] }),
    textEditsProviderSource,
  );
  const consumer = await f.consumer();
  const ok = await f.call(consumer, "readSnapshot", { relativePath: "doc.txt" });
  NodeAssert.equal(ok.contents, "ok");
  await NodeAssert.rejects(
    f.call(consumer, "readSnapshot", { relativePath: "big.txt" }),
    /output does not match schema.*contents|contents.*24000/i,
  );
});

NodeTest.test("escape-heavy input that would overflow the envelope names the field", async (t) => {
  const f = await fixture(t);
  await f.install(
    metadata("test.edits-provider", { provides: [textEditsApi.definition] }),
    textEditsProviderSource,
  );
  const consumer = await f.consumer();
  // 24000 control characters pass every per-field bound (24000 units, 24000
  // UTF-8 bytes) yet JSON-escape to ~144KB — the transport envelope is the
  // bound that fires, and it must name the offending field.
  const contents = "\u0001".repeat(MAX);
  NodeAssert.equal(utf8(contents), MAX);
  await NodeAssert.rejects(
    f.call(consumer, "save", { relativePath: "doc.txt", expectedRevision: revision, contents }),
    /byte limit.*"input\.contents"/,
  );
});

NodeTest.test(
  "a provider shipping the frozen 1.0.0 definition still registers and serves",
  async (t) => {
    const f = await fixture(t);
    await f.install(
      metadata("test.legacy-provider", { provides: [textEditsApiV1.definition] }),
      textEditsProviderSource,
    );
    const consumer = await f.consumer();
    const saved = await f.call(
      consumer,
      "save",
      { relativePath: "doc.txt", expectedRevision: revision, contents: "v2" },
      "^1.0.0",
    );
    NodeAssert.equal(saved.kind, "saved");
  },
);
