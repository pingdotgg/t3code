import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type OrchestrationUsageLimitWait,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  UsageLimitAutoResumeReactor,
  type UsageLimitAutoResumeReactorShape,
} from "../Services/UsageLimitAutoResumeReactor.ts";

type UsageLimitWaitEvent = Extract<
  OrchestrationEvent,
  { type: "thread.usage-limit-wait-scheduled" | "thread.usage-limit-wait-cleared" }
>;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const scheduledFibers = new Map<string, Fiber.Fiber<void, never>>();

  const cancelScheduledFiber = Effect.fnUntraced(function* (waitId: CommandId) {
    const fiber = scheduledFibers.get(waitId);
    if (!fiber) return;
    scheduledFibers.delete(waitId);
    yield* Fiber.interrupt(fiber);
  });

  const dispatchCancel = Effect.fn("dispatchUsageLimitAutoResumeCancel")(function* (
    threadId: ThreadId,
    waitId: CommandId,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* orchestrationEngine.dispatch({
      type: "thread.usage-limit-wait.cancel",
      commandId: CommandId.make(`server:usage-limit-disabled:${waitId}`),
      threadId,
      waitId,
      reason: "disabled",
      createdAt,
    });
  });

  const dispatchResume = Effect.fn("dispatchUsageLimitAutoResume")(function* (
    threadId: ThreadId,
    waitId: CommandId,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* orchestrationEngine.dispatch({
      type: "thread.usage-limit-wait.resume",
      commandId: CommandId.make(`server:usage-limit-resume:${waitId}`),
      threadId,
      waitId,
      createdAt,
    });
  });

  const runScheduledResume = (
    threadId: ThreadId,
    wait: OrchestrationUsageLimitWait,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const resumeAtMs = Date.parse(wait.resumeAt);
      if (Number.isFinite(resumeAtMs) && resumeAtMs > nowMs) {
        yield* Effect.sleep(Duration.millis(resumeAtMs - nowMs));
      }
      scheduledFibers.delete(wait.waitId);
      const settings = yield* serverSettings.getSettings;
      if (settings.autoContinueAfterUsageLimitReset) {
        yield* dispatchResume(threadId, wait.waitId);
      } else {
        yield* dispatchCancel(threadId, wait.waitId);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("usage-limit auto-resume failed", {
              threadId,
              waitId: wait.waitId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const scheduleWait = Effect.fn("scheduleUsageLimitAutoResume")(function* (
    threadId: ThreadId,
    wait: OrchestrationUsageLimitWait,
  ) {
    yield* cancelScheduledFiber(wait.waitId);
    const fiber = yield* Effect.forkScoped(runScheduledResume(threadId, wait));
    scheduledFibers.set(wait.waitId, fiber);
  });

  const cancelAllWaits = Effect.fn("cancelAllUsageLimitWaits")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) {
    yield* Effect.forEach(
      threads,
      (thread) => {
        const wait = thread.usageLimitWait;
        return wait ? dispatchCancel(thread.id, wait.waitId) : Effect.void;
      },
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const applyWaitEvent = (event: UsageLimitWaitEvent) => {
    if (event.type === "thread.usage-limit-wait-scheduled") {
      return scheduleWait(event.payload.threadId, event.payload.wait);
    }
    return cancelScheduledFiber(event.payload.waitId);
  };

  const start: UsageLimitAutoResumeReactorShape["start"] = Effect.fn("start")(function* () {
    const settingsChanges = yield* serverSettings.subscribeChanges;
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.usage-limit-wait-scheduled" ||
        event.type === "thread.usage-limit-wait-cleared"
          ? applyWaitEvent(event)
          : Effect.void,
      ),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) =>
        settings.autoContinueAfterUsageLimitReset
          ? Effect.void
          : projectionSnapshotQuery.getShellSnapshot().pipe(
              Effect.flatMap((snapshot) => cancelAllWaits(snapshot.threads)),
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to cancel usage-limit waits after settings change", {
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
      ),
    );

    const [settings, snapshot] = yield* Effect.all([
      serverSettings.getSettings,
      projectionSnapshotQuery.getShellSnapshot(),
    ]).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to restore usage-limit auto-resume timers", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([null, null] as const)),
      ),
    );
    if (!settings || !snapshot) return;
    if (!settings.autoContinueAfterUsageLimitReset) {
      yield* cancelAllWaits(snapshot.threads).pipe(Effect.catchCause(() => Effect.void));
      return;
    }
    yield* Effect.forEach(
      snapshot.threads,
      (thread) => {
        const wait = thread.usageLimitWait;
        return wait ? scheduleWait(thread.id, wait) : Effect.void;
      },
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  return { start } satisfies UsageLimitAutoResumeReactorShape;
});

export const UsageLimitAutoResumeReactorLive = Layer.effect(UsageLimitAutoResumeReactor, make);
