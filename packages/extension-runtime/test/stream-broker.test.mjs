import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { createApiBroker } from "../dist/broker.js";

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
const context = {
  resource: {
    namespace: "test.consumer",
    id: "view",
    environmentId: "env",
    projectId: "project",
  },
  client: "test",
};
const request = { id: api.id, versionRange: "^1.0.0", name: "changes", input: {}, context };
const record = (id = "test.consumer", capabilities = [grant]) => ({
  id,
  contentHash: "a".repeat(64),
  enabled: true,
  grants: { capabilities, projectIds: ["project"] },
  package: {
    format: 3,
    manifest: { id, version: "1.0.0", apiVersion: 1, surfaces: [] },
    tools: [],
    provides: [],
    requires: [{ id: api.id, versionRange: "^1.0.0" }],
    dependencies: [],
  },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture(subscribe, records = [record()]) {
  const audits = [];
  let valid = true;
  const broker = createApiBroker({
    installations: () => records,
    providers: [{ providerId: "host.events", definition: api, invoke: () => null, subscribe }],
    selections: () => [],
    authorize: () => true,
    validateScope: () => valid,
    environmentId: "env",
    timeoutMs: 500,
    invokeWorker: () => {
      throw new Error("Unexpected worker");
    },
    audit: (event) => audits.push(event),
  });
  return {
    broker,
    records,
    audits,
    invalidateScope: () => {
      valid = false;
    },
    open: (entry = records[0], input = request, signal = new AbortController().signal) =>
      broker.subscribe(entry, input, signal)[Symbol.asyncIterator](),
  };
}
function* values(...items) {
  for (const value of items) yield { type: "data", value };
}
const iterable = (...items) => ({
  async *[Symbol.asyncIterator]() {
    yield* values(...items);
  },
});

NodeTest.test(
  "streams preserve host identity and sequence, expose immutable metadata, and audit once per lifecycle",
  { timeout: 5000 },
  async () => {
    let metadata;
    const f = fixture((_name, _input, _context, _signal, captured) => {
      metadata = captured;
      return iterable("one", "two");
    });
    const stream = f.open();
    const a = await stream.next();
    const b = await stream.next();
    NodeAssert.equal(a.value.streamId, b.value.streamId);
    NodeAssert.deepEqual([a.value.sequence, b.value.sequence], [1, 2]);
    NodeAssert.equal(metadata.rootCallerId, f.records[0].id);
    NodeAssert.ok(Object.isFrozen(metadata));
    NodeAssert.ok(Object.isFrozen(metadata.callerGenerations));
    NodeAssert.equal((await stream.next()).done, true);
    NodeAssert.deepEqual(
      f.audits.map((event) => event.operation),
      ["stream-open", "stream-close"],
    );
    NodeAssert.equal(f.audits[1].outcome, "completed");
  },
);

NodeTest.test(
  "explicit grant membership is enforced even if the authority adapter returns true",
  { timeout: 5000 },
  async () => {
    let opened = false;
    const f = fixture(() => {
      opened = true;
      return iterable("secret");
    }, [record("test.denied", [])]);
    await NodeAssert.rejects(f.open().next(), /capability denied/);
    NodeAssert.equal(opened, false);
  },
);

NodeTest.test(
  "rechecks scope after a pending response and suppresses late data",
  { timeout: 5000 },
  async () => {
    const ready = deferred();
    const next = deferred();
    const f = fixture(() => ({
      [Symbol.asyncIterator]() {
        return {
          next() {
            ready.resolve();
            return next.promise;
          },
          async return() {
            return { done: true };
          },
        };
      },
    }));
    const stream = f.open();
    const pending = stream.next();
    await ready.promise;
    f.invalidateScope();
    next.resolve({ done: false, value: { type: "data", value: "late" } });
    await NodeAssert.rejects(pending, /scope changed/);
  },
);

NodeTest.test(
  "invalidation interrupts pending reads and return; unrelated streams survive",
  { timeout: 5000 },
  async () => {
    const ready = deferred();
    let returns = 0;
    const records = [record("test.first"), record("test.other")];
    const f = fixture((_name, _input, _context, signal, metadata) => {
      if (metadata.callerId === "test.other") return iterable("unaffected");
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              ready.resolve(signal);
              return new Promise(() => {});
            },
            async return() {
              returns++;
              return { done: true };
            },
          };
        },
      };
    }, records);
    const first = f.open(records[0]);
    const second = f.open(records[1]);
    const pending = first.next();
    const signal = await ready.promise;
    f.broker.invalidate([records[0].id]);
    await NodeAssert.rejects(pending, /configuration changed/);
    NodeAssert.equal(signal.aborted, true);
    NodeAssert.equal(returns, 1);
    NodeAssert.equal((await second.next()).value.value, "unaffected");
    await second.return();
  },
);

