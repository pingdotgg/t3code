import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { AppImageUpdater, autoUpdater } from "electron-updater";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { verifyAppImageInstalls } from "./AppImageInstall.ts";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
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
>()("@t3tools/desktop/electron/ElectronUpdater") {}

/** @public */
export const make = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const runSync = Effect.runSyncWith(context);
  const log = makeComponentLogger("desktop-updater");
  const bridge =
    (level: "logDebug" | "logInfo" | "logWarning" | "logError") =>
    (...args: Array<unknown>) => {
      const message = args.map(String).join(" ");
      runSync(
        log[level](message).pipe(
          Effect.withSpan("desktop.updater", {
            attributes: { component: "desktop-updater", level },
          }),
        ),
      );
    };
  let instance: AutoUpdater | undefined;
  let restoreLogger = () => {};
  yield* Effect.addFinalizer(() => Effect.sync(() => restoreLogger()));

  // electron-updater picks the platform updater on first access of `autoUpdater`.
  const getUpdater = () => {
    if (instance !== undefined) return instance;
    const updater = autoUpdater;
    const previousLogger = updater.logger;
    updater.logger = {
      debug: bridge("logDebug"),
      info: bridge("logInfo"),
      warn: bridge("logWarning"),
      error: bridge("logError"),
    };
    restoreLogger = () => {
      updater.logger = previousLogger;
    };
    if (updater instanceof AppImageUpdater) {
      // The dependency's onQuit handler can install after this scope closes.
      verifyAppImageInstalls(updater);
    }
    instance = updater;
    return updater;
  };

  return ElectronUpdater.of({
    setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function (options) {
      return Effect.sync(() => getUpdater().setFeedURL(options));
    }),
    setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function (value) {
      return Effect.sync(() => {
        getUpdater().autoDownload = value;
      });
    }),
    setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function (value) {
      return Effect.sync(() => {
        getUpdater().autoInstallOnAppQuit = value;
      });
    }),
    setChannel: Effect.fn("ElectronUpdater.setChannel")(function (channel) {
      return Effect.sync(() => {
        getUpdater().channel = channel;
      });
    }),
    setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function (value) {
      return Effect.sync(() => {
        getUpdater().allowPrerelease = value;
      });
    }),
    allowDowngrade: Effect.sync(() => getUpdater().allowDowngrade),
    setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function (value) {
      return Effect.sync(() => {
        getUpdater().allowDowngrade = value;
      });
    }),
    setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function (value) {
      return Effect.sync(() => {
        getUpdater().fullChangelog = value;
      });
    }),
    setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
      function (value) {
        return Effect.sync(() => {
          getUpdater().disableDifferentialDownload = value;
        });
      },
    ),
    checkForUpdates: Effect.suspend(() => {
      const updater = getUpdater();
      const channel = updater.channel;
      return Effect.tryPromise({
        try: () => updater.checkForUpdates(),
        catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    downloadUpdate: Effect.suspend(() => {
      const updater = getUpdater();
      const channel = updater.channel;
      return Effect.tryPromise({
        try: () => updater.downloadUpdate(),
        catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function ({
      isSilent,
      isForceRunAfter,
    }) {
      return Effect.suspend(() => {
        const updater = getUpdater();
        const channel = updater.channel;
        return Effect.try({
          try: () => updater.quitAndInstall(isSilent, isForceRunAfter),
          catch: (cause) =>
            new ElectronUpdaterQuitAndInstallError({
              channel,
              isSilent,
              isForceRunAfter,
              cause,
            }),
        });
      });
    }),
    on: Effect.fn("ElectronUpdater.on")(function (eventName, listener) {
      return Effect.suspend(() => {
        const eventTarget = getUpdater() as unknown as {
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
      });
    }),
  });
});

export const layer = Layer.effect(ElectronUpdater, make);
