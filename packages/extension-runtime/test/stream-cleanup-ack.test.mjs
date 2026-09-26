import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createExtensionRuntime } from "../dist/index.js";

const providerId = "test.cleanup-provider";
const providerApiId = "test.cleanup-provider/events";
const consumerId = "test.cleanup-consumer";
const completedGrant = "test.cleanup/completed";
const context = {
  client: "stream-cleanup-ack",
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
    {
      name: "cleanupEvents",
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
const manifest = (id) => ({ id, version: "1.0.0", apiVersion: 1, surfaces: [] });

async function packageDir(root, name, descriptor, server) {
  const dir = NodePath.join(root, name);
  await NodeFSP.mkdir(dir);
  await NodeFSP.writeFile(NodePath.join(dir, "t3-extension.json"), JSON.stringify(descriptor));
  await NodeFSP.writeFile(NodePath.join(dir, "server.mjs"), server);
  return dir;
}

async function fixture(t) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stream-cleanup-ack-"));
  const provider = await packageDir(
    root,
    "provider",
    {
      format: 3,
      manifest: manifest(providerId),
      serverEntry: "server.mjs",
      tools: [
        {
          id: providerId + "/release",
          title: "release",
          description: "release cleanup",
          readOnly: true,
          inputSchema: { type: "object" },
          capabilities: [],
        },
      ],
      provides: [providerApi],
      requires: [],
      dependencies: [],
    },
    String.raw`let enteredResolve;
let releaseResolve;
const entered = new Promise((resolve) => { enteredResolve = resolve; });
const release = new Promise((resolve) => { releaseResolve = resolve; });
export default {
  tools: [{ id: "test.cleanup-provider/release", invoke: () => { releaseResolve(); return "released"; } }],
  apis: [{
    id: "test.cleanup-provider/events",
    streams: [
      {
        name: "events",
        subscribe: async function* (input, session) {
          try {
            yield { type: "snapshot", value: { kind: "first" } };
            await new Promise((resolve) => {
              if (session.signal.aborted) resolve();
              else session.signal.addEventListener("abort", resolve, { once: true });
            });
          } finally {
            enteredResolve();
            await release;
          }
        },
      },
      {
        name: "cleanupEvents",
        subscribe: async function* () {
          await entered;
          yield { type: "snapshot", value: { kind: "cleanup-entered" } };
        },
      },
    ],
  }],
};`,
  );
  const consumer = await packageDir(
    root,
    "consumer",
    {
      format: 3,
      manifest: manifest(consumerId),
      serverEntry: "server.mjs",
      tools: [
        {
          id: consumerId + "/check",
          title: "check",
          description: "cleanup ack",
          readOnly: true,
          inputSchema: { type: "object" },
          capabilities: [completedGrant],
        },
        {
          id: consumerId + "/status",
          title: "status",
          description: "return status",
          readOnly: true,
          inputSchema: { type: "object" },
          capabilities: [],
        },
      ],
      provides: [],
      requires: [{ id: providerApiId, versionRange: "^1.0.0" }],
      dependencies: [
        {
          pluginId: providerId,
          versionRange: "^1.0.0",
          apis: [{ id: providerApiId, versionRange: "^1.0.0" }],
        },
      ],
    },
    String.raw`let returned = false;
const request = { id: "test.cleanup-provider/events", versionRange: "^1.0.0", name: "events", input: {} };
export default {
  tools: [
    {
      id: "test.cleanup-consumer/check",
      invoke: async (input, session) => {
        const iterator = session.subscribeApi(request)[Symbol.asyncIterator]();
        const first = await iterator.next();
        await iterator.return();
        returned = true;
        const next = session.subscribeApi(request)[Symbol.asyncIterator]();
        const frame = await next.next();
        await next.return();
        await session.invoke("test.cleanup/completed", {});
        return { first: first.value.value.kind, replacement: frame.value.value.kind };
      },
    },
    { id: "test.cleanup-consumer/status", invoke: async () => ({ returned }) },
  ],
};`,
  );
  let consumerCompletedResolve;
  const consumerCompleted = new Promise((resolve) => {
    consumerCompletedResolve = resolve;
  });
  const runtime = await createExtensionRuntime({
    rootDir: NodePath.join(root, "state"),
    environmentId: "env",
    timeoutMs: 1500,
    services: [
      {
        capability: completedGrant,
        invoke: () => {
          consumerCompletedResolve();
          return null;
        },
      },
    ],
    authorize: () => true,
  });
  t.after(async () => {
    await runtime.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });
  const installedProvider = await runtime.install(provider, {
    capabilities: [],
    projectIds: ["project"],
  });
  const installedConsumer = await runtime.install(consumer, {
    capabilities: [completedGrant],
    projectIds: ["project"],
  });
  return { runtime, provider: installedProvider, consumer: installedConsumer, consumerCompleted };
}

NodeTest.test(
  "iterator.return waits for cooperative producer cleanup acknowledgement",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const observerSource = f.runtime.subscribeApi(
      f.provider.id,
      f.provider.contentHash,
      { id: providerApiId, versionRange: "^1.0.0", name: "cleanupEvents", input: {}, context },
      new AbortController().signal,
    );
    const observer = observerSource[Symbol.asyncIterator]();
    const invocation = f.runtime.invoke(
      consumerId + "/check",
      {},
      context,
      new AbortController().signal,
      f.consumer.contentHash,
    );
    const entered = await observer.next();
    NodeAssert.equal(entered.value.value.kind, "cleanup-entered");
    const status = await f.runtime.invoke(
      consumerId + "/status",
      {},
      context,
      new AbortController().signal,
      f.consumer.contentHash,
    );
    NodeAssert.deepEqual(status, { returned: false });
    const released = await f.runtime.invoke(
      providerId + "/release",
      {},
      context,
      new AbortController().signal,
      f.provider.contentHash,
    );
    NodeAssert.equal(released, "released");
    const result = await invocation;
    NodeAssert.equal(result.first, "first");
    NodeAssert.equal(result.replacement, "first");
    await observer.return();
  },
);
