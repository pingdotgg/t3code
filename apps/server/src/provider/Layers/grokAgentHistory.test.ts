import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { grokHistoryEntries, grokSubagentTask, readGrokAgentHistory } from "./grokAgentHistory.ts";

const envelope = (update: Record<string, unknown>, sessionId = "child") => ({
  method: "session/update",
  params: { sessionId, update },
});
describe("Grok saved child history", () => {
  it.effect("skips malformed update envelopes but preserves valid history", () =>
    Effect.gen(function* () {
      const result = yield* readGrokAgentHistory({
        parentSessionId: "parent",
        agentId: "child",
        cwd: "/workspace",
        offset: 0,
        request: (method) =>
          Effect.succeed(
            method.endsWith("state")
              ? { summary: { parent_session_id: "parent", session_kind: "subagent" } }
              : {
                  updates: [
                    null,
                    { method: "session/update", params: null },
                    {},
                    envelope({
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Valid answer" },
                    }),
                  ],
                },
          ),
      });
      expect(result.entries.map((entry) => entry.detail)).toEqual(["Valid answer"]);
    }),
  );
  it.effect("fails closed when the CLI omits ancestry metadata", () =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const result = yield* readGrokAgentHistory({
        parentSessionId: "parent",
        agentId: "child",
        cwd: "/workspace",
        offset: 0,
        request: (method) => {
          methods.push(method);
          return Effect.succeed({});
        },
      });
      expect(result.status).toBe("unavailable");
      expect(methods).toEqual(["_x.ai/session/state"]);
    }),
  );
  it("retains edit classification through result-only updates", () => {
    const entries = grokHistoryEntries(
      [
        envelope({
          sessionUpdate: "tool_call",
          toolCallId: "edit",
          kind: "edit",
          title: "Edit X.jsx",
        }),
        envelope({ sessionUpdate: "tool_call_update", toolCallId: "edit", rawOutput: "patch" }),
      ],
      "child",
    );
    expect(entries[0]).toMatchObject({ kind: "file-edit", title: "Edit X.jsx" });
  });
  it("folds chunks and tool results, excluding unrelated sessions", () => {
    const entries = grokHistoryEntries(
      [
        envelope({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello " },
        }),
        envelope({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world" },
        }),
        envelope({
          sessionUpdate: "tool_call",
          toolCallId: "tool",
          title: "Read file",
          rawInput: { path: "a.ts" },
        }),
        envelope({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool",
          content: [{ type: "content", content: { type: "text", text: "file contents" } }],
        }),
        envelope(
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "parent secret" },
          },
          "parent",
        ),
      ],
      "child",
    );
    expect(entries.map((entry) => [entry.kind, entry.detail])).toEqual([
      ["assistant", "Hello world"],
      ["tool", "file contents"],
    ]);
  });
  it("preserves truncation through status-only updates", () => {
    const entries = grokHistoryEntries(
      [
        envelope({
          sessionUpdate: "tool_call",
          toolCallId: "tool",
          content: [{ content: { text: "x".repeat(9000) } }],
        }),
        envelope({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" }),
      ],
      "child",
    );
    expect(entries[0]?.truncated).toBe(true);
    expect(entries[0]?.detail).toHaveLength(8000);
  });
  it.effect("verifies ancestry before reading and pages visible rows", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const updates = Array.from({ length: 52 }, (_, index) =>
        envelope({ sessionUpdate: "tool_call", toolCallId: String(index), title: `Tool ${index}` }),
      );
      const request = (method: string) => {
        calls.push(method);
        return Effect.succeed(
          method.endsWith("state")
            ? { summary: { parent_session_id: "parent", session_kind: "subagent" } }
            : { updates },
        );
      };
      const first = yield* readGrokAgentHistory({
        parentSessionId: "parent",
        agentId: "child",
        cwd: "/workspace",
        offset: 0,
        request,
      });
      expect(first.entries).toHaveLength(50);
      expect(first.nextOffset).toBe(50);
      const last = yield* readGrokAgentHistory({
        parentSessionId: "parent",
        agentId: "child",
        cwd: "/workspace",
        offset: 50,
        request,
      });
      expect(last.entries.map((entry) => entry.title)).toEqual(["Tool 50", "Tool 51"]);
      expect(last.nextOffset).toBeNull();
      expect(calls).toEqual([
        "_x.ai/session/state",
        "_x.ai/session/updates",
        "_x.ai/session/state",
        "_x.ai/session/updates",
      ]);
    }),
  );
  it.effect("does not read unrelated or cyclic child transcripts", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* readGrokAgentHistory({
        parentSessionId: "parent",
        agentId: "child",
        cwd: "/workspace",
        offset: 0,
        request: (method) => {
          calls.push(method);
          return Effect.succeed({
            summary: { parent_session_id: "child", session_kind: "subagent" },
          });
        },
      });
      expect(result.status).toBe("unavailable");
      expect(calls).toEqual(["_x.ai/session/state"]);
    }),
  );
  it("maps native child lifecycle to stable IDs without leaking other sessions", () => {
    const spawn = {
      sessionId: "parent",
      update: {
        sessionUpdate: "subagent_spawned",
        child_session_id: "child",
        parent_session_id: "parent",
        description: "Review",
      },
    };
    expect(grokSubagentTask(spawn, "parent")).toMatchObject({
      type: "task.started",
      payload: { taskId: "child", agentId: "child", description: "Review" },
    });
    expect(grokSubagentTask(spawn, "unrelated")).toBeUndefined();
    expect(
      grokSubagentTask(
        {
          sessionId: "parent",
          update: {
            sessionUpdate: "subagent_finished",
            child_session_id: "child",
            status: "cancelled",
          },
        },
        "parent",
      ),
    ).toMatchObject({ type: "task.completed", payload: { taskId: "child", status: "stopped" } });
  });
});
