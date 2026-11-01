import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const configV1 = {
  metadata: {
    severity: "LOW",
    description: "test",
    recommendation: "investigate",
  },
  ips: ["192.0.2.1"],
};

const configV2 = {
  ...configV1,
  ips: ["192.0.2.1", "192.0.2.0/24"],
};

const waitUntilGone = (name: string) =>
  scc.getFoldersEventThreatDetectionSettingsCustomModules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// Folder-level Security Command Center needs a folder under an organization
// with SCC activated and folder-level SCC roles for the test identity. Set
// GCP_TEST_SECURITY_CENTER=1 and GOOGLE_FOLDER_ID when both hold.
const folderId = process.env.GOOGLE_FOLDER_ID;
const runLifecycle = !!process.env.GCP_TEST_SECURITY_CENTER && !!folderId;

const folderOf = () =>
  Effect.succeed(
    folderId === undefined
      ? ""
      : folderId.startsWith("folders/")
        ? folderId
        : `folders/${folderId}`,
  );

test.provider(
  "getFoldersEventThreatDetectionSettingsCustomModules on a missing module fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = (yield* folderOf()) || "folders/0";
      const error = yield* Effect.flip(
        scc.getFoldersEventThreatDetectionSettingsCustomModules({
          name: `${folder}/eventThreatDetectionSettings/customModules/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a folder Event Threat Detection custom module",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = yield* folderOf();
      const parent = folder
        ? `${folder}/eventThreatDetectionSettings`
        : "folders/0/eventThreatDetectionSettings";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityCenter.FolderEventThreatDetectionSettingsCustomModule(
            "BadIp",
            {
              folder,
              type: "CONFIGURABLE_BAD_IP",
              config: configV1,
              description: "test bad ip",
            },
          );
        }),
      );

      expect(created.moduleId).toEqual(expect.any(String));
      expect(created.folder).toEqual(folder);
      expect(created.name).toContain(
        `${folder}/eventThreatDetectionSettings/customModules/`,
      );
      expect(created.description).toEqual("test bad ip");

      const fetched =
        yield* scc.getFoldersEventThreatDetectionSettingsCustomModules({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityCenter.FolderEventThreatDetectionSettingsCustomModule(
            "BadIp",
            {
              folder,
              type: "CONFIGURABLE_BAD_IP",
              config: configV2,
              description: "updated bad ip",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated bad ip");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);
