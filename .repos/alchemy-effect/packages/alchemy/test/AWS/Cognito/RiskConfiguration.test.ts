import * as AWS from "@/AWS";
import { UserPool } from "@/AWS/Cognito";
import * as Test from "@/Test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class UserPoolStillExists extends Data.TaggedError("UserPoolStillExists")<{
  readonly userPoolId: string;
}> {}

const assertPoolDeleted = (userPoolId: string) =>
  cip.describeUserPool({ UserPoolId: userPoolId }).pipe(
    Effect.flatMap(() => Effect.fail(new UserPoolStillExists({ userPoolId }))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "UserPoolStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

/**
 * RiskConfiguration (threat protection) probe — pins the live semantics of
 * `setRiskConfiguration` with TYPED outcomes only (no untyped error may
 * escape; `UserPoolAddOnNotEnabledException` is in distilled's
 * `SetRiskConfigurationError` union).
 *
 * Probed live 2026-07-09: contrary to the catalog's entitlement assumption,
 * the WRITE is accepted on both `LITE` and `ESSENTIALS` (default) tier
 * pools and reads back verbatim — the feature plan gates *enforcement* of
 * threat protection, not configuration. A future RiskConfiguration
 * resource (catalog: P2, unimplemented) is therefore fully live-testable
 * without a PLUS plan.
 */
test.provider(
  "setRiskConfiguration is accepted and reads back on LITE and ESSENTIALS pools",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const lite = yield* UserPool("RiskProbeLitePool", { tier: "LITE" });
          const essentials = yield* UserPool("RiskProbePool", {});
          return { lite, essentials };
        }),
      );

      const probe = (userPoolId: string) =>
        Effect.gen(function* () {
          const outcome = yield* cip
            .setRiskConfiguration({
              UserPoolId: userPoolId,
              CompromisedCredentialsRiskConfiguration: {
                Actions: { EventAction: "BLOCK" },
              },
            })
            .pipe(
              Effect.map(() => "accepted" as const),
              Effect.catchTag("UserPoolAddOnNotEnabledException", () =>
                Effect.succeed("add-on-not-enabled" as const),
              ),
            );
          const readBack = yield* cip.describeRiskConfiguration({
            UserPoolId: userPoolId,
          });
          return {
            outcome,
            eventAction:
              readBack.RiskConfiguration
                ?.CompromisedCredentialsRiskConfiguration?.Actions?.EventAction,
          };
        });

      const lite = yield* probe(outputs.lite.userPoolId);
      expect(lite.outcome).toBe("accepted");
      expect(lite.eventAction).toBe("BLOCK");

      const essentials = yield* probe(outputs.essentials.userPoolId);
      expect(essentials.outcome).toBe("accepted");
      expect(essentials.eventAction).toBe("BLOCK");

      yield* stack.destroy();
      yield* assertPoolDeleted(outputs.lite.userPoolId);
      yield* assertPoolDeleted(outputs.essentials.userPoolId);
    }),
  { timeout: 120_000 },
);
