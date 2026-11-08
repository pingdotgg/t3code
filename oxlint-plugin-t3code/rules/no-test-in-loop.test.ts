import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-test-in-loop", {
  filename: "fixture.test.ts",
});

describe("t3code/no-test-in-loop", () => {
  rule.valid(
    "allows it.each and it.effect.each",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.each([1, 2])("handles %s", (value) => {});
      it.effect.each([1, 2])("handles %s", (value) => Effect.succeed(value));
    `,
  );

  rule.valid(
    "allows loops inside a test body",
    `
      import { it } from "@effect/vitest";

      it("checks every value", () => {
        for (const value of [1, 2]) {
          if (value < 0) throw new Error("negative");
        }
      });
    `,
  );

  rule.valid(
    "ignores node:test files, which have no .each",
    `
      import { test } from "node:test";

      for (const value of [1, 2]) {
        test(\`handles \${value}\`, () => {});
      }
    `,
  );

  rule.valid(
    "allows it.effect.skipIf inside a loop, which has no .each",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      for (const value of [1, 2]) {
        it.effect.skipIf(value > 1)(\`handles \${value}\`, () => Effect.void);
      }
    `,
  );

  rule.valid(
    "ignores member calls on a loop variable named test",
    `
      import { assert, it } from "@effect/vitest";

      it("checks every case", () => {
        for (const test of [{ expected: [1] }]) {
          assert.isTrue(test.expected.some((value) => value > 0));
        }
      });
    `,
  );

  rule.invalid(
    "reports it inside a for...of loop",
    `
      import { it } from "@effect/vitest";

      for (const value of [1, 2]) {
        it(\`handles \${value}\`, () => {});
      }
    `,
    (output) => {
      assert.match(output, /Use it\.each\(cases\)/);
    },
  );

  rule.invalid(
    "reports it.effect inside a for loop nested in describe",
    `
      import { describe, it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      describe("cases", () => {
        for (let index = 0; index < 2; index++) {
          it.effect(\`handles \${index}\`, () => Effect.void);
        }
      });
    `,
    (output) => {
      assert.match(output, /Use it\.effect\.each\(cases\)/);
    },
  );

  rule.invalid(
    "reports test inside a for...in loop",
    `
      import { test } from "vitest";

      for (const key in { a: 1 }) {
        test(key, () => {});
      }
    `,
  );

  rule.invalid(
    "reports a describe inside a loop once, not the tests inside it",
    `
      import { describe, it } from "vitest";

      for (const bundle of ["a.js", "b.js"]) {
        describe(bundle, () => {
          it("first", () => {});
          it("second", () => {});
        });
      }
    `,
    (output) => {
      assert.match(output, /Use describe\.each\(cases\)/);
      assert.equal(output.match(/no-test-in-loop/g)?.length, 1);
    },
  );

  rule.invalid(
    "reports it.each inside a for...of loop",
    `
      import { it } from "@effect/vitest";

      for (const kind of ["a", "b"]) {
        it.each([1, 2])(\`handles \${kind} %s\`, (value) => {});
      }
    `,
    (output) => {
      assert.match(output, /Do not call it\.each\(…\)\(…\) inside a for loop/);
      assert.match(output, /Fold the loop into one it\.each\(cases\) list/);
    },
  );

  rule.invalid(
    "reports a describe.each inside a loop once",
    `
      import { describe, it } from "vitest";

      for (const kind of ["a", "b"]) {
        describe.each([1, 2])(\`\${kind} %s\`, (value) => {
          it("first", () => {});
        });
      }
    `,
    (output) => {
      assert.match(output, /Fold the loop into one describe\.each\(cases\) list/);
      assert.equal(output.match(/no-test-in-loop/g)?.length, 1);
    },
  );

  rule.invalid(
    "reports it.effect.each inside a for loop",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      for (let index = 0; index < 2; index++) {
        it.effect.each([1, 2])(\`handles \${index} %s\`, (value) => Effect.succeed(value));
      }
    `,
    (output) => {
      assert.match(output, /Fold the loop into one it\.effect\.each\(cases\) list/);
    },
  );
});

const productionRule = createOxlintRuleHarness("t3code/no-test-in-loop");

productionRule.valid(
  "ignores non-test files",
  `
    const it = (_name: string) => {};
    for (const value of ["a"]) it(value);
  `,
);
