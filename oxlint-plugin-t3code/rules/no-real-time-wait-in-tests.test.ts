import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-real-time-wait-in-tests", {
  filename: "fixture.test.ts",
});

const REAL_CLOCK = /Real-clock wait in a test/;
const UNDRIVEN = /never fire without `TestClock.adjust`/;
const MIXED = /they never meet/;

describe("t3code/no-real-time-wait-in-tests", () => {
  rule.valid(
    "allows TestClock-driven sleeps and timeout safety nets",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      import * as TestClock from "effect/testing/TestClock";

      it.effect("fires after a minute", () =>
        Effect.gen(function* () {
          const fiber = yield* Effect.sleep("1 minute").pipe(Effect.forkChild);
          yield* TestClock.adjust("1 minute");
          yield* fiber.await;
        }),
      );

      it.live("spawns a fixture", () => Effect.void.pipe(Effect.timeout("5 seconds")));
    `,
  );

  rule.valid(
    "ignores sleeps inside strings and child-process script templates",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.live("runs a script", () =>
        Effect.sync(() => [
          "setTimeout(() => process.exit(0), 50)",
          \`await new Promise((resolve) => setTimeout(resolve, 10)); Effect.sleep(1)\`,
        ]),
      );
    `,
  );

  rule.valid(
    "ignores shared helpers in files that drive the TestClock",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      import * as TestClock from "effect/testing/TestClock";

      const slowStep = (delay: number) =>
        Effect.gen(function* () {
          if (delay > 0) yield* Effect.sleep(delay);
        });

      it.effect("advances", () => slowStep(5).pipe(Effect.andThen(TestClock.adjust(5))));
    `,
  );

  rule.valid(
    "ignores bare setTimeout callbacks outside promise executors",
    `
      import { it } from "vitest";

      it("schedules work", () => {
        const handle = setTimeout(() => {}, 1000);
        clearTimeout(handle);
      });
    `,
  );

  rule.invalid(
    "reports Effect.sleep under it.live",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.live("waits", () => Effect.sleep("50 millis"));
    `,
    (output) => {
      assert.match(output, REAL_CLOCK);
    },
  );

  rule.invalid(
    "reports retry schedules under curried testers",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      import * as Schedule from "effect/Schedule";

      it.live.skipIf(false)("polls", () =>
        Effect.void.pipe(Effect.retry(Schedule.spaced("10 millis"))),
      );
    `,
    (output) => {
      assert.match(output, REAL_CLOCK);
    },
  );

  rule.invalid(
    "reports Effect.delay under plain it",
    `
      import { it } from "vitest";
      import * as Effect from "effect/Effect";

      it("delays", async () => {
        await Effect.runPromise(Effect.void.pipe(Effect.delay("10 millis")));
      });
    `,
    (output) => {
      assert.match(output, REAL_CLOCK);
    },
  );

  rule.invalid(
    "reports it.effect inside an excludeTestServices layer as a real-clock wait",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      import * as Layer from "effect/Layer";
      import * as TestClock from "effect/testing/TestClock";

      it.layer(Layer.empty, { excludeTestServices: true })("live services", (it) => {
        it.effect("waits", () => Effect.sleep("10 millis"));
      });

      it.effect("advances", () => TestClock.adjust(1));
    `,
    (output) => {
      assert.match(output, REAL_CLOCK);
    },
  );

  rule.invalid(
    "reports it.effect sleeps in files that never adjust the TestClock",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.effect("hangs", () => Effect.sleep("200 millis"));
    `,
    (output) => {
      assert.match(output, UNDRIVEN);
    },
  );

  rule.invalid(
    "reports polling helpers even when the file drives the TestClock",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      import * as TestClock from "effect/testing/TestClock";

      let ready = false;
      const waitUntilReady = Effect.gen(function* () {
        while (!ready) {
          yield* Effect.sleep("10 millis");
        }
      });

      it.effect("advances", () => TestClock.adjust(1));
      it.live("waits", () => waitUntilReady);
    `,
    (output) => {
      assert.match(output, REAL_CLOCK);
    },
  );

  rule.invalid(
    "reports promise-wrapped setTimeout in vitest tests",
    `
      import { it } from "vitest";

      it.each([1])("waits %s", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    `,
    (output) => {
      assert.match(output, REAL_CLOCK);
      assert.notMatch(output, MIXED);
    },
  );

  rule.invalid(
    "reports promise-wrapped setTimeout under it.effect as a mixed clock",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.effect("waits", () =>
        Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10))),
      );
    `,
    (output) => {
      assert.match(output, REAL_CLOCK);
      assert.match(output, MIXED);
    },
  );

  rule.invalid(
    "reports TestClock sleeps when TestClock.adjust appears only in a comment",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      // Callers would normally TestClock.adjust("1 minute") here.
      const note = "TestClock.setTime";
      it.effect("hangs", () => Effect.sleep("1 minute"));
    `,
    (output) => {
      assert.match(output, UNDRIVEN);
    },
  );

  rule.invalid(
    "reports timers hidden in module-level helpers",
    `
      import { setTimeout as delay } from "node:timers/promises";
      import { it } from "vitest";

      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const pause = () => delay(10);

      it("waits", async () => {
        await sleep(10);
        await pause();
      });
    `,
    (output) => {
      assert.equal(output.match(/Real-clock wait in a test/g)?.length, 2);
      assert.notMatch(output, MIXED);
    },
  );

  rule.invalid(
    "reports awaited timers/promises sleeps",
    `
      import * as NodeTimers from "node:timers/promises";
      import { setTimeout as sleep } from "node:timers/promises";
      import { it } from "vitest";

      it("waits", async () => {
        await NodeTimers.setTimeout(10);
        await sleep(10);
      });
    `,
    (output) => {
      assert.equal(output.match(/Real-clock wait in a test/g)?.length, 2);
    },
  );
});

const productionRule = createOxlintRuleHarness("t3code/no-real-time-wait-in-tests");

productionRule.valid(
  "ignores non-test files",
  `
    import * as Effect from "effect/Effect";

    const it = { live: (_name: string, run: () => unknown) => run() };
    it.live("waits", () => Effect.sleep("1 second"));
  `,
);
