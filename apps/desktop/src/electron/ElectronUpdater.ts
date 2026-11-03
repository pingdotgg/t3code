import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";
import { autoUpdater } from "electron-updater";

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

export class ElectronUpdaterPrepareInstallError extends Schema.TaggedError<ElectronUpdaterPrepareInstallError>()(
  "ElectronUpdaterPrepareInstallError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Squirrel.Mac could not prepare the downloaded update.";
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterPrepareInstallError,
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
    /**
     * macOS only. Squirrel.Mac unpacks and verifies a downloaded update only when asked;
     * asking early overlaps that with the backend stop.
     */
    readonly prepareInstall: Effect.Effect<void, ElectronUpdaterPrepareInstallError>;
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

/** The part of Electron's native (Squirrel.Mac) updater that preparing an install uses. */
export interface NativeUpdater {
  on(event: "update-downloaded" | "update-not-available", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "update-downloaded" | "update-not-available", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: string, listener: (...args: Array<never>) => void): unknown;
  checkForUpdates(): void;
}

// electron-updater marks the update ready on Squirrel's update-downloaded, so its
// quitAndInstall then quits at once instead of asking Squirrel itself.
export const makePrepareInstall = (native: () => NativeUpdater) => {
  // Mirrors MacUpdater's own flag: Squirrel prepares a downloaded update once per launch. The
  // watchers stay, so a check that outlives our timeout still counts and is not started twice.
  let prepared = false;
  let checking = false;
  let watching = false;
  return Effect.callback<void, ElectronUpdaterPrepareInstallError>((resume) => {
    const updater = native();
    if (!watching) {
      watching = true;
      updater.on("update-downloaded", () => {
        prepared = true;
        checking = false;
      });
      updater.on("update-not-available", () => {
        checking = false;
      });
      updater.on("error", () => {
        checking = false;
      });
    }
    if (prepared) {
      resume(Effect.void);
      return;
    }
    const removeListeners = () => {
      updater.removeListener("update-downloaded", onDownloaded);
      updater.removeListener("update-not-available", onNotAvailable);
      updater.removeListener("error", onError);
    };
    const fail = (cause: unknown) => {
      removeListeners();
      resume(Effect.fail(new ElectronUpdaterPrepareInstallError({ cause })));
    };
    const onDownloaded = () => {
      removeListeners();
      resume(Effect.void);
    };
    const onNotAvailable = () => fail(new Error("Squirrel.Mac found no update to prepare."));
    const onError = (cause: Error) => fail(cause);
    updater.once("update-downloaded", onDownloaded);
    updater.once("update-not-available", onNotAvailable);
    updater.once("error", onError);
    if (!checking) {
      checking = true;
      try {
        updater.checkForUpdates();
      } catch (cause) {
        checking = false;
        fail(cause);
      }
    }
    return Effect.sync(removeListeners);
  }).pipe(
    // Backends are already stopping; a silent Squirrel must end in recovery, not a stuck quit.
    // Squirrel may still finish afterwards, and then installs on the next quit.
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () =>
        Effect.fail(
          new ElectronUpdaterPrepareInstallError({
            cause: new Error("Squirrel.Mac did not finish preparing the update."),
          }),
        ),
    }),
    Effect.withSpan("ElectronUpdater.prepareInstall"),
  );
};

/** @public */
export const make = ElectronUpdater.of({
  setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function (options) {
    return Effect.suspend(() => {
      autoUpdater.setFeedURL(options);
      return Effect.void;
    });
  }),
  setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.autoDownload = value;
      return Effect.void;
    });
  }),
  setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.autoInstallOnAppQuit = value;
      return Effect.void;
    });
  }),
  setChannel: Effect.fn("ElectronUpdater.setChannel")(function (channel) {
    return Effect.suspend(() => {
      autoUpdater.channel = channel;
      return Effect.void;
    });
  }),
  setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.allowPrerelease = value;
      return Effect.void;
    });
  }),
  allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
  setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.allowDowngrade = value;
      return Effect.void;
    });
  }),
  setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.fullChangelog = value;
      return Effect.void;
    });
  }),
  setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
    function (value) {
      return Effect.suspend(() => {
        autoUpdater.disableDifferentialDownload = value;
        return Effect.void;
      });
    },
  ),
  checkForUpdates: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.downloadUpdate(),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  prepareInstall: makePrepareInstall(() => Electron.autoUpdater),
  quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function ({
    isSilent,
    isForceRunAfter,
  }) {
    return Effect.suspend(() => {
      const channel = autoUpdater.channel;
      return Effect.try({
        try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
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
  }),
});

export const layer = Layer.succeed(ElectronUpdater, make);
