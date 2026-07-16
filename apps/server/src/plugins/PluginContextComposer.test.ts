import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  CONTEXT_MAX_BYTES_PER_PLUGIN,
  CONTEXT_MAX_BYTES_TOTAL,
  findContextDescriptorViolation,
  make,
  type PluginContextTurn,
} from "./PluginContextComposer.ts";

const turn: PluginContextTurn = {
  threadId: ThreadId.make("thread-context"),
  projectId: null,
  interactionMode: "default",
};

class ContributorExploded extends Error {
  readonly _tag = "ContributorExploded";
}

describe("findContextDescriptorViolation", () => {
  it("rejects a static contribution over the per-plugin cap, naming the size", () => {
    // Rejected at REGISTRATION, not truncated: a cut mid-sentence changes what an
    // instruction means, and the author would never learn it happened.
    const violation = findContextDescriptorViolation({
      name: "conventions",
      text: "x".repeat(CONTEXT_MAX_BYTES_PER_PLUGIN + 1),
    });
    assert.isNotNull(violation);
    assert.match(violation ?? "", /over the .* limit/);
  });

  it("accepts a static contribution at exactly the cap", () => {
    assert.isNull(
      findContextDescriptorViolation({
        name: "conventions",
        text: "x".repeat(CONTEXT_MAX_BYTES_PER_PLUGIN),
      }),
    );
  });

  it("rejects a descriptor that can never contribute anything", () => {
    assert.isNotNull(findContextDescriptorViolation({ name: "empty" }));
  });

  it("rejects a contribute that is not a function", () => {
    // Descriptors are dynamically loaded JS: a non-function `contribute` would
    // throw synchronously at turn time, before the composer's isolation is wired,
    // and abort the user's turn. It must be rejected at registration instead.
    assert.isNotNull(
      findContextDescriptorViolation({ name: "bad", contribute: "not a function" } as never),
    );
  });
});

