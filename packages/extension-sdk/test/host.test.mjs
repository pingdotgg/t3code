import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { createExtensionHost } from "../dist/host.js";
import { copyJson, resourceKey } from "../dist/contracts.js";
const context = (env = "one", revision = "1") => ({
  resource: {
    namespace: "example.resources",
    id: "same",
    environmentId: env,
    projectId: "project",
    threadId: "thread",
  },
  workspaceRevision: revision,
  client: "web",
});
const record = (env = "one") => ({
  version: 1,
  surfaceId: "example.counter/view",
  context: context(env),
  placement: "side-panel",
  stateVersion: 1,
  restoreState: null,
  fallback: "Counter unavailable",
});
const manifest = () => ({
  id: "example.counter",
  version: "1.0.0",
  apiVersion: 1,
  surfaces: [
    {
      id: "example.counter/view",
      title: "Counter",
      placements: ["side-panel", "bottom-dock"],
      clients: ["web"],
      scope: "thread",
      capabilities: ["host.counter/read"],
      stateVersion: 1,
    },
  ],
});
function fixture(overrides = {}) {
  const sessions = [],
    visibility = [],
    disposed = [];
  const renderer = {};
  const host = createExtensionHost({
    authorize: () => true,
    services: [
      {
        capability: "host.counter/read",
        invoke: (call) => ({ environment: call.context.resource.environmentId, input: call.input }),
      },
    ],
    ...overrides,
  });
  const extension = {
    manifest: manifest(),
    surfaces: [
      {
        id: "example.counter/view",
        validateRestore: (state) => state === null || typeof state.count === "number",
        createView(session) {
          sessions.push(session);
          session.publish(0, { count: 0 });
          session.onVisibility((value) => visibility.push(value));
          session.onDispose(() => disposed.push(session));
          return { renderer };
        },
      },
    ],
  };
  host.register(extension);
  return { host, extension, sessions, visibility, disposed, renderer };
}
NodeTest.test(
  "public lifecycle preserves hidden renderer/session and independent shared viewers",
  async () => {
    const f = fixture();
    const a = await f.host.open(record()),
      b = await f.host.open(record());
    NodeAssert.equal(f.host.renderer(a), f.renderer);
    NodeAssert.equal(f.sessions.length, 2);
    NodeAssert.deepEqual(await f.sessions[0].invoke("host.counter/read", { operation: "read" }), {
      environment: "one",
      input: { operation: "read" },
    });
    f.sessions[0].save({ count: 8 });
    const saved = f.host.snapshot(a).record;
    f.host.hide(a);
    NodeAssert.equal(f.sessions[0].signal.aborted, false);
    NodeAssert.equal(f.sessions[0].visible, false);
    NodeAssert.equal(f.sessions[0].publish(1, { count: 999 }), false);
    await NodeAssert.rejects(f.sessions[0].invoke("host.counter/read", null), /inactive/);
    await f.host.show(a);
    NodeAssert.equal(f.sessions.length, 2);
    NodeAssert.equal(f.host.renderer(a), f.renderer);
    NodeAssert.deepEqual(f.visibility, [false, true]);
    f.host.close(a);
    f.host.close(a);
    NodeAssert.equal(f.disposed.length, 1);
    NodeAssert.equal(f.sessions[1].signal.aborted, false);
    const c = await f.host.restore(saved);
    NodeAssert.equal(f.sessions[2].restoring, true);
    NodeAssert.deepEqual(f.sessions[2].restoreState, { count: 8 });
    f.host.move(c, "bottom-dock");
    NodeAssert.equal(f.sessions.length, 3);
    f.host.disable("example.counter");
    NodeAssert.equal(f.host.snapshot(b).status, "unavailable");
    NodeAssert.equal(f.disposed.length, 3);
    f.host.enable("example.counter");
    await f.host.show(c);
    NodeAssert.equal(f.host.snapshot(c).status, "ready");
    f.host.dispose();
    NodeAssert.deepEqual(f.host.diagnostics(), {
      views: 0,
      registrations: 0,
      listeners: 0,
      pendingCalls: 0,
    });
  },
);
NodeTest.test(
  "scope and revision changes cancel old work and cannot publish into a new environment",
  async () => {
    let resolveOld;
    const calls = [];
    const f = fixture({
      services: [
        {
          capability: "host.counter/read",
          invoke: (call) => {
            calls.push(call);
            return new Promise((resolve) => (resolveOld = resolve));
          },
        },
      ],
    });
    const id = await f.host.open(record());
    const old = f.sessions[0];
    const pending = old.invoke("host.counter/read", null);
    await Promise.resolve();
    const rejected = NodeAssert.rejects(pending, /cancelled|Stale/);
    await f.host.updateContext(id, context("two", "2"));
    await rejected;
    NodeAssert.equal(calls[0].signal.aborted, true);
    resolveOld({ environment: "one" });
    NodeAssert.equal(old.publish(100, { wrong: true }), false);
    NodeAssert.equal(f.host.snapshot(id).record.context.resource.environmentId, "two");
    NodeAssert.deepEqual(f.host.snapshot(id).state, { count: 0 });
    NodeAssert.notEqual(resourceKey(context().resource), resourceKey(context("two").resource));
    await f.host.updateContext(id, context("two", "3"));
    NodeAssert.equal(f.sessions[1].signal.aborted, true);
    f.host.dispose();
  },
);
NodeTest.test(
  "hide cancels activity but show can issue a fresh call in the same session",
  async () => {
    let first = true,
      signal;
    const f = fixture({
      services: [
        {
          capability: "host.counter/read",
          invoke: (call) => {
            signal = call.signal;
            if (first) {
              first = false;
              return new Promise(() => {});
            }
            return { ok: true };
          },
        },
      ],
    });
    const id = await f.host.open(record());
    const session = f.sessions[0];
    const call = session.invoke("host.counter/read", null);
    await Promise.resolve();
    const rejected = NodeAssert.rejects(call, /cancelled/);
    f.host.hide(id);
    await rejected;
    NodeAssert.equal(signal.aborted, true);
    await f.host.show(id);
    NodeAssert.deepEqual(await session.invoke("host.counter/read", null), { ok: true });
    f.host.dispose();
  },
);
NodeTest.test(
  "rejects invalid, duplicate and incompatible registrations and isolates restore fallbacks",
  async () => {
    const f = fixture();
    NodeAssert.throws(() => f.host.register(f.extension), /Duplicate/);
    for (const patch of [{ apiVersion: 2 }, { id: "counter" }, { version: "latest" }])
      NodeAssert.throws(() =>
        createExtensionHost({ authorize: () => true }).register({
          ...f.extension,
          manifest: { ...manifest(), ...patch },
        }),
      );
    for (const patch of [
      { surfaceId: "absent.extension/view" },
      { stateVersion: 2 },
      { restoreState: { wrong: true } },
      { context: { ...context(), client: "swift" } },
      {
        context: {
          resource: { namespace: "example.resources", id: "same", environmentId: "one" },
          client: "web",
        },
      },
    ]) {
      const id = await f.host.restore({ ...record(), ...patch });
      NodeAssert.equal(f.host.snapshot(id).status, "unavailable");
      NodeAssert.equal(f.host.snapshot(id).record.fallback, "Counter unavailable");
    }
    NodeAssert.equal(f.sessions.length, 0);
    f.host.dispose();
  },
);
NodeTest.test(
  "grants rechecked per call, inputs copied, mutation cannot change captured scope",
  async () => {
    let allow = true;
    const f = fixture({ authorize: () => allow });
    const id = await f.host.open(record());
    const session = f.sessions[0];
    session.context.resource.environmentId = "attacker";
    NodeAssert.equal((await session.invoke("host.counter/read", null)).environment, "one");
    allow = false;
    await NodeAssert.rejects(session.invoke("host.counter/read", null), /denied/);
    allow = true;
    await NodeAssert.rejects(session.invoke("host.counter/write", null), /denied/);
    const snapshot = f.host.snapshot(id);
    snapshot.record.context.resource.environmentId = "mutated";
    NodeAssert.equal(f.host.snapshot(id).record.context.resource.environmentId, "one");
    f.host.dispose();
  },
);
NodeTest.test(
  "bounded coalesced updates reject out-of-order sequences, invalid and oversized data",
  async () => {
    const f = fixture();
    const id = await f.host.open(record());
    let notifications = 0;
    const stop = f.host.subscribe(() => notifications++);
    const s = f.sessions[0];
    for (let i = 1; i <= 1000; i++) NodeAssert.equal(s.publish(i, { count: i }), true);
    NodeAssert.equal(s.publish(999, { count: -1 }), false);
    NodeAssert.equal(notifications, 0);
    await Promise.resolve();
    NodeAssert.equal(notifications, 1);
    NodeAssert.deepEqual(f.host.snapshot(id).state, { count: 1000 });
    for (const value of [undefined, Infinity, () => {}, new Date(), "x".repeat(65537)])
      NodeAssert.throws(() => s.publish(1001, value));
    const cycle = {};
    cycle.self = cycle;
    NodeAssert.throws(() => copyJson(cycle));
    stop();
    f.host.dispose();
  },
);
NodeTest.test("factory, observer and cleanup failures leave unrelated views usable", async () => {
  const f = fixture();
  f.host.subscribe(() => {
    throw new Error("observer");
  });
  const good = await f.host.open(record());
  const bad = {
    manifest: {
      ...manifest(),
      id: "broken.extension",
      surfaces: manifest().surfaces.map((s) => ({ ...s, id: "broken.extension/view" })),
    },
    surfaces: [
      {
        id: "broken.extension/view",
        validateRestore: () => true,
        createView(session) {
          session.onDispose(() => {
            throw new Error("cleanup");
          });
          throw new Error("factory crashed");
        },
      },
    ],
  };
  f.host.register(bad);
  const id = await f.host.open({ ...record(), surfaceId: "broken.extension/view" });
  NodeAssert.equal(f.host.snapshot(id).status, "error");
  NodeAssert.equal(f.host.snapshot(good).status, "ready");
  f.host.fail(good, new Error("render crashed"));
  NodeAssert.equal(f.host.snapshot(good).reason, "render crashed");
  f.host.dispose();
});
NodeTest.test("100 lifecycle cycles return listeners and views to baseline", async () => {
  const f = fixture();
  const baseline = f.host.diagnostics();
  for (let i = 0; i < 100; i++) {
    const id = await f.host.open(record());
    const stop = f.host.subscribe(() => {});
    f.host.hide(id);
    await f.host.show(id);
    await f.host.updateContext(id, context("two", String(i)));
    stop();
    f.host.close(id);
  }
  NodeAssert.deepEqual(f.host.diagnostics(), baseline);
  NodeAssert.equal(f.disposed.length, 200);
  f.host.dispose();
});
NodeTest.test(
  "factory timeout and late completion release owned cleanup and renderer",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let finish,
      disposed = 0,
      cleanup = 0;
    const f = fixture({ timeoutMs: 50 });
    const extra = {
      manifest: {
        ...manifest(),
        id: "slow.extension",
        surfaces: manifest().surfaces.map((s) => ({ ...s, id: "slow.extension/view" })),
      },
      surfaces: [
        {
          id: "slow.extension/view",
          validateRestore: () => true,
          createView(session) {
            session.onDispose(() => cleanup++);
            return new Promise((resolve) => (finish = resolve));
          },
        },
      ],
    };
    f.host.register(extra);
    const opening = f.host.open({ ...record(), surfaceId: "slow.extension/view" });
    await Promise.resolve();
    t.mock.timers.tick(51);
    const id = await opening;
    NodeAssert.equal(f.host.snapshot(id).status, "error");
    NodeAssert.equal(cleanup, 1);
    finish({ renderer: {}, dispose: () => disposed++ });
    await Promise.resolve();
    await Promise.resolve();
    NodeAssert.equal(disposed, 1);
    f.host.dispose();
  },
);
NodeTest.test(
  "service concurrency and timeout are bounded with cooperative cancellation",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const f = fixture({
      timeoutMs: 20,
      maxPendingCalls: 1,
      services: [
        {
          capability: "host.counter/read",
          invoke: (call) => {
            signal = call.signal;
            return new Promise(() => {});
          },
        },
      ],
    });
    const id = await f.host.open(record());
    const pending = f.sessions[0].invoke("host.counter/read", null);
    await Promise.resolve();
    await NodeAssert.rejects(f.sessions[0].invoke("host.counter/read", null), /Too many/);
    const rejected = NodeAssert.rejects(pending, /timed out/);
    t.mock.timers.tick(21);
    await rejected;
    NodeAssert.equal(signal.aborted, true);
    NodeAssert.equal(f.host.diagnostics().pendingCalls, 0);
    NodeAssert.equal(f.host.snapshot(id).status, "ready");
    f.host.dispose();
  },
);

