import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  createInitialDesktopUpdateState,
  resolveNotAppliedInstallVersion,
} from "./updateMachine.ts";
import {
  type UpdateAction,
  type AppUpdateYmlConfig,
  DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  decodeInstallRecord,
  encodeInstallRecord,
  parseAppUpdateYml,
  createBaseUpdateState,
  getAutoUpdateDisabledReason,
  logUpdaterWarning,
} from "./DesktopUpdateModel.ts";

export const makeUpdateContext = Effect.gen(function* () {
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
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
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

  const updateRestartMarkerDir = environment.path.join(environment.baseDir, "runtime");
  const updateRestartMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_RESTART_MARKER_FILE,
  );
  const writeUpdateRestartMarker = fileSystem
    .makeDirectory(updateRestartMarkerDir, { recursive: true })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(updateRestartMarkerPath, "")),
      Effect.catch((error) =>
        logUpdaterWarning("Could not write the update restart marker.", { errorTag: error._tag }),
      ),
    );

  // Failed or interrupted installs leave no replacement backend; later quits must release the tunnel.
  const removeUpdateRestartMarker = fileSystem
    .remove(updateRestartMarkerPath, { force: true })
    .pipe(Effect.ignore);

  const installRecordPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  );
  const writeInstallRecord = (targetVersion: string) =>
    encodeInstallRecord({ fromVersion: environment.appVersion, targetVersion }).pipe(
      Effect.flatMap((text) => fileSystem.writeFileString(installRecordPath, text)),
      Effect.catch((error) =>
        logUpdaterWarning("Could not record the update install.", { errorTag: error._tag }),
      ),
    );
  const removeInstallRecord = fileSystem
    .remove(installRecordPath, { force: true })
    .pipe(Effect.ignore);

  const readNotAppliedInstallVersion = fileSystem.readFileString(installRecordPath).pipe(
    Effect.flatMap(decodeInstallRecord),
    Effect.option,
    Effect.map((record) =>
      Option.flatMap(record, (value) =>
        Option.fromNullishOr(resolveNotAppliedInstallVersion(value, environment.appVersion)),
      ),
    ),
    Effect.tap((notAppliedVersion) =>
      Option.isNone(notAppliedVersion) ? removeInstallRecord : Effect.void,
    ),
  );

  const baseUpdateState = (channel: DesktopUpdateChannel, disabledReason: Option.Option<string>) =>
    Ref.get(notAppliedVersionRef).pipe(
      Effect.map((notAppliedVersion) => ({
        ...createBaseUpdateState(channel, disabledReason, environment),
        // Callers fall back to the channel's reason only when nothing else turns updates off.
        ...(Option.isSome(disabledReason) &&
        disabledReason.value === Option.getOrUndefined(channelBlockedReason(channel))
          ? { channelBlockedByPolicy: true as const }
          : {}),
        ...Option.match(notAppliedVersion, {
          onNone: () => ({}),
          onSome: (version) => ({ notAppliedVersion: version }),
        }),
      })),
    );

  return {
    config,
    pool,
    desktopState,
    electronUpdater,
    environment,
    desktopSettings,
    policy,
    mockUpdates,
    appUpdateYmlConfigRef,
    activeUpdateActionRef,
    finishedUpdateActions,
    updaterConfiguredRef,
    notAppliedVersionRef,
    releaseFloorRef,
    offerable,
    updateStateRef,
    stateChanges,
    stateMutex,
    emitState,
    setState,
    updateState,
    readAppUpdateYml,
    resolveDisabledReason,
    channelBlockedReason,
    resolveStateDisabledReason,
    activeUpdateAction,
    tryStartUpdateAction,
    tryStartChannelChange,
    finishUpdateAction,
    writeUpdateRestartMarker,
    removeUpdateRestartMarker,
    writeInstallRecord,
    removeInstallRecord,
    readNotAppliedInstallVersion,
    baseUpdateState,
  };
});

export type UpdateContext = Effect.Success<typeof makeUpdateContext>;
