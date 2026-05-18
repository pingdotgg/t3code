import {
  DesktopServerExposureModeSchema,
  DesktopUpdateChannelSchema,
  type DesktopServerExposureMode,
  type DesktopUpdateChannel,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDefaultDesktopUpdateChannel } from "../updates/updateChannels.ts";
import { isValidDistroName } from "../wsl/wslPathParsing.ts";

export interface DesktopSettings {
  readonly serverExposureMode: DesktopServerExposureMode;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updateChannelConfiguredByUser: boolean;
  // Was a "local" | "wsl" swap mode in an earlier iteration of the WSL
  // integration. We now run Windows and WSL backends side by side, so the
  // setting is just whether the WSL backend should be running alongside the
  // primary. Persisted documents that still carry the legacy `wslMode: "wsl"`
  // value are migrated to `wslBackendEnabled: true` on load.
  readonly wslBackendEnabled: boolean;
  readonly wslDistro: string | null;
  // When true (and wslBackendEnabled is also true) the desktop runs only
  // the WSL backend as the primary, and the Windows-side Node backend is
  // not started. Designed for users who develop entirely inside WSL and
  // don't want a second backend process running. Defaults to false so
  // existing setups stay on the parallel-backends behavior. Changing
  // this requires a desktop restart because the pool's primary spec is
  // chosen once at layer init.
  readonly wslOnly: boolean;
}

export interface DesktopSettingsChange {
  readonly settings: DesktopSettings;
  readonly changed: boolean;
}

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  serverExposureMode: "local-only",
  tailscaleServeEnabled: false,
  tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  updateChannel: "latest",
  updateChannelConfiguredByUser: false,
  wslBackendEnabled: false,
  wslDistro: null,
  wslOnly: false,
};

const DesktopSettingsDocument = Schema.Struct({
  serverExposureMode: Schema.optionalKey(DesktopServerExposureModeSchema),
  tailscaleServeEnabled: Schema.optionalKey(Schema.Boolean),
  tailscaleServePort: Schema.optionalKey(Schema.Number),
  updateChannel: Schema.optionalKey(DesktopUpdateChannelSchema),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  // Newer form of the WSL toggle. `wslMode` is still accepted on load so
  // existing on-disk settings keep working; on the next persist we write the
  // new boolean and the legacy key drops out.
  wslBackendEnabled: Schema.optionalKey(Schema.Boolean),
  wslMode: Schema.optionalKey(Schema.Literals(["local", "wsl"])),
  wslDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  wslOnly: Schema.optionalKey(Schema.Boolean),
});

type DesktopSettingsDocument = typeof DesktopSettingsDocument.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DesktopSettingsJson = fromLenientJson(DesktopSettingsDocument);
const decodeDesktopSettingsJson = Schema.decodeEffect(DesktopSettingsJson);
const encodeDesktopSettingsJson = Schema.encodeEffect(DesktopSettingsJson);

const settingsChange = (settings: DesktopSettings, changed: boolean): DesktopSettingsChange => ({
  settings,
  changed,
});

export class DesktopSettingsWriteError extends Data.TaggedError("DesktopSettingsWriteError")<{
  readonly cause: PlatformError.PlatformError | Schema.SchemaError;
}> {
  override get message() {
    return `Failed to write desktop settings: ${this.cause.message}`;
  }
}

