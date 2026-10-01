import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  AGENT_LOG_TAIL_MAX_BYTES,
  GENERIC_API_CATALOGUE,
  ORCHESTRATION_OPERATE,
  ORCHESTRATION_READ,
  ORCHESTRATION_READ_LOGS,
  assertProvidedApiOwner,
  orchestrationLogsApi,
} from "../dist/catalogue.js";

NodeTest.test("t3.orchestration/logs is a read-only shared contract behind its own grant", () => {
  const definition = orchestrationLogsApi.definition;
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(definition));
  NodeAssert.equal(definition.id, "t3.orchestration/logs");
  NodeAssert.equal(definition.version, "1.0.0");
  NodeAssert.equal(definition.streams, undefined);
  NodeAssert.deepEqual(
    definition.methods.map((method) => [method.name, method.effect, method.requiredGrants]),
    [
      ["listRuns", "read", [ORCHESTRATION_READ_LOGS]],
      ["readTail", "read", [ORCHESTRATION_READ_LOGS]],
    ],
  );
  NodeAssert.notEqual(ORCHESTRATION_READ_LOGS, ORCHESTRATION_READ);
  NodeAssert.notEqual(ORCHESTRATION_READ_LOGS, ORCHESTRATION_OPERATE);
  // Host-owned namespace: a pack cannot re-provide a divergent copy.
  NodeAssert.doesNotThrow(() => assertProvidedApiOwner("t3.agents", definition));
  NodeAssert.throws(
    () => assertProvidedApiOwner("t3.agents", { ...definition, version: "1.0.1" }),
    /incompatible/,
  );
});

NodeTest.test("readTail names runs, never paths, and bounds the public tail", () => {
  const readTail = orchestrationLogsApi.definition.methods.find((m) => m.name === "readTail");
  NodeAssert.deepEqual(Object.keys(readTail.inputSchema.properties).sort(), [
    "maxBytes",
    "maxLines",
    "runId",
    "source",
  ]);
  NodeAssert.equal(readTail.inputSchema.additionalProperties, false);
  NodeAssert.equal(readTail.inputSchema.properties.maxBytes.maximum, AGENT_LOG_TAIL_MAX_BYTES);
  NodeAssert.equal(readTail.outputSchema.properties.contents.maxLength, AGENT_LOG_TAIL_MAX_BYTES);
  NodeAssert.deepEqual(readTail.outputSchema.required.sort(), [
    "byteLength",
    "contents",
    "runId",
    "source",
    "truncated",
  ]);
  const listRuns = orchestrationLogsApi.definition.methods.find((m) => m.name === "listRuns");
  const run = listRuns.outputSchema.properties.runs.items;
  NodeAssert.equal(run.additionalProperties, false);
  NodeAssert.deepEqual(Object.keys(run.properties).sort(), [
    "kind",
    "runId",
    "sources",
    "status",
    "title",
  ]);
});
