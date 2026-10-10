import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkebackup from "@distilled.cloud/gcp/gkebackup_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "getProjectsLocationsBackupChannels on a missing channel fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkebackup.getProjectsLocationsBackupChannels({
          name: `projects/${project}/locations/us-central1/backupChannels/alchemy-missing-channel`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* gkebackup.listProjectsLocationsBackupChannels({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect(
        (page.backupChannels ?? []).map((item) => item.name),
      ).not.toContain(
        `projects/${project}/locations/us-central1/backupChannels/alchemy-missing-channel`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkebackup", "live"], timeout: 90_000 },
);

test.provider(
  "create with same-project destination is rejected with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.GKEBackup.BackupChannel("Channel", {
              destinationProject: `projects/${project}`,
              description: "alchemy-test-channel",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain(
        "source and destination project cannot be same",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkebackup", "live"], timeout: 90_000 },
);
