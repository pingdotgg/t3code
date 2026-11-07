import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-low-value-comments");

describe("t3code/no-low-value-comments", () => {
  rule.valid(
    "allows a four-line reason above a directive",
    `
      // One.
      // Two.
      // Three.
      // Four.
      // oxlint-disable-next-line no-console -- the script reports to the terminal
      console.log("done");
    `,
  );

  rule.invalid(
    "checks prose above a lint directive",
    `
      // One.
      // Two.
      // Three.
      // Four.
      // Five.
      // oxlint-disable-next-line no-console -- the script reports to the terminal
      console.log("done");
    `,
    (output) => {
      assert.match(output, /Cut this to 4 lines or fewer/);
    },
  );

  rule.invalid(
    "checks prose above a TypeScript directive",
    `
      // Added in #12345.
      // @ts-expect-error untyped
      const count: number = "text";
    `,
    (output) => {
      assert.match(output, /Drop the PR or issue number/);
    },
  );

  rule.invalid(
    "checks a name restated across a directive",
    `
      // The read count.
      // @ts-expect-error untyped
      const readCount: number = "text";
    `,
    (output) => {
      assert.match(output, /only repeats the name below it/);
    },
  );

  rule.invalid(
    "checks prose below a file-level directive",
    `// @effect-diagnostics nodeBuiltinImport:off
// One.
// Two.
// Three.
// Four.
// Five.
export const value = 1;
`,
    (output) => {
      assert.match(output, /Cut this to 4 lines or fewer/);
    },
  );
});