NodeTest.test("malformed JSON manifest metadata is rejected before registry mutation", () => {
  const f = fixture();
  for (const patch of [
    { title: 42 },
    { title: [] },
    { stateVersion: "1" },
    { placements: [42] },
    { clients: [42] },
    { capabilities: [42] },
    { scope: "universe" },
  ]) {
    const host = createExtensionHost({ authorize: () => true });
    NodeAssert.throws(() =>
      host.register({
        ...f.extension,
        manifest: { ...manifest(), surfaces: [{ ...manifest().surfaces[0], ...patch }] },
      }),
    );
    NodeAssert.equal(host.diagnostics().registrations, 0);
  }
  for (const patch of [{ version: ["1.0.0"] }, { apiVersion: "1" }, { surfaces: {} }]) {
    const host = createExtensionHost({ authorize: () => true });
    NodeAssert.throws(() =>
      host.register({ ...f.extension, manifest: { ...manifest(), ...patch } }),
    );
  }
  f.host.dispose();
});

NodeTest.test(
  "hide before dispatch cannot invoke a service after activity cancellation",
  async () => {
    let calls = 0;
    const f = fixture({
      services: [
        {
          capability: "host.counter/read",
          invoke: () => {
            calls++;
            return null;
          },
        },
      ],
    });
    const id = await f.host.open(record());
    const pending = f.sessions[0].invoke("host.counter/read", null);
    const rejected = NodeAssert.rejects(pending, /cancelled/);
    f.host.hide(id);
    await rejected;
    NodeAssert.equal(calls, 0);
    f.host.dispose();
  },
);
NodeTest.test("cached external-store snapshots are stable and deeply immutable", async () => {
  const f = fixture();
  const id = await f.host.open(record());
  const first = f.host.getSnapshot(id);
  NodeAssert.equal(f.host.getSnapshot(id), first);
  NodeAssert.throws(() => {
    first.record.context.resource.id = "changed";
  }, TypeError);
  f.host.hide(id);
  NodeAssert.notEqual(f.host.getSnapshot(id), first);
  f.host.close(id);
  NodeAssert.equal(f.host.getSnapshot(id), null);
  f.host.dispose();
});

