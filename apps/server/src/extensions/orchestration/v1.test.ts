import { afterEach, expect, it } from "@effect/vitest";
import {
  ExtensionOperationError,
  OrchestrationThreadActivity,
  TurnId,
  CheckpointRef,
} from "@t3tools/contracts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { ORCHESTRATION_CONTROL_OPS } from "@t3tools/extension-sdk/catalogue";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import { createFixture, context } from "./v1.fixture.ts";
import { projectAgents } from "./v1.ts";

const decodeActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);
const isOperationError = Schema.is(ExtensionOperationError);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const fixture = async () => {
  const f = await createFixture();
  cleanups.push(f.dispose);
  return f;
};
const signal = new AbortController().signal;
const meta = (
  provider: HostApiProvider,
  scopes = ["orchestration:read", "orchestration:operate"],
) => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  principal: { kind: "environment-session" as const, id: "session", environmentId: "env", scopes },
});
const invoke = (
  provider: HostApiProvider,
  method: string,
  input: Parameters<HostApiProvider["invoke"]>[1] = {},
) => provider.invoke(method, input, context, signal, meta(provider));
const subscribe = (provider: HostApiProvider) => {
  const iterator = provider.subscribe!("subscribeAgents", {}, context, signal, meta(provider))[
    Symbol.asyncIterator
  ]();
  cleanups.push(async () => {
    await iterator.return?.();
  });
  return iterator;
};
const inputs = {
  "turn.start": { text: "hello" },
  "turn.interrupt": {},
  "session.stop": { onlyIfSettled: true },
  "approval.respond": { requestId: "request", decision: "accept" },
  "userInput.respond": { requestId: "request", answers: { question: "yes" } },
  "userInput.dismiss": { requestId: "request" },
  "thread.settle": {},
  "thread.unsettle": {},
  "checkpoint.revert": { turnCount: 0 },
} as const;

it("separates read and operate root authority and rejects stale workspace contexts", async () => {
  const f = await fixture();
  await expect(
    f.control.invoke("thread.settle", {}, context, signal, meta(f.control, ["orchestration:read"])),
  ).rejects.toThrow("orchestration:operate");
  await expect(
    f.status.invoke(
      "getCapabilities",
      {},
      context,
      signal,
      meta(f.status, ["orchestration:operate"]),
    ),
  ).rejects.toThrow("orchestration:read");
  await expect(
    f.control.invoke(
      "thread.settle",
      {},
      { ...context, workspaceRevision: "stale" },
      signal,
      meta(f.control),
    ),
  ).rejects.toThrow("stale");
  expect(f.calls).toHaveLength(0);
});

it("shares the exact RuntimeSubagent and pending-request folds without activities on the wire", async () => {
  const f = await fixture();
  const activity = decodeActivity({
    id: "activity",
    kind: "task.started",
    tone: "info",
    summary: "Started",
    createdAt: "2026-09-13T00:00:00.000Z",
    turnId: null,
    payload: {
      taskId: "agent",
      agentKind: "agent",
      description: "A task",
      model: "gpt-6",
      secretProviderFrame: "PRIVATE",
    },
  });
  const state = { ...f.state, thread: { ...f.state.thread, activities: [activity] } };
  f.setState(state);
  const projected = projectAgents(state);
  expect(projected.agents).toEqual(
    foldSubagentActivities(state.thread.activities, { sessionLive: false }),
  );
  expect(projected.agents).toHaveLength(1);
  expect(projected.pendingApprovals).toEqual(
    derivePendingRequests(state.thread.activities).approvals,
  );
  const first = await subscribe(f.status).next();
  expect(JSON.stringify(first.value)).not.toContain("secretProviderFrame");
  expect(first.value?.value).not.toHaveProperty("activities");
});

