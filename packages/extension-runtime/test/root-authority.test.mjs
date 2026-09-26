import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { createApiBroker } from "../dist/broker.js";
import { createExtensionRuntime } from "../dist/index.js";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const context = {
  resource: { namespace: "root.test", id: "view", environmentId: "env", projectId: "project" },
  client: "test",
};
const record = {
  id: "consumer",
  contentHash: "a".repeat(64),
  enabled: true,
  grants: { capabilities: ["root.test/read", "root.test/write"], projectIds: ["project"] },
  package: {
    format: 3,
    manifest: { id: "consumer", version: "1.0.0", apiVersion: 1, surfaces: [] },
    tools: [],
    provides: [],
    requires: [{ id: "root.host/api", versionRange: "^1.0.0" }],
    dependencies: [],
  },
};
const definition = {
  id: "root.host/api",
  version: "1.0.0",
  methods: [
    {
      name: "read",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      effect: "read",
      requiredGrants: ["root.test/read"],
    },
    {
      name: "write",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      effect: "write",
      requiredGrants: ["root.test/write"],
    },
  ],
  streams: [
    {
      name: "events",
      inputSchema: { type: "object" },
      eventSchema: { type: "string" },
      requiredGrants: ["root.test/read"],
    },
  ],
};
const request = (method) => ({
  id: definition.id,
  versionRange: "^1.0.0",
  method,
  input: {},
  context,
});
const streamRequest = {
  id: definition.id,
  versionRange: "^1.0.0",
  name: "events",
  input: {},
  context,
};
const makeBroker = (provider = {}) => {
  const audits = [];
  let providerCalls = 0;
  const broker = createApiBroker({
    installations: () => [record],
    providers: [
      {
        providerId: "root.host",
        definition,
        invoke: () => {
          providerCalls++;
          return "ok";
        },
        subscribe: async function* () {
          yield { type: "data", value: "event" };
        },
        ...provider,
      },
    ],
    selections: () => [],
    authorize: () => true,
    environmentId: "env",
    timeoutMs: 500,
    invokeWorker: () => {
      throw new Error("unexpected worker");
    },
    audit: (event) => audits.push(event),
  });
  return { broker, audits, calls: () => providerCalls };
};
const root = (revalidate = () => {}) => ({
  principal: {
    kind: "environment-session",
    id: "session-1",
    environmentId: "env",
    subject: "alex",
    scopes: ["root.test/read"],
  },
  allowWrite: false,
  revalidate,
});

NodeTest.test("root principal and callback are captured immutably", async () => {
  let metadata;
  const f = makeBroker({
    invoke: (_m, _i, _c, _s, m) => {
      metadata = m;
      return "ok";
    },
  });
  const original = root();
  const promise = f.broker.invoke(
    record,
    request("read"),
    new AbortController().signal,
    undefined,
    original,
  );
  original.principal.id = "forged";
  original.principal.scopes.push("root.test/write");
  original.revalidate = () => {
    throw new Error("forged callback");
  };
  NodeAssert.equal(await promise, "ok");
  NodeAssert.equal(metadata.principal.id, "session-1");
  NodeAssert.deepEqual(metadata.principal.scopes, ["root.test/read"]);
  NodeAssert.ok(Object.isFrozen(metadata.principal));
  NodeAssert.ok(Object.isFrozen(metadata.principal.scopes));
});

NodeTest.test("rootless access to an opted-in host provider is denied", async () => {
  const f = makeBroker({ requiresRootAuthority: true });
  await NodeAssert.rejects(
    f.broker.invoke(record, request("read"), new AbortController().signal),
    /root authority required/,
  );
  NodeAssert.equal(f.calls(), 0);
});

NodeTest.test("read-only root cannot invoke a write method", async () => {
  const f = makeBroker();
  await NodeAssert.rejects(
    f.broker.invoke(record, request("write"), new AbortController().signal, undefined, root()),
    /Read-only/,
  );
  NodeAssert.equal(f.calls(), 0);
});

NodeTest.test("invalid root environment and subject are rejected", async () => {
  const f = makeBroker();
  await NodeAssert.rejects(
    f.broker.invoke(record, request("read"), new AbortController().signal, undefined, {
      ...root(),
      principal: { ...root().principal, environmentId: "other" },
    }),
    /root principal/,
  );
  await NodeAssert.rejects(
    f.broker.invoke(record, request("read"), new AbortController().signal, undefined, {
      ...root(),
      principal: { ...root().principal, subject: 42 },
    }),
    /root principal/,
  );
});

NodeTest.test("revalidation before dispatch prevents handler side effects", async () => {
  let revoked = false;
  const f = makeBroker();
  await NodeAssert.rejects(
    f.broker.invoke(
      record,
      request("read"),
      new AbortController().signal,
      undefined,
      root(() => {
        revoked = true;
        throw new Error("revoked");
      }),
    ),
    /revoked/,
  );
  NodeAssert.equal(revoked, true);
  NodeAssert.equal(f.calls(), 0);
});

