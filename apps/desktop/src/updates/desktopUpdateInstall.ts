import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Semaphore from "effect/Semaphore";

import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import {
  DesktopUpdateUnexpectedActionError,
} from "./desktopUpdateErrors.ts";
import {
  DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  decodeInstallRecord,
  encodeInstallRecord,
  type DesktopPreparedUpdateInstallResult,
  type UpdateAction,
} from "./desktopUpdateSchema.ts";
import { createBaseUpdateState, describeUpdateErrorCause } from "./desktopUpdateSupport.ts";
import {
  reduceDesktopUpdateStateOnInstallFailure,
  resolveNotAppliedInstallVersion,
} from "./updateMachine.ts";

type UpdaterLogger = DesktopObservability.DesktopComponentLogger;

const PREPARED_INSTALL_CHECK_WAIT = Duration.seconds(90);

export interface UpdateInstallDeps {
  readonly environment: DesktopEnvironment.DesktopEnvironment["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly desktopState: DesktopState.DesktopState["Service"];
  readonly pool: DesktopBackendPool.DesktopBackendPool["Service"];
  readonly electronUpdater: ElectronUpdater.ElectronUpdater["Service"];
  readonly updateStateRef: Ref.Ref<DesktopUpdateState>;
  readonly activeUpdateActionRef: Ref.Ref<Option.Option<UpdateAction>>;
  readonly installRunningBackendsRef: Ref.Ref<ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>>;
  readonly finishedUpdateActions: PubSub.PubSub<UpdateAction>;
  readonly updaterConfiguredRef: Ref.Ref<boolean>;
  readonly notAppliedVersionRef: Ref.Ref<Option.Option<string>>;
  readonly stateMutex: Semaphore.Semaphore;
  readonly tryStartUpdateAction: (action: UpdateAction) => Effect.Effect<boolean>;
  readonly finishUpdateAction: (action: UpdateAction) => Effect.Effect<void>;
  readonly channelBlockedReason: (channel: DesktopUpdateChannel) => Option.Option<string>;
  readonly updateState: (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ) => Effect.Effect<DesktopUpdateState>;
  readonly logError: UpdaterLogger["logError"];
  readonly logWarning: UpdaterLogger["logWarning"];
}

/** Install-phase helpers: restart marker, install record and quitAndInstall orchestration. */
export function makeUpdateInstall(deps: UpdateInstallDeps) {
  const {
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
  } = deps;

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

const resetInstallAction = Effect.all(
  [
    finishUpdateAction("install"),
    Ref.set(desktopState.quitting, false),
    Ref.set(installRunningBackendsRef, []),
    removeUpdateRestartMarker,
    removeInstallRecord,
  ],
  { discard: true },
);

const recoverFailedInstall = Effect.fn("desktop.updates.recoverFailedInstall")(function* (
  message: string,
) {
  const ownsRecovery = yield* Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction) && activeAction.value === "install"
      ? ([true, Option.some<UpdateAction>("install-recovery")] as const)
      : ([false, activeAction] as const),
  );
  if (!ownsRecovery) return;

  yield* Ref.set(desktopState.quitting, false);
  yield* removeUpdateRestartMarker;
  yield* removeInstallRecord;
  yield* Effect.gen(function* () {
    const runningInstances = yield* Ref.getAndSet(installRunningBackendsRef, []);
    const instances = (yield* pool.list).filter((instance) =>
      runningInstances.includes(instance),
    );
    const restartExit = yield* Effect.forEach(instances, (instance) => instance.start, {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.exit);
    yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, message));
    if (Exit.isFailure(restartExit)) {
      yield* logUpdaterError("Desktop update install recovery could not restart every backend.");
    }
  }).pipe(
    Effect.catchCause(() =>
      logUpdaterError("Desktop update install recovery failed unexpectedly."),
    ),
    Effect.ensuring(finishUpdateAction("install-recovery")),
  );
});

