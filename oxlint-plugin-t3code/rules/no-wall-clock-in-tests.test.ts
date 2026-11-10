import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-wall-clock-in-tests", {
  filename: "fixture.test.ts",
});

describe("t3code/no-wall-clock-in-tests", () => {
  rule.valid(
    "ignores a computed member with a variable key",
    `
      import { it } from "vitest";
      it("parses", () => {
        const now = "parse";
        const parsed = Date[now]("2026-01-01");
        const literal = Date["parse"]("2026-01-01");
      });
    `,
  );

  rule.valid(
    "allows fixed dates and readings that seed mocks",
    `
      import { vi } from "vitest";

      const epoch = new Date("2026-01-01T00:00:00.000Z");
      export const later = new Date(epoch.getTime() + 1_000);
      vi.setSystemTime(new Date());
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
      const clock = vi.fn(() => performance.now());
      clock.mockImplementation(() => Number(process.hrtime.bigint()));
      vi.mock("./clock", () => ({ now: () => Date.now() }));
    `,
  );

  rule.invalid(
    "reports elapsed-time measurement",
    `
      const startedAt = performance.now();
      const elapsed = performance.now() - startedAt;
      if (elapsed > 10_000) throw new Error("slow");
    `,
    (output) => {
      assert.match(output, /Wall-clock reading in a test/);
      assert.equal(output.match(/no-wall-clock-in-tests/g)?.length, 2);
    },
  );

  rule.invalid(
    "reports Date.now fixtures",
    `
      export const session = { expiresAt: Date.now() + 60_000 };
    `,
  );

  rule.invalid(
    "reports new Date() with no arguments",
    `
      export const createdAt = new Date().toISOString();
    `,
  );

  rule.invalid(
    "reports process.hrtime and process.hrtime.bigint",
    `
      export const a = process.hrtime();
      export const b = process.hrtime.bigint();
    `,
    (output) => {
      assert.equal(output.match(/no-wall-clock-in-tests/g)?.length, 2);
    },
  );

  rule.invalid(
    "reports a reading outside the mock's arguments",
    `
      import { vi } from "vitest";

      const mock = vi.fn();
      mock.mockReturnValue(1);
      export const now = Date.now();
    `,
  );
});

const productionRule = createOxlintRuleHarness("t3code/no-wall-clock-in-tests");

productionRule.valid(
  "ignores non-test files",
  `
    export const now = Date.now();
  `,
);
