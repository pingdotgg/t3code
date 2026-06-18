import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/schema";

import { handleSessionUpdateForTest } from "./AcpSessionRuntime.ts";
import type {
  AcpParsedSessionEvent,
  AcpSessionModeState,
  AcpToolCallState,
} from "./AcpRuntimeModel.ts";

it.effect("suppresses loaded-session replay updates until the first live prompt", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>({
      currentModeId: "ask",
      availableModes: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code" },
      ],
    });
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make({ nextSegmentIndex: 0 });
    const suppressSessionUpdatesRef = yield* Ref.make(true);

    const handle = (params: EffectAcpSchema.SessionNotification) =>
      handleSessionUpdateForTest({
        queue,
        modeStateRef,
        toolCallsRef,
        assistantSegmentRef,
        suppressSessionUpdatesRef,
        params,
      });

    yield* handle({
      sessionId: "cursor-session",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "code",
      },
    });
    yield* handle({
      sessionId: "cursor-session",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Old replayed plan", priority: "high", status: "completed" }],
      },
    });
    yield* handle({
      sessionId: "cursor-session",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "old replayed user prompt" },
      },
    });
    yield* handle({
      sessionId: "cursor-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "old replayed assistant text" },
      },
    });

    assert.equal(yield* Queue.size(queue), 0);
    assert.equal((yield* Ref.get(modeStateRef))?.currentModeId, "code");

    yield* Ref.set(suppressSessionUpdatesRef, false);
    yield* handle({
      sessionId: "cursor-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "new assistant text" },
      },
    });

    const started = yield* Queue.take(queue);
    const delta = yield* Queue.take(queue);
    assert.equal(started._tag, "AssistantItemStarted");
    assert.equal(delta._tag, "ContentDelta");
    if (delta._tag === "ContentDelta") {
      assert.equal(delta.text, "new assistant text");
    }
    assert.equal(yield* Queue.size(queue), 0);
  }),
);
