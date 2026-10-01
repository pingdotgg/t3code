import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  GENERIC_API_CATALOGUE,
  WORKSPACE_CHANGES,
  WORKSPACE_CHANGES_API,
  WORKSPACE_READ,
  workspaceChangesApi,
} from "../dist/catalogue.js";

const stream = WORKSPACE_CHANGES_API.streams.find((s) => s.name === "subscribeChanges");

NodeTest.test("t3.workspace/changes is a frozen 1.0.0 catalogue contract with one stream", () => {
  NodeAssert.equal(WORKSPACE_CHANGES_API.id, "t3.workspace/changes");
  NodeAssert.equal(WORKSPACE_CHANGES_API.version, "1.0.0");
  NodeAssert.deepEqual(
    GENERIC_API_CATALOGUE.filter((d) => d.id === WORKSPACE_CHANGES),
    [WORKSPACE_CHANGES_API],
  );
  NodeAssert.equal(workspaceChangesApi.definition, WORKSPACE_CHANGES_API);
  NodeAssert.equal(WORKSPACE_CHANGES_API.methods.length, 0);
  NodeAssert.deepEqual(
    WORKSPACE_CHANGES_API.streams.map((s) => s.name),
    ["subscribeChanges"],
  );
  NodeAssert.deepEqual(stream.requiredGrants, [WORKSPACE_READ]);
});

NodeTest.test("subscribeChanges input is a closed, thread-scoped object", () => {
  NodeAssert.equal(stream.inputSchema.additionalProperties, false);
  NodeAssert.deepEqual(stream.inputSchema.required, ["threadId"]);
  NodeAssert.equal(stream.inputSchema.properties.threadId.minLength, 1);
});

NodeTest.test("the event union carries only folded mutation state — no raw payloads", () => {
  const variants = stream.eventSchema.oneOf;
  NodeAssert.equal(variants.length, 3);
  const snapshot = variants.find((v) => v.properties.kind.const === "snapshot");
  const mutation = variants.find((v) => v.properties.kind.const === "mutation");
  const closed = variants.find((v) => v.properties.kind.const === "closed");
  NodeAssert.deepEqual(snapshot.required.sort(), ["kind", "mutationSeq"]);
  NodeAssert.deepEqual(mutation.required.sort(), ["at", "kind", "kinds", "mutationSeq"]);
  NodeAssert.deepEqual(mutation.properties.kinds.items.enum, ["command_execution", "file_change"]);
  NodeAssert.deepEqual(closed.required.sort(), ["kind", "reason"]);
  NodeAssert.deepEqual(closed.properties.reason.enum, ["overflow", "watch-error"]);
  for (const variant of variants) NodeAssert.equal(variant.additionalProperties, false);
});
