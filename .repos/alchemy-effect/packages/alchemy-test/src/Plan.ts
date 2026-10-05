import * as Schema from "effect/Schema";
import { compileTagsFilter } from "./Tags.ts";

const Branch = Schema.Struct({
  /** Tag expressions are ANDed, just like repeated --tags flags. Empty selects all. */
  tags: Schema.Array(Schema.String),
  concurrency: Schema.optional(
    Schema.Union([
      Schema.Int.check(Schema.isGreaterThan(0)),
      Schema.Literal("unbounded"),
    ]),
  ),
});
const Plan = Schema.Array(
  Schema.Union([Branch, Schema.Array(Branch).check(Schema.isMinLength(1))]),
).check(Schema.isMinLength(1));

export type TestPlan = typeof Plan.Type;

/** Parse before collection so an invalid plan cannot trigger test imports. */
export const parsePlan = (json: string): TestPlan => {
  try {
    const plan = Schema.decodeUnknownSync(Plan, { onExcessProperty: "error" })(
      JSON.parse(json),
    );
    for (const phase of plan) {
      for (const branch of Array.isArray(phase) ? phase : [phase]) {
        compileTagsFilter(branch.tags);
      }
    }
    return plan;
  } catch (cause) {
    throw new Error(
      `Invalid --plan: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

/** Shared plain/TUI/log representation of a dry-run plan. */
export const formatPlanPreview = (
  phases: Extract<
    import("./Reporter.ts").TestEvent,
    { _tag: "PlanPreview" }
  >["phases"],
): string =>
  [
    "Dry run — no tests or hooks executed",
    ...phases.flatMap((branches, index) => [
      `Phase ${index + 1}${branches.length > 1 ? " (parallel)" : ""}:`,
      ...branches.map(
        (branch, i) =>
          `  Branch ${i + 1}: tags=${JSON.stringify(branch.tags)}, concurrency=${branch.concurrency} — ${branch.tests} tests in ${branch.files} files${branch.skipped ? ` (${branch.skipped} skipped/todo)` : ""}`,
      ),
    ]),
  ].join("\n");
