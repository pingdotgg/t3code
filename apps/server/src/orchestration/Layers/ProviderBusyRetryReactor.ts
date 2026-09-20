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
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderBusyRetryReactor,
  type ProviderBusyRetryReactorShape,
} from "../Services/ProviderBusyRetryReactor.ts";

type ThreadSessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;

/**
 * Delay before each automatic retry. The length is the retry budget; once it
 * is spent the failure stays terminal until the user sends a message.
 */
export const PROVIDER_BUSY_RETRY_DELAYS = [
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
export function busyRetryStillWanted(
  thread: OrchestrationThreadShell | undefined,
  expected: FailureIdentity,
): thread is OrchestrationThreadShell {
  return (
    thread !== undefined &&
    thread.archivedAt === null &&
    // Settling or snoozing parks the thread; only the user un-parks it.
    thread.settledOverride !== "settled" &&
    (thread.snoozedUntil ?? null) === null &&
    thread.session?.status === "error" &&
    isProviderBusyError(thread.session.lastError ?? "") &&
    thread.latestTurn?.state === "error" &&
    thread.latestTurn.turnId === expected.turnId &&
    thread.latestUserMessageAt === expected.latestUserMessageAt
  );
}

/**
 * Builds the session-set handler. Kept apart from the stream wiring so tests
 * can drive it directly and advance the clock instead of sleeping.
 */
export const makeProviderBusyRetryHandler = (deps: {
  readonly dispatch: OrchestrationEngineShape["dispatch"];
  readonly readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadShell | undefined>;
  readonly makeId: Effect.Effect<string>;
  readonly scope: Scope.Scope;
}) => {
  const retryStates = new Map<ThreadId, RetryState>();
  const pending = new Map<ThreadId, FailureIdentity & { fiber?: Fiber.Fiber<void, unknown> }>();
  const { readThread } = deps;

  const deliverRetry = Effect.fn("deliverProviderBusyRetry")(function* (
    input: FailureIdentity & { readonly threadId: ThreadId; readonly attempt: number },
  ) {
    const thread = yield* readThread(input.threadId);
    if (!busyRetryStillWanted(thread, input)) return;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const id = yield* deps.makeId;
    // A failed delivery still spends the attempt, so a rejected dispatch cannot loop.
    retryStates.set(input.threadId, {
      attempt: input.attempt,
      retryMessageAt: input.latestUserMessageAt,
      exhausted: false,
    });
    yield* deps.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:provider-busy-retry:${id}`),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(`provider-busy-retry:${id}`),
        role: "user",
        text: PROVIDER_BUSY_RETRY_TEXT,
        attachments: [],
      },
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
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
      Effect.forkIn(deps.scope),
    );
  });

  return processSessionSet;
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  let processSessionSet: ReturnType<typeof makeProviderBusyRetryHandler> | undefined;

  const processSessionSetSafely = (event: ThreadSessionSetEvent) =>
    (processSessionSet?.(event) ?? Effect.void).pipe(
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

  const start: ProviderBusyRetryReactorShape["start"] = Effect.fn("start")(function* () {
    processSessionSet = makeProviderBusyRetryHandler({
      dispatch: orchestrationEngine.dispatch,
      makeId: crypto.randomUUIDv4.pipe(Effect.orDie),
      readThread: (threadId) =>
        projectionSnapshotQuery.getThreadShellById(threadId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        ),
      scope: yield* Effect.scope,
    });
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.session-set") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderBusyRetryReactorShape;
});

export const ProviderBusyRetryReactorLive = Layer.effect(ProviderBusyRetryReactor, make);
