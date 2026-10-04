import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  compactTraceAttributes,
  normalizeModelMetricLabel,
  websocketDisconnectFields,
} from "./Attributes.ts";

describe("Attributes", () => {
  it("normalizes circular arrays, maps, and sets without recursing forever", () => {
    const array: Array<unknown> = ["alpha"];
    array.push(array);

    const map = new Map<string, unknown>();
    map.set("self", map);

    const set = new Set<unknown>();
    set.add(set);

    assert.deepStrictEqual(
      compactTraceAttributes({
        array,
        map,
        set,
      }),
      {
        array: ["alpha", "[Circular]"],
        map: { self: "[Circular]" },
        set: ["[Circular]"],
      },
    );
  });

  it("normalizes invalid dates without throwing", () => {
    assert.deepStrictEqual(
      compactTraceAttributes({
        invalidDate: new Date("not-a-real-date"),
      }),
      {
        invalidDate: "Invalid Date",
      },
    );
  });

  it("groups GPT-family models under a shared metric label", () => {
    assert.strictEqual(normalizeModelMetricLabel("gpt-4o"), "gpt");
    assert.strictEqual(normalizeModelMetricLabel("gpt-5.4"), "gpt");
    assert.strictEqual(normalizeModelMetricLabel("claude-sonnet-4"), "claude");
  });
});

describe("websocketDisconnectFields", () => {
  it("marks the log line when the session-expiry branch wins the race", () => {
    assert.deepStrictEqual(
      websocketDisconnectFields(Exit.succeed({ endedBySessionExpiry: true }), 1_000, 1_250),
      { durationMs: 250, outcome: "success", endedBySessionExpiry: true },
    );
  });

  it("leaves ordinary client closes unmarked", () => {
    assert.deepStrictEqual(
      websocketDisconnectFields(Exit.succeed({ endedBySessionExpiry: false }), 1_000, 1_250),
      { durationMs: 250, outcome: "success" },
    );
  });

  it.effect("reports failures with a cause and interrupts without one", () =>
    Effect.gen(function* () {
      let captured: ReturnType<typeof websocketDisconnectFields> | undefined;
      yield* Effect.fail("boom").pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            captured = websocketDisconnectFields(
              exit as Exit.Exit<{ readonly endedBySessionExpiry: boolean }, unknown>,
              1_000,
              1_250,
            );
          }),
        ),
        Effect.ignore,
      );

      assert.strictEqual(captured?.outcome, "failure");
      assert.strictEqual(typeof captured?.cause, "string");
      // Interrupts keep the legacy shape: outcome "interrupt" with the
      // interruption cause attached (isFailure covers interrupts-only).
      const interrupted = websocketDisconnectFields(Exit.interrupt(), 1_000, 1_250);
      assert.strictEqual(interrupted.outcome, "interrupt");
      assert.strictEqual(typeof interrupted.cause, "string");
      assert.strictEqual(interrupted.endedBySessionExpiry, undefined);
    }),
  );

  it("clamps clock skew to a zero duration", () => {
    assert.deepStrictEqual(
      websocketDisconnectFields(Exit.succeed({ endedBySessionExpiry: false }), 2_000, 1_000),
      { durationMs: 0, outcome: "success" },
    );
  });
});
