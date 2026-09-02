import type {
  DesktopTelemetryRequestDesktopUpdate,
  DesktopUpdateRemoteOutcome,
  DesktopUpdateState,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopObservability from "../app/DesktopObservability.ts";
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
const PREPARED_UPDATE_TTL = Duration.minutes(5);

interface PreparedUpdate {
  readonly requestId: string;
  readonly downloadedVersion: string;
  readonly status: "prepared" | "committing" | "failed";
  readonly failureReason?: string;
  readonly expiresAt: number;
}

type CommitClaim =
  | { readonly _tag: "invalid" }
  | { readonly _tag: "failed"; readonly prepared: PreparedUpdate }
  | { readonly _tag: "committing" }
  | { readonly _tag: "claimed"; readonly prepared: PreparedUpdate };

/**
 * Server-triggered desktop updates. Mirrors updater state, prepares downloads,
 * cancels abandoned preparations, and commits installs after the remote client
 * confirms that it received the preparation token.
 */
export const listen: Effect.Effect<
  void,
  never,
  DesktopUpdates.DesktopUpdates | DesktopTelemetryPublisher.DesktopTelemetryPublisher | Scope.Scope
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const activeRequestIdRef = yield* Ref.make(Option.none<string>());
  const requestControlRef = yield* Ref.make<{
    readonly active: Option.Option<{
      readonly requestId: string;
      readonly signal: Deferred.Deferred<void>;
    }>;
    readonly cancelledBeforeStart: ReadonlyArray<string>;
  }>({ active: Option.none(), cancelledBeforeStart: [] });
  const preparedUpdateRef = yield* Ref.make(Option.none<PreparedUpdate>());

  const publishReport = (
    state: DesktopUpdateState,
    terminal?: { readonly outcome: DesktopUpdateRemoteOutcome; readonly reason?: string },
    explicitRequestId?: string,
  ): Effect.Effect<void> => {
    const reason = normalizeRemoteUpdateReason(terminal?.reason);
    return Ref.get(activeRequestIdRef).pipe(
      Effect.flatMap((requestId) =>
        publisher.publishUpdateReport({
          version: 1,
          type: "desktopUpdateStatus",
          ...(explicitRequestId !== undefined
            ? { requestId: explicitRequestId }
            : Option.isSome(requestId)
              ? { requestId: requestId.value }
              : {}),
          ...(terminal === undefined ? {} : { outcome: terminal.outcome }),
          ...(reason ? { reason } : {}),
          state,
        }),
      ),
    );
  };

  const recordPreparedFailure = (requestId: string, reason: string) =>
    Ref.modify(preparedUpdateRef, (prepared) => {
      if (
        Option.isNone(prepared) ||
        prepared.value.requestId !== requestId ||
        prepared.value.status === "failed"
      ) {
        return [false, prepared] as const;
      }
      return [
        true,
        Option.some({ ...prepared.value, status: "failed" as const, failureReason: reason }),
      ] as const;
    });

  const clearActiveRequest = (requestId: string) =>
    Ref.update(activeRequestIdRef, (active) =>
      Option.isSome(active) && active.value === requestId ? Option.none() : active,
    );

  yield* Effect.scoped(
    Effect.gen(function* () {
      const { latest, changes } = yield* updates.subscribe;
      yield* publishReport(latest);
      yield* Stream.runForEach(changes, (state) =>
        Effect.gen(function* () {
          yield* publishReport(state);
          const prepared = yield* Ref.get(preparedUpdateRef);
          if (
            Option.isSome(prepared) &&
            prepared.value.status === "committing" &&
            state.errorContext === "install"
          ) {
            const reason = state.message ?? "The desktop app failed to install the update.";
            if (yield* recordPreparedFailure(prepared.value.requestId, reason)) {
              yield* publishReport(state, { outcome: "failed", reason }, prepared.value.requestId);
            }
          }
        }),
      );
    }),
  ).pipe(Effect.forkScoped);

  const handleRequest = (request: DesktopTelemetryRequestDesktopUpdate): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const cancellation = yield* Deferred.make<void>();
        const shouldStart = yield* Ref.modify(requestControlRef, (control) => {
          if (control.cancelledBeforeStart.includes(request.requestId)) {
            return [
              false,
              {
                ...control,
                cancelledBeforeStart: control.cancelledBeforeStart.filter(
                  (requestId) => requestId !== request.requestId,
                ),
              },
            ] as const;
          }
          return [
            true,
            {
              ...control,
              active: Option.some({ requestId: request.requestId, signal: cancellation }),
            },
          ] as const;
        });
        if (!shouldStart) return;

        const now = yield* Clock.currentTimeMillis;
        const prepared = yield* Ref.modify(preparedUpdateRef, (current) =>
          Option.isSome(current) &&
          current.value.status === "prepared" &&
          current.value.expiresAt <= now
            ? ([Option.none<typeof current.value>(), Option.none()] as const)
            : ([current, current] as const),
        );
        if (Option.isSome(prepared) && prepared.value.status !== "failed") {
          yield* publishReport(
            yield* updates.getState,
            {
              outcome: "failed",
              reason: "A prepared desktop update is already in progress.",
            },
            request.requestId,
          );
          return;
        }
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
                // The download event fires before its action releases the
                // updater reservation. Wait until the prepared install can
                // be committed by the client in a separate RPC.
                if (yield* updates.isActionActive) {
                  yield* retryLater(state);
                  return false;
                }
                if (state.downloadedVersion === null) {
                  yield* publishReport(
                    state,
                    {
                      outcome: "failed",
                      reason: "The desktop app lost the downloaded update.",
                    },
                    request.requestId,
                  );
                  return true;
                }
                yield* Ref.set(
                  preparedUpdateRef,
                  Option.some({
                    requestId: request.requestId,
                    downloadedVersion: state.downloadedVersion,
                    status: "prepared",
                    expiresAt:
                      (yield* Clock.currentTimeMillis) + Duration.toMillis(PREPARED_UPDATE_TTL),
                  }),
                );
                yield* publishReport(state, { outcome: "ready-to-install" }, request.requestId);
                yield* logInfo("remote update prepared", { requestId: request.requestId });
                return true;
              }
              case "done":
                yield* publishReport(
                  state,
                  {
                    outcome: next.outcome,
                    ...(next.reason === undefined ? {} : { reason: next.reason }),
                  },
                  request.requestId,
                );
                yield* logInfo("remote update finished", {
                  requestId: request.requestId,
                  outcome: next.outcome,
                  reason: next.reason ?? null,
                });
                return true;
            }
          });

        yield* Effect.raceFirst(
          Effect.gen(function* () {
            if (yield* step(latest)) return;
            yield* Stream.merge(changes, Stream.fromQueue(retries)).pipe(
              Stream.mapEffect(step),
              Stream.takeUntil((done) => done),
              Stream.runDrain,
            );
          }),
          Deferred.await(cancellation),
        );
      }),
    ).pipe(
      Effect.ensuring(
        Effect.all(
          [
            clearActiveRequest(request.requestId),
            Ref.update(requestControlRef, (control) => ({
              ...control,
              active:
                Option.isSome(control.active) &&
                control.active.value.requestId === request.requestId
                  ? Option.none()
                  : control.active,
            })),
          ],
          { discard: true },
        ),
      ),
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

  yield* Stream.runForEach(publisher.updateCancellations, (cancellation) =>
    Effect.gen(function* () {
      const activeSignal = yield* Ref.modify(requestControlRef, (control) => {
        if (
          Option.isSome(control.active) &&
          control.active.value.requestId === cancellation.requestId
        ) {
          return [Option.some(control.active.value.signal), control] as const;
        }
        return [
          Option.none<Deferred.Deferred<void>>(),
          {
            ...control,
            cancelledBeforeStart: [
              ...control.cancelledBeforeStart.filter(
                (requestId) => requestId !== cancellation.requestId,
              ),
              cancellation.requestId,
            ],
          },
        ] as const;
      });
      if (Option.isSome(activeSignal)) {
        yield* Deferred.succeed(activeSignal.value, undefined);
      }
      const matchedPrepared = yield* Ref.modify(preparedUpdateRef, (prepared) => {
        if (Option.isNone(prepared) || prepared.value.requestId !== cancellation.requestId) {
          return [false, prepared] as const;
        }
        return [true, prepared.value.status === "prepared" ? Option.none() : prepared] as const;
      });
      if (matchedPrepared) {
        yield* Ref.update(requestControlRef, (control) => {
          return {
            ...control,
            cancelledBeforeStart: control.cancelledBeforeStart.filter(
              (requestId) => requestId !== cancellation.requestId,
            ),
          };
        });
      }
    }),
  ).pipe(Effect.forkScoped);

  yield* Stream.runForEach(publisher.updateCommits, (commit) =>
    Effect.gen(function* () {
      const current = yield* updates.getState;
      const now = yield* Clock.currentTimeMillis;
      const claim = yield* Ref.modify(
        preparedUpdateRef,
        (prepared): readonly [CommitClaim, Option.Option<PreparedUpdate>] => {
          if (
            Option.isNone(prepared) ||
            prepared.value.requestId !== commit.requestId ||
            (prepared.value.status === "prepared" && prepared.value.expiresAt <= now)
          ) {
            return [{ _tag: "invalid" as const }, prepared] as const;
          }
          if (prepared.value.status === "failed") {
            return [{ _tag: "failed" as const, prepared: prepared.value }, prepared] as const;
          }
          if (prepared.value.status === "committing") {
            return [{ _tag: "committing" as const }, prepared] as const;
          }
          return [
            { _tag: "claimed" as const, prepared: prepared.value },
            Option.some({ ...prepared.value, status: "committing" as const }),
          ] as const;
        },
      );
      if (claim._tag === "invalid") {
        yield* publishReport(
          yield* updates.getState,
          {
            outcome: "failed",
            reason: "This desktop update is no longer prepared.",
          },
          commit.requestId,
        );
        return;
      }
      if (claim._tag === "failed") {
        yield* publishReport(
          current,
          {
            outcome: "failed",
            reason: claim.prepared.failureReason ?? "The desktop app failed to install the update.",
          },
          commit.requestId,
        );
        return;
      }
      if (claim._tag === "committing") {
        return;
      }
      yield* Ref.set(activeRequestIdRef, Option.some(commit.requestId));
      if (current.downloadedVersion !== claim.prepared.downloadedVersion) {
        const reason = "This desktop update is no longer prepared.";
        if (yield* recordPreparedFailure(commit.requestId, reason)) {
          yield* publishReport(current, { outcome: "failed", reason }, commit.requestId);
        }
        return;
      }
      const result = yield* updates.installPrepared(claim.prepared.downloadedVersion);
      if (
        !result.accepted &&
        result.state.downloadedVersion === claim.prepared.downloadedVersion &&
        (yield* updates.isInstallActive)
      ) {
        // Another install (local, or an earlier remote request) already owns
        // the shutdown and will relaunch the app on the same downloaded
        // version. This commit joins it: no failure marker, and the client
        // proves the handoff the same way, by transport loss then the
        // target version on reconnect.
        yield* logInfo("remote update commit joining an in-progress install", {
          requestId: commit.requestId,
        });
        return;
      }
      if (!result.accepted || result.failed) {
        const reason = result.state.message ?? "The desktop app could not start the install.";
        if (yield* recordPreparedFailure(commit.requestId, reason)) {
          yield* publishReport(result.state, { outcome: "failed", reason }, commit.requestId);
        }
        return;
      }
      // A successful install tears down this backend. Do not send a success
      // marker from the old process: transport loss followed by the target
      // version is the only proof that the handoff succeeded.
    }).pipe(
      Effect.ensuring(clearActiveRequest(commit.requestId)),
      Effect.catchCause((cause) =>
        logError("remote update commit failed unexpectedly", {
          requestId: commit.requestId,
          cause: String(cause),
        }),
      ),
    ),
  ).pipe(Effect.forkScoped);
});
