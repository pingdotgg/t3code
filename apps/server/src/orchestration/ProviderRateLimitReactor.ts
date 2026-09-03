/**
 * ProviderRateLimitReactor - Live usage-limit tracking and account fallback.
 *
 * Consumes provider runtime events in order:
 *
 * 1. `account.rate-limits.updated` is normalized per driver and projected onto
 *    `ServerProvider.rateLimit`, so every client can show which account is
 *    limited and when it resets.
 * 2. A turn that fails while its account is limited is re-sent on a sibling
 *    account when `autoSwitchProviderOnRateLimit` is enabled. The sibling must
 *    share the driver and continuation group so the provider session resumes
 *    with full history. The retry reuses the original user message, so the
 *    thread shows one bubble, and each failed turn is retried at most once.
 *
 * Ordering matters: the runtime reports the rejection before the failing
 * result, and both arrive on the same stream, so the retry decision never
 * races the state update. Turn-start domain events are also observed so the
 * reactor knows which user message started the turn that failed.
 *
 * @module orchestration/ProviderRateLimitReactor
 */
import {
  CommandId,
  EventId,
  type MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type ServerProvider,
  type ServerProviderRateLimit,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  isProviderRateLimitActive,
  selectRateLimitFallbackProvider,
} from "@t3tools/shared/providerRateLimits";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  readProviderRateLimitFromPayload,
  readProviderRateLimitFromTurnError,
  TURN_ERROR_RATE_LIMIT_WINDOW,
} from "../provider/providerRateLimits.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export class ProviderRateLimitReactor extends Context.Service<
  ProviderRateLimitReactor,
  {
    /**
     * Start consuming provider runtime and turn-start events. The returned
     * effect must be run in a scope so the worker fiber is finalized on
     * shutdown.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves when every queued event has been processed. Test use only. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ProviderRateLimitReactor") {}

export const PROVIDER_INSTANCE_SWITCHED_ACTIVITY_KIND = "provider.instance.switched";

const RETRIED_TURN_KEY_MAX = 512;

type ReactorInput =
  | { readonly source: "runtime"; readonly event: ProviderRuntimeEvent }
  | {
      readonly source: "domain";
      readonly event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
    };

export function providerDisplayName(provider: Pick<ServerProvider, "displayName" | "instanceId">) {
  return provider.displayName ?? provider.instanceId;
}

export function formatRateLimitSwitchSummary(input: {
  readonly from: Pick<ServerProvider, "displayName" | "instanceId">;
  readonly to: Pick<ServerProvider, "displayName" | "instanceId">;
}): string {
  return `Switched to ${providerDisplayName(input.to)} because ${providerDisplayName(input.from)} hit its usage limit`;
}

/**
 * Codex reports windows sparsely: an update carrying only the 5-hour window
 * says nothing about a still-rejected weekly window. Keep the previous
 * rejection until its own reset passes or an update names that window.
 */
export function mergeCodexRateLimit(
  previous: ServerProviderRateLimit | undefined,
  next: ServerProviderRateLimit,
  nowMs: number,
): ServerProviderRateLimit {
  if (
    previous !== undefined &&
    // An error-text detection is not a Codex window; a structured update replaces it.
    previous.window !== TURN_ERROR_RATE_LIMIT_WINDOW &&
    next.status !== "rejected" &&
    isProviderRateLimitActive(previous, nowMs) &&
    previous.resetsAt !== undefined &&
    next.resetsAt !== previous.resetsAt
  ) {
    return previous;
  }
  return next;
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const serverSettingsService = yield* ServerSettingsService;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

  // Failed turns already retried once, keyed by `${threadId}:${turnId}`.
  const retriedTurnKeys = new Set<string>();
  const rememberRetriedTurn = (key: string) => {
    if (retriedTurnKeys.size >= RETRIED_TURN_KEY_MAX) {
      const oldest = retriedTurnKeys.values().next().value;
      if (oldest !== undefined) retriedTurnKeys.delete(oldest);
    }
    retriedTurnKeys.add(key);
  };
  // The user message that started each thread's most recent turn. Messages
  // are stored with a null turn id, so this is the only link back from a
  // failed turn to the prompt that should be retried.
  // Bounded like the retry set: threads beyond the cap simply lose auto-retry
  // for their oldest entries, they never leak.
  const LATEST_TURN_MESSAGE_MAX = 512;
  const latestTurnMessageByThread = new Map<ThreadId, MessageId>();
  const rememberLatestTurnMessage = (threadId: ThreadId, messageId: MessageId) => {
    latestTurnMessageByThread.delete(threadId);
    if (latestTurnMessageByThread.size >= LATEST_TURN_MESSAGE_MAX) {
      const oldest = latestTurnMessageByThread.keys().next().value;
      if (oldest !== undefined) latestTurnMessageByThread.delete(oldest);
    }
    latestTurnMessageByThread.set(threadId, messageId);
  };

  const autoSwitchEnabled = serverSettingsService.getSettings.pipe(
    Effect.map((settings) => settings.autoSwitchProviderOnRateLimit),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read server settings; skipping provider auto-switch.", {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );

  const resolveThreadDetail = (threadId: ThreadId) =>
    projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));

  const appendSwitchActivity = (input: {
    readonly threadId: ThreadId;
    readonly from: ServerProvider;
    readonly to: ServerProvider;
    readonly turnId: ProviderRuntimeEvent["turnId"];
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const commandId = yield* serverCommandId("provider-rate-limit-switch");
      const eventId = yield* serverEventId();
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.threadId,
        activity: {
          id: eventId,
          tone: "info",
          kind: PROVIDER_INSTANCE_SWITCHED_ACTIVITY_KIND,
          summary: formatRateLimitSwitchSummary(input),
          payload: {
            reason: "rate-limit",
            fromInstanceId: input.from.instanceId,
            toInstanceId: input.to.instanceId,
            ...(input.from.rateLimit?.resetsAt ? { resetsAt: input.from.rateLimit.resetsAt } : {}),
          },
          turnId: input.turnId ?? null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    }).pipe(
      // The switch note is informational; never let it block the retry.
      Effect.catchCause((cause) =>
        Effect.logWarning("provider rate limit reactor could not record the account switch", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const retryTurnOnProvider = (input: {
    readonly thread: OrchestrationThread;
    readonly userMessage: OrchestrationThread["messages"][number];
    readonly to: ServerProvider;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const commandId = yield* serverCommandId("provider-rate-limit-retry");
      const modelSelection: ModelSelection = {
        ...input.thread.modelSelection,
        instanceId: input.to.instanceId,
      };
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: input.thread.id,
        message: {
          // Same id as the original: the projection upserts instead of
          // appending, so the transcript keeps a single bubble.
          messageId: input.userMessage.id,
          role: "user",
          text: input.userMessage.text,
          attachments: input.userMessage.attachments ?? [],
        },
        modelSelection,
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        createdAt: input.createdAt,
      });
    });

  const recordRateLimit = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (event.providerInstanceId === undefined) return;
      const derived =
        event.type === "account.rate-limits.updated"
          ? readProviderRateLimitFromPayload({
              driver: event.provider,
              payload: event.payload,
              observedAt: event.createdAt,
            })
          : event.type === "turn.completed" && event.payload.state === "failed"
            ? readProviderRateLimitFromTurnError({
                driver: event.provider,
                errorMessage: event.payload.errorMessage,
                observedAt: event.createdAt,
              })
            : undefined;
      if (!derived) return;
      const nowMs = Date.parse(event.createdAt);
      const providers = yield* providerRegistry.getProviders;
      const previous = providers.find((p) => p.instanceId === event.providerInstanceId)?.rateLimit;
      // A structured update always wins; the error-text heuristic only fills
      // in when nothing structured has marked this account as limited.
      if (event.type === "turn.completed" && isProviderRateLimitActive(previous, nowMs)) return;
      const rateLimit =
        event.provider === "codex" && event.type === "account.rate-limits.updated"
          ? mergeCodexRateLimit(previous, derived, nowMs)
          : derived;
      yield* providerRegistry.setProviderRateLimit({
        instanceId: event.providerInstanceId,
        rateLimit,
      });
    });

  const maybeSwitchFailedTurn = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (event.type !== "turn.completed" || event.payload.state !== "failed") return;
      if (event.providerInstanceId === undefined || event.turnId === undefined) return;
      const retryKey = `${event.threadId}:${event.turnId}`;
      if (retriedTurnKeys.has(retryKey)) return;

      const nowMs = Date.parse(event.createdAt);
      const providers = yield* providerRegistry.getProviders;
      const from = providers.find((p) => p.instanceId === event.providerInstanceId);
      if (!from || !isProviderRateLimitActive(from.rateLimit, nowMs)) return;
      if (!(yield* autoSwitchEnabled)) return;

      const to = selectRateLimitFallbackProvider({
        providers,
        instanceId: from.instanceId,
        nowMs,
      });
      if (!to) {
        yield* Effect.logInfo("provider rate limit reactor found no fallback account", {
          threadId: event.threadId,
          instanceId: from.instanceId,
        });
        return;
      }

      const messageId = latestTurnMessageByThread.get(event.threadId);
      if (messageId === undefined) {
        yield* Effect.logWarning(
          "provider rate limit reactor has no turn-start record for the failed turn; not retrying",
          { threadId: event.threadId, turnId: event.turnId },
        );
        return;
      }
      const thread = yield* resolveThreadDetail(event.threadId);
      const userMessage = thread?.messages.find(
        (message) => message.id === messageId && message.role === "user",
      );
      if (!thread || !userMessage) return;

      rememberRetriedTurn(retryKey);
      yield* Effect.logInfo("provider rate limit reactor switching thread to fallback account", {
        threadId: thread.id,
        turnId: event.turnId,
        fromInstanceId: from.instanceId,
        toInstanceId: to.instanceId,
        resetsAt: from.rateLimit?.resetsAt,
      });
      yield* appendSwitchActivity({
        threadId: thread.id,
        from,
        to,
        turnId: event.turnId,
        createdAt: event.createdAt,
      });
      yield* retryTurnOnProvider({ thread, userMessage, to, createdAt: event.createdAt });
    });

  const processInput = (input: ReactorInput) =>
    (input.source === "domain"
      ? Effect.sync(() => {
          rememberLatestTurnMessage(input.event.payload.threadId, input.event.payload.messageId);
        })
      : recordRateLimit(input.event).pipe(Effect.andThen(maybeSwitchFailedTurn(input.event)))
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider rate limit reactor failed to process event", {
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const worker = yield* makeDrainableWorker(processInput);

  const start: ProviderRateLimitReactor["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        Stream.runForEach(providerService.streamEvents, (event) => {
          if (
            event.type !== "account.rate-limits.updated" &&
            !(event.type === "turn.completed" && event.payload.state === "failed")
          ) {
            return Effect.void;
          }
          return worker.enqueue({ source: "runtime", event });
        }),
      );
      // Subscribe before returning so no turn start is missed while event
      // handling waits for server activation.
      const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
      yield* forkParked(
        Stream.runForEach(domainEvents, (event) =>
          event.type === "thread.turn-start-requested"
            ? worker.enqueue({ source: "domain", event })
            : Effect.void,
        ),
      );
    });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRateLimitReactor["Service"];
});

export const layer = Layer.effect(ProviderRateLimitReactor, make);
