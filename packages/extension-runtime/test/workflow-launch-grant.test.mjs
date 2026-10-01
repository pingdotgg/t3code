import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  ORCHESTRATION_CONTROL_API,
  ORCHESTRATION_LAUNCH_WORKFLOW,
  ORCHESTRATION_OPERATE,
} from "@t3tools/extension-sdk/catalogue";
import { createApiBroker } from "../dist/broker.js";

// The launch grant is ANDed with operate by the real contract definition: an
// install that may start turns does not silently gain workflow launch.
const context = {
  resource: {
    namespace: "t3.agents",
    id: "view",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
};
const receipt = { commandId: "launch", status: "accepted", sequence: 2, error: null };
const makeRecord = (capabilities) => ({
  id: "t3.agents",
  contentHash: "a".repeat(64),
  enabled: true,
  grants: { capabilities, projectIds: ["project"] },
  package: {
    format: 3,
    manifest: { id: "t3.agents", version: "0.1.0", apiVersion: 1, surfaces: [] },
    tools: [],
    provides: [],
    requires: [{ id: ORCHESTRATION_CONTROL_API.id, versionRange: "^1.1.0" }],
    dependencies: [],
  },
});
const root = {
  principal: {
    kind: "environment-session",
    id: "session",
    environmentId: "env",
    scopes: ["orchestration:operate"],
  },
  allowWrite: true,
  revalidate: () => {},
};
const makeBroker = (record) => {
  const calls = [];
  const broker = createApiBroker({
    installations: () => [record],
    providers: [
      {
        providerId: "t3.host-orchestration-control",
        definition: ORCHESTRATION_CONTROL_API,
        requiresRootAuthority: true,
        invoke: (method, input) => {
          calls.push({ method, input });
          return receipt;
        },
      },
    ],
    selections: () => [],
    authorize: (installation, grant) => installation.grants.capabilities.includes(grant),
    environmentId: "env",
    timeoutMs: 500,
    invokeWorker: () => {
      throw new Error("unexpected worker");
    },
  });
  return { broker, calls };
};
const launch = (broker, record, input = { workflowName: "review" }) =>
  broker.invoke(
    record,
    {
      id: ORCHESTRATION_CONTROL_API.id,
      versionRange: "^1.1.0",
      method: "workflow.launch",
      input,
      context,
    },
    new AbortController().signal,
    undefined,
    root,
  );

NodeTest.test("workflow.launch requires the launch grant on top of operate", async () => {
  const record = makeRecord([ORCHESTRATION_OPERATE]);
  const f = makeBroker(record);
  await NodeAssert.rejects(
    launch(f.broker, record),
    /API capability denied: t3\.orchestration\/launch-workflow/,
  );
  NodeAssert.equal(f.calls.length, 0);
  // Operate alone still covers the pre-1.1.0 operations.
  NodeAssert.deepEqual(
    await f.broker.invoke(
      record,
      {
        id: ORCHESTRATION_CONTROL_API.id,
        versionRange: "^1.0.0",
        method: "thread.settle",
        input: {},
        context,
      },
      new AbortController().signal,
      undefined,
      root,
    ),
    receipt,
  );
});

NodeTest.test("the launch grant alone does not imply operate", async () => {
  const record = makeRecord([ORCHESTRATION_LAUNCH_WORKFLOW]);
  const f = makeBroker(record);
  await NodeAssert.rejects(
    launch(f.broker, record),
    /API capability denied: t3\.orchestration\/operate/,
  );
  NodeAssert.equal(f.calls.length, 0);
});

NodeTest.test("granted launches reach the host; non-slug names fail at the schema", async () => {
  const record = makeRecord([ORCHESTRATION_OPERATE, ORCHESTRATION_LAUNCH_WORKFLOW]);
  const f = makeBroker(record);
  NodeAssert.deepEqual(await launch(f.broker, record), receipt);
  NodeAssert.deepEqual(f.calls, [{ method: "workflow.launch", input: { workflowName: "review" } }]);
  for (const input of [{ workflowName: "../x" }, { workflowName: "ok", text: "free text" }])
    await NodeAssert.rejects(launch(f.broker, record, input), /API input does not match schema/);
  NodeAssert.equal(f.calls.length, 1);
});
