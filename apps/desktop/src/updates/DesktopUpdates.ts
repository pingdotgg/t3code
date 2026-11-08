import {
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import {
  CHANNEL_CHANGE_RETRY_DELAY,
  CHANNEL_CHANGE_RETRIES,
  type DesktopPreparedUpdateInstallResult,
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
  DesktopUpdateChannelManagedError,
  DesktopUpdateSetChannelError,
  isArm64HostRunningIntelBuild,
  logUpdaterInfo,
  logUpdaterWarning,
} from "./DesktopUpdateModel.ts";
import { makeUpdateContext } from "./DesktopUpdateContext.ts";
import { makeUpdateChecks } from "./DesktopUpdateChecks.ts";
import { makeUpdateInstall } from "./DesktopUpdateInstall.ts";
import { makeUpdateEvents } from "./DesktopUpdateEvents.ts";
export {
  DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
  DesktopUpdatePollerError,
  DesktopUpdateEventHandlingError,
  DesktopUpdaterReportedError,
  DesktopUpdateUnexpectedActionError,
  DesktopUpdateChannelManagedError,
  DesktopUpdateSetChannelError,
  describeUpdateErrorCause,
} from "./DesktopUpdateModel.ts";

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

/** @public */
export const make = Effect.gen(function* () {
  const context = yield* makeUpdateContext;
  const {
    config,
    electronUpdater,
    environment,
    desktopSettings,
    policy,
    mockUpdates,
    appUpdateYmlConfigRef,
    updaterConfiguredRef,
    notAppliedVersionRef,
    releaseFloorRef,
    offerable,
    updateStateRef,
    stateChanges,
    stateMutex,
    emitState,
    setState,
    readAppUpdateYml,
    resolveDisabledReason,
    channelBlockedReason,
    resolveStateDisabledReason,
    activeUpdateAction,
    tryStartChannelChange,
    finishUpdateAction,
    readNotAppliedInstallVersion,
    baseUpdateState,
  } = context;
  const checks = makeUpdateChecks(context);
  const { applyAutoUpdaterChannel, checkForUpdates, downloadAvailableUpdate } = checks;
  const install = yield* makeUpdateInstall(context);
  const { installWithExpectedVersion } = install;
  const events = yield* makeUpdateEvents(context, checks, install);
  const {
    startUpdatePollers,
    handleUpdateAvailable,
    handleUpdateNotAvailable,
    handleUpdaterError,
    handleDownloadProgress,
    handleUpdateDownloaded,
  } = events;
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