export interface DesktopAppSettingsShape {
  readonly load: Effect.Effect<DesktopSettings>;
  readonly get: Effect.Effect<DesktopSettings>;
  readonly setServerExposureMode: (
    mode: DesktopServerExposureMode,
  ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  readonly setTailscaleServe: (input: {
    readonly enabled: boolean;
    readonly port: Option.Option<number>;
  }) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  readonly setUpdateChannel: (
    channel: DesktopUpdateChannel,
  ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  readonly setWslBackendEnabled: (
    enabled: boolean,
  ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  readonly setWslDistro: (
    distro: string | null,
  ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  readonly setWslOnly: (
    enabled: boolean,
  ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
}

export class DesktopAppSettings extends Context.Service<
  DesktopAppSettings,
  DesktopAppSettingsShape
>()("t3/desktop/AppSettings") {}

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: resolveDefaultDesktopUpdateChannel(appVersion),
  };
}

function normalizeTailscaleServePort(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : DEFAULT_TAILSCALE_SERVE_PORT;
}

function normalizeWslDistro(value: unknown): string | null {
  return typeof value === "string" && isValidDistroName(value) ? value : null;
}

function normalizeDesktopSettingsDocument(
  parsed: DesktopSettingsDocument,
  appVersion: string,
): DesktopSettings {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);
  const parsedUpdateChannel = Option.fromNullishOr(parsed.updateChannel);
  const isLegacySettings = parsed.updateChannelConfiguredByUser === undefined;
  const updateChannelConfiguredByUser =
    parsed.updateChannelConfiguredByUser === true ||
    (isLegacySettings && Option.contains(parsedUpdateChannel, "nightly"));

  // Newer form wins when both are present; otherwise fall back to the legacy
  // `wslMode === "wsl"` signal so users coming off the swap-mode build keep
  // their WSL backend enabled.
  const wslBackendEnabled =
    parsed.wslBackendEnabled === true ||
    (parsed.wslBackendEnabled === undefined && parsed.wslMode === "wsl");

  return {
    serverExposureMode:
      parsed.serverExposureMode === "network-accessible" ? "network-accessible" : "local-only",
    tailscaleServeEnabled: parsed.tailscaleServeEnabled === true,
    tailscaleServePort: normalizeTailscaleServePort(parsed.tailscaleServePort),
    updateChannel: updateChannelConfiguredByUser
      ? Option.getOrElse(parsedUpdateChannel, () => defaultSettings.updateChannel)
      : defaultSettings.updateChannel,
    updateChannelConfiguredByUser,
    wslBackendEnabled,
    wslDistro: normalizeWslDistro(parsed.wslDistro),
    wslOnly: parsed.wslOnly === true,
  };
}

function toDesktopSettingsDocument(
  settings: DesktopSettings,
  defaults: DesktopSettings,
): DesktopSettingsDocument {
  const document: Mutable<DesktopSettingsDocument> = {};

  if (settings.serverExposureMode !== defaults.serverExposureMode) {
    document.serverExposureMode = settings.serverExposureMode;
  }
  if (settings.tailscaleServeEnabled !== defaults.tailscaleServeEnabled) {
    document.tailscaleServeEnabled = settings.tailscaleServeEnabled;
  }
  if (settings.tailscaleServePort !== defaults.tailscaleServePort) {
    document.tailscaleServePort = settings.tailscaleServePort;
  }
  if (settings.updateChannel !== defaults.updateChannel) {
    document.updateChannel = settings.updateChannel;
  }
  if (settings.updateChannelConfiguredByUser !== defaults.updateChannelConfiguredByUser) {
    document.updateChannelConfiguredByUser = settings.updateChannelConfiguredByUser;
  }
  if (settings.wslBackendEnabled !== defaults.wslBackendEnabled) {
    document.wslBackendEnabled = settings.wslBackendEnabled;
  }
  if (settings.wslDistro !== defaults.wslDistro) {
    document.wslDistro = settings.wslDistro;
  }
  if (settings.wslOnly !== defaults.wslOnly) {
    document.wslOnly = settings.wslOnly;
  }

  return document;
}

function setServerExposureMode(
  settings: DesktopSettings,
  requestedMode: DesktopServerExposureMode,
): DesktopSettings {
  return settings.serverExposureMode === requestedMode
    ? settings
    : {
        ...settings,
        serverExposureMode: requestedMode,
      };
}

function setTailscaleServe(
  settings: DesktopSettings,
  input: { readonly enabled: boolean; readonly port: Option.Option<number> },
): DesktopSettings {
  const port = Option.match(input.port, {
    onNone: () => settings.tailscaleServePort,
    onSome: normalizeTailscaleServePort,
  });
  return settings.tailscaleServeEnabled === input.enabled && settings.tailscaleServePort === port
    ? settings
    : {
        ...settings,
        tailscaleServeEnabled: input.enabled,
        tailscaleServePort: port,
      };
}

function setUpdateChannel(
  settings: DesktopSettings,
  requestedChannel: DesktopUpdateChannel,
): DesktopSettings {
  return settings.updateChannel === requestedChannel
    ? settings
    : {
        ...settings,
        updateChannel: requestedChannel,
        updateChannelConfiguredByUser: true,
      };
}

function setWslBackendEnabled(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.wslBackendEnabled === enabled
    ? settings
    : {
        ...settings,
        wslBackendEnabled: enabled,
      };
}

function setWslDistro(settings: DesktopSettings, distro: string | null): DesktopSettings {
  const normalized = normalizeWslDistro(distro);
  return settings.wslDistro === normalized
    ? settings
    : {
        ...settings,
        wslDistro: normalized,
      };
}

function setWslOnly(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.wslOnly === enabled
    ? settings
    : {
        ...settings,
        wslOnly: enabled,
      };
}

function readSettings(
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
  appVersion: string,
): Effect.Effect<DesktopSettings> {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);

  return fileSystem.readFileString(settingsPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(defaultSettings),
        onSome: (raw) =>
          decodeDesktopSettingsJson(raw).pipe(
            Effect.map((parsed) => normalizeDesktopSettingsDocument(parsed, appVersion)),
            Effect.catch(() => Effect.succeed(defaultSettings)),
          ),
      }),
    ),
  );
}

