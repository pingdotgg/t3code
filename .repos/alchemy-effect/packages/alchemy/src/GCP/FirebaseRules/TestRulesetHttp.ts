import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Ruleset } from "./Ruleset.ts";
import { TestRuleset, type TestRulesetRequest } from "./TestRuleset.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link TestRuleset}.
 *
 * Grants `roles/firebaserules.admin` on the project because it is the
 * narrowest predefined role containing `firebaserules.rulesets.test`, and Firebase
 * Rules has no resource-level IAM.
 *
 * @layer
 * @provides GCP.FirebaseRules.TestRuleset
 */
export const TestRulesetHttp = Layer.effect(
  TestRuleset,
  Effect.gen(function* () {
    const testProjects = yield* firebaserules.testProjects;
    return Effect.fn(function* (ruleset: Ruleset) {
      yield* bindGcpHost({
        tag: "GCP.FirebaseRules.TestRuleset",
        resource: ruleset,
        iam: [{ role: "roles/firebaserules.admin" }],
      });
      const name = yield* ruleset.name;
      return Effect.fn(`GCP.FirebaseRules.TestRuleset(${ruleset.LogicalId})`)(
        function* (request: TestRulesetRequest = {}) {
          return yield* testProjects({
            ...request,
            name: yield* name,
          });
        },
      );
    });
  }),
);
