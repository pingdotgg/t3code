import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export interface ElectronAppMetadata {
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runningUnderArm64Translation: boolean;
}

export interface ElectronAppShape {
  readonly metadata: Effect.Effect<ElectronAppMetadata>;
  readonly name: Effect.Effect<string>;
  readonly whenReady: Effect.Effect<void>;
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
  readonly setDesktopName: (desktopName: string) => Effect.Effect<void>;
  readonly setDockIcon: (iconPath: string) => Effect.Effect<void>;
  readonly appendCommandLineSwitch: (switchName: string, value?: string) => Effect.Effect<void>;
  readonly on: <Args extends ReadonlyArray<unknown>>(
    eventName: string,
    listener: (...args: Args) => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export class ElectronApp extends Context.Service<ElectronApp, ElectronAppShape>()(
  "t3/desktop/electron/App",
) {}

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

const make = ElectronApp.of({
  metadata: Effect.sync(() => ({
    appVersion: Electron.app.getVersion(),
    appPath: Electron.app.getAppPath(),
    isPackaged: Electron.app.isPackaged,
    resourcesPath: process.resourcesPath,
    runningUnderArm64Translation: Electron.app.runningUnderARM64Translation === true,
  })),
  name: Effect.sync(() => Electron.app.name),
  whenReady: Effect.promise(() => Electron.app.whenReady()).pipe(Effect.asVoid),
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
