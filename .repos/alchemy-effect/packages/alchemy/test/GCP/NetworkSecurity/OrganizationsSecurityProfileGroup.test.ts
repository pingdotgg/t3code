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
  networksecurity.getOrganizationsLocationsSecurityProfileGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsLocationsSecurityProfileGroups on a missing group fails with NotFound (Forbidden without org IAM)",
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
        networksecurity.getOrganizationsLocationsSecurityProfileGroups({
          name: `organizations/${organization}/locations/global/securityProfileGroups/alchemy-missing-secprofilegroup`,
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
  "createOrganizationsLocationsSecurityProfileGroups without org IAM fails with Forbidden",
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
        networksecurity.createOrganizationsLocationsSecurityProfileGroups({
          parent: `organizations/${organization}/locations/global`,
          securityProfileGroupId: "alchemy-org-secprofilegroup-probe",
          body: { description: "probe" },
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
  "create, update, and delete an organization security profile group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const profile =
            yield* GCP.NetworkSecurity.OrganizationsSecurityProfile("Threats", {
              type: "THREAT_PREVENTION",
              threatPreventionProfile: {
                severityOverrides: [
                  { severity: "INFORMATIONAL", action: "ALERT" },
                ],
              },
              labels: { env: "test" },
            });
          const group =
            yield* GCP.NetworkSecurity.OrganizationsSecurityProfileGroup(
              "Profiles",
              {
                threatPreventionProfile: profile.name.as<string>(),
                description: "group a",
                labels: { env: "test" },
              },
            );
          return { profile, group };
        }),
      );

      expect(created.group.name).toContain("/securityProfileGroups/");
      expect(created.group.name).toContain("organizations/");
      expect(created.group.threatPreventionProfile).toEqual(
        created.profile.name,
      );
      expect(created.group.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networksecurity.getOrganizationsLocationsSecurityProfileGroups({
          name: created.group.name,
        });
      expect(fetched.name).toEqual(created.group.name);
      expect(fetched.threatPreventionProfile).toEqual(created.profile.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const profile =
            yield* GCP.NetworkSecurity.OrganizationsSecurityProfile("Threats", {
              securityProfileId: created.profile.securityProfileId,
              organization: created.profile.organization,
              type: "THREAT_PREVENTION",
              threatPreventionProfile: {
                severityOverrides: [
                  { severity: "INFORMATIONAL", action: "ALERT" },
                ],
              },
              labels: { env: "prod" },
            });
          const group =
            yield* GCP.NetworkSecurity.OrganizationsSecurityProfileGroup(
              "Profiles",
              {
                securityProfileGroupId: created.group.securityProfileGroupId,
                organization: created.group.organization,
                threatPreventionProfile: profile.name.as<string>(),
                description: "group b",
                labels: { env: "prod", role: "ngfw" },
              },
            );
          return { profile, group };
        }),
      );

      expect(updated.group.name).toEqual(created.group.name);
      expect(updated.group.description).toEqual("group b");
      expect(updated.group.labels).toMatchObject({ env: "prod", role: "ngfw" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.group.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 120_000,
  },
);
