import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createExtensionRuntime } from "../dist/index.js";

const context = {
  resource: {
    namespace: "t3.thread",
    id: "thread",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
};
const grant = "test.events/read";
const apiId = "test.provider/events";
const receiptApiId = "test.host/receipt";
const receiptApi = {
  id: receiptApiId,
  version: "1.0.0",
  methods: [
    {
      name: "ping",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      effect: "read",
      requiredGrants: [grant],
    },
  ],
};
const api = {
  id: apiId,
  version: "1.0.0",
  methods: [
    {
      name: "write",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      effect: "write",
      requiredGrants: [grant],
    },
  ],
  streams: [
    {
      name: "events",
      inputSchema: { type: "object" },
      eventSchema: { type: "string" },
      requiredGrants: [grant],
    },
  ],
};
const manifest = (id) => ({ id, version: "1.0.0", apiVersion: 1, surfaces: [] });
async function packageDir(root, id, descriptor, server) {
  const dir = NodePath.join(root, id);
  await NodeFSP.mkdir(dir);
  await NodeFSP.writeFile(NodePath.join(dir, "t3-extension.json"), JSON.stringify(descriptor));
  await NodeFSP.writeFile(NodePath.join(dir, "server.mjs"), server);
  return dir;
}
async function fixture(t) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-worker-stream-"));
  const state = NodePath.join(dir, "state");
  const providerDescriptor = {
    format: 3,
    manifest: manifest("test.provider"),
    serverEntry: "server.mjs",
    tools: [
      {
        id: "test.provider/pid",
        title: "pid",
        description: "fixture",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: [],
      },
    ],
    provides: [api],
    requires: [{ id: receiptApiId, versionRange: "^1.0.0" }],
    dependencies: [],
  };
  const consumerDescriptor = {
    format: 3,
    manifest: manifest("test.consumer"),
    serverEntry: "server.mjs",
    tools: [
      {
        id: "test.consumer/read",
        title: "read",
        description: "fixture",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: [grant],
      },
      {
        id: "test.consumer/pending",
        title: "pending",
        description: "fixture",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: [grant],
      },
      {
        id: "test.consumer/return",
        title: "return",
        description: "fixture",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: [grant],
      },
      {
        id: "test.consumer/deny",
        title: "deny",
        description: "fixture",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: [grant],
      },
    ],
    provides: [],
    requires: [{ id: apiId, versionRange: "^1.0.0" }],
    dependencies: [
      {
        pluginId: "test.provider",
        versionRange: "^1.0.0",
        apis: [{ id: apiId, versionRange: "^1.0.0" }],
      },
    ],
  };
  const providerServer = `export default {apis:[{id:"${apiId}",methods:[{name:"write",invoke:()=> "written"}],streams:[{name:"events",subscribe:async function*(input,session){yield {type:"snapshot",value:"first"};if(input.stubborn){void session.invokeApi({id:"${receiptApiId}",versionRange:"^1.0.0",method:"ping",input:{}}).catch(()=>{});await new Promise(()=>{});}if(input.pending){await new Promise((resolve)=>session.signal.addEventListener("abort",resolve,{once:true}));return;}yield {type:"data",value:"second"};}}]}],tools:[{id:"test.provider/pid",invoke:()=>process.pid}]};`;
  const consumerServer = `export default {tools:[
    {id:"test.consumer/read",invoke:async(input,session)=>{const s=session.subscribeApi({id:"${apiId}",versionRange:"^1.0.0",name:"events",input});const i=s[Symbol.asyncIterator]();const a=await i.next();const b=await i.next();return [a.value,b.value];}},
    {id:"test.consumer/pending",invoke:async(input,session)=>{const s=session.subscribeApi({id:"${apiId}",versionRange:"^1.0.0",name:"events",input:{...input,pending:true}});const i=s[Symbol.asyncIterator]();await i.next();await session.invoke("${grant}",{stage:"first"});return await i.next();}},
    {id:"test.consumer/return",invoke:async(input,session)=>{const s=session.subscribeApi({id:"${apiId}",versionRange:"^1.0.0",name:"events",input:{...input,pending:true}});const i=s[Symbol.asyncIterator]();await i.next();await session.invoke("${grant}",{stage:"first"});const next=i.next();await i.return();await next;return "returned";}},
    {id:"test.consumer/deny",invoke:async(input,session)=>session.invokeApi({id:"${apiId}",versionRange:"^1.0.0",method:"write",input:{}})}
  ]};`;
  const otherDescriptor = {
    format: 3,
    manifest: manifest("test.other"),
    serverEntry: "server.mjs",
    tools: [
      {
        id: "test.other/pid",
        title: "pid",
        description: "fixture",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: [],
      },
    ],
    provides: [],
    requires: [],
    dependencies: [],
  };
  const otherServer = 'export default {tools:[{id:"test.other/pid",invoke:()=>process.pid}]};';
  const provider = await packageDir(dir, "provider", providerDescriptor, providerServer);
  const consumer = await packageDir(dir, "consumer", consumerDescriptor, consumerServer);
  const other = await packageDir(dir, "other", otherDescriptor, otherServer);
  let receiptResolve, stubbornResolve, unavailableResolve;
  const receipt = new Promise((resolve) => {
    receiptResolve = resolve;
  });
  const stubbornEntered = new Promise((resolve) => {
    stubbornResolve = resolve;
  });
  let runtime;
  const providerUnavailable = new Promise((resolve) => {
    unavailableResolve = resolve;
  });
  runtime = await createExtensionRuntime({
    rootDir: state,
    environmentId: "env",
    timeoutMs: 1500,
    services: [
      {
        capability: grant,
        invoke: (input) => {
          receiptResolve(input);
          return null;
        },
      },
    ],
    apiProviders: [
      {
        providerId: "host.receipt",
        definition: receiptApi,
        invoke: () => {
          stubbornResolve();
          return "ok";
        },
      },
    ],
    authorize: () => true,
    onCatalogueChanged: () => {
      const state = runtime
        ?.catalogue()
        .pluginResolution.find((item) => item.id === "test.provider");
      if (state?.status === "unavailable") unavailableResolve(state);
    },
  });
  t.after(async () => {
    await runtime.dispose();
    await NodeFSP.rm(dir, { recursive: true, force: true });
  });
  const p = await runtime.install(provider, { capabilities: [grant], projectIds: ["project"] });
  const c = await runtime.install(consumer, { capabilities: [grant], projectIds: ["project"] });
  const o = await runtime.install(other, { capabilities: [], projectIds: ["project"] });
  return { runtime, p, c, o, receipt, stubbornEntered, providerUnavailable };
}

