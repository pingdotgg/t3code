import { describe, expect, it } from "@effect/vitest";
import type * as AcpSchema from "effect-acp/compat";
import {
  DEEPSEEK_SUBAGENT_META,
  deepseekSubagentIdFromOutput,
  extractDeepseekSubagentSessionEvent,
  extractDeepseekSubagentUpdate,
  isDeepseekAcpAgent,
} from "./deepseekAcp.ts";

const notification = (update: Record<string, unknown>, sessionId = "child-1") =>
  ({ sessionId, update }) as unknown as AcpSchema.SessionNotification;

describe("DeepSeek Harness ACP subagents", () => {
  it("detects registry and local dsh agents", () => {
    expect(isDeepseekAcpAgent("deepseek-harness", "/usr/bin/dsh")).toBe(true);
    expect(isDeepseekAcpAgent("", "/home/me/.local/bin/dsh")).toBe(true);
    expect(isDeepseekAcpAgent("", "C:\\tools\\dsh.cmd")).toBe(true);
    expect(isDeepseekAcpAgent("claude-acp", "/usr/bin/claude-agent-acp")).toBe(false);
    expect(isDeepseekAcpAgent("", "/usr/bin/codex")).toBe(false);
  });

  it("publishes the delegation prompt before the first state frame", () => {
    const event = extractDeepseekSubagentSessionEvent(
      notification({
        sessionUpdate: "state_update",
        state: "running",
        _meta: {
          [DEEPSEEK_SUBAGENT_META]: {
            parentSessionId: "root",
            runId: "run-1",
            phase: "delegated",
            prompt: "Investigate the failure",
            title: "Investigate",
          },
        },
      }),
    );
    expect(event).toEqual({
      type: "delegation",
      childSessionId: "child-1",
      parentSessionId: "root",
      delegationId: "run-1",
      prompt: "Investigate the failure",
    });
  });

  it("maps running and terminal child states", () => {
    const frame = (update: Record<string, unknown>) =>
      notification({
        sessionUpdate: "state_update",
        ...update,
        _meta: {
          [DEEPSEEK_SUBAGENT_META]: { parentSessionId: "root", runId: "run-1" },
        },
      });
    expect(extractDeepseekSubagentSessionEvent(frame({ state: "running" }))).toMatchObject({
      type: "state",
      childSessionId: "child-1",
      status: "running",
    });
    expect(extractDeepseekSubagentSessionEvent(frame({ state: "idle" }))).toMatchObject({
      status: "completed",
    });
    expect(
      extractDeepseekSubagentSessionEvent(
        frame({ state: "idle", stopReason: "error", error: { message: "boom" } }),
      ),
    ).toMatchObject({ status: "failed", result: "boom" });
    expect(
      extractDeepseekSubagentSessionEvent(frame({ state: "idle", stopReason: "cancelled" })),
    ).toMatchObject({ status: "cancelled" });
  });

  it("ignores frames without DeepSeek subagent metadata", () => {
    expect(
      extractDeepseekSubagentSessionEvent(notification({ sessionUpdate: "agent_message_chunk" })),
    ).toBeUndefined();
  });
});

describe("DeepSeek Harness subagent tool calls", () => {
  const tool = (rawOutput: unknown, status = "completed") =>
    ({
      toolCallId: "call-1",
      title: "subagent",
      status,
      data: {
        name: "subagent",
        rawInput: {
          prompt: "Investigate the failure",
          description: "Investigate",
          name: "investigate",
        },
        rawOutput,
      },
    }) as never;

  it("publishes a visible subagent task from the parent tool call", () => {
    expect(extractDeepseekSubagentUpdate(tool("started subagent investigate"))).toEqual({
      nativeTaskId: "call-1",
      childSessionId: null,
      prompt: "Investigate the failure",
      title: "Investigate",
      model: null,
      status: "running",
      result: null,
    });
  });

  it("links the child session id from structured or textual tool output", () => {
    expect(deepseekSubagentIdFromOutput({ agent_id: "agent-7" })).toBe("agent-7");
    expect(deepseekSubagentIdFromOutput("started subagent investigate (agent agent-7)")).toBe(
      "agent-7",
    );
    expect(deepseekSubagentIdFromOutput("started subagent investigate")).toBeUndefined();
    // Generic ids can name a run/task and must not be treated as the child session.
    expect(deepseekSubagentIdFromOutput({ id: "run-7" })).toBeUndefined();
    expect(deepseekSubagentIdFromOutput({ session_id: "other" })).toBeUndefined();
    expect(deepseekSubagentIdFromOutput("session id: other")).toBeUndefined();
    expect(
      extractDeepseekSubagentUpdate(
        tool({ kind: "activation", name: "investigate", agent_id: "agent-7" }),
      ),
    ).toMatchObject({ childSessionId: "agent-7" });
  });

  it("marks a failed spawn failed and ignores unrelated tools", () => {
    expect(extractDeepseekSubagentUpdate(tool("spawn failed", "failed"))).toMatchObject({
      status: "failed",
      result: "spawn failed",
    });
    expect(
      extractDeepseekSubagentUpdate({
        toolCallId: "call-2",
        status: "completed",
        data: { name: "bash", rawInput: {}, rawOutput: "ok" },
      } as never),
    ).toBeUndefined();
  });
});
