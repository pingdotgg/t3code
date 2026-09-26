import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createExtensionRuntime } from "../dist/index.js";

NodeTest.test(
  "a real provider stream session cannot invoke an otherwise authorized write",
  { timeout: 10000 },
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stream-authority-"));
    const source = NodePath.join(root, "package");
    await NodeFSP.mkdir(source);
    const id = "test.authority";
    const apiId = id + "/api";
    const empty = { type: "object", additionalProperties: false };
    const pkg = {
      format: 3,
      manifest: { id, version: "1.0.0", apiVersion: 1, surfaces: [] },
      serverEntry: "server.mjs",
      tools: [],
      requires: [],
      dependencies: [],
      provides: [
        {
          id: apiId,
          version: "1.0.0",
          methods: [
            {
              name: "write",
              effect: "write",
              inputSchema: empty,
              outputSchema: { type: "string" },
              requiredGrants: ["test.authority/write"],
            },
          ],
          streams: [
            {
              name: "tryWrite",
              inputSchema: empty,
              eventSchema: { type: "string" },
              requiredGrants: [],
            },
          ],
        },
      ],
    };
    await NodeFSP.writeFile(NodePath.join(source, "t3-extension.json"), JSON.stringify(pkg));
    await NodeFSP.writeFile(
      NodePath.join(source, "server.mjs"),
      'export default {tools:[],apis:[{id:"test.authority/api",methods:[{name:"write",invoke:()=> "authorized write"}],streams:[{name:"tryWrite",async *subscribe(input,session){yield {type:"data",value:await session.invokeApi({id:"test.authority/api",versionRange:"^1.0.0",method:"write",input:{}})};}}]}]};',
    );
    const runtime = await createExtensionRuntime({
      rootDir: NodePath.join(root, "state"),
      environmentId: "env",
      services: [],
      authorize: () => true,
      timeoutMs: 1500,
    });
    t.after(async () => {
      await runtime.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
    });
    const installed = await runtime.install(source, {
      capabilities: ["test.authority/write"],
      projectIds: ["project"],
    });
    const context = {
      client: "test",
      resource: { namespace: id, id: "view", environmentId: "env", projectId: "project" },
    };
    const signal = new AbortController().signal;
    const write = () =>
      runtime.invokeApi(
        id,
        installed.contentHash,
        { id: apiId, versionRange: "^1.0.0", method: "write", input: {}, context },
        signal,
      );
    NodeAssert.equal(await write(), "authorized write");
    const streamSource = runtime.subscribeApi(
      id,
      installed.contentHash,
      { id: apiId, versionRange: "^1.0.0", name: "tryWrite", input: {}, context },
      signal,
    );
    const stream = streamSource[Symbol.asyncIterator]();
    await NodeAssert.rejects(stream.next(), /Read-only API authority cannot invoke writes/);
    NodeAssert.equal(await write(), "authorized write");
  },
);
