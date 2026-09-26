import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { GENERIC_API_CATALOGUE, PRS_READ, PRS_READ_API, prsReadApi } from "../dist/catalogue.js";

const methods = Object.fromEntries(PRS_READ_API.methods.map((m) => [m.name, m]));
const streams = Object.fromEntries((PRS_READ_API.streams ?? []).map((s) => [s.name, s]));

NodeTest.test("t3.prs/read is a frozen 1.0.0 catalogue entry registered once", () => {
  NodeAssert.equal(PRS_READ_API.id, PRS_READ);
  NodeAssert.equal(PRS_READ_API.version, "1.0.0");
  NodeAssert.equal(prsReadApi.definition, PRS_READ_API);
  NodeAssert.deepEqual(
    GENERIC_API_CATALOGUE.filter((d) => d.id === PRS_READ),
    [PRS_READ_API],
  );
});

NodeTest.test("every operation is read-effected and rides the single t3.prs/read grant", () => {
  NodeAssert.deepEqual(Object.keys(methods).sort(), [
    "activity",
    "detail",
    "getCapabilities",
    "invalidate",
    "labelCandidates",
    "linkedThreads",
    "list",
    "listStats",
    "reviewerCandidates",
    "stack",
    "summary",
    "threadComments",
  ]);
  for (const method of Object.values(methods)) {
    NodeAssert.equal(method.effect, "read", method.name);
    NodeAssert.deepEqual(method.requiredGrants, [PRS_READ], method.name);
    NodeAssert.equal(method.inputSchema.additionalProperties, false, method.name);
  }
  NodeAssert.deepEqual(Object.keys(streams).sort(), [
    "streamDiff",
    "streamDiffFileContents",
    "subscribeRefreshes",
  ]);
  for (const stream of Object.values(streams)) {
    NodeAssert.deepEqual(stream.requiredGrants, [PRS_READ], stream.name);
    NodeAssert.equal(stream.inputSchema.additionalProperties, false, stream.name);
  }
});

NodeTest.test("list is bounded and cannot widen scope: no projectIds in the public input", () => {
  const input = methods.list.inputSchema;
  NodeAssert.equal("projectIds" in input.properties, false);
  NodeAssert.equal("projectId" in input.properties, false);
  NodeAssert.equal(input.properties.limit.maximum, 50);
  NodeAssert.equal(input.properties.cursors.maxProperties, 100);
  NodeAssert.equal(input.properties.query.maxLength, 200);

  const output = methods.list.outputSchema;
  for (const key of ["viewers", "providers", "entries", "errors", "truncated", "nextCursors"]) {
    NodeAssert.ok(output.required.includes(key), key);
  }
  NodeAssert.equal(output.properties.entries.maxItems, 100);
});

NodeTest.test(
  "getCapabilities reports hosted flag, probe detail, and per-operation support",
  () => {
    const output = methods.getCapabilities.outputSchema;
    NodeAssert.deepEqual([...output.required].sort(), [
      "detail",
      "hosted",
      "operations",
      "providers",
      "reason",
    ]);
    NodeAssert.deepEqual(output.properties.reason.enum, [
      "cli-missing",
      "cli-unauthenticated",
      "provider-unsupported",
      null,
    ]);
    const operations = output.properties.operations;
    for (const key of [
      "prs.list",
      "prs.detail",
      "prs.activity",
      "prs.streamDiff",
      "prs.linkedThreads",
      "prs.subscribeRefreshes",
    ]) {
      NodeAssert.equal(operations.properties[key].type, "boolean", key);
    }
  },
);

NodeTest.test("truncation is disclosed on every capped collection result", () => {
  const comments = methods.threadComments.outputSchema;
  NodeAssert.ok(comments.required.includes("truncated"));
  NodeAssert.equal(comments.properties.truncated.type, "boolean");
  const linked = methods.linkedThreads.outputSchema;
  NodeAssert.ok(linked.required.includes("truncated"));
  NodeAssert.equal(linked.properties.truncated.type, "boolean");
});

NodeTest.test("streamDiff frames a whole patch under the vcs 1.1.0 frame family", () => {
  const stream = streams.streamDiff;
  const kinds = stream.eventSchema.oneOf.map((variant) => variant.properties.kind.const);
  NodeAssert.deepEqual(kinds, ["manifest", "chunk", "complete"]);
  const manifest = stream.eventSchema.oneOf[0];
  NodeAssert.equal(manifest.properties.diffHash.pattern, "^[0-9a-f]{64}$");
  NodeAssert.equal(manifest.properties.chunkCount.maximum, 512);
  const chunk = stream.eventSchema.oneOf[1];
  NodeAssert.equal(chunk.properties.data.maxLength, 8192);
  NodeAssert.equal(chunk.properties.chunkIndex.maximum, 511);
  const complete = stream.eventSchema.oneOf[2];
  NodeAssert.equal(complete.properties.payloadSha256.pattern, "^[0-9a-f]{64}$");
});

NodeTest.test("streamDiffFileContents reuses the vcs file-contents frame schema", () => {
  const stream = streams.streamDiffFileContents;
  const kinds = stream.eventSchema.oneOf.map((variant) => variant.properties.kind.const);
  NodeAssert.deepEqual(kinds, ["manifest", "chunk", "complete"]);
  const chunk = stream.eventSchema.oneOf[1];
  NodeAssert.deepEqual(chunk.properties.side.enum, ["old", "new"]);
  const input = stream.inputSchema;
  NodeAssert.deepEqual(input.properties.changeType.enum, [
    "change",
    "rename-pure",
    "rename-changed",
    "new",
    "deleted",
  ]);
});

NodeTest.test("subscribeRefreshes emits refreshed events and a named close", () => {
  const stream = streams.subscribeRefreshes;
  const kinds = stream.eventSchema.oneOf.map((variant) => variant.properties.kind.const);
  NodeAssert.deepEqual(kinds, ["refreshed", "closed"]);
  NodeAssert.deepEqual(stream.eventSchema.oneOf[1].properties.reason.enum, [
    "overflow",
    "refresh-error",
  ]);
});
