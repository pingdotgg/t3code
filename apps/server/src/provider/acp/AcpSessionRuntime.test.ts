import { Effect, Queue, Ref } from "effect";
import { describe, expect, it } from "vitest";

import type * as EffectAcpSchema from "effect-acp/schema";

import type {
  AcpParsedSessionEvent,
  AcpSessionModeState,
  AcpToolCallState,
} from "./AcpRuntimeModel.ts";
import { type AcpAssistantSegmentState, handleSessionUpdate } from "./AcpSessionRuntime.ts";

const textChunk = (text: string): EffectAcpSchema.SessionNotification => ({
  sessionId: "session-1",
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  },
});

const toolCallStart = (): EffectAcpSchema.SessionNotification => ({
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Terminal",
    kind: "execute",
    status: "pending",
    rawInput: { executable: "bun", args: ["run", "typecheck"] },
  },
});

const toolCallProgress = (detail: string): EffectAcpSchema.SessionNotification => ({
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: detail } }],
  },
});

const drainNotifications = (notifications: ReadonlyArray<EffectAcpSchema.SessionNotification>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    for (const params of notifications) {
      yield* handleSessionUpdate({
        queue,
        modeStateRef,
        toolCallsRef,
        assistantSegmentRef,
        params,
      });
    }
    return yield* Queue.takeAll(queue).pipe(Effect.map((chunk) => Array.from(chunk)));
  });

describe("AcpSessionRuntime handleSessionUpdate", () => {
  it("keeps streamed assistant text in one segment across in-flight tool-call updates", () =>
    Effect.gen(function* () {
      const events = yield* drainNotifications([
        toolCallStart(),
        textChunk("A "),
        toolCallProgress("still running"),
        textChunk("key "),
        toolCallProgress("still running more"),
        textChunk("discovery"),
      ]);

      const started = events.filter((event) => event._tag === "AssistantItemStarted");
      const completed = events.filter((event) => event._tag === "AssistantItemCompleted");
      const deltas = events.filter(
        (event) => event._tag === "ContentDelta" && event.streamKind === "assistant_text",
      );

      expect(started).toHaveLength(1);
      expect(completed).toHaveLength(0);
      const itemIds = new Set(
        deltas.map((event) => (event._tag === "ContentDelta" ? event.itemId : undefined)),
      );
      expect(itemIds.size).toBe(1);
    }).pipe(Effect.runPromise));

  it("closes the assistant segment when a meaningful new tool call is surfaced", () =>
    Effect.gen(function* () {
      const events = yield* drainNotifications([
        textChunk("Let me look"),
        toolCallStart(),
        textChunk("Found it"),
      ]);

      const started = events.filter((event) => event._tag === "AssistantItemStarted");
      const completed = events.filter((event) => event._tag === "AssistantItemCompleted");
      expect(started).toHaveLength(2);
      expect(completed).toHaveLength(1);
    }).pipe(Effect.runPromise));

  it("closes the assistant segment when the initial tool call update is suppressed", () =>
    Effect.gen(function* () {
      const events = yield* drainNotifications([
        textChunk("Let me look"),
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Terminal",
            kind: "execute",
            status: "pending",
          },
        },
        toolCallProgress("running"),
        textChunk("Found it"),
      ]);

      const started = events.filter((event) => event._tag === "AssistantItemStarted");
      const completed = events.filter((event) => event._tag === "AssistantItemCompleted");
      expect(started).toHaveLength(2);
      expect(completed).toHaveLength(1);
    }).pipe(Effect.runPromise));
});