NodeTest.test(
  "real producer and consumer workers exchange frames with credit and stable identity",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const result = await f.runtime.invoke(
      "test.consumer/read",
      {},
      context,
      new AbortController().signal,
      f.c.contentHash,
    );
    NodeAssert.equal(result.length, 2);
    NodeAssert.deepEqual(
      result.map((x) => x.event ?? x.type),
      ["snapshot", "data"],
    );
    NodeAssert.equal(result[0].streamId, result[1].streamId);
    NodeAssert.deepEqual(
      result.map((x) => x.sequence),
      [1, 2],
    );
  },
);

NodeTest.test(
  "read-only attenuation denies nested write and pending cancellation preserves unrelated worker",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await NodeAssert.rejects(
      f.runtime.invoke(
        "test.consumer/deny",
        {},
        context,
        new AbortController().signal,
        f.c.contentHash,
      ),
      /read.only|write/i,
    );
    const abort = new AbortController();
    const pending = f.runtime.invoke(
      "test.consumer/pending",
      {},
      context,
      abort.signal,
      f.c.contentHash,
    );
    await f.receipt;
    abort.abort();
    await NodeAssert.rejects(pending, /cancel|abort|deadline|closed/i);
    const pid = await f.runtime.invoke(
      "test.provider/pid",
      {},
      context,
      new AbortController().signal,
      f.p.contentHash,
    );
    NodeAssert.equal(typeof pid, "number");
  },
);

