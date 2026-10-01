import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createExtensionRuntime } from "../dist/index.js";

const context = {
  resource: { namespace: "test.resource", id: "file", environmentId: "env", projectId: "project" },
  client: "web",
};
const api = (id) => ({
  id,
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
});

NodeTest.test(
  "host metadata captures nested installation authority, rejects spoofing and is deeply immutable",
  async (t) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-host-metadata-"));
    const captured = [],
      audits = [];
    const runtime = await createExtensionRuntime({
      rootDir: NodePath.join(directory, "state"),
      environmentId: "env",
      services: [],
      authorize: () => true,
      auditApi: (event) => audits.push(event),
      apiProviders: [
        {
          providerId: "host.identity",
          definition: api("test.host/identity"),
          invoke(method, input, actualContext, signal, metadata) {
            NodeAssert.equal(method, "inspect");
            NodeAssert.deepEqual(actualContext, context);
            NodeAssert.equal(signal.aborted, false);
            NodeAssert.ok(Object.isFrozen(metadata));
            NodeAssert.ok(Object.isFrozen(metadata.callerGenerations));
            NodeAssert.ok(metadata.callerGenerations.every(Object.isFrozen));
            NodeAssert.throws(() => {
              metadata.callerId = "forged";
            }, TypeError);
            NodeAssert.throws(() => {
              metadata.callerGenerations[0].contentHash = "forged";
            }, TypeError);
            captured.push(metadata);
            return "ok";
          },
        },
      ],
    });
    t.after(async () => {
      await runtime.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    });
    async function install(id, target, version = "1.0.0", update = false) {
      const source = NodePath.join(directory, id + version);
      await NodeFSP.mkdir(source);
      const pkg = {
        format: 2,
        manifest: { id, apiVersion: 1, version, surfaces: [] },
        serverEntry: "server.mjs",
        tools: [],
        provides: [api(id + "/api")],
        requires: [{ id: target, versionRange: "^1" }],
        dependencies: [],
      };
      await NodeFSP.writeFile(NodePath.join(source, "t3-extension.json"), JSON.stringify(pkg));
      const request = {
        id: target,
        versionRange: "^1",
        method: "inspect",
        input: { callerId: "forged", callId: "forged", providerGeneration: -1 },
        callerId: "forged",
        rootCallerId: "forged",
        callId: "forged",
        parentCallId: "forged",
        callerGenerations: [],
      };
      await NodeFSP.writeFile(
        NodePath.join(source, "server.mjs"),
        `export default {tools:[],apis:[{id:${JSON.stringify(id + "/api")},methods:[{name:"inspect",invoke:async(input,session)=>session.invokeApi(${JSON.stringify(request)})}]}]};`,
      );
      return update
        ? runtime.update(id, source)
        : runtime.install(source, { capabilities: [], projectIds: ["project"] });
    }
    const provider = await install("test.provider", "test.host/identity");
    const consumer = await install("test.consumer", "test.provider/api");
    const invoke = () =>
      runtime.invokeApi(
        consumer.id,
        consumer.contentHash,
        {
          id: "test.consumer/api",
          versionRange: "^1",
          method: "inspect",
          input: {},
          context,
          callId: "forged",
          rootCallerId: "forged",
          providerGeneration: -1,
        },
        new AbortController().signal,
      );
    NodeAssert.equal(await invoke(), "ok");
    NodeAssert.equal(await invoke(), "ok");
    const first = captured[0],
      second = captured[1];
    NodeAssert.equal(first.callerId, provider.id);
    NodeAssert.equal(first.rootCallerId, consumer.id);
    NodeAssert.equal(first.providerId, "host.identity");
    NodeAssert.ok(first.providerGeneration > 0);
    NodeAssert.match(first.callId, /^[0-9a-f-]{36}$/);
    NodeAssert.notEqual(first.callId, second.callId);
    const hostAudit = audits.find((event) => event.callId === first.callId);
    NodeAssert.equal(hostAudit.parentCallId, first.parentCallId);
    NodeAssert.equal(
      audits.find((event) => event.callId === first.parentCallId).callerId,
      consumer.id,
    );
    NodeAssert.deepEqual(
      first.callerGenerations.map((item) => [item.pluginId, item.contentHash]),
      [
        [consumer.id, consumer.contentHash],
        [provider.id, provider.contentHash],
      ],
    );
    NodeAssert.deepEqual(first.callerGenerations, second.callerGenerations);
    const updated = await install("test.provider", "test.host/identity", "1.0.1", true);
    NodeAssert.equal(await invoke(), "ok");
    const third = captured[2];
    NodeAssert.equal(
      third.callerGenerations[0].installationGeneration,
      first.callerGenerations[0].installationGeneration,
    );
    NodeAssert.notEqual(
      third.callerGenerations[1].installationGeneration,
      first.callerGenerations[1].installationGeneration,
    );
    NodeAssert.equal(third.callerGenerations[1].contentHash, updated.contentHash);
    NodeAssert.equal(third.providerGeneration, first.providerGeneration);
    await runtime.updateGrants(provider.id, {
      capabilities: [],
      projectIds: ["project", "another-project"],
    });
    NodeAssert.equal(await invoke(), "ok");
    const fourth = captured[3];
    NodeAssert.equal(
      fourth.callerGenerations[1].contentHash,
      third.callerGenerations[1].contentHash,
    );
    NodeAssert.notEqual(
      fourth.callerGenerations[1].installationGeneration,
      third.callerGenerations[1].installationGeneration,
    );
    NodeAssert.equal(fourth.providerGeneration, third.providerGeneration);
  },
);
