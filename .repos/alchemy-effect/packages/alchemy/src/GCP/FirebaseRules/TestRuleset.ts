import type * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Ruleset } from "./Ruleset.ts";

export interface TestRulesetRequest extends Omit<
  firebaserules.TestProjectsRequest,
  "name"
> {}

/**
 * Runtime binding for Firebase Rules `projects.test` against a
 * {@link Ruleset}.
 *
 * Bind this operation to a ruleset in a Function/Action init phase.
 * Provide {@link TestRulesetHttp}. `source` must be omitted when the
 * name refers to an existing ruleset.
 *
 * ### Testing a Ruleset
 * **Example:** Run a test suite
 * ```typescript
 * const testRuleset = yield* GCP.FirebaseRules.TestRuleset(ruleset);
 * const result = yield* testRuleset({
 *   body: {
 *     testSuite: {
 *       testCases: [{ expectation: "DENY" }],
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category FirebaseRules
 */
export interface TestRuleset extends Binding.Service<
  TestRuleset,
  "GCP.FirebaseRules.TestRuleset",
  (
    ruleset: Ruleset,
  ) => Effect.Effect<
    (
      request?: TestRulesetRequest,
    ) => Effect.Effect<
      firebaserules.TestRulesetResponse,
      firebaserules.TestProjectsError,
      RuntimeContext
    >
  >
> {}

export const TestRuleset = Binding.Service<TestRuleset>(
  "GCP.FirebaseRules.TestRuleset",
);