NodeTest.test(
  "disabling consumer closes an in-flight worker stream",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const pending = f.runtime.invoke(
      "test.consumer/pending",
      {},
      context,
      new AbortController().signal,
      f.c.contentHash,
    );
    const settled = pending.then(
      () => null,
      (error) => error,
    );
    await f.receipt;
    await f.runtime.disable(f.c.id);
    NodeAssert.match((await settled).message, /disabled|changed|cancel|closed|worker/i);
  },
);

NodeTest.test(
  "grant revocation during pending next closes stream and regrant restores reads",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const pending = f.runtime.invoke(
      "test.consumer/pending",
      {},
      context,
      new AbortController().signal,
      f.c.contentHash,
    );
    const settled = pending.then(
      () => null,
      (error) => error,
    );
    await f.receipt;
    await f.runtime.updateGrants(f.c.id, { capabilities: [], projectIds: [] });
    NodeAssert.match((await settled).message, /grant|changed|cancel|closed|resource/i);
    const updated = await f.runtime.updateGrants(f.c.id, {
      capabilities: [grant],
      projectIds: ["project"],
    });
    const result = await f.runtime.invoke(
      "test.consumer/read",
      {},
      context,
      new AbortController().signal,
      updated.contentHash,
    );
    NodeAssert.equal(result[0].sequence, 1);
  },
);
NodeTest.test(
  "explicit iterator return settles pending next and independent read continues",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.runtime.invoke(
      "test.provider/pid",
      {},
      context,
      new AbortController().signal,
      f.p.contentHash,
    );
    const returned = await f.runtime.invoke(
      "test.consumer/return",
      {},
      context,
      new AbortController().signal,
      f.c.contentHash,
    );
    NodeAssert.match(String(returned), /returned/i);
    const after = await f.runtime.invoke(
      "test.provider/pid",
      {},
      context,
      new AbortController().signal,
      f.p.contentHash,
    );
    NodeAssert.equal(after, before);
    const result = await f.runtime.invoke(
      "test.consumer/read",
      {},
      context,
      new AbortController().signal,
      f.c.contentHash,
    );
    NodeAssert.equal(result[1].sequence, 2);
  },
);
NodeTest.test(
  "uncooperative producer is terminated after bounded stream cancellation",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.runtime.invoke(
      "test.provider/pid",
      {},
      context,
      new AbortController().signal,
      f.p.contentHash,
    );
    const unrelatedBefore = await f.runtime.invoke(
      "test.other/pid",
      {},
      context,
      new AbortController().signal,
      f.o.contentHash,
    );
    const abort = new AbortController();
    const pending = f.runtime.invoke(
      "test.consumer/pending",
      { stubborn: true },
      context,
      abort.signal,
      f.c.contentHash,
    );
    const settled = pending.then(
      () => null,
      (error) => error,
    );
    await Promise.race([
      f.stubbornEntered,
      settled.then((error) => {
        throw error;
      }),
    ]);
    abort.abort();
    await settled;
    const providerState = await f.providerUnavailable;
    NodeAssert.equal(providerState.status, "unavailable");
    await NodeAssert.rejects(
      f.runtime.invoke(
        "test.provider/pid",
        {},
        context,
        new AbortController().signal,
        f.p.contentHash,
      ),
      /failed|unavailable|changed|worker/i,
    );
    const unrelatedAfter = await f.runtime.invoke(
      "test.other/pid",
      {},
      context,
      new AbortController().signal,
      f.o.contentHash,
    );
    NodeAssert.equal(unrelatedAfter, unrelatedBefore);
  },
);
