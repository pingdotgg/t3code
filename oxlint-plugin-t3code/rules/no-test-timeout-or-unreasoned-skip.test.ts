import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const RULE = "t3code/no-test-timeout-or-unreasoned-skip";
const rule = createOxlintRuleHarness(RULE, { filename: "fixture.test.ts" });

const assertTimeoutMessage = (output: string) =>
  assert.match(output, /project timeout is the ceiling/);
const assertSkipMessage = (output: string) => assert.match(output, /quarantine: #1234/);

describe(RULE, () => {
  rule.valid(
    "allows tests without overrides, conditional skips, and waitFor timeouts",
    `
      import { describe, it, vi } from "vitest";

      describe.skipIf(process.env.CI)("suite", () => {
        it.runIf(true)("runs", async () => {
          await vi.waitFor(() => {}, { timeout: 10_000 });
        });
        it.each([1, 2])("handles %s", (value) => {});
      });
      vi.setConfig({ restoreMocks: true });
    `,
  );

  rule.valid(
    "allows a skip with a quarantine issue or a GitHub issue URL",
    `
      import { describe, it } from "vitest";

      // quarantine: #1234 flakes on Windows until the pty fix lands
      it.skip("pending", () => {});

      // https://github.com/pingdotgg/t3code/issues/42
      describe.only("focused", () => {});
    `,
  );

  rule.invalid(
    "reports a numeric timeout on it.effect",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.effect("slow", () => Effect.void, 20_000);
    `,
    assertTimeoutMessage,
  );

  rule.invalid(
    "reports a timeout through .each and .skipIf chains",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.live.skipIf(false)("slow", () => Effect.void, 5_000);
      it.effect.each([1])("case %s", () => Effect.void, { timeout: 1_000 });
    `,
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 2);
    },
  );

  rule.invalid(
    "reports retry options, options-first timeouts, and hook timeouts",
    `
      import { beforeAll, describe, it } from "vitest";

      describe("suite", () => {
        beforeAll(() => {}, 60_000);
        it("flaky", () => {}, { retry: 3 });
        it("slow", { timeout: 30_000 }, () => {});
      });
    `,
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 3);
    },
  );

  rule.invalid(
    "reports vi.setConfig timeouts",
    `
      import { vi } from "vitest";

      vi.setConfig({ testTimeout: 30_000 });
    `,
    assertTimeoutMessage,
  );

  rule.invalid(
    "reports a skip whose comment has no issue",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      // flaky, will fix later
      it.effect.skip("pending", () => Effect.void);
    `,
    assertSkipMessage,
  );

  rule.invalid(
    "reports todo, only, and the x/f aliases",
    `
      import { describe, it, test } from "vitest";

      test.todo("later");
      describe.only("focused", () => {});
      xit("disabled", () => {});
      fdescribe("focused", () => {});
    `,
    (output) => {
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 4);
    },
  );
  rule.invalid(
    "flags an options-object timeout when the callback is a reference",
    `
      import { it } from "vitest";
      const run = async () => {};
      it("slow", { timeout: 30_000 }, run);
    `,
    assertTimeoutMessage,
  );

  rule.valid(
    "allows a computed skip option, which is a platform gate like skipIf",
    `
      import { it } from "vitest";
      const windowsHost = process.platform === "win32";
      it.each([{ name: "a" }])("x $name", { skip: windowsHost }, () => {});
    `,
  );

  rule.invalid(
    "flags the suite alias and option-object skips",
    `
      import { suite, test } from "vitest";
      suite.skip("later", () => {});
    `,
    assertSkipMessage,
  );

  rule.invalid(
    "flags a skip option without a quarantine issue",
    `
      import { test } from "vitest";
      test("later", { skip: true }, () => {});
    `,
    assertSkipMessage,
  );

  rule.invalid(
    "flags a bracket-access skip without a quarantine issue",
    `
      import { it } from "vitest";
      it["skip"]("later", () => {});
    `,
    assertSkipMessage,
  );
});

createOxlintRuleHarness(RULE, { filename: "Provider.live.test.ts" }).invalid(
  "still flags an option-object skip in a live file",
  `
    import { it } from "vitest";
    it("later", { skip: true }, () => {});
  `,
  assertSkipMessage,
);

createOxlintRuleHarness(RULE, { filename: "Provider.live.test.ts" }).valid(
  "allows timeouts in opt-in live provider suites",
  `
    import { it } from "@effect/vitest";
    import * as Effect from "effect/Effect";

    it.live("real turn", () => Effect.void, 360_000);
  `,
);

createOxlintRuleHarness(RULE).valid(
  "ignores non-test files",
  `
    const it = (_name: string, _fn: () => void, _ms: number) => {};
    it("x", () => {}, 1_000);
  `,
);