NodeTest.test(
  "iterator return cancels pending next without waiting for an uncooperative source",
  { timeout: 5000 },
  async () => {
    const ready = deferred();
    const f = fixture((_name, _input, _context, signal) => ({
      [Symbol.asyncIterator]() {
        return {
          next() {
            ready.resolve(signal);
            return new Promise(() => {});
          },
          async return() {
            return { done: true };
          },
        };
      },
    }));
    const stream = f.open();
    const pending = stream.next();
    const signal = await ready.promise;
    const rejected = NodeAssert.rejects(pending, /closed/);
    await stream.return();
    await rejected;
    NodeAssert.equal(signal.aborted, true);
    NodeAssert.equal((await stream.next()).done, true);
  },
);

NodeTest.test(
  "validates event shape, type, cursor and full frame size",
  { timeout: 5000 },
  async () => {
    for (const value of [
      { type: "data", value: 123 },
      { type: "write", value: "text" },
      { type: "data", value: "text", cursor: "x".repeat(1025) },
      { type: "data", value: "x".repeat(65535) },
    ]) {
      const f = fixture(() => ({
        async *[Symbol.asyncIterator]() {
          yield value;
        },
      }));
      await NodeAssert.rejects(f.open().next(), /schema|cursor|limit/);
    }
  },
);

NodeTest.test(
  "rejects concurrent pulls, stale generations and incompatible requirements",
  { timeout: 5000 },
  async () => {
    const ready = deferred();
    const frame = deferred();
    const f = fixture(() => ({
      [Symbol.asyncIterator]() {
        return {
          next() {
            ready.resolve();
            return frame.promise;
          },
          async return() {
            return { done: true };
          },
        };
      },
    }));
    const stream = f.open();
    const first = stream.next();
    await ready.promise;
    await NodeAssert.rejects(stream.next(), /Concurrent/);
    frame.resolve({ done: false, value: { type: "data", value: "ok" } });
    await first;
    await stream.return();
    await NodeAssert.rejects(
      f.open(undefined, { ...request, expectedGeneration: 1 }).next(),
      /Stale/,
    );
    await NodeAssert.rejects(
      f.open(undefined, { ...request, versionRange: "^2.0.0" }).next(),
      /Incompatible/,
    );
  },
);

NodeTest.test(
  "admission is lazy, per-plugin bounded, environment bounded, and recovered after return",
  { timeout: 5000 },
  async () => {
    const records = Array.from({ length: 9 }, (_, index) => record("test.reader" + index));
    const f = fixture(
      () => ({
        async *[Symbol.asyncIterator]() {
          while (true) yield { type: "data", value: "ok" };
        },
      }),
      records,
    );
    for (let i = 0; i < 100; i++)
      f.broker.subscribe(records[0], request, new AbortController().signal);
    const active = [];
    try {
      for (let index = 0; index < 64; index++) {
        const iterator = f.open(records[Math.floor(index / 8)]);
        await iterator.next();
        active.push(iterator);
        if (index === 7) await NodeAssert.rejects(f.open(records[0]).next(), /Plugin stream limit/);
      }
      await NodeAssert.rejects(f.open(records[8]).next(), /Environment stream limit/);
      await active.pop().return();
      const recovered = f.open(records[8]);
      NodeAssert.equal((await recovered.next()).value.value, "ok");
      active.push(recovered);
    } finally {
      await Promise.all(active.map((iterator) => iterator.return()));
    }
  },
);

