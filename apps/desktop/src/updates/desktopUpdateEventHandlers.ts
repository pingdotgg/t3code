import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { DesktopUpdateState } from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";

import type * as DesktopObservability from "../app/DesktopObservability.ts";
import {
  DesktopUpdateEventHandlingError,
  DesktopUpdaterReportedError,
} from "./desktopUpdateErrors.ts";
import { decodeDownloadProgressInfo, decodeUpdateInfo, type UpdateAction } from "./desktopUpdateSchema.ts";
import {
  describeUpdateErrorCause,
  getCanRetryFromState,
  shouldBroadcastDownloadProgress,
} from "./desktopUpdateSupport.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import {
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

type UpdaterLogger = DesktopObservability.DesktopComponentLogger;

export interface UpdateEventHandlerDeps {
  readonly updateStateRef: Ref.Ref<DesktopUpdateState>;
  readonly lastLoggedDownloadMilestoneRef: Ref.Ref<number>;
  readonly activeUpdateAction: Effect.Effect<Option.Option<UpdateAction>>;
  readonly offerable: (version: string, state: DesktopUpdateState) => Effect.Effect<boolean>;
  readonly setState: (state: DesktopUpdateState) => Effect.Effect<void>;
  readonly updateState: (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ) => Effect.Effect<DesktopUpdateState>;
  readonly recoverFailedInstall: (reason: string) => Effect.Effect<void>;
  readonly currentIsoTimestamp: Effect.Effect<string>;
  readonly logInfo: UpdaterLogger["logInfo"];
  readonly logWarning: UpdaterLogger["logWarning"];
  readonly logError: UpdaterLogger["logError"];
}

/** Updater event handlers: available/not-available, download progress and download completion. */
export function makeUpdateEventHandlers(deps: UpdateEventHandlerDeps) {
  const {
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
  } = deps;

const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
  raw: unknown,
) {
  yield* decodeUpdateInfo(raw).pipe(
    Effect.flatMap(
      Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
        const state = yield* Ref.get(updateStateRef);
        if (!(yield* offerable(info.version, state))) {
          yield* logUpdaterInfo("ignoring update outside the selected channel or its floor", {
            version: info.version,
            channel: state.channel,
          });
          const checkedAt = yield* currentIsoTimestamp;
          yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          return;
        }

        const checkedAt = yield* currentIsoTimestamp;
        const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
          info.releaseNotes,
          info.version,
          state.channel,
          info.releaseDate,
        );
        yield* setState(
          reduceDesktopUpdateStateOnUpdateAvailable(
            state,
            info.version,
            checkedAt,
            releaseNotes,
            omittedReleaseCount,
          ),
        );
        yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
        yield* logUpdaterInfo("update available", {
          version: info.version,
          releaseNoteGroups: releaseNotes.length,
          omittedReleaseCount,
        });
      }),
    ),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
      return logUpdaterWarning(error.message, {
        errorTag: error._tag,
        cause: describeUpdateErrorCause(error.cause),
        event: error.event,
      });
    }),
  );
});

const handleUpdateNotAvailable = Effect.gen(function* () {
  const checkedAt = yield* currentIsoTimestamp;
  const state = yield* Ref.get(updateStateRef);
  yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
  yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
  yield* logUpdaterInfo("no updates available");
}).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
  cause: unknown,
) {
  const activeAction = yield* activeUpdateAction;
  const error = new DesktopUpdaterReportedError({
    operation: Option.match(activeAction, {
      onNone: () => "background" as const,
      onSome: (action) => (action === "install-recovery" ? "install" : action),
    }),
    cause,
  });
  if (Option.isSome(activeAction) && activeAction.value === "install") {
    yield* recoverFailedInstall(error.message);
    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      cause: describeUpdateErrorCause(error.cause),
      operation: error.operation,
    });
    return;
  }

  if (Option.isNone(activeAction)) {
    const checkedAt = yield* currentIsoTimestamp;
    yield* updateState((current) => ({
      ...current,
      status: "error",
      message: error.message,
      checkedAt,
      downloadPercent: null,
      errorContext: current.errorContext,
      canRetry: getCanRetryFromState(current),
    }));
  }

  yield* logUpdaterError(error.message, {
    errorTag: error._tag,
    cause: describeUpdateErrorCause(error.cause),
    operation: error.operation,
  });
});

const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
  raw: unknown,
) {
  yield* decodeDownloadProgressInfo(raw).pipe(
    Effect.flatMap(
      Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
        const state = yield* Ref.get(updateStateRef);
        const percent = Math.floor(progress.percent);
        if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
          yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
        }
        const milestone = percent - (percent % 10);
        const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
        if (milestone > lastLoggedMilestone) {
          yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
          yield* logUpdaterInfo("download progress", { percent });
        }
      }),
    ),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
      return logUpdaterWarning(error.message, {
        errorTag: error._tag,
        cause: describeUpdateErrorCause(error.cause),
        event: error.event,
      });
    }),
  );
});

const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
  raw: unknown,
) {
  yield* decodeUpdateInfo(raw).pipe(
    Effect.flatMap(
      Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
        const state = yield* Ref.get(updateStateRef);
        // A download can finish after its track switch moved on; never offer that build.
        if (!(yield* offerable(info.version, state))) {
          yield* logUpdaterInfo("ignoring download outside the selected channel or its floor", {
            version: info.version,
            channel: state.channel,
          });
          // Its progress events left the updater "downloading", which would block every check.
          if (state.status === "downloading") {
            yield* setState(
              reduceDesktopUpdateStateOnNoUpdate(state, yield* currentIsoTimestamp),
            );
          }
          return;
        }
        yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, info.version));
        yield* logUpdaterInfo("update downloaded", { version: info.version });
      }),
    ),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
      return logUpdaterWarning(error.message, {
        errorTag: error._tag,
        cause: describeUpdateErrorCause(error.cause),
        event: error.event,
      });
    }),
  );
});
  return {
    handleUpdateAvailable,
    handleUpdateNotAvailable,
    handleUpdaterError,
    handleDownloadProgress,
    handleUpdateDownloaded,
  };
}
