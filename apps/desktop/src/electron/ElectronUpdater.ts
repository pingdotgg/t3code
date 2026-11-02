import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

type AutoUpdater = (typeof import("electron-updater"))["autoUpdater"];

const loadAutoUpdater = Effect.promise(async () => (await import("electron-updater")).autoUpdater);

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
export const make = ElectronUpdater.of({
  setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function* (options) {
    const autoUpdater = yield* loadAutoUpdater;
    autoUpdater.setFeedURL(options);
  }),
  setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function* (value) {
    const autoUpdater = yield* loadAutoUpdater;
    autoUpdater.autoDownload = value;
  }),
  setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function* (value) {
    const autoUpdater = yield* loadAutoUpdater;
    autoUpdater.autoInstallOnAppQuit = value;
  }),
  setChannel: Effect.fn("ElectronUpdater.setChannel")(function* (channel) {
    const autoUpdater = yield* loadAutoUpdater;
    autoUpdater.channel = channel;
  }),
  setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function* (value) {
    const autoUpdater = yield* loadAutoUpdater;
    autoUpdater.allowPrerelease = value;
  }),
  allowDowngrade: loadAutoUpdater.pipe(Effect.map((autoUpdater) => autoUpdater.allowDowngrade)),
  setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function* (value) {
    const autoUpdater = yield* loadAutoUpdater;
    autoUpdater.allowDowngrade = value;
  }),
  setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function* (value) {
    const autoUpdater = yield* loadAutoUpdater;
    autoUpdater.fullChangelog = value;
  }),
  setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
    function* (value) {
      const autoUpdater = yield* loadAutoUpdater;
      autoUpdater.disableDifferentialDownload = value;
    },
  ),
  checkForUpdates: Effect.gen(function* () {
    const autoUpdater = yield* loadAutoUpdater;
    const channel = autoUpdater.channel;
    yield* Effect.tryPromise({
      try: () => autoUpdater.checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.gen(function* () {
    const autoUpdater = yield* loadAutoUpdater;
    const channel = autoUpdater.channel;
    yield* Effect.tryPromise({
      try: () => autoUpdater.downloadUpdate(),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function* ({
    isSilent,
    isForceRunAfter,
  }) {
    const autoUpdater = yield* loadAutoUpdater;
    const channel = autoUpdater.channel;
    yield* Effect.try({
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
  on: Effect.fn("ElectronUpdater.on")(function* (eventName, listener) {
    const autoUpdater = yield* loadAutoUpdater;
    const eventTarget = autoUpdater as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
    };
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    yield* Effect.acquireRelease(
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
