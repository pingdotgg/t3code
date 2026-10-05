import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Needs a provisioned Apigee organization on the testing project (paid, or
// ~1h eval provisioning); without one calls fail with ApigeeResourceNotFound (403 "Permission
// denied on resource \"organizations/{project}\" (or it may not exist)").
// Set GCP_TEST_APIGEE_ORG=1 when the org exists.
const runLifecycle = !!process.env.GCP_TEST_APIGEE_ORG;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsSecurityMonitoringConditions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("ApigeeResourceNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsSecurityMonitoringConditions on a missing condition fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsSecurityMonitoringConditions({
          name: `${org}/securityMonitoringConditions/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a security monitoring condition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* GCP.Apigee.SecurityProfilesV2("Default", {
            description: "default scoring",
          });
          const condition = yield* GCP.Apigee.SecurityMonitoringCondition(
            "Eval",
            {
              profile: profile.name,
              includeAllResources: true,
            },
          );
          return { profile, condition };
        }),
      );

      expect(created.condition.securityMonitoringConditionId).toEqual(
        expect.any(String),
      );
      expect(created.condition.profile).toEqual(created.profile.name);
      expect(created.condition.includeAllResources).toEqual(true);

      const fetched =
        yield* apigee.getOrganizationsSecurityMonitoringConditions({
          name: created.condition.name,
        });
      expect(fetched.profile).toEqual(created.profile.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* GCP.Apigee.SecurityProfilesV2("Default", {
            securityProfileV2Id: created.profile.securityProfileV2Id,
            description: "default scoring",
          });
          const condition = yield* GCP.Apigee.SecurityMonitoringCondition(
            "Eval",
            {
              securityMonitoringConditionId:
                created.condition.securityMonitoringConditionId,
              profile: profile.name,
              includeAllResources: false,
            },
          );
          return { profile, condition };
        }),
      );

      expect(updated.condition.name).toEqual(created.condition.name);
      expect(updated.condition.includeAllResources).toEqual(false);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.condition.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
