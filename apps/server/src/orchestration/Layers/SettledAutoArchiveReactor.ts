import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS } from "@t3tools/contracts";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { AutomaticArchiveGuardRegistry } from "../Services/AutomaticArchiveGuardRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  canAutoArchiveSettledThreadNow,
  normalizeSettledAutoArchiveAfterDays,
  planSettledAutoArchive,
  settledAutoArchiveCommandId,
} from "../SettledAutoArchive.ts";

const SWEEP_INTERVAL = "15 minutes";
const LOG_TAG = "settled-auto-archive";

type SweepServices = OrchestrationEngineService | ServerSettingsService;

// First sweep archives pre-existing debt immediately: there is no grace period
// beyond `settledAt + afterDays`, and old settled threads are already past it.
export const sweepOnce = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;

  const settings = yield* Effect.result(serverSettings.getSettings);
  if (Result.isFailure(settings)) {
    return;
  }
  // Null means never: archive nothing.
  const afterDays = normalizeSettledAutoArchiveAfterDays(
    settings.success.autoArchiveSettledAfterDays,
  );
  if (afterDays === null) {
    return;
  }
  const readModel = yield* engine.getReadModel();
  const now = new Date().toISOString();
  for (const candidate of planSettledAutoArchive(readModel, now, afterDays)) {
    yield* engine
      .dispatch({
        type: "thread.archive",
        commandId: settledAutoArchiveCommandId(candidate.threadId),
        threadId: candidate.threadId,
        automatic: true,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`${LOG_TAG}: archive dispatch failed`, {
            threadId: candidate.threadId,
            cause,
          }),
        ),
      );

    // Dispatch reports no event count, so a refusal is only visible by reading the outcome back.
    const settled = yield* engine.getReadModel();
    if (settled.threads.find((thread) => thread.id === candidate.threadId)?.archivedAt == null) {
      yield* Effect.logDebug(`${LOG_TAG}: archive deferred at admission`, {
        threadId: candidate.threadId,
      });
    }
  }
}) satisfies Effect.Effect<void, never, SweepServices>;

const makeReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;
  const guards = yield* AutomaticArchiveGuardRegistry;

  // The admission guard is synchronous, so it reads the setting through a
  // snapshot refreshed at startup and on every settings change. Strict about
  // its own domain (settled threads only) and false elsewhere: the registry
  // requires every guard to approve, and the merge guard covers the rest.
  // Due-ness is re-checked here (not just at sweep time) so a raise of
  // `autoArchiveSettledAfterDays` between sweep and admission still defers.
  const afterDaysRef = MutableRef.make<number | null>(DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS);
  const refreshAfterDays = Effect.result(serverSettings.getSettings).pipe(
    Effect.map((result) =>
      Result.isFailure(result)
        ? null
        : normalizeSettledAutoArchiveAfterDays(result.success.autoArchiveSettledAfterDays),
    ),
    Effect.tap((value) => Effect.sync(() => MutableRef.set(afterDaysRef, value))),
  );
  yield* refreshAfterDays;
  yield* guards.register(({ readModel, threadId }) =>
    canAutoArchiveSettledThreadNow(
      readModel,
      threadId,
      new Date().toISOString(),
      MutableRef.get(afterDaysRef),
    ),
  );
  yield* Effect.forkScoped(Stream.runForEach(serverSettings.streamChanges, () => refreshAfterDays));

  yield* Effect.forkScoped(sweepOnce.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));
  // A re-settle preserves the original `settledAt`, so a thread can become due
  // at the moment it settles — sweep promptly instead of waiting out the timer.
  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      event.type === "thread.settled" ? sweepOnce : Effect.void,
    ),
  );
});

export const layer = Layer.effectDiscard(makeReactor);
