import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export interface ElectronAppMetadata {
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runningUnderArm64Translation: boolean;
}

export class ElectronAppMetadataReadError extends Schema.TaggedError<ElectronAppMetadataReadError>()(
  "ElectronAppMetadataReadError",
  {
    property: Schema.Literals(["app-version", "app-path"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read Electron app metadata property "${this.property}".`;
  }
}

export class ElectronAppWhenReadyError extends Schema.TaggedError<ElectronAppWhenReadyError>()(
  "ElectronAppWhenReadyError",
  {
    isPackaged: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to wait for the Electron app to become ready (packaged: ${this.isPackaged}).`;
  }
}

export class ElectronApp extends Context.Service<
  ElectronApp,
  {
    readonly metadata: Effect.Effect<ElectronAppMetadata, ElectronAppMetadataReadError>;
    readonly name: Effect.Effect<string>;
    /**
     * The OS locale, read from the operating system rather than from Chromium's
     * resolved application locale — the packaged app ships only the `en-US`
     * locale pak, so `app.getLocale()` and the renderer's `Intl` default are
     * pinned to `en-US` however the machine is configured. It carries the
     * macOS region override and 12/24-hour preference, and the Linux LC_TIME
     * locale.
     */
    readonly systemLocale: Effect.Effect<string>;
    readonly whenReady: Effect.Effect<void, ElectronAppWhenReadyError>;
    readonly requestSingleInstanceLock: Effect.Effect<boolean>;
    readonly quit: Effect.Effect<void>;
    readonly exit: (code: number) => Effect.Effect<void>;
    readonly relaunch: (options: Electron.RelaunchOptions) => Effect.Effect<void>;
    readonly setPath: (
      name: Parameters<Electron.App["setPath"]>[0],
      path: string,
    ) => Effect.Effect<void>;
    readonly setName: (name: string) => Effect.Effect<void>;
    readonly setAboutPanelOptions: (
      options: Electron.AboutPanelOptionsOptions,
    ) => Effect.Effect<void>;
    readonly setAppUserModelId: (id: string) => Effect.Effect<void>;
    readonly getAppMetrics: Effect.Effect<ReadonlyArray<Electron.ProcessMetric>>;
    readonly setAsDefaultProtocolClient: (
      protocol: string,
      path?: string,
      args?: readonly string[],
    ) => Effect.Effect<boolean>;
    readonly setDesktopName: (desktopName: string) => Effect.Effect<void>;
    readonly setDockIcon: (iconPath: string) => Effect.Effect<void>;
    readonly appendCommandLineSwitch: (switchName: string, value?: string) => Effect.Effect<void>;
    readonly onBeforeQuitForUpdate: (
      listener: () => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly removeCommandLineSwitch: (switchName: string) => Effect.Effect<void>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronApp") {}

const addScopedAppListener = <Args extends ReadonlyArray<unknown>>(
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      Electron.app.on(eventName as any, listener as any);
    }),
    () =>
      Effect.sync(() => {
        Electron.app.removeListener(eventName as any, listener as any);
      }),
  ).pipe(Effect.asVoid);

type SystemHourCycle = "h12" | "h23";

/**
 * Turns an OS locale identifier into a tag `Intl` accepts. macOS reports ICU
 * identifiers (`en_GB`, `en_US@rg=nlzzzz`) and Linux POSIX ones
 * (`sr_RS@latin`), and `Intl` rejects both outright, which drops the renderer
 * back to `en-US`.
 */
export function toSystemLocaleTag(identifier: string, hourCycle?: SystemHourCycle): string {
  const [base = "", keywords = ""] = identifier.split("@");
  const languageTag = base.replace(/_/g, "-");
  // macOS writes `rg` when the region is set apart from the language, and the
  // region picks the date formats. V8 ignores a `-u-rg` extension, so the
  // override has to become the region subtag.
  const region = /(?:^|;)rg=([a-z]{2}|\d{3})/i.exec(keywords)?.[1]?.toUpperCase();
  try {
    return new Intl.Locale(languageTag, {
      ...(region ? { region } : {}),
      ...(hourCycle ? { hourCycle } : {}),
    }).toString();
  } catch {
    return languageTag;
  }
}

// The macOS 24-hour toggle lives outside the locale identifier.
function readMacHourCycle(): SystemHourCycle | undefined {
  const prefs = Electron.systemPreferences;
  if (prefs.getUserDefault("AppleICUForce24HourTime", "boolean")) return "h23";
  if (prefs.getUserDefault("AppleICUForce12HourTime", "boolean")) return "h12";
  return undefined;
}

// Chromium reads the Linux locale from the language categories, but desktops
// set date formats apart from the language through LC_TIME.
function readLinuxTimeLocale(env: NodeJS.ProcessEnv): string | undefined {
  // libc's precedence for the time category, where an empty value is unset.
  const value = env.LC_ALL || env.LC_TIME || env.LANG;
  const locale = value?.split(".")[0];
  return locale && locale !== "C" && locale !== "POSIX" ? locale : undefined;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronApp.of({
  metadata: Effect.gen(function* () {
    const appVersion = yield* Effect.try({
      try: () => Electron.app.getVersion(),
      catch: (cause) =>
        new ElectronAppMetadataReadError({
          property: "app-version",
          cause,
        }),
    });
    const appPath = yield* Effect.try({
      try: () => Electron.app.getAppPath(),
      catch: (cause) =>
        new ElectronAppMetadataReadError({
          property: "app-path",
          cause,
        }),
    });

    return {
      appVersion,
      appPath,
      isPackaged: Electron.app.isPackaged,
      resourcesPath: process.resourcesPath,
      runningUnderArm64Translation: Electron.app.runningUnderARM64Translation === true,
    };
  }),
  name: Effect.sync(() => Electron.app.name),
  systemLocale: Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (platform === "linux") {
      const timeLocale = readLinuxTimeLocale(yield* HostProcess.Environment);
      if (timeLocale) return toSystemLocaleTag(timeLocale);
    }
    return toSystemLocaleTag(
      Electron.app.getSystemLocale(),
      platform === "darwin" ? readMacHourCycle() : undefined,
    );
  }),
  whenReady: Effect.gen(function* () {
    const isPackaged = Electron.app.isPackaged;
    yield* Effect.tryPromise({
      try: () => Electron.app.whenReady(),
      catch: (cause) => new ElectronAppWhenReadyError({ isPackaged, cause }),
    });
  }),
  requestSingleInstanceLock: Effect.sync(() => Electron.app.requestSingleInstanceLock()),
  quit: Effect.sync(() => {
    Electron.app.quit();
  }),
  exit: (code) =>
    Effect.sync(() => {
      Electron.app.exit(code);
    }),
  relaunch: (options) =>
    Effect.sync(() => {
      Electron.app.relaunch(options);
    }),
  setPath: (name, path) =>
    Effect.sync(() => {
      Electron.app.setPath(name, path);
    }),
  setName: (name) =>
    Effect.sync(() => {
      Electron.app.setName(name);
    }),
  setAboutPanelOptions: (options) =>
    Effect.sync(() => {
      Electron.app.setAboutPanelOptions(options);
    }),
  setAppUserModelId: (id) =>
    Effect.sync(() => {
      Electron.app.setAppUserModelId(id);
    }),
  getAppMetrics: Effect.sync(() => Electron.app.getAppMetrics()),
  setAsDefaultProtocolClient: (protocol, path, args) =>
    Effect.sync(() => {
      if (path === undefined) {
        return Electron.app.setAsDefaultProtocolClient(protocol);
      }
      return Electron.app.setAsDefaultProtocolClient(protocol, path, [...(args ?? [])]);
    }),
  setDesktopName: (desktopName) =>
    Effect.sync(() => {
      const linuxApp = Electron.app as Electron.App & {
        setDesktopName?: (desktopName: string) => void;
      };
      linuxApp.setDesktopName?.(desktopName);
    }),
  setDockIcon: (iconPath) =>
    Effect.sync(() => {
      Electron.app.dock?.setIcon(iconPath);
    }),
  appendCommandLineSwitch: (switchName, value) =>
    Effect.sync(() => {
      if (value === undefined) {
        Electron.app.commandLine.appendSwitch(switchName);
        return;
      }
      Electron.app.commandLine.appendSwitch(switchName, value);
    }),
  onBeforeQuitForUpdate: (listener) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        Electron.autoUpdater.on("before-quit-for-update", listener);
      }),
      () =>
        Effect.sync(() => {
          Electron.autoUpdater.removeListener("before-quit-for-update", listener);
        }),
    ).pipe(Effect.asVoid),
  removeCommandLineSwitch: (switchName) =>
    Effect.sync(() => {
      Electron.app.commandLine.removeSwitch(switchName);
    }),
  on: addScopedAppListener,
});

export const layer = Layer.succeed(ElectronApp, make);