NodeTest.test(
  "restore and save rejections name the surface, the received state and the fix",
  async () => {
    const f = fixture();
    const bad = await f.host.restore({ ...record(), restoreState: { wrong: true } });
    NodeAssert.equal(f.host.snapshot(bad).status, "unavailable");
    NodeAssert.match(
      f.host.snapshot(bad).reason,
      /"example\.counter\/view".*validateRestore rejected \{"wrong":true\}.*stateVersion 1.*fix the stored record or the validator/s,
    );
    const open = await f.host.open(record());
    NodeAssert.throws(
      () => f.sessions.at(-1).save({ wrong: true }),
      /Invalid restore state for "example\.counter\/view".*rejected \{"wrong":true\}.*stateVersion 1.*fix the validator/s,
    );
    NodeAssert.equal(f.host.snapshot(open).status, "ready");
    f.host.dispose();
  },
);
NodeTest.test(
  "save notifies durable record observers once per burst without requiring publish",
  async () => {
    const host = createExtensionHost({ authorize: () => false });
    let session;
    host.register({
      manifest: {
        ...manifest(),
        surfaces: manifest().surfaces.map((surface) => ({ ...surface, capabilities: [] })),
      },
      surfaces: [
        {
          id: "example.counter/view",
          validateRestore: () => true,
          createView(current) {
            session = current;
            return { renderer: {} };
          },
        },
      ],
    });
    const id = await host.open(record());
    const observed = [];
    host.subscribe((next) => {
      if (next) observed.push(next.record.restoreState);
    });
    for (let count = 0; count < 1000; count++) session.save({ count });
    await new Promise((resolve) => queueMicrotask(resolve));
    NodeAssert.deepEqual(observed, [{ count: 999 }]);
    NodeAssert.deepEqual(host.records()[0].restoreState, { count: 999 });
    host.close(id);
    NodeAssert.equal(session.save({ count: 1000 }), false);
    host.dispose();
  },
);