const installDownloadedUpdate = (expectedVersion?: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const actionCompletions = yield* PubSub.subscribe(finishedUpdateActions);
      let admission: "admitted" | "refused" | "wait-for-check" = "wait-for-check";
      while (admission === "wait-for-check") {
        admission = yield* stateMutex.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* Ref.get(updateStateRef);
            const activeAction = yield* Ref.get(activeUpdateActionRef);
            const hasExpectedDownload =
              state.downloadedVersion !== null &&
              (expectedVersion === undefined || state.downloadedVersion === expectedVersion);
            if (
              (yield* Ref.get(desktopState.quitting)) ||
              !(yield* Ref.get(updaterConfiguredRef)) ||
              !hasExpectedDownload
            ) {
              return "refused" as const;
            }
            if (Option.isSome(activeAction)) {
              return activeAction.value === "check" && expectedVersion !== undefined
                ? ("wait-for-check" as const)
                : ("refused" as const);
            }
            const hasInstallableDownload =
              state.status === "downloaded" ||
              (state.status === "error" &&
                (state.errorContext === null || state.errorContext === "install"));
            if (!hasInstallableDownload) return "refused" as const;
            return (yield* tryStartUpdateAction("install"))
              ? ("admitted" as const)
              : ("refused" as const);
          }),
        );
        if (admission === "wait-for-check") {
          const finishedAction = yield* PubSub.take(actionCompletions).pipe(
            Effect.timeoutOption(PREPARED_INSTALL_CHECK_WAIT),
          );
          if (Option.isNone(finishedAction)) {
            admission = "refused";
          }
        }
      }
      if (admission === "refused") {
        return { accepted: false, completed: false, failed: false };
      }

      yield* Ref.set(desktopState.quitting, true);
      yield* Ref.set(installRunningBackendsRef, []);

      return yield* Effect.gen(function* () {
        yield* writeUpdateRestartMarker;
        const { downloadedVersion } = yield* Ref.get(updateStateRef);
        if (downloadedVersion !== null) yield* writeInstallRecord(downloadedVersion);
        // Stop pooled backends before quitAndInstall can outrun their scope finalizers.
        const instances = yield* pool.list;
        // stop clears desiredRunning, so retain the recovery set beforehand.
        const runningInstances = yield* Effect.filter(instances, (instance) =>
          instance.snapshot.pipe(Effect.map((snapshot) => snapshot.desiredRunning)),
        );
        yield* Ref.set(installRunningBackendsRef, runningInstances);
        yield* Effect.forEach(
          instances,
          (instance) => instance.stop({ timeout: Duration.seconds(5) }),
          { concurrency: "unbounded" },
        );
        yield* electronUpdater.quitAndInstall({
          isSilent: true,
          isForceRunAfter: true,
        });
        return { accepted: true, completed: false, failed: false };
      }).pipe(
        Effect.catchTags({
          ElectronUpdaterQuitAndInstallError: Effect.fn("desktop.updates.handleInstallFailure")(
            function* (error) {
              yield* recoverFailedInstall(error.message);
              yield* logUpdaterError(error.message, {
                errorTag: error._tag,
                cause: describeUpdateErrorCause(error.cause),
                channel: error.channel,
                isSilent: error.isSilent,
                isForceRunAfter: error.isForceRunAfter,
              });
              return { accepted: true, completed: false, failed: true };
            },
          ),
        }),
        Effect.onInterrupt(() => resetInstallAction),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) {
              return yield* Effect.failCause(cause);
            }
            const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
            yield* recoverFailedInstall(error.message);
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause: describeUpdateErrorCause(error.cause),
              action: error.action,
            });
            return { accepted: true, completed: false, failed: true };
          }),
        ),
      );
    }),
  ).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

const installWithExpectedVersion = Effect.fn("desktop.updates.install")(function* (
  expectedVersion?: string,
) {
  if (yield* Ref.get(desktopState.quitting)) {
    return {
      accepted: false,
      completed: false,
      failed: false,
      state: yield* Ref.get(updateStateRef),
    };
  }
  const result = yield* installDownloadedUpdate(expectedVersion);
  return {
    accepted: result.accepted,
    completed: result.completed,
    failed: result.failed,
    state: yield* Ref.get(updateStateRef),
  };
});
  return {
    baseUpdateState,
    installWithExpectedVersion,
    readNotAppliedInstallVersion,
    recoverFailedInstall,
  };
}
