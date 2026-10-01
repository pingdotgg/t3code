import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { bindStreamApi } from "../dist/capabilities.js";
import { requireApi } from "../dist/authoring.js";
import { copyJson } from "../dist/contracts.js";
import { orchestrationStatusApi, splitWorkspaceResourceChunks } from "../dist/catalogue.js";

NodeTest.test("workflow script transfer is an additive, read-granted 1.1.0 stream", () => {
  const definition = orchestrationStatusApi.definition;
  NodeAssert.equal(definition.version, "1.1.0");
  NodeAssert.equal(requireApi(orchestrationStatusApi).versionRange, "^1.0.0");
  NodeAssert.deepEqual(orchestrationStatusApi.additions, [
    { version: "1.1.0", stream: "readWorkflowScript" },
  ]);
  const stream = definition.streams.find((entry) => entry.name === "readWorkflowScript");
  NodeAssert.deepEqual(stream.requiredGrants, ["t3.orchestration/read"]);
  NodeAssert.deepEqual(Object.keys(stream.inputSchema.properties), ["workflowId"]);
  NodeAssert.equal(
    definition.methods.some((entry) => entry.name === "getWorkflowScript"),
    false,
  );
});

NodeTest.test("workflow script transfer cannot run without negotiating the stream addition", () => {
  const requests = [];
  const host = {
    subscribeApi(request) {
      requests.push(request);
      return (async function* () {})();
    },
  };
  const signal = new AbortController().signal;
  NodeAssert.throws(
    () =>
      bindStreamApi(orchestrationStatusApi, host, {}).subscribe(
        "readWorkflowScript",
        { workflowId: "workflow" },
        signal,
      ),
    /needs \^1\.1\.0/,
  );
  bindStreamApi(orchestrationStatusApi, host, {}, "^1.1.0").subscribe(
    "readWorkflowScript",
    { workflowId: "workflow" },
    signal,
  );
  NodeAssert.equal(requests.length, 1);
  NodeAssert.equal(requests[0].versionRange, "^1.1.0");
});

NodeTest.test(
  "workflow script chunks fit the envelope even with worst-case escaping and split Unicode",
  () => {
    const contents = `${"\u0000".repeat(8191)}🦀${"\u0000".repeat(256 * 1024 - 8195)}`;
    const chunks = splitWorkspaceResourceChunks(contents);
    NodeAssert.equal(chunks.join(""), contents);
    NodeAssert.equal(chunks[0].length, 8191);
    for (const [chunkIndex, data] of chunks.entries())
      NodeAssert.doesNotThrow(() =>
        copyJson({
          streamId: "x".repeat(128),
          sequence: chunkIndex,
          type: "data",
          value: { kind: "chunk", chunkIndex, data },
        }),
      );
  },
);
