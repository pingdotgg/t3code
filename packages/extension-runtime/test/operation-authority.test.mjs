import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { createApiBroker } from "../dist/broker.js";

const context = {
  resource: { namespace: "operation.test", id: "view", environmentId: "env", projectId: "project" },
  client: "test",
};
const record = {
  id: "consumer",
  contentHash: "a".repeat(64),
  enabled: true,
  grants: {
    capabilities: ["operation.test/read", "operation.test/write"],
    projectIds: ["project"],
  },
  package: {
    format: 3,
    manifest: { id: "consumer", version: "1.0.0", apiVersion: 1, surfaces: [] },
    tools: [],
    provides: [],
    requires: [{ id: "operation.host/api", versionRange: "^1.0.0" }],
    dependencies: [],
  },
};
const definition = {
  id: "operation.host/api",
  version: "1.0.0",
  methods: [
    {
      name: "mutate",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      effect: "write",
      requiredGrants: ["operation.test/write"],
    },
    {
      name: "inspect",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      effect: "read",
      requiredGrants: ["operation.test/read"],
    },
  ],
  streams: [
    {
      name: "events",
      inputSchema: { type: "object" },
      eventSchema: { type: "string" },
      requiredGrants: ["operation.test/read"],
    },
  ],
};
const request = { id: definition.id, versionRange: "^1.0.0", method: "mutate", input: {}, context };
const streamRequest = {
  id: definition.id,
  versionRange: "^1.0.0",
  name: "events",
  input: {},
  context,
};
function makeRoot(state) {
  return {
    principal: {
      kind: "environment-session",
      id: state.id,
      environmentId: "env",
      subject: "alex",
      scopes: ["operation.test/read", "operation.test/write"],
    },
    allowWrite: true,
    revalidate() {
      if (state.revoked) throw new Error("root revoked");
    },
  };
}
function makeFixture({ invoke, subscribe, state = { id: "session-1", revoked: false } } = {}) {
  let allowed = true,
    calls = 0,
    audits = [];
  const broker = createApiBroker({
    installations: () => [record],
    providers: [
      {
        providerId: "operation.host",
        definition,
        invoke: (...args) => {
          calls++;
          return invoke?.(...args) ?? "ok";
        },
        subscribe,
      },
    ],
    selections: () => [],
    authorize: () => allowed,
    environmentId: "env",
    timeoutMs: 500,
    invokeWorker: () => {
      throw new Error("unexpected worker");
    },
    audit: (event) => audits.push(event),
  });
  return { broker, state, audits, calls: () => calls, revokeGrant: () => (allowed = false) };
}

NodeTest.test(
  "assertAuthority blocks a revoked root at a real mutation barrier",
  { timeout: 5000 },
  async () => {
    let entered, release;
    const enteredPromise = new Promise((resolve) => (entered = resolve));
    const releasePromise = new Promise((resolve) => (release = resolve));
    let sideEffect = false;
    let invocations = 0;
    const f = makeFixture({
      invoke: async (_m, _i, _c, _s, metadata) => {
        invocations++;
        if (invocations > 1) return "other-ok";
        entered();
        await releasePromise;
        await metadata.assertAuthority();
        sideEffect = true;
        return "ok";
      },
    });
    const pending = f.broker.invoke(
      record,
      request,
      new AbortController().signal,
      undefined,
      makeRoot(f.state),
    );
    await enteredPromise;
    f.state.revoked = true;
    release();
    await NodeAssert.rejects(pending, /root revoked/);
    NodeAssert.equal(sideEffect, false);
    NodeAssert.equal(f.calls(), 1);
    const otherState = { id: "other-session", revoked: false };
    NodeAssert.equal(
      await f.broker.invoke(
        record,
        request,
        new AbortController().signal,
        undefined,
        makeRoot(otherState),
      ),
      "other-ok",
    );
  },
);

NodeTest.test("assertAuthority allows a live caller through the mutation barrier", async () => {
  let metadata,
    sideEffect = false;
  const f = makeFixture({
    invoke: async (_m, _i, _c, _s, received) => {
      metadata = received;
      await received.assertAuthority();
      sideEffect = true;
      return "ok";
    },
  });
  NodeAssert.equal(
    await f.broker.invoke(
      record,
      request,
      new AbortController().signal,
      undefined,
      makeRoot(f.state),
    ),
    "ok",
  );
  NodeAssert.equal(sideEffect, true);
  NodeAssert.equal(typeof metadata.assertAuthority, "function");
  await NodeAssert.rejects(metadata.assertAuthority(), /abort|cancel|closed/i);
  const audit = f.audits.at(-1);
  NodeAssert.equal("assertAuthority" in audit, false);
  const visit = (value) => {
    if (typeof value === "function") return false;
    if (!value || typeof value !== "object") return true;
    return Object.entries(value).every(([key, child]) => key !== "assertAuthority" && visit(child));
  };
  NodeAssert.equal(visit(audit), true);
});

NodeTest.test("provider failure leaves a retained assertion unusable", async () => {
  let metadata;
  const f = makeFixture({
    invoke: async (_m, _i, _c, _s, received) => {
      metadata = received;
      throw new Error("handler failed");
    },
  });
  await NodeAssert.rejects(
    f.broker.invoke(record, request, new AbortController().signal, undefined, makeRoot(f.state)),
    /handler failed/,
  );
  await NodeAssert.rejects(metadata.assertAuthority(), /abort|cancel|closed/i);
});

