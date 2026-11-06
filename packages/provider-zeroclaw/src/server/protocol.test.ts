import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  decodeAgentsListResult,
  decodeInitializeResult,
  decodeSessionMessagesResult,
  decodeSessionNewResult,
  decodeSessionPromptResult,
  decodeSessionStateResult,
  decodeSessionUpdate,
  decodeStatusResult,
} from "./protocol.ts";

// Fixtures mirror the daemon's serde output (zeroclaw-runtime/src/rpc/types.rs),
// which is snake_case on the wire.
describe("ZeroClaw protocol decoders", () => {
  it.effect("decodes initialize, status, and agents/list", () =>
    Effect.gen(function* () {
      expect(
        yield* decodeInitializeResult({
          protocol_version: 1,
          server_version: "0.8.7",
          server_pid: 42,
          commands: [],
        }),
      ).toEqual({ protocolVersion: 1, serverVersion: "0.8.7" });
      expect(
        yield* decodeStatusResult({
          server_version: "0.8.7",
          protocol_version: 1,
          active_sessions: 0,
          session_ids: [],
        }),
      ).toEqual({ version: "0.8.7" });
      expect(
        yield* decodeAgentsListResult({
          agents: [{ alias: "coder", enabled: true, channels: [] }],
        }),
      ).toEqual({ agents: [{ alias: "coder", enabled: true }] });
    }),
  );

  it.effect("decodes session results", () =>
    Effect.gen(function* () {
      expect(
        yield* decodeSessionNewResult({
          session_id: "s1",
          agent_alias: "coder",
          message_count: 0,
          workspace_dir: "/w",
        }),
      ).toEqual({ sessionId: "s1", agentAlias: "coder" });
      expect(
        yield* decodeSessionPromptResult({
          session_id: "s1",
          stop_reason: "end_turn",
          content: "done",
        }),
      ).toEqual({ sessionId: "s1", stopReason: "end_turn", content: "done" });
      expect(yield* decodeSessionStateResult({ session_id: "s1", state: "idle" })).toEqual({
        sessionId: "s1",
        state: "idle",
      });
      expect(
        yield* decodeSessionMessagesResult({
          session_id: "s1",
          messages: [{ role: "user", content: "hi", kind: "message" }],
          total: 1,
          start: 0,
        }),
      ).toEqual({ messages: [{ role: "user", content: "hi", kind: "message" }] });
    }),
  );

  it.effect("rejects a session/new result without session_id", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeSessionNewResult({ agent_alias: "coder" }));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("decodes each session/update type the adapter projects", () =>
    Effect.gen(function* () {
      expect(
        yield* decodeSessionUpdate({
          type: "agent_message_chunk",
          session_id: "s1",
          text: "hello",
        }),
      ).toEqual({ type: "agent_message_chunk", sessionId: "s1", text: "hello" });
      expect(
        yield* decodeSessionUpdate({ type: "agent_thought_chunk", session_id: "s1", text: "hmm" }),
      ).toMatchObject({ type: "agent_thought_chunk", text: "hmm" });
      expect(
        yield* decodeSessionUpdate({
          type: "tool_call",
          session_id: "s1",
          tool_call_id: "c1",
          name: "shell",
          raw_input: { command: "ls" },
        }),
      ).toEqual({
        type: "tool_call",
        sessionId: "s1",
        toolCallId: "c1",
        name: "shell",
        input: { command: "ls" },
      });
      expect(
        yield* decodeSessionUpdate({
          type: "tool_result",
          session_id: "s1",
          tool_call_id: "c1",
          name: "shell",
          raw_output: "ok",
        }),
      ).toEqual({
        type: "tool_result",
        sessionId: "s1",
        toolCallId: "c1",
        name: "shell",
        output: "ok",
      });
      expect(
        yield* decodeSessionUpdate({
          type: "approval_request",
          session_id: "s1",
          request_id: "r1",
          tool_name: "shell",
          arguments_summary: "ls",
          timeout_secs: 30,
        }),
      ).toEqual({
        type: "approval_request",
        sessionId: "s1",
        requestId: "r1",
        toolName: "shell",
        argumentsSummary: "ls",
        timeoutSecs: 30,
      });
      expect(
        yield* decodeSessionUpdate({
          type: "plan",
          session_id: "s1",
          entries: [
            { content: "step", status: "in_progress", priority: "high", activeForm: "Stepping" },
          ],
        }),
      ).toEqual({
        type: "plan",
        sessionId: "s1",
        items: [{ content: "step", status: "in_progress" }],
      });
      expect(
        yield* decodeSessionUpdate({
          type: "context_usage",
          session_id: "s1",
          input_tokens: 10,
          input_tokens_source: "provider",
          max_context_tokens: 100,
          model_context_window: 200,
        }),
      ).toEqual({ type: "context_usage", sessionId: "s1", usedTokens: 10, maxTokens: 100 });
      expect(
        yield* decodeSessionUpdate({
          type: "history_trimmed",
          session_id: "s1",
          dropped_messages: 4,
          dropped_turns: 2,
          kept_turns: 3,
          reason: "token_budget",
        }),
      ).toMatchObject({ type: "history_trimmed", reason: "token_budget", droppedMessages: 4 });
      expect(
        yield* decodeSessionUpdate({
          type: "budget_warning",
          session_id: "s1",
          current_usd: 4.5,
          limit_usd: 5,
          period: "daily",
        }),
      ).toMatchObject({ type: "budget_warning", currentUsd: 4.5, limitUsd: 5 });
      expect(
        yield* decodeSessionUpdate({
          type: "turn_complete",
          session_id: "s1",
          outcome: "cancelled",
          content: "partial",
          message_count: 4,
        }),
      ).toEqual({
        type: "turn_complete",
        sessionId: "s1",
        outcome: "cancelled",
        content: "partial",
      });
    }),
  );

  it.effect("decodes an unknown session/update type instead of failing", () =>
    Effect.gen(function* () {
      expect(
        yield* decodeSessionUpdate({ type: "future_event", session_id: "s1", extra: 1 }),
      ).toEqual({
        type: "future_event",
        sessionId: "s1",
      });
    }),
  );

  it.effect("rejects a turn_complete with an unknown outcome", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeSessionUpdate({ type: "turn_complete", session_id: "s1", outcome: "nope" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
