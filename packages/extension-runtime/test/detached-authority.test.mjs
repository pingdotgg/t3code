import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { createApiBroker } from "../dist/broker.js";

const context = {
  resource: { namespace: "detached.test", id: "view", environmentId: "env", projectId: "project" },
  client: "test",
};
const record = {
  id: "consumer",
  contentHash: "a".repeat(64),
  enabled: true,
  grants: { capabilities: ["detached.test/write"], projectIds: ["project"] },
  package: {
    format: 3,
    manifest: { id: "consumer", version: "1.0.0", apiVersion: 1, surfaces: [] },
    tools: [],
    provides: [],
    requires: [{ id: "detached.host/api", versionRange: "^1.0.0" }],
    dependencies: [],
  },
};
const definition = {
  id: "detached.host/api",
  version: "1.0.0",
  methods: [
    {
      name: "start",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      effect: "write",
      requiredGrants: ["detached.test/write"],
    },
  ],
};
const request = { id: definition.id, versionRange: "^1.0.0", method: "start", input: {}, context };

/**
 * A provider that returns immediately and keeps its metadata, like a unary
 * method that detaches work past its return. `authorize` mirrors
 * EnvironmentExtensions: live enabled flag, capability and project grant.
 */
async function startDetached() {
  const session = { revoked: false };
  let installations = [record];
  let metadata;
  const broker = createApiBroker({
    installations: () => installations,
    providers: [
      {
        providerId: "detached.host",
        definition,
        invoke: (_method, _input, _context, _signal, meta) => {
          metadata = meta;
          return "started";
        },
      },
    ],
    selections: () => [],
    authorize: (caller, grant, ctx) => {
      const live = installations.find((item) => item.id === caller.id);
      return (
        live !== undefined &&
        live.enabled &&
        live.grants.capabilities.includes(grant) &&
        live.grants.projectIds.includes(ctx.resource.projectId)
      );
    },
    environmentId: "env",
    timeoutMs: 500,
    invokeWorker: () => {
      throw new Error("unexpected worker");
    },
  });
  const root = {
    principal: {
      kind: "environment-session",
      id: "session",
      environmentId: "env",
      scopes: ["detached.test/write"],
    },
    allowWrite: true,
    revalidate() {
      if (session.revoked) throw new Error("root revoked");
    },
  };
  NodeAssert.equal(
    await broker.invoke(record, request, new AbortController().signal, undefined, root),
    "started",
  );
  return {
    metadata,
    session,
    setInstallations: (next) => {
      installations = next;
      broker.invalidate([record.id]);
    },
  };
}

NodeTest.test("the detached check outlives the invocation that minted it", async () => {
  const f = await startDetached();
  await NodeAssert.rejects(f.metadata.assertAuthority());
  await f.metadata.assertDetachedAuthority();
});

NodeTest.test("the detached check rejects once the root session is revoked", async () => {
  const f = await startDetached();
  f.session.revoked = true;
  await NodeAssert.rejects(f.metadata.assertDetachedAuthority(), /root revoked/);
});

NodeTest.test("the detached check rejects once the required grant is removed", async () => {
  const f = await startDetached();
  f.setInstallations([{ ...record, grants: { ...record.grants, capabilities: [] } }]);
  await NodeAssert.rejects(f.metadata.assertDetachedAuthority());
});

NodeTest.test("the detached check rejects once the project grant is removed", async () => {
  const f = await startDetached();
  f.setInstallations([{ ...record, grants: { ...record.grants, projectIds: [] } }]);
  await NodeAssert.rejects(f.metadata.assertDetachedAuthority());
});

NodeTest.test("the detached check rejects once the extension is disabled", async () => {
  const f = await startDetached();
  f.setInstallations([{ ...record, enabled: false }]);
  await NodeAssert.rejects(f.metadata.assertDetachedAuthority());
});

NodeTest.test("the detached check rejects once the extension is uninstalled", async () => {
  const f = await startDetached();
  f.setInstallations([]);
  await NodeAssert.rejects(f.metadata.assertDetachedAuthority(), /Installation changed/);
});

NodeTest.test("the detached check rejects a replaced installation with the same id", async () => {
  const f = await startDetached();
  f.setInstallations([{ ...record, contentHash: "b".repeat(64) }]);
  await NodeAssert.rejects(f.metadata.assertDetachedAuthority(), /Installation changed/);
});
