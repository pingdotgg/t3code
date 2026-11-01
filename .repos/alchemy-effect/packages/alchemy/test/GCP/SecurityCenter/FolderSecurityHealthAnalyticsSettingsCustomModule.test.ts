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

const customConfigV1 = {
  predicate: { expression: 'resource.name == "alchemy-nonexistent"' },
  resourceSelector: {
    resourceTypes: ["compute.googleapis.com/Instance"],
  },
  severity: "LOW" as const,
  description: "unused detector",
  recommendation: "n/a",
};

const customConfigV2 = {
  ...customConfigV1,
  severity: "MEDIUM" as const,
  description: "updated unused detector",
};

const waitUntilGone = (name: string) =>
  scc.getFoldersSecurityHealthAnalyticsSettingsCustomModules({ name }).pipe(
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
  "getFoldersSecurityHealthAnalyticsSettingsCustomModules on a missing module fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = (yield* folderOf()) || "folders/0";
      const error = yield* Effect.flip(
        scc.getFoldersSecurityHealthAnalyticsSettingsCustomModules({
          name: `${folder}/securityHealthAnalyticsSettings/customModules/alchemy-missing`,
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
  "create, update, and delete a folder Security Health Analytics custom module",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = yield* folderOf();
      const parent = folder
        ? `${folder}/securityHealthAnalyticsSettings`
        : "folders/0/securityHealthAnalyticsSettings";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityCenter.FolderSecurityHealthAnalyticsSettingsCustomModule(
            "Unused",
            {
              folder,
              customConfig: customConfigV1,
            },
          );
        }),
      );

      expect(created.moduleId).toEqual(expect.any(String));
      expect(created.folder).toEqual(folder);
      expect(created.name).toContain(
        `${folder}/securityHealthAnalyticsSettings/customModules/`,
      );
      expect(created.customConfig?.description).toEqual("unused detector");

      const fetched =
        yield* scc.getFoldersSecurityHealthAnalyticsSettingsCustomModules({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.customConfig?.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityCenter.FolderSecurityHealthAnalyticsSettingsCustomModule(
            "Unused",
            {
              folder,
              displayName: created.displayName,
              customConfig: customConfigV2,
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.customConfig?.description).toEqual(
        "updated unused detector",
      );
      expect(updated.customConfig?.severity).toEqual("MEDIUM");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);
