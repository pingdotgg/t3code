import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

const clientSettings: ClientSettings = {
  autoOpenPlanSidebar: false,
  confirmThreadArchive: true,
  confirmThreadDelete: false,
  dismissedProviderUpdateNotificationKeys: [],
  diffIgnoreWhitespace: true,
  diffWordWrap: true,
  favorites: [],
  providerModelPreferences: {},
  sidebarProjectGroupingMode: "repository_path",
  sidebarProjectGroupingOverrides: {
    "environment-1:/tmp/project-a": "separate",
  },
  sidebarProjectSortOrder: "manual",
  sidebarThreadSortOrder: "created_at",
  sidebarThreadPreviewCount: 6,
  timestampFormat: "24-hour",
};

const decodeClientSettingsJson = Schema.decodeEffect(Schema.fromJsonString(ClientSettingsSchema));
const decodeRecordJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

function makeLayer(baseDir: string) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  return DesktopClientSettings.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withClientSettings = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopClientSettings.DesktopClientSettings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-client-settings-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopClientSettings", () => {
  it.effect("returns none when no client settings file exists", () =>
    withClientSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        assert.isTrue(Option.isNone(yield* settings.get));
      }),
    ),
  );

  it.effect("persists and reloads client settings", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* settings.set(clientSettings);

        assert.deepEqual(yield* settings.get, Option.some(clientSettings));
        assert.deepEqual(
          yield* decodeClientSettingsJson(
            yield* fileSystem.readFileString(environment.clientSettingsPath),
          ),
          clientSettings,
        );
        assert.isFalse(
          Object.hasOwn(
            yield* decodeRecordJson(
              yield* fileSystem.readFileString(environment.clientSettingsPath),
            ),
            "settings",
          ),
        );
      }),
    ),
  );

  it.effect("loads lenient direct client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            // Matches server settings parsing.
            "timestampFormat": "24-hour",
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.equal(persisted.value.timestampFormat, "24-hour");
        }
      }),
    ),
  );

  it.effect("loads legacy wrapped client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            "settings": {
              "timestampFormat": "12-hour"
            }
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.equal(persisted.value.timestampFormat, "12-hour");
        }
      }),
    ),
  );

  it.effect("loads defaults from empty client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.clientSettingsPath, "{}\n");

        assert.deepEqual(yield* settings.get, Option.some(yield* decodeClientSettingsJson("{}")));
      }),
    ),
  );

  it.effect("treats malformed client settings documents as absent", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.clientSettingsPath, "{not-json");

        assert.isTrue(Option.isNone(yield* settings.get));
      }),
    ),
  );
});
