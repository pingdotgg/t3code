import type {
  DesktopTelemetryRequestDesktopUpdate,
  DesktopUpdateRemoteOutcome,
  DesktopUpdateState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import {
  nextRemoteDesktopUpdateStep,
  type RemoteDesktopUpdateAttempts,
} from "./remoteUpdateFlow.ts";

const { logInfo, logError } = DesktopObservability.makeComponentLogger("desktop-remote-updates");

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
  DesktopUpdates.DesktopUpdates | DesktopTelemetryPublisher.DesktopTelemetryPublisher | Scope.Scope
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const activeRequestIdRef = yield* Ref.make(Option.none<string>());

  const publishReport = (
    state: DesktopUpdateState,
    terminal?: { readonly outcome: DesktopUpdateRemoteOutcome; readonly reason?: string },
  ): Effect.Effect<void> =>
    Ref.get(activeRequestIdRef).pipe(
      Effect.flatMap((requestId) =>
        publisher.publishUpdateReport({
          version: 1,
          type: "desktopUpdateStatus",
          ...(Option.isSome(requestId) ? { requestId: requestId.value } : {}),
          ...(terminal === undefined ? {} : { outcome: terminal.outcome }),
          ...(terminal?.reason === undefined ? {} : { reason: terminal.reason }),
          state,
        }),
      ),
    );

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

        // Returns true when the run reached a terminal outcome.
        const step = (state: DesktopUpdateState): Effect.Effect<boolean, never, Scope.Scope> =>
          Effect.gen(function* () {
            const next = nextRemoteDesktopUpdateStep(state, attempts, disabledReason);
            switch (next.action) {
              case "wait":
                return false;
              case "check":
                attempts = { ...attempts, checks: attempts.checks + 1 };
                yield* Effect.forkScoped(updates.check("remote-update"));
                return false;
              case "download":
                attempts = { ...attempts, downloads: attempts.downloads + 1 };
                yield* Effect.forkScoped(updates.download);
                return false;
              case "install": {
                // The terminal report must go out BEFORE installing:
                // install stops the backend server first, so anything
                // published after this point never reaches the requester.
                yield* publishReport(state, { outcome: "installing" });
                yield* logInfo("remote update installing", { requestId: request.requestId });
                const before = yield* updates.getState;
                const result = yield* updates.install;
                if (!result.accepted) {
                  yield* publishReport(result.state, {
                    outcome: "failed",
                    reason: "The desktop app could not start the install.",
                  });
                } else if (result.state !== before) {
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
        yield* changes.pipe(
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
