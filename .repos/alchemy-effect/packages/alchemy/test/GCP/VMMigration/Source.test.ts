import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmmigration from "@distilled.cloud/gcp/vmmigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  dummyAws,
  logLevel,
  currentProject,
  runSourceLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsSources on a missing source fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsSources({
          name: `projects/${project}/locations/us-central1/sources/alchemy-missing-source`,
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

test.provider.skipIf(!runSourceLifecycle)(
  "create, update, and delete a vm migration source",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMMigration.Source("Aws", {
            location: "us-central1",
            description: "aws inventory",
            labels: { env: "test" },
            aws: dummyAws,
          });
        }),
      );

      expect(created.sourceId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/sources/${created.sourceId}`,
      );
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("aws inventory");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.aws?.awsRegion).toEqual("us-east-1");

      const fetched = yield* vmmigration.getProjectsLocationsSources({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.aws?.awsRegion).toEqual("us-east-1");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMMigration.Source("Aws", {
            sourceId: created.sourceId,
            location: "us-central1",
            description: "aws inventory v2",
            labels: { env: "prod" },
            aws: dummyAws,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("aws inventory v2");
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsSources({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmmigration", "live"],
    timeout: 120_000,
  },
);
