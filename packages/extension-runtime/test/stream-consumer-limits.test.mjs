import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createExtensionRuntime } from "../dist/index.js";

const context = {
  client: "stream-consumer-limits",
  resource: {
    namespace: "t3.thread",
    id: "thread",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
};
const streamApi = {
  id: "test.stream-producer/events",
  version: "1.0.0",
  streams: [
    {
      name: "events",
      inputSchema: {
        type: "object",
        properties: { end: { type: "boolean" }, error: { type: "boolean" } },
        additionalProperties: false,
      },
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
  id: "test.stream-consumer/views",
  version: "1.0.0",
  streams: [
    {
      name: "views",
      inputSchema: { type: "object", additionalProperties: false },
      eventSchema: {
        type: "object",
        properties: { kind: { type: "string" }, value: {} },
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
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stream-consumer-limits-"));
  const state = NodePath.join(root, "state");
  const providerDescriptor = {
    format: 3,
    manifest: manifest("test.stream-producer"),
    serverEntry: "server.mjs",
    tools: [],
    provides: [streamApi],
    requires: [],
    dependencies: [],
  };
  const consumerDescriptor = {
    format: 3,
    manifest: manifest("test.stream-consumer"),
    serverEntry: "server.mjs",
    tools: [
      {
        id: "test.stream-consumer/dormant",
        title: "dormant",
        description: "lazy",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: [],
      },
      {
        id: "test.stream-consumer/active-limit",
        title: "active-limit",
        description: "limit",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: [],
      },
      {
        id: "test.stream-consumer/replacement",
        title: "replacement",
        description: "replacement",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: [],
      },
    ],
    provides: [consumerApi],
    requires: [{ id: streamApi.id, versionRange: "^1.0.0" }],
    dependencies: [
      {
        pluginId: "test.stream-producer",
        versionRange: "^1.0.0",
        apis: [{ id: streamApi.id, versionRange: "^1.0.0" }],
      },
    ],
  };
  const providerServer = String.raw`export default {
  tools: [],
  apis: [{ id: "test.stream-producer/events", streams: [{
    name: "events",
    subscribe: async function* (input, session) {
      yield { type: "snapshot", value: { kind: "first" } };
      if (input.error) throw new Error("fixture stream error");
      if (input.end) return;
      await new Promise((resolve) => {
        if (session.signal.aborted) resolve();
        else session.signal.addEventListener("abort", resolve, { once: true });
      });
    },
  }] }],
};`;
  const consumerServer = String.raw`const providerRequest = (input = {}) => ({
  id: "test.stream-producer/events", versionRange: "^1.0.0", name: "events", input,
});
const firstNested = async (session, input = {}) => {
  const stream = session.subscribeApi(providerRequest(input));
  const iterator = stream[Symbol.asyncIterator]();
  return { iterator, frame: await iterator.next() };
};
export default {
  tools: [
    { id: "test.stream-consumer/dormant", invoke: async (input, session) => {
      const streams = [];
      for (let index = 0; index < 9; index += 1) streams.push(session.subscribeApi(providerRequest()));
      const iterator = streams[0][Symbol.asyncIterator]();
      const first = await iterator.next();
      await iterator.return();
      return first.value;
    } },
    { id: "test.stream-consumer/active-limit", invoke: async (input, session) => {
      const active = [];
      for (let index = 0; index < 8; index += 1) active.push((await firstNested(session)).iterator);
      const ninth = session.subscribeApi(providerRequest())[Symbol.asyncIterator]();
      let blocked = "";
      try { await ninth.next(); } catch (error) { blocked = String(error?.message ?? error); }
      for (const iterator of active) await iterator.return();
      const fresh = await firstNested(session);
      const freshValue = fresh.frame.value;
      await fresh.iterator.return();
      return { active: active.length, blocked, fresh: freshValue };
    } },
    { id: "test.stream-consumer/replacement", invoke: async (input, session) => {
      const ended = await firstNested(session, { end: true });
      const endedAgain = await ended.iterator.next();
      const afterEnd = await firstNested(session);
      await afterEnd.iterator.return();
      const failed = await firstNested(session, { error: true });
      let failedMessage = "";
      try { await failed.iterator.next(); } catch (error) { failedMessage = String(error?.message ?? error); }
      const afterError = await firstNested(session);
      const afterErrorValue = afterError.frame.value;
      await afterError.iterator.return();
      return { ended: endedAgain.done, failed: failedMessage, freshAfterEnd: afterEnd.frame.value, freshAfterError: afterErrorValue };
    } },
  ],
  apis: [{ id: "test.stream-consumer/views", streams: [{
    name: "views",
    subscribe: async function* (input, session) {
      const nested = await firstNested(session);
      yield { type: "data", value: { kind: "nested", value: nested.frame.value } };
      await new Promise((resolve) => {
        if (session.signal.aborted) resolve();
        else session.signal.addEventListener("abort", resolve, { once: true });
      });
    },
  }] }],
};`;
  const provider = await packageDir(root, "producer", providerDescriptor, providerServer);
  const consumer = await packageDir(root, "consumer", consumerDescriptor, consumerServer);
  const runtime = await createExtensionRuntime({
    rootDir: state,
    environmentId: "env",
    timeoutMs: 1500,
    services: [],
    authorize: () => true,
  });
  t.after(async () => {
    await runtime.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });
  const producer = await runtime.install(provider, { capabilities: [], projectIds: ["project"] });
  const installedConsumer = await runtime.install(consumer, {
    capabilities: [],
    projectIds: ["project"],
  });
  return { runtime, producer, consumer: installedConsumer };
}

NodeTest.test(
  "more than eight dormant session.subscribeApi iterables admit lazily",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const result = await f.runtime.invoke(
      "test.stream-consumer/dormant",
      {},
      context,
      new AbortController().signal,
      f.consumer.contentHash,
    );
    NodeAssert.deepEqual(result.value, { kind: "first" });
  },
);

NodeTest.test(
  "eight active nested streams reject the ninth and release all slots on return",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const result = await f.runtime.invoke(
      "test.stream-consumer/active-limit",
      {},
      context,
      new AbortController().signal,
      f.consumer.contentHash,
    );
    NodeAssert.equal(result.active, 8);
    NodeAssert.match(result.blocked, /stream limit/i);
    NodeAssert.deepEqual(result.fresh.value, { kind: "first" });
  },
);

NodeTest.test(
  "ended and errored nested streams can be replaced without killing the worker",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const result = await f.runtime.invoke(
      "test.stream-consumer/replacement",
      {},
      context,
      new AbortController().signal,
      f.consumer.contentHash,
    );
    NodeAssert.equal(result.ended, true);
    NodeAssert.match(result.failed, /fixture stream error/i);
    NodeAssert.deepEqual(result.freshAfterEnd.value, { kind: "first" });
    NodeAssert.deepEqual(result.freshAfterError.value, { kind: "first" });
    const repeat = await f.runtime.invoke(
      "test.stream-consumer/dormant",
      {},
      context,
      new AbortController().signal,
      f.consumer.contentHash,
    );
    NodeAssert.deepEqual(repeat.value, { kind: "first" });
  },
);
