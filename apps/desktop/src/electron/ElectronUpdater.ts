import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { autoUpdater } from "electron-updater";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Data.TaggedError(
  "ElectronUpdaterCheckForUpdatesError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Electron updater failed to check for updates.";
  }
}

export class ElectronUpdaterDownloadUpdateError extends Data.TaggedError(
  "ElectronUpdaterDownloadUpdateError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Electron updater failed to download the update.";
  }
}

export class ElectronUpdaterQuitAndInstallError extends Data.TaggedError(
  "ElectronUpdaterQuitAndInstallError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Electron updater failed to quit and install the update.";
  }
}

export type ElectronUpdaterError =
  | ElectronUpdaterCheckForUpdatesError
  | ElectronUpdaterDownloadUpdateError
  | ElectronUpdaterQuitAndInstallError;

export interface ElectronUpdaterShape {
  readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
  readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
  readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
  readonly setChannel: (channel: string) => Effect.Effect<void>;
  readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
  readonly allowDowngrade: Effect.Effect<boolean>;
  readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
  readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
  readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
  readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
  readonly quitAndInstall: (options: {
    readonly isSilent: boolean;
    readonly isForceRunAfter: boolean;
  }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
  readonly on: <Args extends ReadonlyArray<unknown>>(
    eventName: string,
    listener: (...args: Args) => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export class ElectronUpdater extends Context.Service<ElectronUpdater, ElectronUpdaterShape>()(
  "t3/desktop/electron/Updater",
) {}

export const layer = Layer.succeed(ElectronUpdater, {
  setFeedURL: (options) =>
    Effect.suspend(() => {
      autoUpdater.setFeedURL(options);
      return Effect.void;
    }),
  setAutoDownload: (value) =>
    Effect.suspend(() => {
      autoUpdater.autoDownload = value;
      return Effect.void;
    }),
  setAutoInstallOnAppQuit: (value) =>
    Effect.suspend(() => {
      autoUpdater.autoInstallOnAppQuit = value;
      return Effect.void;
    }),
  setChannel: (channel) =>
    Effect.suspend(() => {
      autoUpdater.channel = channel;
      return Effect.void;
    }),
  setAllowPrerelease: (value) =>
    Effect.suspend(() => {
      autoUpdater.allowPrerelease = value;
      return Effect.void;
    }),
  allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
  setAllowDowngrade: (value) =>
    Effect.suspend(() => {
      autoUpdater.allowDowngrade = value;
      return Effect.void;
    }),
  setDisableDifferentialDownload: (value) =>
    Effect.suspend(() => {
      autoUpdater.disableDifferentialDownload = value;
      return Effect.void;
    }),
  checkForUpdates: Effect.tryPromise({
    try: () => autoUpdater.checkForUpdates(),
    catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ cause }),
  }).pipe(Effect.asVoid),
  downloadUpdate: Effect.tryPromise({
    try: () => autoUpdater.downloadUpdate(),
    catch: (cause) => new ElectronUpdaterDownloadUpdateError({ cause }),
  }).pipe(Effect.asVoid),
  quitAndInstall: ({ isSilent, isForceRunAfter }) =>
    Effect.try({
      try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
      catch: (cause) => new ElectronUpdaterQuitAndInstallError({ cause }),
    }),
  on: (eventName, listener) => {
    const eventTarget = autoUpdater as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
    };
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return Effect.acquireRelease(
      Effect.sync(() => {
        eventTarget.on(eventName, untypedListener);
      }),
      () =>
        Effect.sync(() => {
          eventTarget.removeListener(eventName, untypedListener);
        }),
    ).pipe(Effect.asVoid);
  },
} satisfies ElectronUpdaterShape);