NodeTest.test(
  "revalidation after dispatch suppresses a revoked unary result and audits principal",
  async () => {
    let revoked = false;
    let handlerCalls = 0;
    const f = makeBroker({
      invoke: () => {
        handlerCalls++;
        revoked = true;
        return "stale";
      },
    });
    await NodeAssert.rejects(
      f.broker.invoke(
        record,
        request("read"),
        new AbortController().signal,
        undefined,
        root(() => {
          if (revoked) throw new Error("revoked");
        }),
      ),
      /revoked/,
    );
    NodeAssert.equal(handlerCalls, 1);
    NodeAssert.equal(f.audits.at(-1).principal.id, "session-1");
  },
);

NodeTest.test("stream metadata and audit retain sanitized root principal", async () => {
  let streamMetadata;
  const f = makeBroker({
    subscribe: async function* (_name, _input, _context, _signal, metadata) {
      streamMetadata = metadata;
      yield { type: "data", value: "event" };
    },
  });
  const supplied = root();
  const iterable = f.broker.subscribe(
    record,
    streamRequest,
    new AbortController().signal,
    undefined,
    supplied,
  );
  supplied.principal.id = "forged";
  supplied.revalidate = () => {
    throw new Error("forged callback");
  };
  const stream = iterable[Symbol.asyncIterator]();
  NodeAssert.equal((await stream.next()).value.value, "event");
  NodeAssert.equal((await stream.next()).done, true);
  NodeAssert.equal(streamMetadata.principal.id, "session-1");
  NodeAssert.equal(streamMetadata.principal.environmentId, "env");
  NodeAssert.equal(f.audits[0].principal.id, "session-1");
  NodeAssert.equal(f.audits[1].principal.environmentId, "env");
});

NodeTest.test(
  "stream revalidation suppresses revoked frames while an unrelated root continues",
  async () => {
    let revoked = false;
    const f = makeBroker({
      subscribe: async function* () {
        revoked = true;
        yield { type: "data", value: "stale" };
      },
    });
    const deniedStream = f.broker.subscribe(
      record,
      streamRequest,
      new AbortController().signal,
      undefined,
      root(() => {
        if (revoked) throw new Error("revoked");
      }),
    );
    const denied = deniedStream[Symbol.asyncIterator]();
    await NodeAssert.rejects(denied.next(), /revoked/);
    const unrelatedStream = f.broker.subscribe(
      record,
      streamRequest,
      new AbortController().signal,
      undefined,
      root(() => {}),
    );
    const unrelated = unrelatedStream[Symbol.asyncIterator]();
    NodeAssert.equal((await unrelated.next()).value.value, "stale");
    await unrelated.return();
  },
);

NodeTest.test(
  "public runtime preserves root principal through an independent worker descendant",
  async (t) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-root-authority-"));
    let nestedMetadata;
    const runtime = await createExtensionRuntime({
      rootDir: NodePath.join(directory, "state"),
      environmentId: "env",
      services: [],
      authorize: () => true,
      apiProviders: [
        {
          providerId: "root.host",
          definition,
          requiresRootAuthority: true,
          invoke(_method, _input, _context, _signal, metadata) {
            nestedMetadata = metadata;
            return "nested-ok";
          },
        },
      ],
    });
    t.after(async () => {
      await runtime.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    });
    const source = NodePath.join(directory, "consumer");
    await NodeFSP.mkdir(source);
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
              name: "inspect",
              inputSchema: { type: "object" },
              outputSchema: { type: "string" },
              effect: "read",
              requiredGrants: [],
            },
          ],
        },
      ],
      requires: [{ id: definition.id, versionRange: "^1.0.0" }],
      dependencies: [],
    };
    await NodeFSP.writeFile(NodePath.join(source, "t3-extension.json"), JSON.stringify(pkg));
    const server =
      'export default {tools:[],apis:[{id:"worker.consumer/api",methods:[{name:"inspect",invoke:async(_input,session)=>session.invokeApi({id:"' +
      definition.id +
      '",versionRange:"^1.0.0",method:"read",input:{},principal:{kind:"host",id:"forged",environmentId:"other",scopes:["root.test/write"]},root:{allowWrite:true,principal:{kind:"host",id:"forged"}}})}]}]};';
    await NodeFSP.writeFile(NodePath.join(source, "server.mjs"), server);
    const installed = await runtime.install(source, {
      capabilities: ["root.test/read"],
      projectIds: ["project"],
    });
    const result = await runtime.invokeApi(
      installed.id,
      installed.contentHash,
      { id: "worker.consumer/api", versionRange: "^1.0.0", method: "inspect", input: {}, context },
      new AbortController().signal,
      root(),
    );
    NodeAssert.equal(result, "nested-ok");
    NodeAssert.equal(nestedMetadata.principal.id, "session-1");
    NodeAssert.deepEqual(nestedMetadata.principal.scopes, ["root.test/read"]);
  },
);
