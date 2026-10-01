import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createApiBroker } from "../dist/broker.js";
import { createExtensionRuntime } from "../dist/index.js";

// Stream admission awaits the root authority's session revalidation. A client that
// reloads or drops its socket while that is pending must not leave a slot behind.

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
// Runs every queued continuation. Revalidation here settles through promises alone, so
// one macrotask turn is a complete drain rather than a timing guess.
const drain = () => new Promise((resolve) => setImmediate(resolve));
const principal = {
  kind: "environment-session",
  id: "session-1",
  environmentId: "env",
  scopes: [],
};
const openRoot = { principal, allowWrite: false, revalidate: () => {} };
const gatedRoot = () => {
  const gate = deferred();
  const entered = deferred();
  return {
    gate,
    entered: entered.promise,
    root: {
      principal,
      allowWrite: false,
      revalidate: () => {
        entered.resolve();
        return gate.promise;
      },
    },
  };
};

const grant = "test.resource/read";
const api = {
  id: "test.host/events",
  version: "1.0.0",
  methods: [],
  streams: [
    {
      name: "changes",
      inputSchema: { type: "object" },
      eventSchema: { type: "string" },
      requiredGrants: [grant],
    },
  ],
};
const brokerContext = {
  resource: { namespace: "test.consumer", id: "view", environmentId: "env", projectId: "project" },
  client: "test",
};
const brokerRequest = {
  id: api.id,
  versionRange: "^1.0.0",
  name: "changes",
  input: {},
  context: brokerContext,
};
const consumer = {
  id: "test.consumer",
  contentHash: "a".repeat(64),
  enabled: true,
  grants: { capabilities: [grant], projectIds: ["project"] },
  package: {
    format: 3,
    manifest: { id: "test.consumer", version: "1.0.0", apiVersion: 1, surfaces: [] },
    tools: [],
    provides: [],
    requires: [{ id: api.id, versionRange: "^1.0.0" }],
    dependencies: [],
  },
};
function brokerFixture() {
  const broker = createApiBroker({
    installations: () => [consumer],
    providers: [
      {
        providerId: "host.events",
        definition: api,
        invoke: () => null,
        subscribe: (_name, _input, _context, signal) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "data", value: "ok" };
            await new Promise((resolve) => signal.addEventListener("abort", resolve));
          },
        }),
      },
    ],
    selections: () => [],
    authorize: () => true,
    environmentId: "env",
    timeoutMs: 5000,
    invokeWorker: () => {
      throw new Error("Unexpected worker");
    },
  });
  const open = (signal, root = openRoot) =>
    broker.subscribe(consumer, brokerRequest, signal, undefined, root)[Symbol.asyncIterator]();
  // A client that goes away mid-admission: its socket closes, aborting the stream, without
  // ever calling return() on the iterator.
  const disconnectDuringAdmission = async () => {
    const { gate, entered, root } = gatedRoot();
    const client = new AbortController();
    const first = open(client.signal, root).next();
    await entered;
    client.abort(new Error("socket closed"));
    await NodeAssert.rejects(first, /socket closed|cancelled/);
    gate.resolve();
    await drain();
  };
  // Opens the full per-plugin allowance, proves the next one is refused, then drops every
  // client without an unsubscribe.
  const fillToCap = async () => {
    const clients = [];
    for (let index = 0; index < 8; index++) {
      const client = new AbortController();
      const stream = open(client.signal);
      NodeAssert.equal((await stream.next()).value.value, "ok", `stream ${index} opens`);
      clients.push(client);
    }
    await NodeAssert.rejects(open(new AbortController().signal).next(), /Plugin stream limit/);
    for (const client of clients) client.abort(new Error("socket closed"));
    await drain();
  };
  return { broker, open, disconnectDuringAdmission, fillToCap };
}

NodeTest.test(
  "a client that disconnects during admission without unsubscribing releases its slot",
  { timeout: 5000 },
  async () => {
    const f = brokerFixture();
    for (let index = 0; index < 8; index++) await f.disconnectDuringAdmission();
    await f.fillToCap();
  },
);

NodeTest.test(
  "reload loops far beyond the per-plugin cap keep the full allowance available",
  { timeout: 5000 },
  async () => {
    const f = brokerFixture();
    for (let reload = 0; reload < 24; reload++) {
      // Each reload mounts one stream that opens and one still admitting, then drops both.
      const mounted = new AbortController();
      NodeAssert.equal((await f.open(mounted.signal).next()).value.value, "ok");
      const { gate, entered, root } = gatedRoot();
      const admitting = new AbortController();
      const pending = f.open(admitting.signal, root).next();
      await entered;
      mounted.abort(new Error("socket closed"));
      admitting.abort(new Error("socket closed"));
      await NodeAssert.rejects(pending, /socket closed|cancelled/);
      gate.resolve();
      await drain();
    }
    await f.fillToCap();
    await f.fillToCap();
  },
);

