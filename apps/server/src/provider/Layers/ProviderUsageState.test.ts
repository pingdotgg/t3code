import { describe, expect, it } from "vitest";
import { Effect, Layer, PubSub, Stream } from "effect";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import { ProviderUsageState } from "../Services/ProviderUsageState.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderUsageStateLive } from "./ProviderUsageState.ts";

function makeProviderServiceStub() {
  const pubsub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  return {
    pubsub,
    layer: Layer.succeed(ProviderService, {
      startSession: () => Effect.die("unused"),
      sendTurn: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: () => Effect.die("unused"),
      stopSession: () => Effect.die("unused"),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.die("unused"),
      rollbackConversation: () => Effect.die("unused"),
      streamEvents: Stream.fromPubSub(pubsub),
    }),
  };
}

describe("ProviderUsageStateLive", () => {
  it("sets, gets, and clears usage by provider", async () => {
    const stub = makeProviderServiceStub();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* usageState.set("cursor", {
          source: "cursorAcp",
          available: true,
          checkedAt: "2026-04-18T00:00:00.000Z",
          windows: [{ kind: "session", label: "Session", usedPercent: 25 }],
        });
        const first = yield* usageState.get("cursor");
        yield* usageState.clear("cursor");
        const second = yield* usageState.get("cursor");

        return { first, second };
      }).pipe(Effect.provide(ProviderUsageStateLive.pipe(Layer.provide(stub.layer)))),
    );

    expect(result.first?.windows).toEqual([{ kind: "session", label: "Session", usedPercent: 25 }]);
    expect(result.second).toBeUndefined();
  });

  it("ingests real Cursor token usage events and isolates providers", async () => {
    const stub = makeProviderServiceStub();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(stub.pubsub, {
          type: "thread.token-usage.updated",
          eventId: "evt-1" as never,
          provider: "cursor",
          threadId: "thread-1" as never,
          createdAt: "2026-04-18T00:00:00.000Z",
          payload: {
            usage: {
              usedTokens: 50,
              maxTokens: 100,
            },
          },
        });

        yield* Effect.sleep("10 millis");

        return {
          cursor: yield* usageState.get("cursor"),
          opencode: yield* usageState.get("opencode"),
        };
      }).pipe(Effect.provide(ProviderUsageStateLive.pipe(Layer.provide(stub.layer)))),
    );

    expect(state.cursor?.windows).toEqual([{ kind: "session", label: "Session", usedPercent: 50 }]);
    expect(state.opencode).toBeUndefined();
  });
});
