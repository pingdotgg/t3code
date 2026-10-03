import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderRuntimeLiveness } from "../Services/ProviderRuntimeLiveness.ts";
import { ProviderRuntimeLivenessLive } from "./ProviderRuntimeLiveness.ts";

const threadId = ThreadId.make("thread-liveness");
const otherThreadId = ThreadId.make("thread-liveness-other");
const turnId = TurnId.make("turn-liveness");

const runtimeEvent = (
  overrides: Partial<ProviderRuntimeEvent> & Pick<ProviderRuntimeEvent, "type">,
): ProviderRuntimeEvent =>
  ({
    eventId: EventId.make(`evt-${overrides.type}-${Math.random().toString(36).slice(2)}`),
    provider: ProviderDriverKind.make("opencode"),
    threadId,
    createdAt: new Date().toISOString(),
    ...overrides,
  }) as ProviderRuntimeEvent;

const withLiveness = <A, E>(
  use: (liveness: ProviderRuntimeLiveness["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const liveness = yield* Effect.provide(
        Effect.service(ProviderRuntimeLiveness),
        ProviderRuntimeLivenessLive,
      );
      return yield* use(liveness);
    }),
  ) as Promise<A>;

describe("ProviderRuntimeLivenessLive", () => {
  it("reports no observation before any event", async () => {
    const observation = await withLiveness((liveness) => liveness.observe(threadId));
    expect(observation).toBeNull();
  });

  it("records turn ids the provider reported a terminal outcome for", async () => {
    const settled = await withLiveness((liveness) =>
      Effect.gen(function* () {
        yield* liveness.record(
          runtimeEvent({ type: "turn.completed", turnId, payload: { state: "completed" } }),
        );
        yield* liveness.record(
          runtimeEvent({
            type: "turn.aborted",
            turnId: TurnId.make("turn-liveness-aborted"),
            payload: { reason: "interrupted" },
          }),
        );
        return yield* liveness.observe(threadId);
      }),
    );

    expect(new Set(settled?.settledTurns.keys())).toEqual(
      new Set([turnId, TurnId.make("turn-liveness-aborted")]),
    );
  });

  it("settles the last announced turn when a terminal event omits turnId", async () => {
    // Real: `ClaudeAdapter.completeTurn` emits a turnId-less `turn.completed`
    // whenever `context.turnState` is unset, and Codex's `readRouteFields`
    // returns `turnId: undefined` from its default branch for unlisted methods.
    // Trusting `event.turnId` alone would leave these turns unrecorded, so the
    // reaper would interrupt a turn that finished cleanly.
    const settled = await withLiveness((liveness) =>
      Effect.gen(function* () {
        yield* liveness.record(runtimeEvent({ type: "turn.started", turnId, payload: {} }));
        yield* liveness.record(
          runtimeEvent({ type: "turn.completed", payload: { state: "completed" } }),
        );
        return yield* liveness.observe(threadId);
      }),
    );

    expect(settled?.settledTurns.has(turnId)).toBe(true);
  });

  it("settles nothing for a turnId-less terminal event with no announced turn", async () => {
    // Without a `turn.started` there is no turn to attribute the outcome to;
    // recording a guess would risk holding a genuinely lost session forever.
    const settled = await withLiveness((liveness) =>
      Effect.gen(function* () {
        yield* liveness.record(
          runtimeEvent({ type: "turn.completed", payload: { state: "completed" } }),
        );
        return yield* liveness.observe(threadId);
      }),
    );

    expect(settled?.settledTurns.size).toBe(0);
  });

  it("prefers the event's own turnId over the last announced turn", async () => {
    const otherTurnId = TurnId.make("turn-liveness-other-terminal");
    const settled = await withLiveness((liveness) =>
      Effect.gen(function* () {
        yield* liveness.record(runtimeEvent({ type: "turn.started", turnId, payload: {} }));
        yield* liveness.record(
          runtimeEvent({
            type: "turn.completed",
            turnId: otherTurnId,
            payload: { state: "completed" },
          }),
        );
        return yield* liveness.observe(threadId);
      }),
    );

    expect(settled?.settledTurns.has(otherTurnId)).toBe(true);
    expect(settled?.settledTurns.has(turnId)).toBe(false);
  });

  it("does not settle a turn from non-terminal events", async () => {
    const observation = await withLiveness((liveness) =>
      Effect.gen(function* () {
        yield* liveness.record(
          runtimeEvent({
            type: "item.updated",
            turnId,
            payload: { itemType: "command_execution" },
          }),
        );
        return yield* liveness.observe(threadId);
      }),
    );

    expect(observation?.settledTurns.size).toBe(0);
  });

  it("keeps observations scoped per thread", async () => {
    const [observed, otherObserved] = await withLiveness((liveness) =>
      Effect.gen(function* () {
        yield* liveness.record(
          runtimeEvent({ type: "turn.completed", turnId, payload: { state: "completed" } }),
        );
        yield* liveness.record(
          runtimeEvent({
            type: "item.started",
            turnId: TurnId.make("turn-other"),
            threadId: otherThreadId,
            payload: { itemType: "command_execution" },
          }),
        );
        return [yield* liveness.observe(threadId), yield* liveness.observe(otherThreadId)] as const;
      }),
    );

    expect(observed?.settledTurns.has(turnId)).toBe(true);
    expect(otherObserved?.settledTurns.size).toBe(0);
  });

  it("bounds the settled turn tail to the most recent ids", async () => {
    const settledTurns = await withLiveness((liveness) =>
      Effect.gen(function* () {
        // More turns than the bounded tail retains.
        for (let index = 0; index < 12; index += 1) {
          yield* liveness.record(
            runtimeEvent({
              type: "turn.completed",
              turnId: TurnId.make(`turn-liveness-${index}`),
              payload: { state: "completed" },
            }),
          );
        }
        return new Set((yield* liveness.observe(threadId))?.settledTurns.keys() ?? []);
      }),
    );

    expect(settledTurns.size).toBe(8);
    // Newest ids are retained; the oldest fell out of the tail.
    expect(settledTurns.has(TurnId.make("turn-liveness-11"))).toBe(true);
    expect(settledTurns.has(TurnId.make("turn-liveness-0"))).toBe(false);
  });

  it("treats a repeated terminal event as idempotent", async () => {
    const settledTurns = await withLiveness((liveness) =>
      Effect.gen(function* () {
        for (let index = 0; index < 20; index += 1) {
          yield* liveness.record(
            runtimeEvent({ type: "turn.completed", turnId, payload: { state: "completed" } }),
          );
        }
        return new Set((yield* liveness.observe(threadId))?.settledTurns.keys() ?? []);
      }),
    );

    expect(settledTurns).toEqual(new Set([turnId]));
  });
});
