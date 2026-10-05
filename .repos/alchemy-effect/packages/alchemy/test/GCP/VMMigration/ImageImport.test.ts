import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmmigration from "@distilled.cloud/gcp/vmmigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsImageImports on a missing import fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsImageImports({
          name: `projects/${project}/locations/us-central1/imageImports/alchemy-missing-import`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmmigration", "live"],
    timeout: 90_000,
  },
);

// An image import validates its source object up front (NotFound: Resource
// "gs://.../disk.vmdk" was not found), and a project holds a single target
// project. Set GCP_TEST_VMMIGRATION_IMAGE_URI to a gs:// VMDK to run it.
const imageUri = process.env.GCP_TEST_VMMIGRATION_IMAGE_URI;

test.provider.skipIf(!imageUri)(
  "create, update, and delete a vm migration image import",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* GCP.VMMigration.Target("ImportLanding");
          return yield* GCP.VMMigration.ImageImport("Disk", {
            location: "us-central1",
            cloudStorageUri: imageUri!,
            diskImageTargetDefaults: {
              imageName: "alchemy-imported-disk",
              targetProject: target.name,
              description: "imported disk",
              labels: { env: "test" },
            },
          });
        }),
      );

      expect(created.imageImportId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/imageImports/${created.imageImportId}`,
      );
      expect(created.location).toEqual("us-central1");
      expect(created.cloudStorageUri).toContain("gs://");
      expect(created.diskImageTargetDefaults?.imageName).toEqual(
        "alchemy-imported-disk",
      );
      expect(created.diskImageTargetDefaults?.labels).toMatchObject({
        env: "test",
      });

      const fetched = yield* vmmigration.getProjectsLocationsImageImports({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.diskImageTargetDefaults?.labels?.env).toEqual("test");
      expect(fetched.diskImageTargetDefaults?.description).toContain(
        "alchemy-id=",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsImageImports({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmmigration", "live"],
    timeout: 120_000,
  },
);
