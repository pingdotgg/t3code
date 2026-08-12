import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decodePiEvent, projectPiEvent, projectPiExtensionUiRequest } from "./PiRpcProtocol.ts";
import { PiRpcProtocolError } from "./PiRpcTransport.ts";

const usage = {
  input: 100,
  output: 20,
  cacheRead: 40,
  cacheWrite: 5,
  reasoning: 8,
  totalTokens: 125,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

const assistantMessage = (stopReason: "stop" | "error" | "aborted" = "stop") => ({
  role: "assistant",
  provider: "openai-codex",
  model: "gpt-5.4",
  usage,
  stopReason,
  ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
  timestamp: 1_765_000_000_000,
});

const decodeKnown = (record: Record<string, unknown>) =>
  Effect.gen(function* () {
    const decoded = yield* decodePiEvent(record);
    expect(decoded._tag).toBe("known");
    if (decoded._tag !== "known") return yield* Effect.die("expected known event");
    return decoded.event;
  });

describe("decodePiEvent", () => {
  it.effect("accepts current max thinking and preserves unknown future events", () =>
    Effect.gen(function* () {
      const thinking = yield* decodePiEvent({ type: "thinking_level_changed", level: "max" });
      expect(thinking).toMatchObject({ _tag: "known", event: { level: "max" } });

      const future = yield* decodePiEvent({ type: "provider_telemetry_v2", detail: "new" });
      expect(future).toEqual({
        _tag: "unknown",
        event: { type: "provider_telemetry_v2", detail: "new" },
      });
    }),
  );

  it.effect("fails closed when a known event violates Pi's contract", () =>
    Effect.gen(function* () {
      const error = yield* decodePiEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        isError: "no",
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(PiRpcProtocolError);
      expect(error.detail).toBe("invalid tool_execution_end event");
    }),
  );
});

describe("projectPiEvent", () => {
  it.effect("projects assistant and reasoning deltas by content index", () =>
    Effect.gen(function* () {
      const text = yield* decodeKnown({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
      });
      const thought = yield* decodeKnown({
        type: "message_update",
        message: assistantMessage(),
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" },
      });

      expect(projectPiEvent(text)).toEqual([
        { type: "assistant.delta", contentIndex: 0, delta: "hello" },
      ]);
      expect(projectPiEvent(thought)).toEqual([
        { type: "reasoning.delta", contentIndex: 1, delta: "hmm" },
      ]);
    }),
  );

  it.effect("projects tool lifecycle without interpreting provider-specific payloads", () =>
    Effect.gen(function* () {
      const started = yield* decodeKnown({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "git status" },
      });
      const updated = yield* decodeKnown({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "git status" },
        partialResult: { content: [{ type: "text", text: "M file" }] },
      });
      const completed = yield* decodeKnown({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "clean" }] },
        isError: false,
      });

      expect(projectPiEvent(started)[0]).toMatchObject({
        type: "tool.started",
        toolCallId: "call-1",
        args: { command: "git status" },
      });
      expect(projectPiEvent(updated)[0]).toMatchObject({
        type: "tool.updated",
        partialResult: { content: [{ text: "M file" }] },
      });
      expect(projectPiEvent(completed)[0]).toMatchObject({
        type: "tool.completed",
        result: { content: [{ text: "clean" }] },
        isError: false,
      });
    }),
  );

  it.effect("accounts usage at message end and terminals only after retry is exhausted", () =>
    Effect.gen(function* () {
      const messageEnd = yield* decodeKnown({ type: "message_end", message: assistantMessage() });
      const retrying = yield* decodeKnown({
        type: "agent_end",
        messages: [assistantMessage("error")],
        willRetry: true,
      });
      const failed = yield* decodeKnown({
        type: "agent_end",
        messages: [assistantMessage("error")],
        willRetry: false,
      });
      const aborted = yield* decodeKnown({
        type: "agent_end",
        messages: [assistantMessage("aborted")],
        willRetry: false,
      });
      const settled = yield* decodeKnown({ type: "agent_settled" });

      expect(projectPiEvent(messageEnd)).toEqual([
        {
          type: "message.completed",
          provider: "openai-codex",
          model: "gpt-5.4",
          stopReason: "stop",
          usage,
        },
      ]);
      expect(projectPiEvent(retrying)).toEqual([{ type: "run.retrying" }]);
      expect(projectPiEvent(failed)).toEqual([
        { type: "run.finished", status: "failed", errorMessage: "provider failed" },
      ]);
      expect(projectPiEvent(aborted)).toEqual([{ type: "run.finished", status: "interrupted" }]);
      expect(projectPiEvent(settled)).toEqual([{ type: "run.settled" }]);
    }),
  );

  it.effect("projects queue, compaction, and retry state", () =>
    Effect.gen(function* () {
      const queue = yield* decodeKnown({
        type: "queue_update",
        steering: ["stop and inspect"],
        followUp: ["then test"],
      });
      const compaction = yield* decodeKnown({
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        willRetry: false,
        errorMessage: "summary failed",
      });
      const retry = yield* decodeKnown({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1_000,
        errorMessage: "rate limited",
      });

      expect(projectPiEvent(queue)).toEqual([
        { type: "queue.updated", steering: ["stop and inspect"], followUp: ["then test"] },
      ]);
      expect(projectPiEvent(compaction)).toEqual([
        {
          type: "compaction.updated",
          status: "failed",
          reason: "overflow",
          errorMessage: "summary failed",
        },
      ]);
      expect(projectPiEvent(retry)).toEqual([
        {
          type: "run.retrying",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 1_000,
          errorMessage: "rate limited",
        },
      ]);
    }),
  );
});

describe("projectPiExtensionUiRequest", () => {
  it("maps blocking extension UI methods and ignores display-only methods", () => {
    expect(
      projectPiExtensionUiRequest({
        type: "extension_ui_request",
        id: "editor-1",
        method: "editor",
        title: "Edit instructions",
        prefill: "draft",
        timeout: 15_000,
      }),
    ).toEqual({
      type: "user-input",
      requestId: "editor-1",
      method: "editor",
      title: "Edit instructions",
      prefill: "draft",
      timeoutMs: 15_000,
    });
    expect(
      projectPiExtensionUiRequest({
        type: "extension_ui_request",
        id: "approval-1",
        method: "confirm",
        title: "Run command?",
        message: "rm generated.tmp",
        timeout: 30_000,
      }),
    ).toEqual({
      type: "approval",
      requestId: "approval-1",
      title: "Run command?",
      message: "rm generated.tmp",
      timeoutMs: 30_000,
    });
    expect(
      projectPiExtensionUiRequest({
        type: "extension_ui_request",
        id: "select-1",
        method: "select",
        title: "Choose environment",
        options: ["dev", "prod"],
      }),
    ).toEqual({
      type: "user-input",
      requestId: "select-1",
      method: "select",
      title: "Choose environment",
      options: ["dev", "prod"],
    });
    expect(
      projectPiExtensionUiRequest({
        type: "extension_ui_request",
        id: "notice-1",
        method: "notify",
        message: "done",
      }),
    ).toBeUndefined();
  });
});
