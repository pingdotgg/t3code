import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  type AcpToolCallState,
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "@t3tools/provider-acp/server/runtimeModel";

import { extractFxSubagentUpdate, makeFxSubagentHookRouter } from "./subagents.ts";

const ROOT = "fx-session-01";
const CHILD = "fx-session-02";
const CALL = "call_subagent";
const TASK = "Read package.json and summarize it.";
const REPLY = `The package is fx-replay.\n${"Scripts: build, test, lint. ".repeat(20)}`;
const WHOLE_RESULT = JSON.stringify({ ok: true, result: REPLY, error_code: null });

/** fx's ACP view of a `subagent` call: its arguments, then a 200-byte preview of the result. */
const fxToolCall = {
  toolCallId: CALL,
  title: "Subagent · Read package.json",
  _meta: { fx: { toolCall: { internal: false } } },
};
const announce: EffectAcpSchema.SessionNotification = {
  sessionId: ROOT,
  update: {
    sessionUpdate: "tool_call",
    ...fxToolCall,
    name: "subagent",
    kind: "other",
    status: "pending",
    rawInput: { action: "run", task: TASK },
  },
};
const subagentUpdate = (
  update: Omit<EffectAcpSchema.ToolCallUpdate, "toolCallId">,
): EffectAcpSchema.SessionNotification => ({
  sessionId: ROOT,
  update: { sessionUpdate: "tool_call_update", ...fxToolCall, ...update },
});
const preview = (status: "completed" | "failed", text = WHOLE_RESULT.slice(0, 199)) =>
  subagentUpdate({
    status,
    content: [{ type: "content", content: { type: "text", text } }],
  });

const hook = (
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
  contentTruncated = false,
) => ({
  version: 1 as const,
  sessionId,
  rootSessionId: ROOT,
  executionId: sessionId === ROOT ? "exec-root" : "exec-child",
  type,
  data,
  contentTruncated,
});
const call = (callId: string, name: string, argumentsJson?: string) => ({
  callId,
  name,
  provenance: "model",
  ...(argumentsJson === undefined ? {} : { argumentsJson }),
});
const delegation = (phase: string) =>
  hook(ROOT, "delegation", { callId: CALL, childSessionId: CHILD, workId: "work-1", phase });
const rootResult = (output: string, truncated = false, type = "tool.result") =>
  hook(ROOT, type, { call: call(CALL, "subagent"), output, status: "success" }, truncated);

/**
 * Plays fx's ACP updates and hook events the way the adapter receives them,
 * folding root tool updates into tool state as the ACP runtime model does.
 */
function play(
  steps: ReadonlyArray<
    | { readonly acp: EffectAcpSchema.SessionNotification }
    | { readonly hook: ReturnType<typeof hook> }
  >,
) {
  const router = makeFxSubagentHookRouter();
  const delivered: Array<EffectAcpSchema.SessionNotification> = [];
  let tool: AcpToolCallState | undefined;
  const statuses: Array<string | undefined> = [];
  for (const step of steps) {
    const notifications = "acp" in step ? [router.enrich(step.acp)] : router.route(step.hook);
    for (const notification of notifications) {
      if (notification.sessionId !== ROOT) {
        delivered.push(notification);
        continue;
      }
      for (const event of parseSessionUpdateEvent(notification).events) {
        if (event._tag !== "ToolCallUpdated") continue;
        tool = mergeToolCallState(tool, event.toolCall);
        statuses.push(extractFxSubagentUpdate(tool)?.status);
      }
    }
  }
  if (tool === undefined) throw new Error("fx never announced the subagent call");
  return { delivered, statuses, update: extractFxSubagentUpdate(tool) };
}

const childSteps = (delivered: ReadonlyArray<EffectAcpSchema.SessionNotification>) =>
  delivered.map(({ sessionId, update }) => {
    assert.equal(sessionId, CHILD);
    switch (update.sessionUpdate) {
      case "tool_call":
      case "tool_call_update":
        return `${update.sessionUpdate} ${update.toolCallId} ${update.status}`;
      case "agent_message":
        return `agent_message ${update.messageId}: ${update.content?.map((block) => (block.type === "text" ? block.text : "")).join("")}`;
      default:
        return update.sessionUpdate;
    }
  });

