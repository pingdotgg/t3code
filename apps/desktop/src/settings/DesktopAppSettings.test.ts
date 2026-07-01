import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";

const DesktopSettingsPatch = Schema.Struct({
  linuxPasswordStore: Schema.optionalKey(
    Schema.Literals(["auto", "gnome-libsecret", "kwallet", "kwallet5", "kwallet6"]),
  ),
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

function makeEnvironmentLayer(baseDir: string, appVersion = "0.0.17") {
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
          Layer.provideMerge(makeEnvironmentLayer(baseDir, options?.appVersion)),
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
  it.effect("loads defaults when no settings file exists", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.deepEqual(yield* settings.load, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
        assert.deepEqual(yield* settings.get, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );

  it("defaults packaged nightly builds to the nightly update channel", () => {
    assert.deepEqual(
      DesktopAppSettings.resolveDefaultDesktopSettings("0.0.17-nightly.20260415.1"),
      {
        linuxPasswordStore: "auto",
        serverExposureMode: "local-only",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        updateChannel: "nightly",
        updateChannelConfiguredByUser: false,
        wslBackendEnabled: false,
        wslOnly: false,
        wslDistro: null,
      } satisfies DesktopAppSettings.DesktopSettings,
    );
  });

  it.effect("loads persisted settings and applies semantic updates", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          linuxPasswordStore: "gnome-libsecret",
          serverExposureMode: "network-accessible",
          tailscaleServeEnabled: true,
          tailscaleServePort: 8443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
        });

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "gnome-libsecret",
          serverExposureMode: "network-accessible",
          tailscaleServeEnabled: true,
          tailscaleServePort: 8443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
        } satisfies DesktopAppSettings.DesktopSettings);

        const exposure = yield* settings.setServerExposureMode("local-only");
        assert.isTrue(exposure.changed);
        assert.equal(exposure.settings.serverExposureMode, "local-only");

        const tailscale = yield* settings.setTailscaleServe({
          enabled: true,
          port: Option.some(9443),
        });
        assert.isTrue(tailscale.changed);
        assert.equal(tailscale.settings.tailscaleServePort, 9443);

        const updateChannel = yield* settings.setUpdateChannel("nightly");
        assert.isTrue(updateChannel.changed);
        assert.equal(updateChannel.settings.updateChannel, "nightly");
        assert.equal(updateChannel.settings.updateChannelConfiguredByUser, true);
      }),
    ),
  );

  it.effect("reports the failed desktop settings write operation and path", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.desktopSettingsPath, { recursive: true });

        const error = yield* settings.setServerExposureMode("network-accessible").pipe(Effect.flip);
        assert.instanceOf(error, DesktopAppSettings.DesktopSettingsWriteError);
        assert.equal(error.operation, "replace-settings-file");
        assert.equal(error.path, environment.desktopSettingsPath);
        assert.exists(error.cause);
        assert.equal(
          error.message,
          `Desktop settings write failed during replace-settings-file at ${environment.desktopSettingsPath}.`,
        );
      }),
    ),
  );

  it.effect("does not persist no-op semantic updates", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        const exposure = yield* settings.setServerExposureMode("local-only");
        assert.isFalse(exposure.changed);

        const tailscale = yield* settings.setTailscaleServe({
          enabled: false,
          port: Option.none(),
        });
        assert.isFalse(tailscale.changed);

        const updateChannel = yield* settings.setUpdateChannel("latest");
        assert.isFalse(updateChannel.changed);
        assert.equal(updateChannel.settings.updateChannelConfiguredByUser, false);
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
          }\n`,
        );

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
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

  it.effect(
    "normalizes unsupported linux password-store values without dropping other settings",
    () =>
      withSettings(
        Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fileSystem = yield* FileSystem.FileSystem;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
          yield* fileSystem.writeFileString(
            environment.desktopSettingsPath,
            `{
            "linuxPasswordStore": "unsupported-store",
            "serverExposureMode": "network-accessible",
            "tailscaleServeEnabled": true,
            "tailscaleServePort": 8443,
            "updateChannel": "nightly",
            "updateChannelConfiguredByUser": true
          }\n`,
          );

          assert.deepEqual(yield* settings.load, {
            linuxPasswordStore: "auto",
            serverExposureMode: "network-accessible",
            tailscaleServeEnabled: true,
            tailscaleServePort: 8443,
            updateChannel: "nightly",
            updateChannelConfiguredByUser: true,
          } satisfies DesktopAppSettings.DesktopSettings);
        }),
      ),
  );

  it.effect("persists sparse desktop settings documents", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setServerExposureMode("network-accessible");

        const persisted = yield* decodeDesktopSettingsPatch(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
        );
        assert.deepEqual(persisted, {
          serverExposureMode: "network-accessible",
        } satisfies typeof DesktopSettingsPatch.Type);
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

  it.effect("normalizes invalid persisted Tailscale Serve ports", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          tailscaleServeEnabled: true,
          tailscaleServePort: 0,
        });

        assert.deepEqual(yield* settings.load, {
          linuxPasswordStore: "auto",
          serverExposureMode: "local-only",
          tailscaleServeEnabled: true,
          tailscaleServePort: 443,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          wslBackendEnabled: false,
          wslOnly: false,
          wslDistro: null,
        } satisfies DesktopAppSettings.DesktopSettings);
      }),
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

  it.effect("drops invalid persisted wsl distro values on load", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          wslBackendEnabled: true,
          wslDistro: "bad/name",
        });
        const loaded = yield* settings.load;
        assert.equal(loaded.wslBackendEnabled, true);
        assert.equal(loaded.wslDistro, null);
      }),
    ),
  );
});