it("subscribes before snapshot, then emits monotonically stamped folded updates", async () => {
  const f = await fixture();
  f.onRead(() => {
    f.onRead(() => {});
    void f.publish(2);
  });
  const stream = subscribe(f.status);
  const first = await stream.next();
  expect(first.value?.type).toBe("snapshot");
  expect(first.value?.value).toMatchObject({ kind: "snapshot", revision: 1 });
  const second = await stream.next();
  expect(second.value?.value).toMatchObject({ kind: "updated", revision: 2 });
});

for (const operation of ORCHESTRATION_CONTROL_OPS) {
  it(`${operation} mints a native command and returns correlated rejected receipts`, async () => {
    const f = await fixture();
    f.setReject(true);
    const stream = subscribe(f.status);
    await stream.next();
    const receipt = await invoke(f.control, operation, {
      ...inputs[operation],
      commandId: `reject-${operation}`,
    });
    expect(receipt).toMatchObject({
      status: "rejected",
      commandId: `reject-${operation}`,
      error: "OrchestrationCommandRejected",
    });
    expect(f.calls).toHaveLength(1);
    expect((await stream.next()).value?.value).toMatchObject({ kind: "receipt", receipt });
    expect(
      await invoke(f.control, operation, {
        ...inputs[operation],
        commandId: `reject-${operation}`,
      }),
    ).toEqual(receipt);
    expect(f.calls).toHaveLength(1);
  });
}

it("retries accepted commands idempotently and rejects wrong epochs, revisions and unsupported fields", async () => {
  const f = await fixture();
  const first = await invoke(f.control, "turn.start", { text: "hello", commandId: "retry" });
  expect(first).toMatchObject({ status: "accepted" });
  expect(
    await invoke(f.control, "turn.start", {
      text: "hello",
      commandId: "retry",
      expectedEpoch: "old",
    }),
  ).toEqual(first);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({
    type: "thread.turn.start",
    message: { text: "hello", attachments: [] },
    createdAt: expect.any(String),
  });
  expect(await invoke(f.control, "thread.settle", { expectedEpoch: "old" })).toMatchObject({
    status: "rejected",
    error: "OrchestrationWrongEpoch",
  });
  expect(await invoke(f.control, "thread.settle", { expectedRevision: 0 })).toMatchObject({
    status: "rejected",
    error: "OrchestrationStaleRevision",
  });
  for (const field of ["attachments", "bootstrap", "sourceProposedPlan"])
    expect(await invoke(f.control, "turn.start", { text: "x", [field]: [] })).toMatchObject({
      status: "rejected",
      error: `OrchestrationUnsupported: ${field}`,
    });
  expect(f.calls).toHaveLength(1);
});

it("closes overflow recoverably and resubscription recovers the full state and receipts", async () => {
  const f = await fixture();
  const stream = subscribe(f.status);
  await stream.next();
  for (let i = 0; i < 70; i++)
    await invoke(f.control, "thread.settle", { commandId: `burst-${i}` });
  expect((await stream.next()).value).toMatchObject({
    type: "closed",
    value: { kind: "closed", reason: "overflow" },
  });
  expect((await stream.next()).done).toBe(true);
  const reopened = await subscribe(f.status).next();
  expect(reopened.value?.value).toMatchObject({
    kind: "snapshot",
    revision: 71,
    receipts: expect.arrayContaining([expect.objectContaining({ commandId: "burst-69" })]),
  });
});

for (const driver of [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
] as const) {
  it(`${driver} reports registered provider support and rollback honesty`, async () => {
    const f = await fixture();
    f.setProvider(driver);
    expect(await invoke(f.status, "getCapabilities")).toMatchObject({
      operations: { "checkpoint.revert": !["grok", "antigravity"].includes(driver) },
    });
    f.setProvider(driver, false);
    expect(await invoke(f.status, "getCapabilities")).toMatchObject({
      operations: { "turn.start": true, "userInput.respond": true, "checkpoint.revert": false },
    });
    expect(await invoke(f.control, "checkpoint.revert", { turnCount: 0 })).toMatchObject({
      status: "rejected",
      error: "OrchestrationUnsupported: checkpoint.revert",
    });
    f.setProvider(driver, true, false);
    expect(await invoke(f.status, "getCapabilities")).toMatchObject({
      operations: { "turn.start": false, "thread.settle": true },
    });
  });
}

