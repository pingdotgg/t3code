import type {
  DesktopTelemetryRequestDesktopUpdate,
  DesktopUpdateRemoteOutcome,
  DesktopUpdateState,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import {
  nextRemoteDesktopUpdateStep,
  normalizeRemoteUpdateReason,
  type RemoteDesktopUpdateAttempts,
} from "./remoteUpdateFlow.ts";

const { logInfo, logError } = DesktopObservability.makeComponentLogger("desktop-remote-updates");

/** Pause before retrying an action the updater refused for a held reservation. */
const ACTION_RETRY_DELAY = Duration.millis(250);

/**
 * Server-triggered desktop updates. Forks two fibers into the surrounding
 * scope: one mirrors every updater state change to the attached backend (so
 * the server always knows the desktop's update state), one consumes
 * requestDesktopUpdate control messages and drives check -> download ->
 * quit-and-install with no local confirmation. The remote click that caused
 * the request is the consent.
 */
export const listen: Effect.Effect<
  void,
  never,
  | DesktopUpdates.DesktopUpdates
  | DesktopTelemetryPublisher.DesktopTelemetryPublisher
  | DesktopState.DesktopState
  | Scope.Scope
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const desktopState = yield* DesktopState.DesktopState;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const activeRequestIdRef = yield* Ref.make(Option.none<string>());

  const publishReport = (
    state: DesktopUpdateState,
    terminal?: { readonly outcome: DesktopUpdateRemoteOutcome; readonly reason?: string },
  ): Effect.Effect<void> => {
    const reason = normalizeRemoteUpdateReason(terminal?.reason);
    return Ref.get(activeRequestIdRef).pipe(
      Effect.flatMap((requestId) =>
        publisher.publishUpdateReport({
          version: 1,
          type: "desktopUpdateStatus",
          ...(Option.isSome(requestId) ? { requestId: requestId.value } : {}),
          ...(terminal === undefined ? {} : { outcome: terminal.outcome }),
          ...(reason ? { reason } : {}),
          state,
        }),
      ),
    );
  };

  yield* Effect.scoped(
    Effect.gen(function* () {
      const { latest, changes } = yield* updates.subscribe;
      yield* publishReport(latest);
      yield* Stream.runForEach(changes, (state) => publishReport(state));
    }),
  ).pipe(Effect.forkScoped);

  const handleRequest = (request: DesktopTelemetryRequestDesktopUpdate): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Ref.set(activeRequestIdRef, Option.some(request.requestId));
        yield* logInfo("remote update requested", { requestId: request.requestId });
        const { latest, changes } = yield* updates.subscribe;
        const disabledReason = Option.getOrNull(yield* updates.disabledReason);
        let attempts: RemoteDesktopUpdateAttempts = { checks: 0, downloads: 0 };
        // The updater admits one action at a time. A state event can land
        // while the action that produced it still holds the reservation
        // (e.g. "available" before the check releases), so a forked action
        // can be refused with no later state event to retry on. Rejected
        // actions re-enqueue their state here after a short pause so the
        // step runs again once the reservation is free.
        const retries = yield* Queue.unbounded<DesktopUpdateState>();
        const retryLater = (state: DesktopUpdateState) =>
          Effect.sleep(ACTION_RETRY_DELAY).pipe(
            Effect.andThen(Queue.offer(retries, state)),
            Effect.asVoid,
            Effect.forkScoped,
          );

        // Returns true when the run reached a terminal outcome.
        const step = (state: DesktopUpdateState): Effect.Effect<boolean, never, Scope.Scope> =>
          Effect.gen(function* () {
            const next = nextRemoteDesktopUpdateStep(state, attempts, disabledReason);
            switch (next.action) {
              case "wait":
                return false;
              // Counters increment before the action so the state event the
              // action produces already sees it; a refusal for a held
              // reservation rolls the count back, since it was not a try.
              case "check":
                attempts = { ...attempts, checks: attempts.checks + 1 };
                yield* updates.check("remote-update").pipe(
                  Effect.flatMap((result) => {
                    if (result.checked) return Effect.void;
                    attempts = { ...attempts, checks: attempts.checks - 1 };
                    return retryLater(state);
                  }),
                  Effect.forkScoped,
                );
                return false;
              case "download":
                attempts = { ...attempts, downloads: attempts.downloads + 1 };
                yield* updates.download.pipe(
                  Effect.flatMap((result) => {
                    if (result.accepted) return Effect.void;
                    attempts = { ...attempts, downloads: attempts.downloads - 1 };
                    return retryLater(state);
                  }),
                  Effect.forkScoped,
                );
                return false;
              case "install": {
                // Another install (local, or an earlier remote request)
                // already owns the shutdown and will relaunch the app. It
                // also holds the reservation, so check this before the
                // reservation wait below or the join path is unreachable.
                if (yield* Ref.get(desktopState.quitting)) {
                  yield* publishReport(state, { outcome: "installing" });
                  yield* logInfo("remote update joining an in-progress install", {
                    requestId: request.requestId,
                  });
                  return true;
                }
                // "downloaded" fires from inside the download action, so
                // install may be refused for the reservation the download
                // still holds. Wait for it to free up before reporting:
                // the terminal report below is irrevocable.
                if (yield* updates.isActionActive) {
                  yield* retryLater(state);
                  return false;
                }
                // The terminal report must go out BEFORE installing:
                // install stops the backend server first, so anything
                // published after this point never reaches the requester.
                yield* publishReport(state, { outcome: "installing" });
                yield* logInfo("remote update installing", { requestId: request.requestId });
                const before = yield* updates.getState;
                const result = yield* updates.install;
                if (!result.accepted) {
                  // An install that started between the quitting check and
                  // this call owns the relaunch: join it.
                  if (yield* Ref.get(desktopState.quitting)) {
                    return true;
                  }
                  // Lost a race for the reservation despite the check
                  // above. The "installing" report is already out, so
                  // this cannot be retried without a duplicate terminal.
                  yield* publishReport(result.state, {
                    outcome: "failed",
                    reason: "The desktop app could not start the install.",
                  });
                  return true;
                }
                if (result.state !== before) {
                  // During an accepted install the only state writes are the
                  // failure reducers, so a transition means this attempt
                  // failed. Field checks cannot tell a fresh failure from a
                  // lingering errorContext left by a previous attempt, which
                  // success does not clear.
                  yield* publishReport(result.state, {
                    outcome: "failed",
                    reason: result.state.message ?? "The desktop app failed to install the update.",
                  });
                }
                return true;
              }
              case "done":
                yield* publishReport(state, {
                  outcome: next.outcome,
                  ...(next.reason === undefined ? {} : { reason: next.reason }),
                });
                yield* logInfo("remote update finished", {
                  requestId: request.requestId,
                  outcome: next.outcome,
                  reason: next.reason ?? null,
                });
                return true;
            }
          });

        if (yield* step(latest)) return;
        yield* Stream.merge(changes, Stream.fromQueue(retries)).pipe(
          Stream.mapEffect(step),
          Stream.takeUntil((done) => done),
          Stream.runDrain,
        );
      }),
    ).pipe(
      Effect.ensuring(Ref.set(activeRequestIdRef, Option.none())),
      Effect.catchCause((cause) =>
        logError("remote update request failed unexpectedly", {
          requestId: request.requestId,
          cause: String(cause),
        }),
      ),
    );

  // Sequential by construction: a second remote request queued mid-run is
  // handled after the current one, when the state machine resolves it fast.
  yield* Stream.runForEach(publisher.updateRequests, handleRequest).pipe(Effect.forkScoped);
});
