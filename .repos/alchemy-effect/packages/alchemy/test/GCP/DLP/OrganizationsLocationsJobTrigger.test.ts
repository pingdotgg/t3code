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
  dlp.getOrganizationsLocationsJobTriggers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsLocationsJobTriggers on a missing trigger fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getOrganizationsLocationsJobTriggers({
          name: `${organization}/locations/${location}/jobTriggers/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId)(
  "create, update, and delete an organization job trigger",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const inspectJob = {
        inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
        storageConfig: {
          cloudStorageOptions: {
            fileSet: { url: `gs://${project}-dlp-noop/` },
          },
        },
      };

      const parent = `${organization}/locations/${location}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsLocationsJobTrigger("ScanBucket", {
            organization,
            location,
            displayName: "scan-bucket",
            description: "paused inspect",
            status: "PAUSED",
            triggers: [{ schedule: { recurrencePeriodDuration: "86400s" } }],
            inspectJob,
          });
        }),
      );

      expect(created.location).toEqual(location);
      expect(created.status).toEqual("PAUSED");
      expect(created.name).toEqual(
        `${parent}/jobTriggers/${created.triggerId}`,
      );

      const fetched = yield* dlp.getOrganizationsLocationsJobTriggers({
        name: created.name,
      });
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsLocationsJobTrigger("ScanBucket", {
            organization,
            location,
            triggerId: created.triggerId,
            displayName: "scan-bucket-v2",
            description: "paused inspect v2",
            status: "PAUSED",
            triggers: [{ schedule: { recurrencePeriodDuration: "172800s" } }],
            inspectJob,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("scan-bucket-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
