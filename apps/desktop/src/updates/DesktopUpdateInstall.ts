import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import { reduceDesktopUpdateStateOnInstallFailure } from "./updateMachine.ts";
import {
  PREPARED_INSTALL_CHECK_WAIT,
  type UpdateAction,
  DesktopUpdateUnexpectedActionError,
  describeUpdateErrorCause,
  logUpdaterError,
} from "./DesktopUpdateModel.ts";
import type { UpdateContext } from "./DesktopUpdateContext.ts";

export const makeUpdateInstall = Effect.fn("desktop.updates.makeInstall")(function* (
  context: UpdateContext,
) {
  const {
    pool,
    desktopState,
    electronUpdater,
    activeUpdateActionRef,
    finishedUpdateActions,
    updaterConfiguredRef,
    updateStateRef,
    stateMutex,
    updateState,
    tryStartUpdateAction,
    finishUpdateAction,
    writeUpdateRestartMarker,
    removeUpdateRestartMarker,
    writeInstallRecord,
    removeInstallRecord,
  } = context;
  const installRunningBackendsRef = yield* Ref.make<
    ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>
  >([]);
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
            (instance) =>
              instance.stop({ timeout: DesktopBackendManager.BACKEND_QUIT_STOP_TIMEOUT }),
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

  return { recoverFailedInstall, installWithExpectedVersion };
});

export type UpdateInstall = Effect.Success<ReturnType<typeof makeUpdateInstall>>;
