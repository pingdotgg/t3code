import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";

const DesktopSettingsPatch = Schema.Struct({
  linuxPasswordStore: Schema.optionalKey(
    Schema.Literals(["auto", "gnome-libsecret", "kwallet", "kwallet5", "kwallet6"]),
  ),
  mainWindowBounds: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
    ),
  ),
  mainWindowMaximized: Schema.optionalKey(Schema.Boolean),
  serverExposureMode: Schema.optionalKey(Schema.Literals(["local-only", "network-accessible"])),
  tailscaleServeEnabled: Schema.optionalKey(Schema.Boolean),
  tailscaleServePort: Schema.optionalKey(Schema.Number),
  updateChannel: Schema.optionalKey(Schema.Literals(["latest", "nightly"])),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  wslBackendEnabled: Schema.optionalKey(Schema.Boolean),
  wslMode: Schema.optionalKey(Schema.Literals(["local", "wsl"])),
  wslDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  wslOnly: Schema.optionalKey(Schema.Boolean),
});

const decodeDesktopSettingsPatch = Schema.decodeEffect(Schema.fromJsonString(DesktopSettingsPatch));
const encodeDesktopSettingsPatch = Schema.encodeEffect(Schema.fromJsonString(DesktopSettingsPatch));

function layerEnvironment(baseDir: string, appVersion = "0.0.17") {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
}

const withSettings = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopAppSettings.DesktopAppSettings | DesktopEnvironment.DesktopEnvironment
  >,
  options?: { readonly appVersion?: string },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-settings-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopAppSettings.layer.pipe(
          Layer.provideMerge(layerEnvironment(baseDir, options?.appVersion)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

function writeSettingsPatch(patch: typeof DesktopSettingsPatch.Type) {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* encodeDesktopSettingsPatch(patch);
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    yield* fileSystem.writeFileString(environment.desktopSettingsPath, `${encoded}\n`);
  });
}

