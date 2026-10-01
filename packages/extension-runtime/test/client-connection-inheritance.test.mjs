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

NodeTest.test("nested session.invokeApi inherits the parent clientConnectionId hint", async (t) => {
  const directory = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-client-hint-")),
  );
  const seen = [];
  const runtime = await createExtensionRuntime({
    rootDir: NodePath.join(directory, "state"),
    environmentId: "env",
    services: [],
    authorize: () => true,
    apiProviders: [
      {
        providerId: "host.identity",
        definition: api("test.host/identity"),
        invoke(method, input, actualContext, signal, metadata) {
          seen.push(metadata.clientConnectionId);
          return "ok";
        },
      },
    ],
  });
  t.after(async () => {
    await runtime.dispose();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  const source = NodePath.join(directory, "ext");
  await NodeFSP.mkdir(source);
  await NodeFSP.writeFile(
    NodePath.join(source, "t3-extension.json"),
    JSON.stringify({
      format: 2,
      manifest: { id: "test.ext", apiVersion: 1, version: "1.0.0", surfaces: [] },
      serverEntry: "server.mjs",
      tools: [],
      provides: [api("test.ext/api")],
      requires: [{ id: "test.host/identity", versionRange: "^1" }],
      dependencies: [],
    }),
  );
  // The extension forwards whatever nested request the caller packs into input.
  await NodeFSP.writeFile(
    NodePath.join(source, "server.mjs"),
    `export default {tools:[],apis:[{id:"test.ext/api",methods:[{name:"inspect",invoke:async(input,session)=>session.invokeApi(input.request)}]}]};`,
  );
  const ext = await runtime.install(source, { capabilities: [], projectIds: ["project"] });
  const invoke = (request, clientConnectionId) =>
    runtime.invokeApi(
      ext.id,
      ext.contentHash,
      {
        id: "test.ext/api",
        versionRange: "^1",
        method: "inspect",
        input: { request },
        context,
        ...(clientConnectionId !== undefined ? { clientConnectionId } : {}),
      },
      new AbortController().signal,
    );

  // No hint on the nested request → inherits the parent's.
  NodeAssert.equal(
    await invoke(
      { id: "test.host/identity", versionRange: "^1", method: "inspect", input: {} },
      "conn-x",
    ),
    "ok",
  );
  NodeAssert.equal(seen.at(-1), "conn-x");

  // An explicit nested hint wins over the parent's.
  NodeAssert.equal(
    await invoke(
      {
        id: "test.host/identity",
        versionRange: "^1",
        method: "inspect",
        input: {},
        clientConnectionId: "conn-y",
      },
      "conn-x",
    ),
    "ok",
  );
  NodeAssert.equal(seen.at(-1), "conn-y");

  // No hint anywhere → undefined reaches the provider untouched.
  NodeAssert.equal(
    await invoke({ id: "test.host/identity", versionRange: "^1", method: "inspect", input: {} }),
    "ok",
  );
  NodeAssert.equal(seen.at(-1), undefined);
});
