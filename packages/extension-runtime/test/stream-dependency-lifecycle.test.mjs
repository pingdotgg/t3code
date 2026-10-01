import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createExtensionRuntime } from "../dist/index.js";
const providerId = "test.lifecycle-provider";
const providerApiId = "test.lifecycle-provider/events";
const consumerId = "test.lifecycle-consumer";
const unrelatedId = "test.lifecycle-unrelated";
const context = {
  client: "stream-dependency-lifecycle",
  resource: {
    namespace: "t3.thread",
    id: "thread",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
};
const providerApi = {
  id: providerApiId,
  version: "1.0.0",
  streams: [
    {
      name: "events",
      inputSchema: { type: "object", additionalProperties: false },
      eventSchema: {
        type: "object",
        properties: { kind: { type: "string" } },
        required: ["kind"],
        additionalProperties: false,
      },
      requiredGrants: [],
    },
  ],
};
const consumerApi = {
  id: consumerId + "/views",
  version: "1.0.0",
  streams: [
    {
      name: "views",
      inputSchema: { type: "object", additionalProperties: false },
      eventSchema: {
        type: "object",
        properties: { kind: { type: "string" } },
        required: ["kind"],
        additionalProperties: false,
      },
      requiredGrants: [],
    },
  ],
};
const manifest = (id, version = "1.0.0") => ({ id, version, apiVersion: 1, surfaces: [] });
async function packageDir(root, name, descriptor, server) {
  const dir = NodePath.join(root, name);
  await NodeFSP.mkdir(dir);
  await NodeFSP.writeFile(NodePath.join(dir, "t3-extension.json"), JSON.stringify(descriptor));
  await NodeFSP.writeFile(NodePath.join(dir, "server.mjs"), server);
  return dir;
}
async function writeProvider(root, name, version, kind) {
  const server = String.raw`export default {
  tools: [],
  apis: [{ id: "test.lifecycle-provider/events", streams: [{
    name: "events",
    subscribe: async function* (input, session) {
      yield { type: "snapshot", value: { kind: "KIND" } };
      await new Promise((resolve) => {
        if (session.signal.aborted) resolve();
        else session.signal.addEventListener("abort", resolve, { once: true });
      });
    },
  }] }],
};`.replace("KIND", kind);
  return packageDir(
    root,
    name,
    {
      format: 3,
      manifest: manifest(providerId, version),
      serverEntry: "server.mjs",
      tools: [],
      provides: [providerApi],
      requires: [],
      dependencies: [],
    },
    server,
  );
}
async function fixture(t) {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-stream-dependency-lifecycle-"),
  );
  const providerV1 = await writeProvider(root, "provider-v1", "1.0.0", "old");
  const providerV2 = await writeProvider(root, "provider-v2", "1.1.0", "replacement");
  const consumer = await packageDir(
    root,
    "consumer",
    {
      format: 3,
      manifest: manifest(consumerId),
      serverEntry: "server.mjs",
      tools: [],
      provides: [consumerApi],
      requires: [{ id: providerApiId, versionRange: "^1.0.0" }],
      dependencies: [
        {
          pluginId: providerId,
          versionRange: "^1.0.0",
          apis: [{ id: providerApiId, versionRange: "^1.0.0" }],
        },
      ],
    },
    String.raw`const nestedRequest = { id: "test.lifecycle-provider/events", versionRange: "^1.0.0", name: "events", input: {} };
export default {
  tools: [],
  apis: [{ id: "test.lifecycle-consumer/views", streams: [{
    name: "views",
    subscribe: async function* (input, session) {
      const iterator = session.subscribeApi(nestedRequest)[Symbol.asyncIterator]();
      const frame = await iterator.next();
      yield { type: "data", value: { kind: frame.value.value.kind } };
      await new Promise((resolve) => {
        if (session.signal.aborted) resolve();
        else session.signal.addEventListener("abort", resolve, { once: true });
      });
    },
  }] }],
};`,
  );
  const unrelated = await packageDir(
    root,
    "unrelated",
    {
      format: 3,
      manifest: manifest(unrelatedId),
      serverEntry: "server.mjs",
      tools: [
        {
          id: unrelatedId + "/pid",
          title: "pid",
          description: "worker pid",
          readOnly: true,
          inputSchema: { type: "object" },
          capabilities: [],
        },
      ],
      provides: [],
      requires: [],
      dependencies: [],
    },
    String.raw`export default { tools: [{ id: "test.lifecycle-unrelated/pid", invoke: () => process.pid }] };`,
  );
  const runtime = await createExtensionRuntime({
    rootDir: NodePath.join(root, "state"),
    environmentId: "env",
    timeoutMs: 1500,
    services: [],
    authorize: () => true,
  });
  t.after(async () => {
    await runtime.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });
  const provider = await runtime.install(providerV1, { capabilities: [], projectIds: ["project"] });
  const installedConsumer = await runtime.install(consumer, {
    capabilities: [],
    projectIds: ["project"],
  });
  const installedUnrelated = await runtime.install(unrelated, {
    capabilities: [],
    projectIds: ["project"],
  });
  return {
    runtime,
    provider,
    providerV2,
    consumer: installedConsumer,
    unrelated: installedUnrelated,
  };
}
function consumerStream(f) {
  const source = f.runtime.subscribeApi(
    f.consumer.id,
    f.consumer.contentHash,
    { id: consumerApi.id, versionRange: "^1.0.0", name: "views", input: {}, context },
    new AbortController().signal,
  );
  return source[Symbol.asyncIterator]();
}
async function firstKind(iterator) {
  return (await iterator.next()).value.value.kind;
}