describe("DesktopSettings", () => {
  it.effect(
    "persists disabling and re-enabling local execution without clearing backend settings",
    () =>
      withSettings(
        Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* settings.setWslBackendEnabled(true);
          yield* settings.setWslDistro("Ubuntu");
          yield* settings.setServerExposureMode("network-accessible");
          const before = yield* settings.get;
          assert.isTrue((yield* settings.setLocalEnvironmentEnabled(false)).changed);
          assert.deepEqual(yield* settings.load, { ...before, localEnvironmentEnabled: false });
          assert.isFalse((yield* settings.setLocalEnvironmentEnabled(false)).changed);
          yield* settings.setLocalEnvironmentEnabled(true);
          assert.deepEqual(yield* settings.load, before);
        }),
      ),
  );

  it.effect("falls back to defaults when the settings file is malformed", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.desktopSettingsPath, "{not-json");

        assert.deepEqual(yield* settings.load, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );

  it.effect("loads lenient persisted desktop settings JSON", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.desktopSettingsPath,
          `{
            // JSONC-style comments and trailing commas match server settings parsing.
            "serverExposureMode": "network-accessible",
            "tailscaleServeEnabled": true,
            "tailscaleServePort": 8443,
            "mainWindowBounds": { "x": 120, "y": 80, "width": 1280, "height": 900 },
          }\n`,
        );

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
          localEnvironmentEnabled: true,
          mainWindowBounds: { x: 120, y: 80, width: 1280, height: 900 },
          mainWindowMaximized: false,
          serverExposureMode: "network-accessible",
          tailscaleServeEnabled: true,
          tailscaleServePort: 8443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
        } satisfies DesktopAppSettings.DesktopSettings);
      }),
    ),
  );

  it.effect("rejects window bounds that do not satisfy the domain schema", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          mainWindowBounds: { x: 10.5, y: 20, width: 839, height: 620 },
          mainWindowMaximized: true,
          serverExposureMode: "network-accessible",
        });

        const loaded = yield* settings.load;
        assert.isNull(loaded.mainWindowBounds);
        assert.isFalse(loaded.mainWindowMaximized);
        assert.equal(loaded.serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect("persists sparse desktop settings documents", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setMainWindowBounds({ x: -1200, y: 40, width: 1440, height: 960 }, true);
        yield* settings.setServerExposureMode("network-accessible");

        const persisted = yield* decodeDesktopSettingsPatch(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
        );
        assert.deepEqual(persisted, {
          mainWindowBounds: { x: -1200, y: 40, width: 1440, height: 960 },
          mainWindowMaximized: true,
          serverExposureMode: "network-accessible",
        } satisfies typeof DesktopSettingsPatch.Type);
      }),
    ),
  );

  it.effect("saves through a symlinked settings file without replacing the link", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const dotfiles = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-settings-dotfiles-",
        });
        const linkedSettingsPath = `${dotfiles}/desktop-settings.json`;
        yield* fileSystem.writeFileString(linkedSettingsPath, "{}\n");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.symlink(linkedSettingsPath, environment.desktopSettingsPath);

        yield* settings.setServerExposureMode("network-accessible");

        assert.equal(
          yield* fileSystem.readLink(environment.desktopSettingsPath),
          linkedSettingsPath,
        );
        const persisted = yield* decodeDesktopSettingsPatch(
          yield* fileSystem.readFileString(linkedSettingsPath),
        );
        assert.equal(persisted.serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect("migrates legacy implicit update channels to the runtime default", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          serverExposureMode: "local-only",
          updateChannel: "latest",
        });

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
          localEnvironmentEnabled: true,
          mainWindowBounds: null,
          mainWindowMaximized: false,
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "nightly",
          updateChannelConfiguredByUser: false,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
        } satisfies DesktopAppSettings.DesktopSettings);
      }),
      { appVersion: "0.0.17-nightly.20260415.1" },
    ),
  );

  it.effect("preserves explicit stable update channel on nightly builds", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          serverExposureMode: "local-only",
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
        });

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
          localEnvironmentEnabled: true,
          mainWindowBounds: null,
          mainWindowMaximized: false,
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
        } satisfies DesktopAppSettings.DesktopSettings);
      }),
      { appVersion: "0.0.17-nightly.20260415.1" },
    ),
  );

  it.effect("persists wsl backend toggle and normalizes invalid distro names", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const enable = yield* settings.setWslBackendEnabled(true);
        assert.isTrue(enable.changed);
        assert.equal(enable.settings.wslBackendEnabled, true);

        const distro = yield* settings.setWslDistro("Ubuntu-22.04");
        assert.isTrue(distro.changed);
        assert.equal(distro.settings.wslDistro, "Ubuntu-22.04");

        const reloaded = yield* settings.load;
        assert.equal(reloaded.wslBackendEnabled, true);
        assert.equal(reloaded.wslDistro, "Ubuntu-22.04");

        const reject = yield* settings.setWslDistro("bad name!");
        assert.equal(reject.settings.wslDistro, null);

        const noop = yield* settings.setWslDistro(null);
        assert.isFalse(noop.changed);
      }),
    ),
  );

  it.effect("applies WSL Windows fallback with persisted and volatile updates", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setWslBackendEnabled(true);
        yield* settings.setWslOnly(true);

        const persistedFallback = yield* settings.applyWslWindowsFallback;
        assert.isTrue(persistedFallback.changed);
        assert.equal(persistedFallback.settings.wslBackendEnabled, false);
        assert.equal(persistedFallback.settings.wslOnly, false);

        const persistedReload = yield* settings.load;
        assert.equal(persistedReload.wslBackendEnabled, false);
        assert.equal(persistedReload.wslOnly, false);

        yield* settings.setWslBackendEnabled(true);
        yield* settings.setWslOnly(true);

        const volatileFallback = yield* settings.applyWslWindowsFallbackInMemory;
        assert.isTrue(volatileFallback.changed);
        assert.equal(volatileFallback.settings.wslBackendEnabled, false);
        assert.equal(volatileFallback.settings.wslOnly, false);

        const current = yield* settings.get;
        assert.equal(current.wslBackendEnabled, false);
        assert.equal(current.wslOnly, false);

        const diskReload = yield* settings.load;
        assert.equal(diskReload.wslBackendEnabled, true);
        assert.equal(diskReload.wslOnly, true);
      }),
    ),
  );

  it.effect("migrates legacy wslMode=wsl to wslBackendEnabled on load", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          wslMode: "wsl",
          wslDistro: "Ubuntu-22.04",
        });
        const loaded = yield* settings.load;
        assert.equal(loaded.wslBackendEnabled, true);
        assert.equal(loaded.wslDistro, "Ubuntu-22.04");
      }),
    ),
  );
});
