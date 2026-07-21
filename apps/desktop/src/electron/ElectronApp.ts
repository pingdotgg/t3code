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

export class ElectronAppMetadataReadError extends Schema.TaggedErrorClass<ElectronAppMetadataReadError>()(
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

export class ElectronAppWhenReadyError extends Schema.TaggedErrorClass<ElectronAppWhenReadyError>()(
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
    readonly whenReady: Effect.Effect<void, ElectronAppWhenReadyError>;
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
    readonly requestSingleInstanceLock: Effect.Effect<boolean>;
    readonly isDefaultProtocolClient: (protocol: string) => Effect.Effect<boolean>;
    readonly setAsDefaultProtocolClient: (
      protocol: string,
      path?: string,
      args?: readonly string[],
    ) => Effect.Effect<boolean>;
    readonly setDesktopName: (desktopName: string) => Effect.Effect<void>;
    readonly setDockIcon: (iconPath: string) => Effect.Effect<void>;
    readonly appendCommandLineSwitch: (switchName: string, value?: string) => Effect.Effect<void>;
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
  whenReady: Effect.gen(function* () {
    const isPackaged = Electron.app.isPackaged;
    yield* Effect.tryPromise({
      try: () => Electron.app.whenReady(),
      catch: (cause) => new ElectronAppWhenReadyError({ isPackaged, cause }),
    });
  }),
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
  requestSingleInstanceLock: Effect.sync(() => Electron.app.requestSingleInstanceLock()),
  isDefaultProtocolClient: (protocol) =>
    Effect.sync(() => Electron.app.isDefaultProtocolClient(protocol)),
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
  on: addScopedAppListener,
});

export const layer = Layer.succeed(ElectronApp, make);
