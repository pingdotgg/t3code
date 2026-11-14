import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  DesktopUpdateChannelSchema,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import { makeUpdateEventHandlers } from "./desktopUpdateEventHandlers.ts";
import { makeUpdateInstall } from "./desktopUpdateInstall.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
  resolveNotAppliedInstallVersion,
} from "./updateMachine.ts";

const CHANNEL_CHANGE_RETRY_DELAY = Duration.seconds(1);
const CHANNEL_CHANGE_RETRIES = 30;
const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";
const PREPARED_INSTALL_CHECK_WAIT = Duration.seconds(90);

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly isActionActive: Effect.Effect<boolean>;
    readonly isInstallActive: Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    /** `minimumVersion` is a track switch's checked release; nothing older is offered after. */
    readonly setChannel: (
      channel: DesktopUpdateChannel,
      options?: { readonly minimumVersion?: string | undefined },
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    /** `allowDowngrade` is for a guarded track switch, which checked that older release. */
    readonly check: (
      reason: string,
      options?: { readonly allowDowngrade?: boolean },
    ) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

/** @public */
export * from "./desktopUpdateErrors.ts";

import {
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelManagedError,
  DesktopUpdateChannelPersistenceError,
  DesktopUpdateEventHandlingError,
  DesktopUpdatePollerError,
  DesktopUpdateUnexpectedActionError,
  DesktopUpdaterReportedError,
  DesktopUpdateSetChannelError,
} from "./desktopUpdateErrors.ts";
export { describeUpdateErrorCause } from "./desktopUpdateSupport.ts";
export * from "./desktopUpdateSchema.ts";

import {
  describeUpdateErrorCause,
  parseAppUpdateYml,
  createBaseUpdateState,
  getCanRetryFromState,
  shouldBroadcastDownloadProgress,
  getAutoUpdateDisabledReason,
  isArm64HostRunningIntelBuild,
} from "./desktopUpdateSupport.ts";
import {
  currentIsoTimestamp,
  decodeAppUpdateYmlConfig,
  decodeDownloadProgressInfo,
  decodeInstallRecord,
  decodeUpdateInfo,
  DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  encodeInstallRecord,
  type AppUpdateYmlConfig,
  type DesktopPreparedUpdateInstallResult,
  type UpdateAction,
} from "./desktopUpdateSchema.ts";

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;
  // Any user can set the mock flag, so it never replaces an administrator's update source.
  const mockUpdates = config.mockUpdates && policy.message === null;

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const installRunningBackendsRef = yield* Ref.make<
    ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>
  >([]);
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const notAppliedVersionRef = yield* Ref.make(Option.none<string>());
  // The release a track switch's database check cleared. A build crosses to another track only
  // through such a switch, and never below that release: version order alone cannot tell whether
  // a Stable knows a Nightly's migrations.
  const releaseFloorRef = yield* Ref.make(Option.none<string>());
  const offerable = (version: string, state: DesktopUpdateState) =>
    Ref.get(releaseFloorRef).pipe(
      Effect.map(
        (floor) =>
          desktopUpdateChannelOf(version) === state.channel &&
          (Option.isSome(floor)
            ? compareSemverVersions(version, floor.value) >= 0
            : desktopUpdateChannelOf(environment.appVersion) === state.channel),
      ),
    );
  const updateStateRef = yield* Ref.make<DesktopUpdateState>(
    createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
  );

  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  // Serialize writes and publishes against subscription so snapshots cannot overlap the first change.
  const stateMutex = yield* Semaphore.make(1);

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    stateMutex
      .withPermits(1)(
        Ref.set(updateStateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      )
      .pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  // electron-updater uses this marker to install .deb updates with dpkg.
  const isDebPackage =
    environment.platform === "linux" && environment.isPackaged
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.resourcesPath, "package-type"))
          .pipe(
            Effect.map((packageType) => packageType.trim() === "deb"),
            Effect.orElseSucceed(() => false),
          )
      : false;

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map(
      (appUpdateYmlConfig) =>
        Option.isSome(appUpdateYmlConfig) || mockUpdates || policy.feedUrl !== undefined,
    ),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        policy,
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        isDebPackage,
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  // Without nightly, an install on that channel stays put until its user picks stable: moving it
  // silently would be a downgrade nobody asked for, and checking nightly would break the policy.
  const channelBlockedReason = (channel: DesktopUpdateChannel): Option.Option<string> =>
    channel === "nightly" && !policy.allowNightly
      ? Option.some(
          `${policy.message ?? "Nightly updates are turned off on this machine."} Switch to the stable channel to keep getting updates.`,
        )
      : Option.none();

  const resolveStateDisabledReason = (channel: DesktopUpdateChannel) =>
    resolveDisabledReason.pipe(Effect.map(Option.orElse(() => channelBlockedReason(channel))));

  const activeUpdateAction = Ref.get(activeUpdateActionRef);

  const tryStartUpdateAction = (action: UpdateAction): Effect.Effect<boolean> =>
    Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) ? [false, activeAction] : [true, Option.some(action)],
    );

  const tryStartChannelChange = Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction)
      ? [activeAction, activeAction]
      : [Option.none<UpdateAction>(), Option.some<UpdateAction>("channel")],
  );

  const finishUpdateAction = (action: UpdateAction): Effect.Effect<void> =>
    Ref.modify(activeUpdateActionRef, (activeAction) => {
      const finished = Option.isSome(activeAction) && activeAction.value === action;
      return [finished, finished ? Option.none() : activeAction] as const;
    }).pipe(
      Effect.flatMap((finished) =>
        finished ? PubSub.publish(finishedUpdateActions, action).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    // An older build can lack migrations this one ran. Only a guarded track switch's own check
    // may offer one.
    yield* electronUpdater.setAllowDowngrade(false);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      fullChangelog: allowsPrerelease,
    });
  });

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (
    reason: string,
    actionReservation: "acquire" | "held" = "acquire",
    allowDowngrade = false,
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;

    const state = yield* Ref.get(updateStateRef);
    // A configured updater is disabled only by a channel the managed policy blocks.
    if (state.status === "disabled") return false;
    if (state.status === "downloading") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (actionReservation === "acquire" && !(yield* tryStartUpdateAction("check"))) return false;

    const check = Effect.gen(function* () {
      const checkedAt = yield* currentIsoTimestamp;
      yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
      yield* logUpdaterInfo("checking for updates", { reason });

      // The flag is shared updater state, so it flips only while this check holds the reservation.
      const restoreDowngrade = yield* electronUpdater.allowDowngrade;
      if (allowDowngrade) yield* electronUpdater.setAllowDowngrade(true);
      return yield* electronUpdater.checkForUpdates.pipe(
        Effect.ensuring(electronUpdater.setAllowDowngrade(restoreDowngrade).pipe(Effect.ignore)),
        Effect.as(true),
        Effect.catchTags({
          ElectronUpdaterCheckForUpdatesError: Effect.fn(
            "desktop.updates.handleCheckForUpdatesFailure",
          )(function* (error) {
            const failedAt = yield* currentIsoTimestamp;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause: describeUpdateErrorCause(error.cause),
              channel: error.channel,
            });
            return true;
          }),
        }),
      );
    });

    return yield* actionReservation === "held"
      ? check
      : check.pipe(
          Effect.onInterrupt(() => setState(state)),
          Effect.ensuring(finishUpdateAction("check")),
        );
  });

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
      return { accepted: false, completed: false };
    }

    if (!(yield* tryStartUpdateAction("download"))) {
      return { accepted: false, completed: false };
    }

    return yield* Effect.gen(function* () {
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updates.handleDownloadFailure")(
          function* (error) {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause: describeUpdateErrorCause(error.cause),
              channel: error.channel,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            cause: describeUpdateErrorCause(error.cause),
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(finishUpdateAction("download")),
    );
  }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  const {
    baseUpdateState,
    installWithExpectedVersion,
    readNotAppliedInstallVersion,
    recoverFailedInstall,
  } = makeUpdateInstall({
    environment,
    fileSystem,
    desktopState,
    pool,
    electronUpdater,
    updateStateRef,
    activeUpdateActionRef,
    installRunningBackendsRef,
    finishedUpdateActions,
    updaterConfiguredRef,
    notAppliedVersionRef,
    stateMutex,
    tryStartUpdateAction,
    finishUpdateAction,
    channelBlockedReason,
    updateState,
    logError: logUpdaterError,
    logWarning: logUpdaterWarning,
  });

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const {
    handleUpdateAvailable,
    handleUpdateNotAvailable,
    handleUpdaterError,
    handleDownloadProgress,
    handleUpdateDownloaded,
  } = makeUpdateEventHandlers({
    updateStateRef,
    lastLoggedDownloadMilestoneRef,
    activeUpdateAction,
    offerable,
    setState,
    updateState,
    recoverFailedInstall,
    currentIsoTimestamp,
    logInfo: logUpdaterInfo,
    logWarning: logUpdaterWarning,
    logError: logUpdaterError,
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    isActionActive: activeUpdateAction.pipe(Effect.map(Option.isSome)),
    isInstallActive: activeUpdateAction.pipe(
      Effect.map((action) => Option.isSome(action) && action.value === "install"),
    ),
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(stateChanges);
        const latest = yield* Ref.get(updateStateRef);
        return { latest, changes: Stream.fromSubscription(subscription) };
      }),
    ),
    emitState,
    disabledReason: Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => resolveStateDisabledReason(state.channel)),
    ),
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      const notAppliedVersion = yield* readNotAppliedInstallVersion;
      yield* Ref.set(notAppliedVersionRef, notAppliedVersion);
      if (Option.isSome(notAppliedVersion)) {
        yield* logUpdaterWarning("the last update install did not apply", {
          version: environment.appVersion,
          targetVersion: notAppliedVersion.value,
        });
      }

      if (mockUpdates) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      } else if (policy.feedUrl !== undefined) {
        // The administrator's mirror replaces the GitHub feed baked into app-update.yml.
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: policy.feedUrl,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      const settings = yield* desktopSettings.get;
      const disabledReason = yield* resolveDisabledReason;
      yield* setState(
        yield* baseUpdateState(
          settings.updateChannel,
          Option.orElse(disabledReason, () => channelBlockedReason(settings.updateChannel)),
        ),
      );
      if (Option.isSome(disabledReason)) {
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(settings.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
      options?: { readonly minimumVersion?: string | undefined },
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      if (Option.isSome(channelBlockedReason(nextChannel))) {
        return yield* new DesktopUpdateChannelManagedError({
          channel: nextChannel,
          policyMessage: policy.message ?? "Your administrator manages T3 Code updates.",
        });
      }
      // A background check holds the updater only briefly, so wait it out instead of refusing.
      const activeAction = yield* tryStartChannelChange.pipe(
        Effect.repeat({
          while: (active) => Option.isSome(active) && active.value === "check",
          schedule: Schedule.spaced(CHANNEL_CHANGE_RETRY_DELAY),
          times: CHANNEL_CHANGE_RETRIES,
        }),
      );
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value === "install-recovery" ? "install" : activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      return yield* Effect.gen(function* () {
        yield* Ref.set(releaseFloorRef, Option.fromNullishOr(options?.minimumVersion));
        const state = yield* Ref.get(updateStateRef);
        const retained = state.downloadedVersion ?? state.availableVersion;
        // A build from another track re-checks, so retrying a track switch finds an older release.
        // So does a retained offer below the new floor, which must not install.
        if (
          nextChannel === state.channel &&
          nextChannel === desktopUpdateChannelOf(environment.appVersion) &&
          (retained === null || (yield* offerable(retained, state)))
        ) {
          return state;
        }

        yield* desktopSettings
          .setUpdateChannel(nextChannel)
          .pipe(
            Effect.mapError(
              (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
            ),
          );

        const disabledReason = yield* resolveDisabledReason;
        yield* setState(yield* baseUpdateState(nextChannel, disabledReason));

        if (Option.isSome(disabledReason) || !(yield* Ref.get(updaterConfiguredRef))) {
          return yield* Ref.get(updateStateRef);
        }

        yield* applyAutoUpdaterChannel(nextChannel);
        // Only leaving the running build's track can need an older release.
        yield* checkForUpdates(
          "channel-change",
          "held",
          nextChannel !== desktopUpdateChannelOf(environment.appVersion),
        );
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("channel")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (
      reason: string,
      options?: { readonly allowDowngrade?: boolean },
    ) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason, "acquire", options?.allowDowngrade === true);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: installWithExpectedVersion().pipe(
      Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
    ),
    installPrepared: Effect.fn("DesktopUpdates.installPrepared")(function (expectedVersion) {
      return installWithExpectedVersion(expectedVersion);
    }),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
