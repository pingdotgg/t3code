/**
 * Integration test for AugmentAdapter against actual Auggie CLI.
 *
 * Run with: bun run vitest run src/provider/Layers/AugmentAdapter.integration.test.ts
 *
 * Prerequisites:
 * - Auggie CLI installed and available on PATH
 * - Auggie authenticated (run `auggie login` first)
 */

import { describe, it, expect } from "vitest";
import { Effect, Layer, Stream } from "effect";
import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AugmentAdapter } from "../Services/AugmentAdapter.ts";
import { makeAugmentAdapterLive } from "./AugmentAdapter.ts";
import { ServerConfig } from "../../config.ts";

// Use the test layer helper from ServerConfig
const TestServerConfig = ServerConfig.layerTest(process.cwd(), "/tmp/t3code-test").pipe(
  Layer.provide(NodeServices.layer),
);

describe("AugmentAdapter Integration", () => {
  const testLayer = makeAugmentAdapterLive().pipe(Layer.provide(TestServerConfig));

  it("should start a session and send a turn with streaming events", async () => {
    const threadId = ThreadId.makeUnsafe("adapter-test-1");

    const program = Effect.gen(function* () {
      const adapter = yield* AugmentAdapter;

      // Start session
      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: process.cwd(),
      });

      expect(session.provider).toBe("augment");
      expect(session.status).toBe("ready");
      expect(session.threadId).toBe(threadId);

      // Collect events in background
      const events: unknown[] = [];
      const collectEvents = adapter.streamEvents.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            events.push(event);
            console.log("Event:", event.type);
          }),
        ),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runDrain,
      );

      // Send turn
      const turnResult = yield* adapter.sendTurn({
        threadId,
        input: "What is 2+2? Reply with just the number.",
      });

      expect(turnResult.threadId).toBe(threadId);
      expect(turnResult.turnId).toBeDefined();

      // Wait for events to complete
      yield* collectEvents;

      console.log("Total events:", events.length);
      console.log(
        "Event types:",
        [...new Set(events.map((e: unknown) => (e as { type: string }).type))].join(", "),
      );

      // Verify we got streaming content
      const contentDeltas = events.filter(
        (e: unknown) => (e as { type: string }).type === "content.delta",
      );
      expect(contentDeltas.length).toBeGreaterThan(0);

      // Stop session
      yield* adapter.stopSession(threadId);

      return { session, turnResult, events };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    expect(result.session.status).toBe("ready");
  }, 60_000);

  it("should handle session lifecycle correctly", async () => {
    const threadId = ThreadId.makeUnsafe("adapter-test-2");

    const program = Effect.gen(function* () {
      const adapter = yield* AugmentAdapter;

      // Start session
      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: process.cwd(),
      });

      expect(session.status).toBe("ready");

      // Check session exists
      const hasSession = yield* adapter.hasSession(threadId);
      expect(hasSession).toBe(true);

      // List sessions
      const sessions = yield* adapter.listSessions();
      expect(sessions.some((s) => s.threadId === threadId)).toBe(true);

      // Stop session
      yield* adapter.stopSession(threadId);

      // Check session is gone
      const hasSessionAfter = yield* adapter.hasSession(threadId);
      expect(hasSessionAfter).toBe(false);

      return { session };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    expect(result.session.provider).toBe("augment");
  }, 30_000);

  it("should interrupt a turn", async () => {
    const threadId = ThreadId.makeUnsafe("adapter-test-3");

    const program = Effect.gen(function* () {
      const adapter = yield* AugmentAdapter;

      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: process.cwd(),
      });

      // Start a long turn
      const turnResultEffect = adapter.sendTurn({
        threadId,
        input: "Write a very long essay about computing history. Make it at least 2000 words.",
      });

      const turnResult = yield* turnResultEffect;

      // Wait a bit then interrupt
      yield* Effect.sleep("1 second");
      yield* adapter.interruptTurn(threadId, turnResult.turnId);

      yield* adapter.stopSession(threadId);

      return { turnResult };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    expect(result.turnResult.turnId).toBeDefined();
  }, 30_000);
});

