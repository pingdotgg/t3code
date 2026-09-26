import { EventId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeTestProviderAdapterHarness } from "./TestProviderAdapter.integration.ts";

it.effect("keeps progress deltas out of the synthetic assistant answer", () =>
  Effect.gen(function* () {
    const harness = yield* makeTestProviderAdapterHarness();
    const threadId = ThreadId.make("thread-progress-fixture");
    yield* harness.adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      runtimeMode: "full-access",
      cwd: "/repo",
    });
    const eventBase = {
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: String(threadId),
      type: "content.delta",
    } as const;
    yield* harness.queueTurnResponse(threadId, {
      events: [
        {
          ...eventBase,
          eventId: EventId.make("progress-delta"),
          payload: { streamKind: "assistant_progress_text", delta: "Thinking aloud. " },
        },
        {
          ...eventBase,
          eventId: EventId.make("answer-delta"),
          payload: { streamKind: "assistant_text", delta: "Final answer." },
        },
      ],
    });
    yield* harness.adapter.sendTurn({ threadId, input: "Prompt", attachments: [] });
    const snapshot = yield* harness.adapter.readThread(threadId);
    assert.deepStrictEqual(snapshot.turns[0]?.items, [
      { type: "userMessage", content: [{ type: "text", text: "Prompt" }] },
      { type: "agentMessage", text: "Final answer." },
    ]);
  }),
);
