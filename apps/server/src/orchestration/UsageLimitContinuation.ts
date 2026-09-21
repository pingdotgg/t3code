import {
  CommandId,
  MessageId,
  ModelSelection,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { usageLimitRetryAt } from "../provider/Layers/codexUsageLimits.ts";
import {
  type PendingUsageLimitContinuation,
  readPendingUsageLimitContinuation,
} from "../provider/usageLimitContinuation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { cancelsUsageLimitContinuation } from "./decider.ts";

type FailedTurn = Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
const RECHECK_MS = 5 * 60_000;
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const sameModel = Schema.toEquivalence(ModelSelection);

export class UsageLimitContinuation extends Context.Service<
  UsageLimitContinuation,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly recordFailure: (event: FailedTurn, snapshotSequence: number) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/UsageLimitContinuation") {}

function waitingMessage(pending: PendingUsageLimitContinuation): string {
  return `Usage limit reached. Automatic continuation will check usage at ${pending.nextCheckAt}.`;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const registry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const pending = new Map<ThreadId, PendingUsageLimitContinuation>();
  const probing = new Set<ProviderInstanceId>();
  const handledFailures = new Map<ThreadId, TurnId>();
  let timer: Fiber.Fiber<void> | undefined;

  const getThread = (threadId: ThreadId) =>
    query.getThreadShellById(threadId).pipe(Effect.map(Option.getOrUndefined));
  const eligible = (
    thread: OrchestrationThreadShell | undefined,
    wait: PendingUsageLimitContinuation,
  ) =>
    thread !== undefined &&
    thread.archivedAt === null &&
    thread.latestTurn?.turnId === wait.failedTurnId &&
    thread.latestTurn.state === "error" &&
    thread.session !== null &&
    thread.session.activeTurnId === null &&
    thread.session.status !== "starting" &&
    thread.session.status !== "running" &&
    thread.session.providerInstanceId === wait.providerInstanceId &&
    sameModel(thread.modelSelection, wait.modelSelection);

  const expected = (
    thread: OrchestrationThreadShell,
    wait: PendingUsageLimitContinuation,
    sequence: number,
  ) => ({
    turnId: wait.failedTurnId,
    providerInstanceId: wait.providerInstanceId,
    sessionUpdatedAt: thread.session?.updatedAt ?? wait.failedAt,
    snapshotSequence: sequence,
  });

  const setBanner = Effect.fn("UsageLimitContinuation.setBanner")(function* (
    threadId: ThreadId,
    wait: PendingUsageLimitContinuation,
    message: string,
  ) {
    const sequence = yield* engine.latestSequence;
    const thread = yield* getThread(threadId);
    if (!eligible(thread, wait) || !thread?.session) return;
    const now = iso(yield* Clock.currentTimeMillis);
    yield* engine
      .dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId,
        session: { ...thread.session, lastError: message, updatedAt: now },
        expectedUsageLimit: expected(thread, wait, sequence),
        createdAt: now,
      })
      .pipe(Effect.ignore);
  });

  const cancel = Effect.fn("UsageLimitContinuation.cancel")(function* (threadId: ThreadId) {
    const wait = pending.get(threadId);
    if (!wait) return;
    yield* directory.setUsageLimitContinuation({
      threadId,
      pending: null,
      expectedFailedTurnId: wait.failedTurnId,
    });
    pending.delete(threadId);
    yield* Effect.gen(function* () {
      const thread = yield* query
        .getThreadShellById(threadId, { includeArchived: true })
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        thread?.session?.lastError !== waitingMessage(wait) ||
        thread.latestTurn?.turnId !== wait.failedTurnId ||
        thread.session.activeTurnId !== null ||
        thread.session.status === "starting" ||
        thread.session.status === "running"
      )
        return;
      const now = iso(yield* Clock.currentTimeMillis);
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId,
        session: { ...thread.session, lastError: wait.errorMessage, updatedAt: now },
        expectedSession: thread.session,
        createdAt: now,
      });
    }).pipe(
      // An explicit stop can update the session while its waiting banner is cleared.
      Effect.retry({
        times: 1,
        while: (error) => error._tag === "OrchestrationCommandInvariantError",
      }),
      Effect.ignore,
    );
  });

  const canceledSince = (
    threadId: ThreadId,
    wait: PendingUsageLimitContinuation,
    sequence: number,
  ) =>
    engine
      .readThreadEvents({
        threadId,
        fromSequenceExclusive: wait.snapshotSequence,
        toSequenceInclusive: sequence,
        limit: sequence - wait.snapshotSequence,
      })
      .pipe(
        Stream.filter(cancelsUsageLimitContinuation),
        Stream.runHead,
        Effect.map(Option.isSome),
      );

  const save = Effect.fn("UsageLimitContinuation.save")(function* (
    threadId: ThreadId,
    wait: PendingUsageLimitContinuation,
  ) {
    yield* directory.setUsageLimitContinuation({ threadId, pending: wait });
    pending.set(threadId, wait);
    yield* setBanner(threadId, wait, waitingMessage(wait));
  });

  type Attempt = {
    threadId: ThreadId;
    wait: PendingUsageLimitContinuation;
  };
  const finishProbe = Effect.fn("UsageLimitContinuation.finishProbe")(function* (
    instanceId: ProviderInstanceId,
    attempts: Attempt[],
    startedAt: number,
    providers: readonly ServerProvider[],
  ) {
    probing.delete(instanceId);
    const now = yield* Clock.currentTimeMillis;
    const limits = providers.find((provider) => provider.instanceId === instanceId)?.usageLimits;
    for (const attempt of attempts) {
      const { threadId, wait } = attempt;
      if (pending.get(threadId) !== wait) continue;
      const sequence = yield* engine.latestSequence;
      const thread = yield* getThread(threadId);
      if (!thread || !eligible(thread, wait)) {
        yield* cancel(threadId);
        continue;
      }
      const settings = yield* settingsService.getSettings;
      if (
        !settings.continueThreadsAfterUsageLimit ||
        (yield* canceledSince(threadId, wait, yield* engine.latestSequence))
      ) {
        yield* cancel(threadId);
        continue;
      }
      if (limits?.unavailable?.reason === "unsupported") {
        yield* cancel(threadId);
        continue;
      }
      const fresh =
        limits !== undefined &&
        !limits.unavailable &&
        Date.parse(limits.checkedAt) >= startedAt &&
        limits.windows.length > 0;
      if (fresh && limits.windows.every((window) => window.usedPercent < 100)) {
        const key = `usage-limit:${threadId}:${wait.failedTurnId}`;
        const result = yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(key),
            threadId,
            message: {
              messageId: MessageId.make(key),
              role: "user",
              text: settings.usageLimitContinuationPrompt,
              attachments: [],
            },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            expectedUsageLimit: expected(thread, wait, sequence),
            createdAt: iso(now),
          })
          .pipe(Effect.result);
        // A rejected conditional command cannot be retried under the same receipt.
        // Leave the ordinary error if the thread changed while the probe ran.
        yield* cancel(threadId);
        if (result._tag === "Failure")
          yield* Effect.logDebug("usage-limit continuation was not admitted", result.failure);
      } else {
        const retryAt = fresh ? usageLimitRetryAt(limits.windows, iso(now)) : undefined;
        yield* save(threadId, {
          ...wait,
          nextCheckAt: iso(retryAt ? Date.parse(retryAt) + 1000 : now + RECHECK_MS),
        });
      }
    }
  });

  const checkDue = Effect.fn("UsageLimitContinuation.checkDue")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const groups = new Map<ProviderInstanceId, Attempt[]>();
    for (const [threadId, wait] of pending) {
      if (probing.has(wait.providerInstanceId) || Date.parse(wait.nextCheckAt) > now) continue;
      const sequence = yield* engine.latestSequence;
      const thread = yield* getThread(threadId);
      if (!eligible(thread, wait) || !thread || (yield* canceledSince(threadId, wait, sequence))) {
        yield* cancel(threadId);
        continue;
      }
      const group = groups.get(wait.providerInstanceId) ?? [];
      group.push({ threadId, wait });
      groups.set(wait.providerInstanceId, group);
    }
    for (const [instanceId, attempts] of groups) {
      probing.add(instanceId);
      yield* registry.refreshInstance(instanceId).pipe(
        Effect.orElseSucceed(() => []),
        Effect.flatMap((providers) => enqueue(finishProbe(instanceId, attempts, now, providers))),
        Effect.forkIn(scope),
      );
    }
  });

  const armTimer: Effect.Effect<void> = Effect.gen(function* () {
    if (timer) yield* Fiber.interrupt(timer);
    timer = undefined;
    const times = [...pending.values()]
      .filter((wait) => !probing.has(wait.providerInstanceId))
      .map((wait) => Date.parse(wait.nextCheckAt));
    if (times.length === 0) return;
    const delay = Math.max(0, Math.min(...times) - (yield* Clock.currentTimeMillis));
    timer = yield* Effect.sleep(delay).pipe(
      Effect.andThen(Effect.suspend(() => enqueue(checkDue()))),
      Effect.forkIn(scope),
    );
  });
  const worker = yield* makeDrainableWorker((work: Effect.Effect<void>) =>
    work.pipe(Effect.andThen(armTimer)),
  );
  const enqueue = <E>(work: Effect.Effect<void, E>): Effect.Effect<void> =>
    worker.enqueue(
      work.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            for (const [threadId, wait] of pending) {
              if (Date.parse(wait.nextCheckAt) <= now)
                pending.set(threadId, { ...wait, nextCheckAt: iso(now + RECHECK_MS) });
            }
            yield* Effect.logWarning("usage-limit continuation failed", cause);
          }),
        ),
      ),
    );

  const recordFailure = Effect.fn("UsageLimitContinuation.recordFailure")(function* (
    event: FailedTurn,
    snapshotSequence: number,
  ) {
    yield* enqueue(
      Effect.gen(function* () {
        if (!event.payload.usageLimit || !event.turnId || !event.providerInstanceId) return;
        if (handledFailures.get(event.threadId) === event.turnId) return;
        const thread = yield* getThread(event.threadId);
        if (thread?.latestTurn?.turnId !== event.turnId || thread.latestTurn.state !== "error")
          return;
        handledFailures.set(event.threadId, TurnId.make(event.turnId));
        if (!(yield* settingsService.getSettings).continueThreadsAfterUsageLimit) return;
        const binding = yield* directory.getBinding(event.threadId);
        if (!thread || Option.isNone(binding) || binding.value.resumeCursor == null) return;
        const now = yield* Clock.currentTimeMillis;
        const retryAt = event.payload.usageLimit.retryAt;
        let nextCheckAt = retryAt ? Math.max(now, Date.parse(retryAt) + 1000) : now;
        if (!retryAt || Date.parse(retryAt) <= now) {
          const detail = yield* query.getThreadDetailSnapshot(event.threadId, { turnLimit: 1 });
          const lastUser = Option.isSome(detail)
            ? detail.value.thread.messages.findLast((message) => message.role === "user")
            : undefined;
          if (lastUser?.id.startsWith("usage-limit:"))
            nextCheckAt = Math.max(now, Date.parse(event.createdAt) + RECHECK_MS);
        }
        const wait: PendingUsageLimitContinuation = {
          failedTurnId: TurnId.make(event.turnId),
          providerInstanceId: event.providerInstanceId,
          modelSelection: thread.modelSelection,
          errorMessage: event.payload.errorMessage ?? "Usage limit reached.",
          failedAt: event.createdAt,
          snapshotSequence,
          nextCheckAt: iso(nextCheckAt),
        };
        if (
          eligible(thread, wait) &&
          !(yield* canceledSince(event.threadId, wait, yield* engine.latestSequence))
        )
          yield* save(event.threadId, wait);
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (handledFailures.get(event.threadId) === event.turnId)
              handledFailures.delete(event.threadId);
          }),
        ),
      ),
    );
  });

  const start = Effect.fn("UsageLimitContinuation.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    const changes = yield* settingsService.subscribeChanges;
    yield* forkParked(
      enqueue(
        Effect.gen(function* () {
          const enabled = (yield* settingsService.getSettings).continueThreadsAfterUsageLimit;
          for (const binding of yield* directory.listBindings()) {
            const wait = readPendingUsageLimitContinuation(binding.runtimePayload);
            if (!wait) continue;
            pending.set(binding.threadId, wait);
            handledFailures.set(binding.threadId, wait.failedTurnId);
            if (
              !enabled ||
              binding.providerInstanceId !== wait.providerInstanceId ||
              (yield* canceledSince(binding.threadId, wait, yield* engine.latestSequence))
            )
              yield* cancel(binding.threadId);
          }
        }),
      ),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        cancelsUsageLimitContinuation(event)
          ? enqueue(
              Effect.suspend(() => {
                const threadId = ThreadId.make(event.aggregateId);
                const wait = pending.get(threadId);
                return wait && event.sequence > wait.snapshotSequence
                  ? cancel(threadId)
                  : Effect.void;
              }),
            )
          : Effect.void,
      ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) =>
        settings.continueThreadsAfterUsageLimit
          ? Effect.void
          : enqueue(
              Effect.suspend(() => Effect.forEach([...pending.keys()], cancel, { discard: true })),
            ),
      ),
    );
  });
  return { start, recordFailure, drain: worker.drain } satisfies UsageLimitContinuation["Service"];
});

export const layer = Layer.effect(UsageLimitContinuation, make);
