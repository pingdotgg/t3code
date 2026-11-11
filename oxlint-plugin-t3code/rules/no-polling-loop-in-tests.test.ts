import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-polling-loop-in-tests", {
  filename: "fixture.test.ts",
});

describe("t3code/no-polling-loop-in-tests", () => {
  rule.valid(
    "allows a fixed-count flush followed by unrelated error handling",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      it.effect("flushes", () =>
        Effect.gen(function* () {
          for (let i = 0; i < 3; i++) yield* Effect.yieldNow;
          if (!ready()) return yield* Effect.die("not ready");
        }),
      );
    `,
  );

  rule.valid(
    "allows a fixed-N flush with a literal bound",
    `
      import * as Effect from "effect/Effect";

      export const flush = Effect.gen(function* () {
        for (let i = 0; i < 3; i++) yield* Effect.yieldNow;
      });
    `,
  );

  rule.valid(
    "allows a fixed-N while flush with a counter bound",
    `
      import * as Effect from "effect/Effect";

      export const flush = Effect.gen(function* () {
        let i = 0;
        while (i < 3) {
          yield* Effect.yieldNow;
          i++;
        }
      });
    `,
  );

  rule.valid(
    "allows a fixed-N do-while flush against a named bound",
    `
      import * as Effect from "effect/Effect";

      export const flush = (turns: number) =>
        Effect.gen(function* () {
          let i = 0;
          do {
            yield* Effect.yieldNow;
            i += 1;
          } while (i < turns);
        });
    `,
  );

  rule.valid(
    "allows a loop that takes from a queue",
    `
      import * as Effect from "effect/Effect";
      import * as Queue from "effect/Queue";

      export const until = (events: Queue.Queue<number>) =>
        Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(events);
            if (event > 2) return event;
          }
        });
    `,
  );

  rule.valid(
    "ignores waits inside nested callbacks",
    `
      import * as Effect from "effect/Effect";

      export const run = (items: ReadonlyArray<number>, done: () => boolean) =>
        Effect.gen(function* () {
          for (let i = 0; i < items.length; i++) {
            if (done()) return;
            yield* Effect.forkChild(Effect.gen(function* () {
              yield* Effect.yieldNow;
            }));
          }
        });
    `,
  );

  rule.invalid(
    "reports a budgeted yieldNow poll that dies after the loop",
    `
      import * as Effect from "effect/Effect";

      export const awaitUntil = (predicate: () => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 5000; attempt++) {
            if (predicate()) return;
            yield* Effect.yieldNow;
          }
          return yield* Effect.die("Timed out");
        });
    `,
    (output) => {
      assert.match(output, /Await the `Deferred`/);
    },
  );

  rule.invalid(
    "reports a while loop spinning on a predicate",
    `
      import * as Effect from "effect/Effect";

      export const wait = (turns: Array<number>) =>
        Effect.gen(function* () {
          while (turns.length === 0) yield* Effect.yieldNow;
        });
    `,
  );

  rule.invalid(
    "reports a while loop bounded by a length predicate",
    `
      import * as Effect from "effect/Effect";

      export const wait = (events: Array<number>) =>
        Effect.gen(function* () {
          while (events.length < 1) yield* Effect.yieldNow;
        });
    `,
  );

  rule.invalid(
    "reports a comparison against an identifier the loop never advances",
    `
      import * as Effect from "effect/Effect";

      export const wait = (state: { count: number }) =>
        Effect.gen(function* () {
          let seen = state.count;
          while (seen < 3) {
            yield* Effect.yieldNow;
            seen = state.count;
          }
        });
    `,
  );

  rule.invalid(
    "reports a for loop bounded by a length predicate",
    `
      import * as Effect from "effect/Effect";

      export const wait = (events: Array<number>) =>
        Effect.gen(function* () {
          for (; events.length < 1; ) yield* Effect.yieldNow;
        });
    `,
  );

  rule.invalid(
    "reports a sleep poll with a counter bound and an early return",
    `
      import * as Effect from "effect/Effect";

      export const waitFor = (done: () => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 240; attempt += 1) {
            if (done()) return;
            yield* Effect.sleep("500 millis");
          }
        });
    `,
  );

  rule.invalid(
    "reports a microtask poll keyed on the loop condition",
    `
      import * as Effect from "effect/Effect";

      export const settle = function* (until: () => boolean) {
        for (let attempt = 0; attempt < 30 && !until(); attempt++) {
          yield* Effect.promise(() => Promise.resolve());
        }
      };
    `,
  );

  rule.invalid(
    "reports an awaited setTimeout poll",
    `
      export const waitFor = async (done: () => boolean) => {
        do {
          await new Promise((resolve) => setTimeout(resolve, 10));
        } while (!done());
      };
    `,
  );

  rule.invalid(
    "reports an awaited Promise.resolve poll that breaks",
    `
      export const waitFor = async (done: () => boolean) => {
        while (true) {
          if (done()) break;
          await Promise.resolve();
        }
      };
    `,
  );
});

const productionRule = createOxlintRuleHarness("t3code/no-polling-loop-in-tests");

productionRule.valid(
  "ignores non-test files",
  `
    export const waitFor = async (done: () => boolean) => {
      while (!done()) await Promise.resolve();
    };
  `,
);