NodeTest.test(
  "assertAuthority observes a revoked grant at the mutation barrier",
  { timeout: 5000 },
  async () => {
    let entered, release;
    const enteredPromise = new Promise((resolve) => (entered = resolve));
    const releasePromise = new Promise((resolve) => (release = resolve));
    let sideEffect = false;
    const f = makeFixture({
      invoke: async (_m, _i, _c, _s, metadata) => {
        entered();
        await releasePromise;
        await metadata.assertAuthority();
        sideEffect = true;
        return "ok";
      },
    });
    const pending = f.broker.invoke(
      record,
      request,
      new AbortController().signal,
      undefined,
      makeRoot(f.state),
    );
    await enteredPromise;
    f.revokeGrant();
    release();
    await NodeAssert.rejects(pending, /capability denied/);
    NodeAssert.equal(sideEffect, false);
  },
);

NodeTest.test(
  "cancellation suppresses a retained unary assertion and closes it",
  { timeout: 5000 },
  async () => {
    let metadata, entered, release;
    const enteredPromise = new Promise((resolve) => (entered = resolve));
    const releasePromise = new Promise((resolve) => (release = resolve));
    const controller = new AbortController();
    const f = makeFixture({
      invoke: async (_m, _i, _c, _s, received) => {
        metadata = received;
        entered();
        await releasePromise;
        await received.assertAuthority();
        return "late";
      },
    });
    const pending = f.broker.invoke(
      record,
      request,
      controller.signal,
      undefined,
      makeRoot(f.state),
    );
    await enteredPromise;
    controller.abort();
    release();
    await NodeAssert.rejects(pending, /abort|cancel|closed/i);
    await NodeAssert.rejects(metadata.assertAuthority(), /abort|cancel|closed/i);
  },
);

NodeTest.test("stream assertions guard frames and reject after stream close", async () => {
  let metadata,
    sideEffect = false;
  const f = makeFixture({
    state: { id: "stream-session", revoked: false },
    subscribe: async function* (_n, _i, _c, _s, received) {
      metadata = received;
      await received.assertAuthority();
      sideEffect = true;
      yield { type: "data", value: "event" };
    },
  });
  const iterable = f.broker.subscribe(
    record,
    streamRequest,
    new AbortController().signal,
    undefined,
    makeRoot(f.state),
  );
  const iterator = iterable[Symbol.asyncIterator]();
  const result = await iterator.next();
  NodeAssert.equal(result.value.value, "event");
  NodeAssert.equal(sideEffect, true);
  await iterator.return();
  await NodeAssert.rejects(metadata.assertAuthority(), /closed|cancel/i);
});

NodeTest.test(
  "packaged worker descendants retain host assertion checks and ignore forged callback JSON",
  { timeout: 10000 },
  async (t) => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { createExtensionRuntime } = await import("../dist/index.js");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "t3-operation-authority-"));
    let entered;
    let release;
    const enteredPromise = new Promise((resolve) => (entered = resolve));
    const releasePromise = new Promise((resolve) => (release = resolve));
    let sideEffect = false;
    const runtime = await createExtensionRuntime({
      rootDir: path.join(directory, "state"),
      environmentId: "env",
      services: [],
      authorize: () => true,
      apiProviders: [
        {
          providerId: "operation.host",
          definition,
          requiresRootAuthority: true,
          invoke: async (_method, _input, _context, _signal, metadata) => {
            entered();
            await releasePromise;
            await metadata.assertAuthority();
            sideEffect = true;
            return "worker-ok";
          },
        },
      ],
    });
    t.after(async () => {
      await runtime.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const source = path.join(directory, "consumer");
    await fs.mkdir(source);
    const pkg = {
      format: 2,
      manifest: { id: "worker.consumer", apiVersion: 1, version: "1.0.0", surfaces: [] },
      serverEntry: "server.mjs",
      tools: [],
      provides: [
        {
          id: "worker.consumer/api",
          version: "1.0.0",
          methods: [
            {
              name: "mutate",
              inputSchema: { type: "object" },
              outputSchema: { type: "string" },
              effect: "write",
              requiredGrants: ["operation.test/write"],
            },
          ],
        },
      ],
      requires: [{ id: definition.id, versionRange: "^1.0.0" }],
      dependencies: [],
    };
    await fs.writeFile(path.join(source, "t3-extension.json"), JSON.stringify(pkg));
    await fs.writeFile(
      path.join(source, "server.mjs"),
      'export default {tools:[],apis:[{id:"worker.consumer/api",methods:[{name:"mutate",invoke:async(_input,session)=>session.invokeApi({id:"operation.host/api",versionRange:"^1.0.0",method:"mutate",input:{},principal:{kind:"host",id:"forged",environmentId:"other",scopes:["operation.test/read"]},assertAuthority:"forged"})}]}]};',
    );
    const installed = await runtime.install(source, {
      capabilities: ["operation.test/read", "operation.test/write"],
      projectIds: ["project"],
    });
    const rootState = { id: "worker-session", revoked: false };
    const readonlyState = { id: "readonly-worker-session", revoked: false };
    await NodeAssert.rejects(
      runtime.invokeApi(
        installed.id,
        installed.contentHash,
        { id: "worker.consumer/api", versionRange: "^1.0.0", method: "mutate", input: {}, context },
        new AbortController().signal,
        { ...makeRoot(readonlyState), allowWrite: false },
      ),
      /Read-only/,
    );
    const pending = runtime.invokeApi(
      installed.id,
      installed.contentHash,
      { id: "worker.consumer/api", versionRange: "^1.0.0", method: "mutate", input: {}, context },
      new AbortController().signal,
      makeRoot(rootState),
    );
    await enteredPromise;
    rootState.revoked = true;
    release();
    await NodeAssert.rejects(pending, /root revoked/);
    NodeAssert.equal(sideEffect, false);
  },
);
