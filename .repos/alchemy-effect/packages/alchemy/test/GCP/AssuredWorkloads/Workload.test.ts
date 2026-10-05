import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as assuredworkloads from "@distilled.cloud/gcp/assuredworkloads_v1";
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

const defaultLocation = "us-central1";

// Workloads live under an organization the credentials administer. Set
// GOOGLE_ORGANIZATION_ID and GOOGLE_BILLING_ACCOUNT to run the lifecycle.
const organizationId = process.env.GOOGLE_ORGANIZATION_ID?.trim();
const organization = organizationId
  ? organizationId.startsWith("organizations/")
    ? organizationId
    : `organizations/${organizationId}`
  : undefined;

const waitUntilGone = (name: string) =>
  assuredworkloads.getOrganizationsLocationsWorkloads({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const billingAccount = process.env.GOOGLE_BILLING_ACCOUNT
  ? process.env.GOOGLE_BILLING_ACCOUNT.startsWith("billingAccounts/")
    ? process.env.GOOGLE_BILLING_ACCOUNT
    : `billingAccounts/${process.env.GOOGLE_BILLING_ACCOUNT}`
  : undefined;

const runLifecycle =
  organization !== undefined &&
  billingAccount !== undefined &&
  !process.env.FAST;

test.provider.skipIf(organization === undefined)(
  "getOrganizationsLocationsWorkloads on a missing workload fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        assuredworkloads.getOrganizationsLocationsWorkloads({
          name: `${organization}/locations/${defaultLocation}/workloads/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:assuredworkloads", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(organization !== undefined)(
  "getOrganizationsLocationsWorkloads without organization access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const parent = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      // "Permission 'assuredworkloads.workload.get' denied on resource ...
      // (or it may not exist)": the testing credentials hold no
      // organization-level Assured Workloads role.
      const error = yield* Effect.flip(
        assuredworkloads.getOrganizationsLocationsWorkloads({
          name: `${parent.parent}/locations/${defaultLocation}/workloads/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:assuredworkloads", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a workload",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AssuredWorkloads.Workload("Regulated", {
            organization: organization!,
            location: defaultLocation,
            displayName: "alchemy test",
            complianceRegime: "US_REGIONAL_ACCESS",
            billingAccount,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.workloadId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.location).toEqual(defaultLocation);
      expect(created.name).toEqual(
        `${organization}/locations/${defaultLocation}/workloads/${created.workloadId}`,
      );
      expect(created.displayName).toEqual("alchemy test");
      expect(created.complianceRegime).toEqual("US_REGIONAL_ACCESS");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* assuredworkloads.getOrganizationsLocationsWorkloads({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AssuredWorkloads.Workload("Regulated", {
            organization: organization!,
            location: defaultLocation,
            displayName: "alchemy prod",
            complianceRegime: "US_REGIONAL_ACCESS",
            billingAccount,
            labels: { env: "prod", role: "aw" },
            violationNotificationsEnabled: false,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.workloadId).toEqual(created.workloadId);
      expect(updated.displayName).toEqual("alchemy prod");
      expect(updated.labels).toMatchObject({ env: "prod", role: "aw" });
      expect(updated.violationNotificationsEnabled).toEqual(false);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:assuredworkloads", "live"],
    timeout: 120_000,
  },
);
