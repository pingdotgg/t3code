/**
 * Enforces native-agent wall-time budgets.
 *
 * The repository owns durable state and emits in-process change notifications.
 * This reactor only schedules timers from that state, so a restart recovers
 * every queued/running/waiting run without a polling loop.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ProviderService from "../../provider/Services/ProviderService.ts";
import * as AgentRunRepository from "./AgentRunRepository.ts";
import type { AgentRun } from "./AgentRun.ts";

const ACTIVE_STATUSES = new Set<AgentRun["status"]>(["queued", "running", "waiting-for-input"]);
const DEADLINE_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

export const isDeadlineTracked = (run: AgentRun): boolean => ACTIVE_STATUSES.has(run.status);

/** The wall-time budget starts at the root request until the run finishes. */
export const deadlineAtMillis = (run: AgentRun): number => {
  const origin = Date.parse(run.wallTimeOriginAt);
  return origin + run.budget.maxWallTimeMinutes * 60_000;
};

export const isDeadlineExpired = (run: AgentRun, nowMillis: number): boolean =>
  isDeadlineTracked(run) && nowMillis >= deadlineAtMillis(run);

const budgetFailure = (run: AgentRun): string =>
  `Wall-time budget exhausted after ${run.budget.maxWallTimeMinutes} minute${
    run.budget.maxWallTimeMinutes === 1 ? "" : "s"
  }.`;

/**
 * Attempts exactly one durable expiry transition. The terminal event is
 * appended before interrupting the provider session, making provider abort
 * receipts harmless races instead of a second terminal transition.
 */
export const expireRun = Effect.fn("AgentRunDeadlineReactor.expireRun")(function* (
  runId: AgentRun["id"],
  repository: AgentRunRepository.AgentRunRepository["Service"],
  provider: ProviderService.ProviderServiceShape,
) {
  const run = yield* repository.get(runId).pipe(Effect.map(Option.getOrNull));
  if (run === null) return false;

  const nowMillis = yield* Clock.currentTimeMillis;
  if (!isDeadlineExpired(run, nowMillis)) return false;

  const cancellation = yield* repository
    .dispatch({
      type: "agent-run.cancel",
      runId: run.id,
      reason: budgetFailure(run),
      occurredAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    })
    .pipe(Effect.result);

  // An empty event list means another reactor won the terminal race. Do not
  // interrupt a provider session that may now belong to a follow-up turn.
  if (Result.isFailure(cancellation)) return yield* cancellation.failure;
  if (cancellation.success.length === 0) return false;

  if (
    run.childThreadId !== null &&
    (run.status === "running" || run.status === "waiting-for-input")
  ) {
    yield* provider.interruptTurn({ threadId: run.childThreadId }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Agent run provider interrupt failed after deadline", {
          runId: run.id,
          threadId: run.childThreadId,
          cause,
        }),
      ),
    );
  }
  return true;
});

const make = Effect.gen(function* () {
  const repository = yield* AgentRunRepository.AgentRunRepository;
  const provider = yield* ProviderService.ProviderService;
  const fibers = new Map<string, Fiber.Fiber<void, never>>();

  const cancelScheduled = (runId: AgentRun["id"]) => {
    const fiber = fibers.get(runId);
    if (fiber === undefined) return Effect.void;
    fibers.delete(runId);
    return Fiber.interrupt(fiber).pipe(Effect.asVoid);
  };

  const schedule = Effect.fn("AgentRunDeadlineReactor.schedule")(function* (run: AgentRun) {
    yield* cancelScheduled(run.id);
    if (!isDeadlineTracked(run)) return;

    const nowMillis = yield* Clock.currentTimeMillis;
    const delayMillis = Math.max(0, deadlineAtMillis(run) - nowMillis);
    const registered = yield* Deferred.make<void>();
    const fiber = yield* Deferred.await(registered).pipe(
      Effect.andThen(Effect.sleep(Duration.millis(delayMillis))),
      Effect.andThen(Effect.sync(() => fibers.delete(run.id))),
      Effect.andThen(
        expireRun(run.id, repository, provider).pipe(Effect.retry(DEADLINE_RETRY_SCHEDULE)),
      ),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("Agent run deadline reactor could not enforce a deadline", {
          runId: run.id,
          cause,
        }),
      ),
      Effect.forkScoped,
    );
    fibers.set(run.id, fiber);
    yield* Deferred.succeed(registered, undefined);
  });

  // listActive is the restart recovery boundary. The change stream is
  // unbounded and durable reads happen before every expiry, so startup and
  // provider/event races cannot resurrect a completed run.
  const changes = yield* repository.subscribeChanges;
  yield* repository.listActive().pipe(Effect.flatMap((runs) => Effect.forEach(runs, schedule)));
  yield* changes.pipe(Stream.runForEach(schedule), Effect.forkScoped);
});

export const layer = Layer.effectDiscard(make);