it("streams the existing diff frame family with a verified delivered hash", async () => {
  const f = await fixture();
  const stream = f.status.subscribe!("getThreadDiff", {}, context, signal, meta(f.status));
  const frames = [];
  for await (const frame of stream) frames.push(frame);
  expect(frames[0]?.value).toMatchObject({
    kind: "manifest",
    sources: [expect.objectContaining({ id: "checkpoint-0-0" })],
  });
  const data = frames
    .filter(
      (frame) =>
        frame.value &&
        typeof frame.value === "object" &&
        "kind" in frame.value &&
        frame.value.kind === "chunk",
    )
    .map((frame) => (frame.value as { data: string }).data)
    .join("");
  expect(frames.at(-1)?.value).toEqual({
    kind: "complete",
    payloadSha256: NodeCrypto.createHash("sha256").update(data).digest("hex"),
  });
});

it("folds approval options and dismissible questions and removes resolved requests", async () => {
  const f = await fixture();
  const base = {
    tone: "info",
    summary: "Request",
    createdAt: "2026-09-13T00:00:00.000Z",
    turnId: null,
  };
  const activities = [
    decodeActivity({
      ...base,
      id: "a",
      kind: "approval.requested",
      payload: {
        requestId: "approve",
        requestKind: "command",
        options: [{ decision: "accept", label: "Allow", warning: "Check command" }],
        raw: "PRIVATE",
      },
    }),
    decodeActivity({
      ...base,
      id: "q",
      kind: "user-input.requested",
      payload: {
        requestId: "question",
        responseMode: "message",
        questions: [
          {
            id: "q",
            header: "Choose",
            question: "Which?",
            options: [{ label: "One", description: "First", value: "1" }],
          },
        ],
        raw: "PRIVATE",
      },
    }),
  ];
  const state = { ...f.state, thread: { ...f.state.thread, activities } };
  const folded = projectAgents(state);
  expect(folded.pendingApprovals[0]?.options).toEqual([
    { decision: "accept", label: "Allow", warning: "Check command" },
  ]);
  expect(folded.pendingUserInputs[0]).toMatchObject({ requestId: "question", dismissible: true });
  expect(JSON.stringify(folded)).not.toContain("PRIVATE");
  const resolved = projectAgents({
    ...state,
    thread: {
      ...state.thread,
      activities: [
        ...activities,
        decodeActivity({
          ...base,
          id: "resolved",
          kind: "approval.resolved",
          payload: { requestId: "approve" },
        }),
      ],
    },
  });
  expect(resolved.pendingApprovals).toEqual([]);
});

it("does not accept a command ID belonging to another thread", async () => {
  const f = await fixture();
  await invoke(f.control, "thread.settle", { commandId: "shared" });
  await expect(
    f.control.invoke(
      "thread.settle",
      { commandId: "shared" },
      { ...context, resource: { ...context.resource, threadId: "other" } },
      signal,
      meta(f.control),
    ),
  ).rejects.toThrow("OrchestrationCommandConflict");
  expect(f.calls).toHaveLength(1);
});

it("cancels an outstanding read and rechecks authority before dispatch", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const stream = f.status.subscribe!(
    "subscribeAgents",
    {},
    context,
    controller.signal,
    meta(f.status),
  )[Symbol.asyncIterator]();
  await stream.next();
  const next = stream.next();
  controller.abort();
  await expect(next).rejects.toThrow();
  await stream.return?.();
  let checks = 0;
  await expect(
    f.control.invoke("thread.settle", {}, context, signal, {
      ...meta(f.control),
      assertAuthority: async () => {
        checks++;
        if (checks === 2) throw new Error("revoked");
      },
    }),
  ).rejects.toThrow("OrchestrationAuthorityDenied");
  expect(f.calls).toHaveLength(0);
});