describe("PluginContextComposer", () => {
  it.effect("includes a registered contribution", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      yield* composer.put("plugin-a", [{ name: "conventions", text: "Use tabs." }]);

      const composed = yield* composer.compose(turn);
      assert.strictEqual(composed.text, "Use tabs.");
      assert.deepStrictEqual(composed.records, [
        { pluginId: "plugin-a", name: "conventions", bytes: 9, skipped: null },
      ]);
    }),
  );

  it.effect("removes a plugin's contributions", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      yield* composer.put("plugin-a", [{ name: "conventions", text: "Use tabs." }]);
      yield* composer.remove("plugin-a");

      // A disabled plugin must stop steering the agent immediately. Leaving its text
      // in place would be the plugin still running.
      const composed = yield* composer.compose(turn);
      assert.strictEqual(composed.text, "");
    }),
  );

  it.effect("passes the turn to a dynamic contributor", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      yield* composer.put("plugin-a", [
        {
          name: "ticket",
          contribute: (input) =>
            Effect.succeed(`thread=${input.threadId} mode=${input.interactionMode}`),
        },
      ]);

      const composed = yield* composer.compose(turn);
      assert.strictEqual(composed.text, "thread=thread-context mode=default");
    }),
  );

  it.effect("skips (does not fail the turn on) a contributor that throws synchronously", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      yield* composer.put("plugin-a", [
        {
          name: "boom",
          // A function that THROWS when called (not Effect.fail). Invoked eagerly this
          // would defect the whole compose — which its "cannot fail" caller yields
          // unguarded. compose must skip it and keep going.
          contribute: () => {
            throw new Error("kaboom");
          },
        },
        { name: "ok", text: "survivor" },
      ]);

      const composed = yield* composer.compose(turn);
      assert.strictEqual(composed.text, "survivor");
      assert.isDefined(
        composed.records.find((record) => record.name === "boom" && record.skipped === "failed"),
      );
    }),
  );

  it.effect("skips the contributions that do not fit the total budget", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      // 40% each: two fit (80% + a separator), the third cannot. Sized off the knife
      // edge deliberately — at exactly half each, the separator's own bytes push the
      // SECOND one out, which tests the arithmetic rather than the policy.
      const chunk = "a".repeat(Math.floor(CONTEXT_MAX_BYTES_TOTAL * 0.4));
      yield* composer.put("plugin-a", [{ name: "one", text: chunk }]);
      yield* composer.put("plugin-b", [{ name: "two", text: chunk }]);
      yield* composer.put("plugin-c", [{ name: "three", text: chunk }]);

      const composed = yield* composer.compose(turn);
      const skipped = composed.records.filter((record) => record.skipped === "over-total-budget");
      assert.strictEqual(skipped.length, 1, "the contribution that does not fit must be skipped");
      assert.strictEqual(skipped[0]?.name, "three");
      // Skipped WHOLE, never truncated to fill the remaining space.
      assert.isFalse(composed.text.includes("three"));
      assert.isAtMost(new TextEncoder().encode(composed.text).length, CONTEXT_MAX_BYTES_TOTAL);
    }),
  );

  it.effect("counts the joiner's bytes, so the composed text never exceeds the budget", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      // EXACTLY half each: the two contributions sum to the budget precisely, so the
      // blank line between them is the only thing that can push the result over. This
      // knife edge is the point — at any other size the separator's 2 bytes vanish
      // into the slack and the accounting goes untested. (Summing only the
      // contributions produced 32770 bytes against a 32768 budget.)
      const half = "a".repeat(CONTEXT_MAX_BYTES_TOTAL / 2);
      yield* composer.put("plugin-a", [{ name: "one", text: half }]);
      yield* composer.put("plugin-b", [{ name: "two", text: half }]);

      const composed = yield* composer.compose(turn);
      assert.isAtMost(
        new TextEncoder().encode(composed.text).length,
        CONTEXT_MAX_BYTES_TOTAL,
        "the joiner's bytes are as real to the model's window as the plugin's",
      );
    }),
  );

  it.effect("omits a failing contributor and keeps the turn going", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      yield* composer.put("plugin-a", [
        { name: "broken", contribute: () => Effect.fail(new ContributorExploded()) },
        { name: "fine", text: "Use tabs." },
      ]);

      // A plugin's failure must never fail the USER's turn — theirs is the work that
      // matters; the contribution is an extra.
      const composed = yield* composer.compose(turn);
      assert.strictEqual(composed.text, "Use tabs.");
      assert.strictEqual(
        composed.records.find((record) => record.name === "broken")?.skipped,
        "failed",
      );
    }),
  );

  it.effect("abandons a hung contributor rather than stalling the turn", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      yield* composer.put("plugin-a", [
        { name: "hung", contribute: () => Effect.never },
        { name: "fine", text: "Use tabs." },
      ]);

      const fiber = yield* Effect.forkChild(composer.compose(turn));
      yield* TestClock.adjust("6 seconds");
      const composed = yield* Fiber.join(fiber);

      assert.strictEqual(composed.text, "Use tabs.");
      assert.strictEqual(
        composed.records.find((record) => record.name === "hung")?.skipped,
        "timed-out",
      );
    }),
  );

  it.effect("bounds the whole gather, not just each contributor", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      // Per-contributor timeouts STACK: 10 hung plugins x 5s is a 50s wait before the
      // user sees anything. The gather deadline is what they actually wait for.
      for (let index = 0; index < 10; index += 1) {
        yield* composer.put(`plugin-${index}`, [
          { name: `hung-${index}`, contribute: () => Effect.never },
        ]);
      }

      const fiber = yield* Effect.forkChild(composer.compose(turn));
      yield* TestClock.adjust("11 seconds");
      const composed = yield* Fiber.join(fiber);

      assert.strictEqual(composed.text, "", "the turn proceeds with no plugin context");
    }),
  );

  it.effect("records an empty contribution rather than dropping it silently", () =>
    Effect.gen(function* () {
      const composer = yield* make();
      const calls = yield* Ref.make(0);
      yield* composer.put("plugin-a", [
        {
          name: "nothing-today",
          contribute: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(null)),
        },
      ]);

      const composed = yield* composer.compose(turn);
      assert.strictEqual(yield* Ref.get(calls), 1);
      // "the agent ignored my rule" must be answerable from the record.
      assert.strictEqual(composed.records[0]?.skipped, "empty");
    }),
  );
});
