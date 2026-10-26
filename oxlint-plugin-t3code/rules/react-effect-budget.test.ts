import { assert, describe } from "@effect/vitest";

import budget from "../../scripts/effect-budget.json" with { type: "json" };
import { createOxlintRuleHarness } from "../test/utils.ts";

const [budgetedFile, allowed] = Object.entries(budget)[0]!;

const component = (effects: number) => `import React, { useEffect } from "react";
export function Panel() {
${Array.from({ length: effects }, (_, index) => (index % 2 === 0 ? "  useEffect(() => {}, []);" : "  React.useLayoutEffect(() => {});")).join("\n")}
  return null;
}
`;

const reports = (output: string) => output.match(/t3code\(react-effect-budget\)/g)?.length ?? 0;
const lint = (filename: string) =>
  createOxlintRuleHarness("t3code/react-effect-budget", { filename });

const budgeted = lint(budgetedFile);
const unbudgeted = lint("apps/web/src/NotInTheBudget.tsx");

describe("t3code/react-effect-budget", () => {
  budgeted.valid("passes a file at its budget", component(allowed));

  budgeted.invalid("reports only the calls past the budget", component(allowed + 2), (output) => {
    assert.strictEqual(reports(output), 2);
    assert.include(output, `has ${allowed + 2} React effects against a budget of ${allowed}`);
  });

  unbudgeted.invalid(
    "gives a file without an entry a budget of 0, counting member calls",
    `export function New() { React.useEffect(() => {}); return null; }`,
    (output) => {
      assert.strictEqual(reports(output), 1);
      assert.include(output, "has 1 React effect against a budget of 0");
    },
  );

  unbudgeted.valid(
    "ignores comments, strings and lookalike names",
    `// useEffect(() => {}) in a comment
/* React.useLayoutEffect(() => {}) */
const label = "useEffect(() => {})";
const pipeline = Effect.matchCauseEffect(effect, {});
const alias = useEffect;
`,
  );

  unbudgeted.valid(
    "does not count an effect that states its reason",
    `export function New() {
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to the window's resize events
  React.useEffect(() => {});
  return null;
}
`,
  );

  lint("apps/web/src/Panel.test.tsx").valid("skips test files", component(3));
});
