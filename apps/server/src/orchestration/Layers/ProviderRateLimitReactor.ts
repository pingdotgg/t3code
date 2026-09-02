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
 *    with full history. Each failed turn is retried at most once.
 *
 * Ordering matters: the runtime reports the rejection before the failing
 * result, and both arrive on the same stream, so the retry decision never
 * races the state update.
 *
 * @module ProviderRateLimitReactorLive
 */
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  isProviderRateLimitActive,
  selectRateLimitFallbackProvider,
} from "@t3tools/shared/providerRateLimits";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  readProviderRateLimitFromPayload,
  readProviderRateLimitFromTurnError,
} from "../../provider/providerRateLimits.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRateLimitReactor,
  type ProviderRateLimitReactorShape,
} from "../Services/ProviderRateLimitReactor.ts";

export const PROVIDER_INSTANCE_SWITCHED_ACTIVITY_KIND = "provider.instance.switched";

const RETRIED_TURN_KEY_MAX = 512;

export function providerDisplayName(provider: Pick<ServerProvider, "displayName" | "instanceId">) {
  return provider.displayName ?? provider.instanceId;
}

export function formatRateLimitSwitchSummary(input: {
  readonly from: Pick<ServerProvider, "displayName" | "instanceId">;
  readonly to: Pick<ServerProvider, "displayName" | "instanceId">;
}): string {
  return `Switched to ${providerDisplayName(input.to)} because ${providerDisplayName(input.from)} hit its usage limit`;
}

const make = Effect.gen(function* () {
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
    });

  const retryTurnOnProvider = (input: {
    readonly thread: OrchestrationThread;
    readonly userMessage: OrchestrationThread["messages"][number];
    readonly to: ServerProvider;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const commandId = yield* serverCommandId("provider-rate-limit-retry");
      const messageId = MessageId.make(yield* crypto.randomUUIDv4);
      const modelSelection: ModelSelection = {
        ...input.thread.modelSelection,
        instanceId: input.to.instanceId,
      };
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: input.thread.id,
        message: {
          messageId,
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
      const rateLimit =
        event.type === "account.rate-limits.updated"
          ? readProviderRateLimitFromPayload({
              driver: event.provider,
              payload: event.payload,
              observedAt: event.createdAt,
            })
          : event.type === "turn.completed" && event.payload.state === "failed"
            ? readProviderRateLimitFromTurnError({
                errorMessage: event.payload.errorMessage,
                observedAt: event.createdAt,
              })
            : undefined;
      if (!rateLimit) return;
      // A structured update always wins; the error-text heuristic only fills
      // in when nothing structured has marked this account as limited.
      if (event.type === "turn.completed") {
        const providers = yield* providerRegistry.getProviders;
        const current = providers.find((p) => p.instanceId === event.providerInstanceId);
        if (isProviderRateLimitActive(current?.rateLimit, Date.parse(event.createdAt))) return;
      }
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

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) return;
      const userMessages = thread.messages
        .toReversed()
        .filter((message) => message.role === "user" && message.text.trim().length > 0);
      const userMessage =
        userMessages.find((message) => message.turnId === event.turnId) ?? userMessages[0];
      if (!userMessage) return;

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

  const processEvent = (event: ProviderRuntimeEvent) =>
    recordRateLimit(event).pipe(
      Effect.andThen(maybeSwitchFailedTurn(event)),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider rate limit reactor failed to process runtime event", {
          eventId: event.eventId,
          eventType: event.type,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const worker = yield* makeDrainableWorker(processEvent);

  const start: ProviderRateLimitReactorShape["start"] = () =>
    forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "account.rate-limits.updated" &&
          !(event.type === "turn.completed" && event.payload.state === "failed")
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRateLimitReactorShape;
});

export const ProviderRateLimitReactorLive = Layer.effect(ProviderRateLimitReactor, make);