it("fails oversized projections by name rather than silently dropping native fields", async () => {
  const f = await fixture();
  const activities = Array.from({ length: 100 }, (_, index) =>
    decodeActivity({
      id: `activity-${index}`,
      kind: "task.started",
      tone: "info",
      summary: "Started",
      createdAt: "2026-09-13T00:00:00.000Z",
      turnId: null,
      payload: { taskId: `agent-${index}`, agentKind: "agent", outputFile: "x".repeat(1000) },
    }),
  );
  f.setState({ ...f.state, thread: { ...f.state.thread, activities } });
  await expect(subscribe(f.status).next()).rejects.toThrow("OrchestrationProjectionTooLarge");
});

it("fails a pathological phase roster by name instead of a schema rejection", async () => {
  const f = await fixture();
  // The fold never bounds payload.phases; the wire schema caps it at 100.
  const activity = decodeActivity({
    id: "workflow",
    kind: "task.started",
    tone: "info",
    summary: "Workflow",
    createdAt: "2026-09-13T00:00:00.000Z",
    turnId: null,
    payload: {
      taskId: "workflow",
      agentKind: "agent",
      taskType: "local_workflow",
      phases: Array.from({ length: 101 }, (_, index) => ({
        index,
        title: `Phase ${index}`,
      })),
    },
  });
  f.setState({ ...f.state, thread: { ...f.state.thread, activities: [activity] } });
  await expect(subscribe(f.status).next()).rejects.toThrow("OrchestrationProjectionTooLarge");
});

it("names a stale workspace revision race instead of reporting authority denied", async () => {
  const f = await fixture();
  let checks = 0;
  const error = await Promise.resolve(
    f.control.invoke("thread.settle", {}, context, signal, {
      ...meta(f.control),
      // The workspace moves between the entry guard and the pre-dispatch
      // re-guard — the race must surface as a stale context, not authority.
      assertAuthority: async () => {
        checks += 1;
        if (checks === 1) f.setWorkspaceRoot("/moved");
      },
    }),
  ).then(
    () => {
      throw new Error("expected rejection");
    },
    (cause: unknown) => cause,
  );
  const operationError = isOperationError(error) ? error : null;
  expect(operationError?.detail).toContain("stale");
  expect(operationError?.detail).not.toContain("AuthorityDenied");
  expect(f.calls).toHaveLength(0);
});

it("keeps the stale name when the workspace races inside broker scope revalidation", async () => {
  const f = await fixture();
  let checks = 0;
  const error = await Promise.resolve(
    f.control.invoke("thread.settle", {}, context, signal, {
      ...meta(f.control),
      // The production broker's scope check runs the same resolver; a
      // rejection carries the tagged error through assertAuthority.
      assertAuthority: async () => {
        checks += 1;
        if (checks !== 2) return;
        f.setWorkspaceRoot("/moved");
        await f.validateScope();
      },
    }),
  ).then(
    () => {
      throw new Error("expected rejection");
    },
    (cause: unknown) => cause,
  );
  const operationError = isOperationError(error) ? error : null;
  expect(operationError?.detail).toContain("stale");
  expect(operationError?.detail).not.toContain("AuthorityDenied");
  expect(f.calls).toHaveLength(0);
});

it("keeps the stale name when the workspace change reverts before any later read", async () => {
  const f = await fixture();
  let checks = 0;
  const error = await Promise.resolve(
    f.control.invoke("thread.settle", {}, context, signal, {
      ...meta(f.control),
      // ABA schedule: the broker validation fails while the workspace is
      // moved, then the state reverts. Stale detection is captured at
      // failure time, so the later revert cannot leak an authority label.
      assertAuthority: async () => {
        checks += 1;
        if (checks !== 2) return;
        f.setWorkspaceRoot("/moved");
        try {
          await f.validateScope();
        } finally {
          f.setWorkspaceRoot("/workspace");
        }
      },
    }),
  ).then(
    () => {
      throw new Error("expected rejection");
    },
    (cause: unknown) => cause,
  );
  const operationError = isOperationError(error) ? error : null;
  expect(operationError?.detail).toContain("stale");
  expect(operationError?.detail).not.toContain("AuthorityDenied");
  expect(f.calls).toHaveLength(0);
});