NodeTest.test(
  "provider update and rollback invalidate pending consumer streams, while fresh reads and unrelated worker survive",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const pid = await f.runtime.invoke(
      unrelatedId + "/pid",
      {},
      context,
      new AbortController().signal,
      f.unrelated.contentHash,
    );
    const old = consumerStream(f);
    NodeAssert.equal(await firstKind(old), "old");
    const oldPending = old.next();
    const oldRejected = NodeAssert.rejects(oldPending, /changed|cancel|unavailable|closed|worker/i);
    const updated = await f.runtime.update(f.provider.id, f.providerV2);
    NodeAssert.equal(updated.package.manifest.version, "1.1.0");
    await oldRejected;
    await old.return().catch(() => {});
    NodeAssert.ok(
      f.runtime
        .catalogue()
        .pluginResolution.some((entry) => entry.id === providerId && entry.status === "available"),
    );
    const discovered = await f.runtime.discoverApis(
      f.consumer.id,
      f.consumer.contentHash,
      context,
      new AbortController().signal,
    );
    NodeAssert.ok(discovered.some((entry) => entry.id === providerApiId));
    const replacement = consumerStream(f);
    NodeAssert.equal(await firstKind(replacement), "replacement");
    await replacement.return();
    const replacementPending = consumerStream(f);
    NodeAssert.equal(await firstKind(replacementPending), "replacement");
    const rollbackPending = replacementPending.next();
    const rollbackRejected = NodeAssert.rejects(
      rollbackPending,
      /changed|cancel|unavailable|closed|worker/i,
    );
    const rolledBack = await f.runtime.rollback(f.provider.id);
    NodeAssert.equal(rolledBack.package.manifest.version, "1.0.0");
    await rollbackRejected;
    await replacementPending.return().catch(() => {});
    const restored = consumerStream(f);
    NodeAssert.equal(await firstKind(restored), "old");
    await restored.return();
    const removePending = consumerStream(f);
    NodeAssert.equal(await firstKind(removePending), "old");
    const removing = removePending.next();
    const removeRejected = NodeAssert.rejects(
      removing,
      /changed|cancel|unavailable|closed|worker|dependency/i,
    );
    await f.runtime.remove(f.provider.id);
    await removeRejected;
    await removePending.return().catch(() => {});
    NodeAssert.equal(
      await f.runtime.invoke(
        unrelatedId + "/pid",
        {},
        context,
        new AbortController().signal,
        f.unrelated.contentHash,
      ),
      pid,
    );
  },
);
