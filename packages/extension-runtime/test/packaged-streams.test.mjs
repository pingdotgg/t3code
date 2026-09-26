import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createExtensionRuntime } from "../dist/index.js";

const examples = NodeURL.fileURLToPath(new URL("../../extension-sdk/examples/", import.meta.url));
const context = {
  client: "independent-packaged-consumer",
  resource: {
    namespace: "example.stream-consumer",
    id: "counter",
    environmentId: "env",
    projectId: "project",
  },
};
NodeTest.test(
  "installed independent counter packages stream through both server API handlers",
  { timeout: 10000 },
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-packaged-streams-"));
    const audit = [];
    const runtime = await createExtensionRuntime({
      rootDir: root,
      environmentId: "env",
      services: [],
      authorize: () => true,
      timeoutMs: 1500,
      auditApi: (event) => audit.push(event),
    });
    t.after(async () => {
      await runtime.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
    });
    const grants = { capabilities: [], projectIds: ["project"] };
    const provider = await runtime.install(
      NodePath.join(examples, "installable-stream-provider"),
      grants,
    );
    const consumer = await runtime.install(
      NodePath.join(examples, "installable-stream-consumer"),
      grants,
    );
    const signal = new AbortController().signal;
    const iteratorSource = runtime.subscribeApi(
      consumer.id,
      consumer.contentHash,
      {
        id: "example.stream-consumer/state",
        versionRange: "^1.0.0",
        name: "changes",
        input: {},
        context,
      },
      signal,
    );
    const iterator = iteratorSource[Symbol.asyncIterator]();
    const first = await iterator.next();
    NodeAssert.equal(first.value.value.count, 0);
    const pending = iterator.next();
    await runtime.invokeApi(
      provider.id,
      provider.contentHash,
      {
        id: "example.stream-provider/state",
        versionRange: "^1.0.0",
        method: "increment",
        input: {},
        context,
      },
      signal,
    );
    const second = await pending;
    NodeAssert.equal(second.value.value.count, 1);
    NodeAssert.equal(first.value.streamId, second.value.streamId);
    NodeAssert.deepEqual([first.value.sequence, second.value.sequence], [1, 2]);
    await iterator.return();
    const reopenedSource = runtime.subscribeApi(
      consumer.id,
      consumer.contentHash,
      {
        id: "example.stream-consumer/state",
        versionRange: "^1.0.0",
        name: "changes",
        input: {},
        context,
      },
      signal,
    );
    const reopened = reopenedSource[Symbol.asyncIterator]();
    NodeAssert.equal(
      (await reopened.next()).value.value.count,
      1,
      "closing a view must preserve the provider's in-memory counter",
    );
    await reopened.return();
    NodeAssert.ok(
      audit.some(
        (event) =>
          event.apiId === "example.stream-provider/state" &&
          event.operation === "stream-open" &&
          event.rootCallerId === consumer.id &&
          event.callerId === consumer.id &&
          event.parentCallId,
      ),
    );
    const saved = await runtime.readClient(consumer.id);
    NodeAssert.ok(saved.code.includes("host.subscribeApi"));
    NodeAssert.ok(!saved.code.includes("WebSocket"));
  },
);
