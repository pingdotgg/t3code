import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { GcpEnvironment } from "@/GCP/Environment";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withDataplexSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const organizationId = process.env.GOOGLE_ORGANIZATION_ID ?? "";
const runLifecycle = !process.env.FAST && organizationId.length > 0;

const waitUntilGone = (name: string) =>
  dataplex.getOrganizationsLocationsEncryptionConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsLocationsEncryptionConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      // Probe the test project's own organization so the name is valid.
      const projectInfo = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      const org =
        organizationId.length > 0
          ? organizationId
          : (projectInfo.parent ?? "").replace(/^organizations\//, "");
      const error = yield* Effect.flip(
        dataplex.getOrganizationsLocationsEncryptionConfigs({
          name: `organizations/${org}/locations/us-central1/encryptionConfigs/alchemy-missing`,
        }),
      );
      // Without an organization-level Dataplex role the API answers
      // "Permission 'dataplex.encryptionConfig.get' denied".
      expect(error._tag).toEqual(runLifecycle ? "NotFound" : "Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an encryption config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.EncryptionConfig("Default", {
            organizationId,
            location: "us-central1",
            encryptionConfigId: "default",
            enableMetastoreEncryption: false,
          });
        }),
      );

      expect(created.name).toContain("/encryptionConfigs/");
      expect(created.encryptionConfigId).toEqual("default");
      expect(created.organizationId).toEqual(organizationId);
      expect(created.location).toEqual("us-central1");

      const fetched =
        yield* dataplex.getOrganizationsLocationsEncryptionConfigs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.EncryptionConfig("Default", {
            organizationId,
            location: "us-central1",
            encryptionConfigId: "default",
            enableMetastoreEncryption: false,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