it("truncates workflow scripts without splitting a surrogate pair", async () => {
  const f = await fixture();
  const workflow = decodeActivity({
    id: "workflow",
    kind: "task.started",
    tone: "info",
    summary: "Workflow",
    createdAt: "2026-09-13T00:00:00.000Z",
    turnId: null,
    payload: {
      taskId: "workflow",
      agentKind: "agent",
      taskType: "local_workflow",
      runHandles: { scriptPath: "/home/workflow.js" },
    },
  });
  f.setState({ ...f.state, thread: { ...f.state.thread, activities: [workflow] } });
  // An astral pair straddles the 8 192-unit bound, so the delivered contents
  // must shrink to 8 191 units rather than emit a lone surrogate.
  const crafted = `${"a".repeat(8_191)}\u{1F980}${"z".repeat(100)}`;
  f.setScriptContents(crafted);
  const result = (await invoke(f.status, "getWorkflowScript", {
    workflowId: "workflow",
  })) as { contents: string; truncated: boolean };
  expect(result.contents).toBe("a".repeat(8_191));
  expect(result.truncated).toBe(true);
});

it("resolves workflow scripts only from this thread's folded workflow handles", async () => {
  const f = await fixture();
  const workflow = decodeActivity({
    id: "workflow",
    kind: "task.started",
    tone: "info",
    summary: "Workflow",
    createdAt: "2026-09-13T00:00:00.000Z",
    turnId: null,
    payload: {
      taskId: "workflow",
      agentKind: "agent",
      taskType: "local_workflow",
      runHandles: { scriptPath: "/home/workflow.js" },
    },
  });
  f.setState({ ...f.state, thread: { ...f.state.thread, activities: [workflow] } });
  expect(await invoke(f.status, "getCapabilities")).toMatchObject({
    operations: { getWorkflowScript: true },
  });
  expect(await invoke(f.status, "getWorkflowScript", { workflowId: "workflow" })).toEqual({
    contents: "export default 1;",
    truncated: false,
  });
  await expect(invoke(f.status, "getWorkflowScript", { workflowId: "other" })).rejects.toThrow(
    "OrchestrationUnsupported",
  );
  await expect(
    invoke(f.status, "getWorkflowScript", { workflowId: "workflow", scriptPath: "/arbitrary.js" }),
  ).rejects.toThrow();
});

it("accepts either turn ID or count for checkpoint diffs and refuses nonexistent turns", async () => {
  const f = await fixture();
  f.setState({
    ...f.state,
    thread: {
      ...f.state.thread,
      checkpoints: [
        {
          turnId: TurnId.make("turn"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("checkpoint"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-09-13T00:00:00.000Z",
        },
      ],
    },
  });
  for (const input of [{ turnId: "turn" }, { turnCount: 1 }]) {
    const stream = f.status.subscribe!("getTurnDiff", input, context, signal, meta(f.status))[
      Symbol.asyncIterator
    ]();
    expect((await stream.next()).value?.value).toMatchObject({
      kind: "manifest",
      sources: [expect.objectContaining({ id: "checkpoint-0-1" })],
    });
    await stream.return?.();
  }
  const missing = f.status.subscribe!(
    "getTurnDiff",
    { turnCount: 2 },
    context,
    signal,
    meta(f.status),
  )[Symbol.asyncIterator]();
  await expect(missing.next()).rejects.toThrow("OrchestrationCheckpointUnavailable");
});

it("does not deliver buffered frames after iterator return", async () => {
  const f = await fixture();
  const stream = subscribe(f.status);
  await stream.next();
  await invoke(f.control, "thread.settle");
  await stream.return?.();
  expect((await stream.next()).done).toBe(true);
});
