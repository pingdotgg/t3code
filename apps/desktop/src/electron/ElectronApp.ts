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
    /** Packaged builds ship only en-US; app.getLocale() and Intl defaults do not reflect the OS locale. */
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

export function toSystemLocaleTag(identifier: string, hourCycle?: "h12" | "h23"): string {
  const [base = "", keywords = ""] = identifier.split("@");
  const languageTag = base.replace(/_/g, "-");
  // Intl ignores rg extensions, so the macOS region override must replace the region subtag.
  const region = /(?:^|;)rg=([a-z]{2}|\d{3})zzzz(?:;|$)/i.exec(keywords)?.[1]?.toUpperCase();
  try {
    return new Intl.Locale(languageTag, {
      ...(region ? { region } : {}),
      ...(hourCycle ? { hourCycle } : {}),
    }).toString();
  } catch {
    return languageTag;
  }
}

/** @public */
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
    let identifier = Electron.app.getSystemLocale();
    let hourCycle: "h12" | "h23" | undefined;
    if (platform === "linux") {
      const env = yield* HostProcess.Environment;
      const timeLocale = (env.LC_ALL || env.LC_TIME || env.LANG)?.split(".")[0];
      if (timeLocale && timeLocale !== "C" && timeLocale !== "POSIX") identifier = timeLocale;
    } else if (platform === "darwin") {
      if (Electron.systemPreferences.getUserDefault("AppleICUForce24HourTime", "boolean")) {
        hourCycle = "h23";
      } else if (Electron.systemPreferences.getUserDefault("AppleICUForce12HourTime", "boolean")) {
        hourCycle = "h12";
      }
    }
    return toSystemLocaleTag(identifier, hourCycle);
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
  exit: Effect.fn("ElectronApp.exit")(function (code) {
    return Effect.sync(() => {
      Electron.app.exit(code);
    });
  }),
  relaunch: Effect.fn("ElectronApp.relaunch")(function (options) {
    return Effect.sync(() => {
      Electron.app.relaunch(options);
    });
  }),
  setPath: Effect.fn("ElectronApp.setPath")(function (name, path) {
    return Effect.sync(() => {
      Electron.app.setPath(name, path);
    });
  }),
  setName: Effect.fn("ElectronApp.setName")(function (name) {
    return Effect.sync(() => {
      Electron.app.setName(name);
    });
  }),
  setAboutPanelOptions: Effect.fn("ElectronApp.setAboutPanelOptions")(function (options) {
    return Effect.sync(() => {
      Electron.app.setAboutPanelOptions(options);
    });
  }),
  setAppUserModelId: Effect.fn("ElectronApp.setAppUserModelId")(function (id) {
    return Effect.sync(() => {
      Electron.app.setAppUserModelId(id);
    });
  }),
  getAppMetrics: Effect.sync(() => Electron.app.getAppMetrics()),
  setAsDefaultProtocolClient: Effect.fn("ElectronApp.setAsDefaultProtocolClient")(
    function (protocol, path, args) {
      return Effect.sync(() => {
        if (path === undefined) {
          return Electron.app.setAsDefaultProtocolClient(protocol);
        }
        return Electron.app.setAsDefaultProtocolClient(protocol, path, [...(args ?? [])]);
      });
    },
  ),
  setDesktopName: Effect.fn("ElectronApp.setDesktopName")(function (desktopName) {
    return Effect.sync(() => {
      const linuxApp = Electron.app as Electron.App & {
        setDesktopName?: (desktopName: string) => void;
      };
      linuxApp.setDesktopName?.(desktopName);
    });
  }),
  setDockIcon: Effect.fn("ElectronApp.setDockIcon")(function (iconPath) {
    return Effect.sync(() => {
      Electron.app.dock?.setIcon(iconPath);
    });
  }),
  appendCommandLineSwitch: Effect.fn("ElectronApp.appendCommandLineSwitch")(
    function (switchName, value) {
      return Effect.sync(() => {
        if (value === undefined) {
          Electron.app.commandLine.appendSwitch(switchName);
          return;
        }
        Electron.app.commandLine.appendSwitch(switchName, value);
      });
    },
  ),
  onBeforeQuitForUpdate: Effect.fn("ElectronApp.onBeforeQuitForUpdate")(function (listener) {
    return Effect.acquireRelease(
      Effect.sync(() => {
        Electron.autoUpdater.on("before-quit-for-update", listener);
      }),
      () =>
        Effect.sync(() => {
          Electron.autoUpdater.removeListener("before-quit-for-update", listener);
        }),
    ).pipe(Effect.asVoid);
  }),
  removeCommandLineSwitch: Effect.fn("ElectronApp.removeCommandLineSwitch")(function (switchName) {
    return Effect.sync(() => {
      Electron.app.commandLine.removeSwitch(switchName);
    });
  }),
  on: addScopedAppListener,
});

export const layer = Layer.succeed(ElectronApp, make);
