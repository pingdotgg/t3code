import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as osconfig from "@distilled.cloud/gcp/osconfig_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  osconfig.getFoldersLocationsGlobalPolicyOrchestrators({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// The OS Config API is disabled on the testing project (every call fails
// with ServiceDisabled), and folder orchestrators need a folder. Set
// GCP_TEST_OSCONFIG=1 and GOOGLE_FOLDER_ID on a project with OS Config
// enabled.
const folderId = process.env.GOOGLE_FOLDER_ID;
const runLifecycle = !!process.env.GCP_TEST_OSCONFIG && !!folderId;

const folderOf = () =>
  Effect.succeed(
    folderId === undefined
      ? ""
      : folderId.startsWith("folders/")
        ? folderId
        : `folders/${folderId}`,
  );

test.provider(
  "getFoldersLocationsGlobalPolicyOrchestrators on a missing orchestrator fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = (yield* folderOf()) || "folders/0";
      const error = yield* Effect.flip(
        osconfig.getFoldersLocationsGlobalPolicyOrchestrators({
          name: `${folder}/locations/global/policyOrchestrators/alchemy-missing-orch`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:osconfig", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a folder policy orchestrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = yield* folderOf();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OSConfig.FoldersLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              folderId: folder,
              description: "folder validation",
              labels: { env: "test" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(created.policyOrchestratorId).toEqual(expect.any(String));
      expect(created.folderId).toEqual(folder.replace("folders/", ""));
      expect(created.parent).toEqual(`${folder}/locations/global`);
      expect(created.name).toEqual(
        `${folder}/locations/global/policyOrchestrators/${created.policyOrchestratorId}`,
      );
      expect(created.state).toEqual("STOPPED");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* osconfig.getFoldersLocationsGlobalPolicyOrchestrators({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OSConfig.FoldersLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              folderId: folder,
              policyOrchestratorId: created.policyOrchestratorId,
              description: "updated folder",
              labels: { env: "prod" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated folder");
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:osconfig", "live"], timeout: 90_000 },
);