const writeSettings = Effect.fn("desktop.settings.writeSettings")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: DesktopSettings;
  readonly defaultSettings: DesktopSettings;
}): Effect.fn.Return<void, PlatformError.PlatformError | Schema.SchemaError> {
  const directory = input.path.dirname(input.settingsPath);
  const suffix = (yield* Random.nextUUIDv4).replace(/-/g, "");
  const tempPath = `${input.settingsPath}.${process.pid}.${suffix}.tmp`;
  const encoded = yield* encodeDesktopSettingsJson(
    toDesktopSettingsDocument(input.settings, input.defaultSettings),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true });
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`);
  yield* input.fileSystem.rename(tempPath, input.settingsPath);
});

export const layer = Layer.effect(
  DesktopAppSettings,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settingsRef = yield* SynchronizedRef.make(environment.defaultDesktopSettings);

    const persist = (
      update: (settings: DesktopSettings) => DesktopSettings,
    ): Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError> =>
      SynchronizedRef.modifyEffect(settingsRef, (settings) => {
        const nextSettings = update(settings);
        if (nextSettings === settings) {
          return Effect.succeed([settingsChange(settings, false), settings] as const);
        }

        return writeSettings({
          fileSystem,
          path,
          settingsPath: environment.desktopSettingsPath,
          settings: nextSettings,
          defaultSettings: environment.defaultDesktopSettings,
        }).pipe(
          Effect.mapError((cause) => new DesktopSettingsWriteError({ cause })),
          Effect.as([settingsChange(nextSettings, true), nextSettings] as const),
        );
      });

    return DesktopAppSettings.of({
      get: SynchronizedRef.get(settingsRef),
      load: Effect.gen(function* () {
        const settings = yield* readSettings(
          fileSystem,
          environment.desktopSettingsPath,
          environment.appVersion,
        );
        return yield* SynchronizedRef.setAndGet(settingsRef, settings);
      }).pipe(Effect.withSpan("desktop.settings.load")),
      setServerExposureMode: (mode) =>
        persist((settings) => setServerExposureMode(settings, mode)).pipe(
          Effect.withSpan("desktop.settings.setServerExposureMode", { attributes: { mode } }),
        ),
      setTailscaleServe: (input) =>
        persist((settings) => setTailscaleServe(settings, input)).pipe(
          Effect.withSpan("desktop.settings.setTailscaleServe", { attributes: input }),
        ),
      setUpdateChannel: (channel) =>
        persist((settings) => setUpdateChannel(settings, channel)).pipe(
          Effect.withSpan("desktop.settings.setUpdateChannel", { attributes: { channel } }),
        ),
      setWslBackendEnabled: (enabled) =>
        persist((settings) => setWslBackendEnabled(settings, enabled)).pipe(
          Effect.withSpan("desktop.settings.setWslBackendEnabled", { attributes: { enabled } }),
        ),
      setWslDistro: (distro) =>
        persist((settings) => setWslDistro(settings, distro)).pipe(
          Effect.withSpan("desktop.settings.setWslDistro", {
            attributes: { distro: distro ?? null },
          }),
        ),
      setWslOnly: (enabled) =>
        persist((settings) => setWslOnly(settings, enabled)).pipe(
          Effect.withSpan("desktop.settings.setWslOnly", { attributes: { enabled } }),
        ),
    });
  }),
);

export const layerTest = (initialSettings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS) =>
  Layer.effect(
    DesktopAppSettings,
    Effect.gen(function* () {
      const settingsRef = yield* SynchronizedRef.make(initialSettings);
      const update = (f: (settings: DesktopSettings) => DesktopSettings) =>
        SynchronizedRef.modify(settingsRef, (settings) => {
          const nextSettings = f(settings);
          return [
            {
              settings: nextSettings,
              changed: nextSettings !== settings,
            },
            nextSettings,
          ] as const;
        });

      return DesktopAppSettings.of({
        get: SynchronizedRef.get(settingsRef),
        load: SynchronizedRef.get(settingsRef),
        setServerExposureMode: (mode) =>
          update((settings) => setServerExposureMode(settings, mode)),
        setTailscaleServe: (input) => update((settings) => setTailscaleServe(settings, input)),
        setUpdateChannel: (channel) => update((settings) => setUpdateChannel(settings, channel)),
        setWslBackendEnabled: (enabled) =>
          update((settings) => setWslBackendEnabled(settings, enabled)),
        setWslDistro: (distro) => update((settings) => setWslDistro(settings, distro)),
        setWslOnly: (enabled) => update((settings) => setWslOnly(settings, enabled)),
      });
    }),
  );
