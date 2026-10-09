import * as securityposture from "@distilled.cloud/gcp/securityposture_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Postures live on the organization and need org-level Security Posture
// permissions the testing service account lacks (list/create answer 403);
// set GCP_TEST_SECURITY_POSTURE=1 and GOOGLE_ORGANIZATION_ID on an org where
// the credential is a Security Posture admin.
const organizationId = process.env.GOOGLE_ORGANIZATION_ID?.trim() ?? "";
export const organization =
  organizationId.length === 0 || organizationId.startsWith("organizations/")
    ? organizationId
    : `organizations/${organizationId}`;
export const runLifecycle =
  !process.env.FAST &&
  process.env.GCP_TEST_SECURITY_POSTURE === "1" &&
  organization.length > 0;

export const waitUntilPostureGone = (name: string) =>
  securityposture.getOrganizationsLocationsPostures({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilDeploymentGone = (name: string) =>
  securityposture.getOrganizationsLocationsPostureDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const updatedPolicySets: securityposture.PolicySetList = [
  {
    policySetId: "alchemy",
    description: "updated alchemy policy set",
    policies: [
      {
        policyId: "alchemy-sha",
        constraint: {
          securityHealthAnalyticsModule: {
            moduleName: "API_KEY_EXISTS",
            moduleEnablementState: "DISABLED",
          },
        },
      },
      {
        policyId: "alchemy-sha-2",
        constraint: {
          securityHealthAnalyticsModule: {
            moduleName: "BUCKET_IAM_NOT_MONITORED",
            moduleEnablementState: "DISABLED",
          },
        },
      },
    ],
  },
];