describe("fx sub-agent hooks", () => {
  it("shows a child's steps and takes its reply whole from the root call's hooks", () => {
    const run = play([
      { acp: announce },
      { hook: hook(ROOT, "tool.start", { call: call(CALL, "subagent") }) },
      { acp: subagentUpdate({ status: "in_progress" }) },
      { hook: delegation("dispatched") },
      { hook: hook(CHILD, "model.start", { modelCallId: 1, purpose: "agent", messages: [] }) },
      {
        hook: hook(CHILD, "model.end", {
          modelCallId: 1,
          output: "Reading package.json.",
          toolCalls: [call("call_read", "read_file")],
        }),
      },
      {
        hook: hook(CHILD, "tool.start", {
          call: call("call_read", "read_file", '{"path":"package.json"}'),
        }),
      },
      {
        hook: hook(CHILD, "tool.end", {
          call: call("call_read", "read_file"),
          output: '{"name":"fx-replay"}',
          status: "success",
        }),
      },
      {
        hook: hook(CHILD, "tool.result", {
          call: call("call_read", "read_file"),
          output: '{"name":"fx-replay"}',
          status: "success",
        }),
      },
      { hook: hook(CHILD, "model.start", { modelCallId: 2, purpose: "permission_review" }) },
      { hook: hook(CHILD, "model.end", { modelCallId: 2, output: "allow", toolCalls: [{}] }) },
      { hook: hook(CHILD, "model.start", { modelCallId: 3, purpose: "agent" }) },
      { hook: hook(CHILD, "model.end", { modelCallId: 3, output: REPLY, toolCalls: [] }) },
      { hook: delegation("completed") },
      { acp: preview("completed") },
      { hook: rootResult(WHOLE_RESULT, false, "tool.end") },
      // A parallel batch reports this only once its slowest call ends.
      { hook: rootResult(WHOLE_RESULT) },
      // A child step after its call settled has no turn to land in.
      { hook: hook(CHILD, "tool.start", { call: call("call_late", "shell") }) },
    ]);

    assert.deepEqual(childSteps(run.delivered), [
      "agent_message exec-child:1: Reading package.json.",
      "tool_call call_read in_progress",
      "tool_call_update call_read completed",
      "tool_call_update call_read completed",
      `agent_message result: ${REPLY}`,
    ]);
    const read = run.delivered[1]?.update;
    assert.deepInclude(read, { kind: "read", rawInput: { path: "package.json" } });
    // fx completes the ACP call before it reports the whole result.
    assert.deepEqual(run.statuses, [
      "running",
      "running",
      "running",
      "running",
      "running",
      "completed",
    ]);
    assert.deepInclude(run.update, {
      nativeTaskId: CALL,
      childSessionId: CHILD,
      prompt: TASK,
      status: "completed",
      result: REPLY,
    });
  });

  it("settles a hooked call from its delegation phase and whole result", () => {
    const settle = (
      phase: string,
      ending: ReadonlyArray<{ readonly acp: EffectAcpSchema.SessionNotification }>,
      result?: ReturnType<typeof rootResult>,
    ) => {
      const run = play([
        { acp: announce },
        { hook: delegation("dispatched") },
        { hook: delegation(phase) },
        ...ending,
        ...(result === undefined ? [] : [{ hook: result }]),
      ]);
      return { status: run.update?.status, result: run.update?.result, steps: run.delivered };
    };
    const failure = JSON.stringify({ ok: false, result: "No package.json", error_code: null });

    const truncated = settle(
      "completed",
      [{ acp: preview("completed") }],
      rootResult(WHOLE_RESULT.slice(0, 300), true),
    );
    assert.equal(truncated.status, "completed");
    assert.match(
      truncated.result ?? "",
      /^The package is fx-replay\.\nScripts: [^"]+…\n\n\[fx truncated this reply at 64 KiB\]$/,
    );
    assert.deepInclude(
      settle("failed", [{ acp: preview("completed", failure) }], rootResult(failure)),
      { status: "failed", result: "No package.json" },
    );
    const yielded = JSON.stringify({ ok: true, result: "Still running.", pending: true });
    const pending = settle(
      "yielded",
      [{ acp: preview("completed", yielded) }],
      rootResult(yielded),
    );
    assert.deepInclude(pending, { status: "idle", result: "Still running." });
    assert.lengthOf(pending.steps, 0, "a yielded child has not replied yet");
    assert.deepInclude(settle("cancelled", [{ acp: preview("failed", "cancelled") }]), {
      status: "cancelled",
      result: "cancelled",
    });
  });

  it("ignores hooks for calls fx never announced over ACP and for sessions it never dispatched", () => {
    const router = makeFxSubagentHookRouter();
    assert.deepEqual(router.route(delegation("dispatched")), []);
    assert.deepEqual(
      router.route(hook("fx-session-09", "tool.start", { call: call("c", "shell") })),
      [],
    );
    assert.deepEqual(
      router.route(hook(ROOT, "model.end", { modelCallId: 1, output: "hi", toolCalls: [] })),
      [],
    );
  });
});
