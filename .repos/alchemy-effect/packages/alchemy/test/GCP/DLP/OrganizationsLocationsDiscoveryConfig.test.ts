import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

// Organization-scoped: set GOOGLE_ORGANIZATION_ID when the credentials
// administer the organization (the testing service account does not).
const organizationId = process.env.GOOGLE_ORGANIZATION_ID?.trim().replace(
  /^organizations\//,
  "",
);
const organization = `organizations/${organizationId}`;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const location = "us-central1";

const waitUntilGone = (name: string) =>
  dlp.getOrganizationsLocationsDiscoveryConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsLocationsDiscoveryConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getOrganizationsLocationsDiscoveryConfigs({
          name: `${organization}/locations/${location}/discoveryConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId || !!process.env.FAST)(
  "create, update, and delete an organization discovery config",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const orgId = organization.replace(/^organizations\//, "") || "0";
      const targets = [
        {
          bigQueryTarget: {
            filter: { otherTables: {} },
            disabled: {},
          },
        },
      ];

      const parent = `${organization}/locations/${location}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsLocationsDiscoveryConfig(
            "OrgProfiles",
            {
              organization,
              location,
              displayName: "org-profiles",
              status: "PAUSED",
              orgConfig: {
                projectId: project,
                location: { organizationId: orgId },
              },
              targets,
            },
          );
        }),
      );

      expect(created.location).toEqual(location);
      expect(created.status).toEqual("PAUSED");
      expect(created.name).toEqual(
        `${parent}/discoveryConfigs/${created.configId}`,
      );

      const fetched = yield* dlp.getOrganizationsLocationsDiscoveryConfigs({
        name: created.name,
      });
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsLocationsDiscoveryConfig(
            "OrgProfiles",
            {
              organization,
              location,
              configId: created.configId,
              displayName: "org-profiles-v2",
              status: "PAUSED",
              orgConfig: {
                projectId: project,
                location: { organizationId: orgId },
              },
              targets,
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("org-profiles-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
