import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Retries turns that failed because the provider was temporarily overloaded.
 * After a delay it asks the agent to continue; a user message sent in the
 * meantime always wins over the automatic retry.
 */
export class ProviderBusyRetryReactor extends Context.Service<
  ProviderBusyRetryReactor,
  {
    /** Must run in a scope so pending retries are cancelled on shutdown. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves when the processing queue is idle. For tests, in place of sleeps. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ProviderBusyRetryReactor") {}

type ThreadSessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;

/**
 * Delay before each automatic retry. The length is the retry budget; once it
 * is spent the failure stays terminal until the user sends a message.
 */
const PROVIDER_BUSY_RETRY_DELAYS = [
  Duration.minutes(1),
  Duration.minutes(5),
  Duration.minutes(15),
] as const;

export const PROVIDER_BUSY_RETRY_TEXT =
  "The provider was temporarily at capacity and the last turn stopped. Continue where you left off.";

/**
 * Whether a turn error describes the provider or model being temporarily
 * overloaded. Conservative on purpose because a match restarts the agent: a
 * bare 503 is excluded since proxies also use it for revoked credentials.
 */
export function isProviderBusyError(message: string): boolean {
  return /\b(?:model|server|service|provider|api)s? (?:is |are )?(?:currently |temporarily )?(?:at capacity|overloaded)\b|overloaded_error|serverOverloaded/iu.test(
    message,
  );
}

interface RetryState {
  readonly attempt: number;
  /**
   * `latestUserMessageAt` once the attempt was spent. While it still matches
   * the thread, no real user message has arrived and the budget keeps counting.
   */
  readonly retryMessageAt: string | null;
  /** The budget is spent; stays set until a real user message arrives. */
  readonly exhausted: boolean;
}

/** The failed turn a retry was scheduled for. */
interface FailureIdentity {
  readonly turnId: TurnId | null;
  readonly latestUserMessageAt: string | null;
}

/** Whether the thread is still sitting, unparked, on the busy failure the retry was scheduled for. */
function busyRetryStillWanted(
  thread: OrchestrationThreadShell | undefined,
  expected: FailureIdentity,
  nowIso: string,
): thread is OrchestrationThreadShell {
  const snoozedUntil = thread?.snoozedUntil ?? null;
  return (
    thread !== undefined &&
    thread.archivedAt === null &&
    // Settling or snoozing parks the thread; only the user un-parks it.
    // An expired snooze no longer parks it.
    thread.settledOverride !== "settled" &&
    (snoozedUntil === null || Date.parse(snoozedUntil) <= Date.parse(nowIso)) &&
    thread.session?.status === "error" &&
    isProviderBusyError(thread.session.lastError ?? "") &&
    thread.latestTurn?.state === "error" &&
    thread.latestTurn.turnId === expected.turnId &&
    thread.latestUserMessageAt === expected.latestUserMessageAt
  );
}

/**
 * Builds the session-set handler. Kept apart from the stream wiring so tests
 * can drive it directly and advance the clock instead of sleeping. Pending
 * retries are forked into the surrounding scope, so closing it cancels them.
 */
/** @internal Exported for tests. */
export const makeRetryHandler = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const scope = yield* Effect.scope;
  // A failed read fails the step; only a successful miss means the thread is gone.
  const readThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(threadId).pipe(Effect.map(Option.getOrUndefined));
  const retryStates = new Map<ThreadId, RetryState>();
  const pending = new Map<ThreadId, FailureIdentity & { fiber?: Fiber.Fiber<void, unknown> }>();

  // Budget state only matters while the thread can still be retried.
  const forgetGoneThread = (threadId: ThreadId, thread: OrchestrationThreadShell | undefined) => {
    if (thread === undefined || thread.archivedAt !== null) retryStates.delete(threadId);
  };

  const deliverRetry = Effect.fn("deliverProviderBusyRetry")(function* (
    input: FailureIdentity & { readonly threadId: ThreadId; readonly attempt: number },
  ) {
    const thread = yield* readThread(input.threadId);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    if (!busyRetryStillWanted(thread, input, createdAt)) {
      forgetGoneThread(input.threadId, thread);
      return;
    }
    const id = yield* crypto.randomUUIDv4;
    // A failed delivery still spends the attempt, so a rejected dispatch cannot loop.
    retryStates.set(input.threadId, {
      attempt: input.attempt,
      retryMessageAt: input.latestUserMessageAt,
      exhausted: false,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:provider-busy-retry:${id}`),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(`provider-busy-retry:${id}`),
        role: "user",
        text: PROVIDER_BUSY_RETRY_TEXT,
        attachments: [],
      },
      // No modelSelection: the turn uses whatever the thread has when it is decided.
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      // The engine re-checks this atomically, closing the gap since the read above.
      onlyIfUnchanged: {
        latestTurnId: input.turnId,
        latestUserMessageAt: input.latestUserMessageAt,
      },
      createdAt,
    });
    retryStates.set(input.threadId, {
      attempt: input.attempt,
      retryMessageAt: createdAt,
      exhausted: false,
    });
  });

  const processSessionSet = Effect.fn("processProviderBusySessionSet")(function* (
    event: ThreadSessionSetEvent,
  ) {
    const { threadId, session } = event.payload;
    if (session.status !== "error" || !isProviderBusyError(session.lastError ?? "")) return;
    const thread = yield* readThread(threadId);
    forgetGoneThread(threadId, thread);
    // A busy-looking error after a turn that finished is not a stopped turn.
    if (
      thread === undefined ||
      thread.latestTurn == null ||
      thread.latestTurn.state === "completed"
    )
      return;
    const failure: FailureIdentity = {
      turnId: thread.latestTurn.turnId,
      latestUserMessageAt: thread.latestUserMessageAt,
    };
    const scheduled = pending.get(threadId);
    if (scheduled !== undefined) {
      // runtime.error and turn.completed both report the same failure.
      if (
        scheduled.turnId === failure.turnId &&
        scheduled.latestUserMessageAt === failure.latestUserMessageAt
      )
        return;
      // A newer failure replaces the retry scheduled for the old one.
      pending.delete(threadId);
      if (scheduled.fiber !== undefined) yield* Fiber.interrupt(scheduled.fiber);
    }
    const previous = retryStates.get(threadId);
    // A real user message since our last retry starts a fresh budget.
    const continuing =
      previous !== undefined && previous.retryMessageAt === thread.latestUserMessageAt;
    if (continuing && previous.exhausted) return;
    const attempt = continuing ? previous.attempt + 1 : 1;
    const delay = PROVIDER_BUSY_RETRY_DELAYS[attempt - 1];
    if (delay === undefined) {
      retryStates.set(threadId, { ...previous!, exhausted: true });
      return;
    }
    const entry: FailureIdentity & { fiber?: Fiber.Fiber<void, unknown> } = { ...failure };
    pending.set(threadId, entry);
    entry.fiber = yield* Effect.sleep(delay).pipe(
      Effect.andThen(deliverRetry({ threadId, attempt, ...failure })),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider busy retry failed to deliver", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (pending.get(threadId) === entry) pending.delete(threadId);
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  return processSessionSet;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const processSessionSet = yield* makeRetryHandler;

  const processSessionSetSafely = (event: ThreadSessionSetEvent) =>
    processSessionSet(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider busy retry reactor failed to process event", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processSessionSetSafely);

  const start: ProviderBusyRetryReactor["Service"]["start"] = Effect.fn("start")(function* () {
    // Subscribe before forking so an event published while the consumer parks is not lost.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(domainEvents, (event) => {
        if (event.type !== "thread.session-set") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return ProviderBusyRetryReactor.of({ start, drain: worker.drain });
});

export const layer = Layer.effect(ProviderBusyRetryReactor, make);