NodeTest.test(
  "already-aborted subscription fails before acquiring authority or opening provider",
  { timeout: 5000 },
  async () => {
    let opened = 0;
    const f = fixture(() => {
      opened++;
      return iterable("never");
    });
    const controller = new AbortController();
    controller.abort();
    await NodeAssert.rejects(f.open(undefined, request, controller.signal).next(), /cancelled/);
    NodeAssert.equal(opened, 0);
  },
);

NodeTest.test(
  "stream-close audits a first-pull failure as failed, not completed",
  { timeout: 5000 },
  async () => {
    const f = fixture(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error("source exploded");
      },
    }));
    await NodeAssert.rejects(f.open().next(), /source exploded/);
    NodeAssert.deepEqual(
      f.audits.map((event) => [event.operation, event.outcome]),
      [
        ["stream-open", "completed"],
        ["stream-close", "failed"],
      ],
    );
  },
);

NodeTest.test(
  "stream-close audits a later-pull failure as failed, not completed",
  { timeout: 5000 },
  async () => {
    const f = fixture(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "data", value: "ok" };
        throw new Error("mid-stream exploded");
      },
    }));
    const stream = f.open();
    NodeAssert.equal((await stream.next()).value.value, "ok");
    await NodeAssert.rejects(stream.next(), /mid-stream exploded/);
    NodeAssert.deepEqual(
      f.audits.map((event) => [event.operation, event.outcome]),
      [
        ["stream-open", "completed"],
        ["stream-close", "failed"],
      ],
    );
  },
);

NodeTest.test(
  "stream-close audits consumer return and external cancellation as cancelled",
  { timeout: 5000 },
  async () => {
    const f = fixture(() => ({
      async *[Symbol.asyncIterator]() {
        while (true) yield { type: "data", value: "ok" };
      },
    }));
    const returned = f.open();
    await returned.next();
    await returned.return();
    const controller = new AbortController();
    const aborted = f.open(undefined, request, controller.signal);
    await aborted.next();
    controller.abort(new Error("went away"));
    await NodeAssert.rejects(aborted.next(), /cancelled/);
    NodeAssert.deepEqual(
      f.audits.map((event) => [event.operation, event.outcome]),
      [
        ["stream-open", "completed"],
        ["stream-close", "cancelled"],
        ["stream-open", "completed"],
        ["stream-close", "cancelled"],
      ],
    );
  },
);

NodeTest.test(
  "provider selection changes suppress the pending frame",
  { timeout: 5000 },
  async () => {
    let selected = "host.first";
    const waiting = deferred();
    const ready = deferred();
    const entry = record();
    const subscribe = () => ({
      [Symbol.asyncIterator]() {
        return {
          next() {
            ready.resolve();
            return waiting.promise;
          },
          async return() {
            return { done: true };
          },
        };
      },
    });
    const broker = createApiBroker({
      installations: () => [entry],
      providers: ["host.first", "host.second"].map((providerId) => ({
        providerId,
        definition: api,
        subscribe,
        invoke: () => null,
      })),
      selections: () => [{ id: api.id, providerId: selected, fallbackProviderIds: [] }],
      authorize: () => true,
      environmentId: "env",
      timeoutMs: 500,
      invokeWorker: () => {
        throw new Error("Unexpected worker");
      },
    });
    const streamSource = broker.subscribe(entry, request, new AbortController().signal);
    const stream = streamSource[Symbol.asyncIterator]();
    const pending = stream.next();
    await ready.promise;
    selected = "host.second";
    waiting.resolve({ done: false, value: { type: "data", value: "old provider" } });
    await NodeAssert.rejects(pending, /Stale API generation/);
  },
);
