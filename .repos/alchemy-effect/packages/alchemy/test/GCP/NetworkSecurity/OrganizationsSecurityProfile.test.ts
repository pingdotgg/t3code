import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networksecurity.getOrganizationsLocationsSecurityProfiles({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsLocationsSecurityProfiles on a missing profile fails with NotFound (Forbidden without org IAM)",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      const parent = resource.parent ?? "organizations/0";
      const organization = parent.startsWith("organizations/")
        ? parent.slice("organizations/".length)
        : "0";
      const error = yield* Effect.flip(
        networksecurity.getOrganizationsLocationsSecurityProfiles({
          name: `organizations/${organization}/locations/global/securityProfiles/alchemy-missing-secprofile`,
        }),
      );
      expect(error._tag).toEqual(
        process.env.GCP_TEST_ORG_NETWORKSECURITY ? "NotFound" : "Forbidden",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

// The testing credentials lack org-level Network Security IAM (Forbidden:
// "Permission 'networksecurity.….get' denied on 'organizations/…'"). Set
// GCP_TEST_ORG_NETWORKSECURITY=1 when they administer the organization.
test.provider.skipIf(!!process.env.GCP_TEST_ORG_NETWORKSECURITY)(
  "createOrganizationsLocationsSecurityProfiles without org IAM fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      const parent = resource.parent ?? "organizations/0";
      const organization = parent.startsWith("organizations/")
        ? parent.slice("organizations/".length)
        : "0";
      const error = yield* Effect.flip(
        networksecurity.createOrganizationsLocationsSecurityProfiles({
          parent: `organizations/${organization}/locations/global`,
          securityProfileId: "alchemy-org-secprofile-probe",
          body: { type: "THREAT_PREVENTION", threatPreventionProfile: {} },
        }),
      );
      expect(error._tag).toBe("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(
  !!process.env.FAST || !process.env.GCP_TEST_ORG_NETWORKSECURITY,
)(
  "create, update, and delete an organization security profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.OrganizationsSecurityProfile(
            "Threats",
            {
              type: "THREAT_PREVENTION",
              threatPreventionProfile: {
                severityOverrides: [
                  { severity: "INFORMATIONAL", action: "ALERT" },
                ],
              },
              description: "profile a",
              labels: { env: "test" },
            },
          );
        }),
      );

      expect(created.name).toContain("/securityProfiles/");
      expect(created.name).toContain("organizations/");
      expect(created.type).toEqual("THREAT_PREVENTION");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networksecurity.getOrganizationsLocationsSecurityProfiles({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.OrganizationsSecurityProfile(
            "Threats",
            {
              securityProfileId: created.securityProfileId,
              organization: created.organization,
              type: "THREAT_PREVENTION",
              threatPreventionProfile: {
                severityOverrides: [
                  { severity: "INFORMATIONAL", action: "ALERT" },
                  { severity: "HIGH", action: "DENY" },
                ],
              },
              description: "profile b",
              labels: { env: "prod", role: "ngfw" },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("profile b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ngfw" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