NodeTest.test(
  "configuration invalidation after disconnect churn leaves no stale slot behind",
  { timeout: 5000 },
  async () => {
    const f = brokerFixture();
    for (let index = 0; index < 8; index++) await f.disconnectDuringAdmission();
    f.broker.invalidate([consumer.id]);
    await f.fillToCap();
  },
);

const packId = "test.slots";
const packApiId = packId + "/sessions";
const packContext = {
  client: "stream-slot-release",
  resource: { namespace: packId, id: "view", environmentId: "env", projectId: "project" },
};
const packRequest = {
  id: packApiId,
  versionRange: "^1.0.0",
  name: "sessions",
  input: {},
  context: packContext,
};
async function packRuntime(t) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stream-slots-")),
  );
  const source = NodePath.join(root, "package");
  await NodeFSP.mkdir(source);
  await NodeFSP.writeFile(
    NodePath.join(source, "t3-extension.json"),
    JSON.stringify({
      format: 3,
      manifest: { id: packId, version: "1.0.0", apiVersion: 1, surfaces: [] },
      serverEntry: "server.mjs",
      tools: [],
      requires: [],
      dependencies: [],
      provides: [
        {
          id: packApiId,
          version: "1.0.0",
          streams: [
            {
              name: "sessions",
              inputSchema: { type: "object", additionalProperties: false },
              eventSchema: { type: "string" },
              requiredGrants: [],
            },
          ],
        },
      ],
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(source, "server.mjs"),
    String.raw`export default {
  tools: [],
  apis: [{ id: "test.slots/sessions", streams: [{
    name: "sessions",
    subscribe: async function* (input, session) {
      yield { type: "snapshot", value: "live" };
      await new Promise((resolve) => {
        if (session.signal.aborted) resolve();
        else session.signal.addEventListener("abort", resolve, { once: true });
      });
    },
  }] }],
};`,
  );
  const runtime = await createExtensionRuntime({
    rootDir: NodePath.join(root, "state"),
    environmentId: "env",
    services: [],
    authorize: () => true,
    timeoutMs: 3000,
  });
  t.after(async () => {
    await runtime.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });
  const installed = await runtime.install(source, { capabilities: [], projectIds: ["project"] });
  const open = (signal, root = openRoot) => {
    const source = runtime.subscribeApi(packId, installed.contentHash, packRequest, signal, root);
    return source[Symbol.asyncIterator]();
  };
  const disconnectDuringAdmission = async () => {
    const { gate, entered, root: gated } = gatedRoot();
    const client = new AbortController();
    const first = open(client.signal, gated).next();
    await entered;
    client.abort(new Error("socket closed"));
    await NodeAssert.rejects(first, /socket closed|cancelled/);
    gate.resolve();
    await drain();
  };
  // Opens the full allowance against the real worker and returns the live streams.
  const openAll = async () => {
    const streams = [];
    for (let index = 0; index < 8; index++) {
      const client = new AbortController();
      const stream = open(client.signal);
      NodeAssert.equal((await stream.next()).value.value, "live", `stream ${index} opens`);
      streams.push({ client, stream });
    }
    await NodeAssert.rejects(open(new AbortController().signal).next(), /stream limit/);
    return streams;
  };
  return { runtime, open, disconnectDuringAdmission, openAll };
}

NodeTest.test(
  "a worker-backed pack recovers its allowance after disconnect churn and disable/re-enable",
  { timeout: 15000 },
  async (t) => {
    const f = await packRuntime(t);
    for (let index = 0; index < 8; index++) await f.disconnectDuringAdmission();
    await f.runtime.disable(packId);
    await f.runtime.enable(packId);
    const live = await f.openAll();
    // Disabling a pack ends its live streams and releases every slot they held.
    await f.runtime.disable(packId);
    for (const { stream } of live) await NodeAssert.rejects(stream.next(), /./);
    await f.runtime.enable(packId);
    const reopened = await f.openAll();
    // Client disconnects without unsubscribing release real worker streams too. return()
    // here only awaits the worker's settle receipt; the slot was released by the abort.
    for (const { client } of reopened) client.abort(new Error("socket closed"));
    for (const { stream } of reopened) await stream.return();
    const again = await f.openAll();
    for (const { stream } of again) await stream.return();
  },
);
