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
  apigee.getOrganizationsSecurityFeedback({ name }).pipe(
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
  "getOrganizationsSecurityFeedback on a missing report fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsSecurityFeedback({
          name: `${org}/securityFeedback/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a security feedback report",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.SecurityFeedback("PenTest", {
            displayName: "pen test",
            reason: "PENETRATION_TEST",
            comment: "exclude detections",
            feedbackContexts: [
              {
                attribute: "ATTRIBUTE_ENVIRONMENTS",
                values: ["eval"],
              },
            ],
          });
        }),
      );

      expect(created.securityFeedbackId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("pen test");
      expect(created.comment).toEqual("exclude detections");

      const fetched = yield* apigee.getOrganizationsSecurityFeedback({
        name: created.name,
      });
      expect(fetched.comment).toContain("alchemy-id=");
      expect(fetched.comment).toContain("exclude detections");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.SecurityFeedback("PenTest", {
            securityFeedbackId: created.securityFeedbackId,
            displayName: "pen test updated",
            reason: "PENETRATION_TEST",
            comment: "updated exclusion",
            feedbackContexts: [
              {
                attribute: "ATTRIBUTE_ENVIRONMENTS",
                values: ["eval"],
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("pen test updated");
      expect(updated.comment).toEqual("updated exclusion");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
