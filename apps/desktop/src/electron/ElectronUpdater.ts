import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { AppImageUpdater, autoUpdater } from "electron-updater";

import { verifyAppImageInstalls } from "./AppImageInstall.ts";
import { DesktopTraceFlush, makeComponentLogger } from "../app/DesktopObservability.ts";

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

const makeWithUpdater = (getUpdater: () => AutoUpdater) =>
  ElectronUpdater.of({
    setFeedURL: (options) =>
      Effect.suspend(() => {
        getUpdater().setFeedURL(options);
        return Effect.void;
      }),
    setAutoDownload: (value) =>
      Effect.suspend(() => {
        getUpdater().autoDownload = value;
        return Effect.void;
      }),
    setAutoInstallOnAppQuit: (value) =>
      Effect.suspend(() => {
        getUpdater().autoInstallOnAppQuit = value;
        return Effect.void;
      }),
    setChannel: (channel) =>
      Effect.suspend(() => {
        getUpdater().channel = channel;
        return Effect.void;
      }),
    setAllowPrerelease: (value) =>
      Effect.suspend(() => {
        getUpdater().allowPrerelease = value;
        return Effect.void;
      }),
    allowDowngrade: Effect.sync(() => getUpdater().allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.suspend(() => {
        getUpdater().allowDowngrade = value;
        return Effect.void;
      }),
    setFullChangelog: (value) =>
      Effect.suspend(() => {
        getUpdater().fullChangelog = value;
        return Effect.void;
      }),
    setDisableDifferentialDownload: (value) =>
      Effect.suspend(() => {
        getUpdater().disableDifferentialDownload = value;
        return Effect.void;
      }),
    checkForUpdates: Effect.suspend(() => {
      const autoUpdater = getUpdater();
      const channel = autoUpdater.channel;
      return Effect.tryPromise({
        try: () => autoUpdater.checkForUpdates(),
        catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    downloadUpdate: Effect.suspend(() => {
      const autoUpdater = getUpdater();
      const channel = autoUpdater.channel;
      return Effect.tryPromise({
        try: () => autoUpdater.downloadUpdate(),
        catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.suspend(() => {
        const autoUpdater = getUpdater();
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
      }),
    on: (eventName, listener) =>
      Effect.suspend(() => {
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
      }),
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = makeWithUpdater(() => autoUpdater);

export const layer = Layer.effect(
  ElectronUpdater,
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const { flush } = yield* DesktopTraceFlush;
    const runSync = Effect.runSyncWith(context);
    const runPromise = Effect.runPromiseWith(context);
    const log = makeComponentLogger("desktop-updater");
    const bridge =
      (level: "logDebug" | "logInfo" | "logWarning" | "logError") =>
      (...args: Array<unknown>) => {
        const message = args
          .slice(0, 4)
          .map((value) => {
            try {
              return typeof value === "string"
                ? value
                : JSON.stringify(value, (_key, item) =>
                    item instanceof Error ? item.message : item,
                  );
            } catch {
              return String(value);
            }
          })
          .join(" ")
          .slice(0, 2048);
        runSync(
          log[level](message).pipe(
            // The text can name paths or URLs, so it stays in the log record.
            // Span attributes keep only bounded values.
            Effect.withSpan("desktop.updater", {
              attributes: { component: "desktop-updater", level },
            }),
          ),
        );
      };
    let instance: AutoUpdater | undefined;
    let restore = () => {};
    yield* Effect.addFinalizer(() => Effect.sync(() => restore()));
    return makeWithUpdater(() => {
      if (instance !== undefined) return instance;
      const updater = autoUpdater;
      instance = updater;
      const previousLogger = updater.logger;
      updater.logger = {
        debug: bridge("logDebug"),
        info: bridge("logInfo"),
        warn: bridge("logWarning"),
        error: bridge("logError"),
      };
      let restoreAdapter = () => {};
      if (instance instanceof AppImageUpdater) {
        // Keep the verified installer for the process lifetime. Scope release
        // must not make a later install fall back to the destructive installer.
        verifyAppImageInstalls(instance);
        const internals = instance as unknown as {
          app: { quit(): void };
          spawnLog(...args: Array<unknown>): Promise<boolean>;
        };
        const adapter = internals.app;
        const previousQuit = adapter.quit;
        const previousSpawnLog = internals.spawnLog;
        // Explicit quitAndInstall launches the new AppImage during the
        // synchronous install, then schedules this quit. The new app exits if
        // this one still holds the single-instance lock, so drain the install
        // records before the launch and quit right after it.
        let drained: Promise<void> | undefined;
        internals.spawnLog = function (...args) {
          const launch = () => previousSpawnLog.apply(this, args);
          // Start once the install call has unwound, so spans that end as
          // quitAndInstall returns are drained too. The scheduled quit runs
          // after this and waits for the same drain.
          drained = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
            runPromise(flush),
          );
          return drained.then(launch, launch);
        };
        adapter.quit = function () {
          void (drained ?? runPromise(flush)).finally(() => previousQuit.call(this));
        };
        restoreAdapter = () => {
          adapter.quit = previousQuit;
          internals.spawnLog = previousSpawnLog;
        };
      }
      restore = () => {
        updater.logger = previousLogger;
        restoreAdapter();
      };
      return instance;
    });
  }),
);
