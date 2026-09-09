/**
 * ProviderAccountSwitchReactor - continue a thread on another account when
 * the one it is bound to runs out of subscription usage.
 *
 * Usage windows themselves are owned by the provider snapshot: adapters
 * normalise their native payloads and `ProviderUsageLimitsIngestion` merges
 * them onto `ServerProvider.usageLimits`. This reactor only reads that state
 * and reacts to it.
 *
 * When a turn fails while its account has a spent window, and the user has
 * turned on `autoSwitchProviderOnRateLimit`, the turn is re-sent on a sibling
 * account that shares the driver and continuation group, so the provider
 * session resumes with full history. The retry reuses the original user
 * message id, so the thread keeps one bubble, and each failed turn is retried
 * at most once.
 *
 * Turn-start domain events are observed so a failed turn can be traced back
 * to the message that started it: messages are stored with a null turn id.
 *
 * @module orchestration/ProviderAccountSwitchReactor
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
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  exhaustedUsageWindow,
  selectAccountSwitchTarget,
} from "@t3tools/shared/providerAccountSwitching";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export class ProviderAccountSwitchReactor extends Context.Service<
  ProviderAccountSwitchReactor,
  {
    /**
     * Start consuming failed turns and turn starts. The returned effect must
     * be run in a scope so the worker fiber is finalized on shutdown.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves when every queued event has been processed. Test use only. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ProviderAccountSwitchReactor") {}

export const PROVIDER_INSTANCE_SWITCHED_ACTIVITY_KIND = "provider.instance.switched";

const RETRIED_TURN_KEY_MAX = 512;
const LATEST_TURN_MESSAGE_MAX = 512;

type ReactorInput =
  | { readonly source: "runtime"; readonly event: ProviderRuntimeEvent }
  | {
      readonly source: "domain";
      readonly event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
    };

export function providerDisplayName(provider: Pick<ServerProvider, "displayName" | "instanceId">) {
  return provider.displayName ?? provider.instanceId;
}

export function formatAccountSwitchSummary(input: {
  readonly from: Pick<ServerProvider, "displayName" | "instanceId">;
  readonly to: Pick<ServerProvider, "displayName" | "instanceId">;
}): string {
  return `Switched to ${providerDisplayName(input.to)} because ${providerDisplayName(input.from)} ran out of usage`;
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

  // The user message that started each thread's most recent turn. Bounded:
  // threads past the cap lose auto-retry rather than leaking memory.
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
    readonly resetsAt: string | undefined;
    readonly turnId: ProviderRuntimeEvent["turnId"];
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const commandId = yield* serverCommandId("provider-account-switch");
      const eventId = yield* serverEventId();
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.threadId,
        activity: {
          id: eventId,
          tone: "info",
          kind: PROVIDER_INSTANCE_SWITCHED_ACTIVITY_KIND,
          summary: formatAccountSwitchSummary(input),
          payload: {
            reason: "usage-limit",
            fromInstanceId: input.from.instanceId,
            toInstanceId: input.to.instanceId,
            ...(input.resetsAt ? { resetsAt: input.resetsAt } : {}),
          },
          turnId: input.turnId ?? null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    }).pipe(
      // The switch note is informational; never let it block the retry.
      Effect.catchCause((cause) =>
        Effect.logWarning("provider account switch reactor could not record the switch", {
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
      const commandId = yield* serverCommandId("provider-account-switch-retry");
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

  const maybeSwitchFailedTurn = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (event.type !== "turn.completed" || event.payload.state !== "failed") return;
      if (event.providerInstanceId === undefined || event.turnId === undefined) return;
      const retryKey = `${event.threadId}:${event.turnId}`;
      if (retriedTurnKeys.has(retryKey)) return;

      const nowMs = Date.parse(event.createdAt);
      const providers = yield* providerRegistry.getProviders;
      const from = providers.find((p) => p.instanceId === event.providerInstanceId);
      if (!from) return;
      const spent = exhaustedUsageWindow(from, nowMs);
      if (!spent) return;
      if (!(yield* autoSwitchEnabled)) return;

      const to = selectAccountSwitchTarget({
        providers,
        instanceId: from.instanceId,
        nowMs,
      });
      if (!to) {
        yield* Effect.logInfo("provider account switch reactor found no account with usage left", {
          threadId: event.threadId,
          instanceId: from.instanceId,
        });
        return;
      }

      const messageId = latestTurnMessageByThread.get(event.threadId);
      if (messageId === undefined) {
        yield* Effect.logWarning(
          "provider account switch reactor has no turn-start record for the failed turn; not retrying",
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
      yield* Effect.logInfo("provider account switch reactor moving thread to another account", {
        threadId: thread.id,
        turnId: event.turnId,
        fromInstanceId: from.instanceId,
        toInstanceId: to.instanceId,
        window: spent.id,
        resetsAt: spent.resetsAt,
      });
      yield* appendSwitchActivity({
        threadId: thread.id,
        from,
        to,
        resetsAt: spent.resetsAt,
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
      : maybeSwitchFailedTurn(input.event)
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider account switch reactor failed to process event", {
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const worker = yield* makeDrainableWorker(processInput);

  const start: ProviderAccountSwitchReactor["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        Stream.runForEach(providerService.streamEvents, (event) =>
          event.type === "turn.completed" && event.payload.state === "failed"
            ? worker.enqueue({ source: "runtime", event })
            : Effect.void,
        ),
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
  } satisfies ProviderAccountSwitchReactor["Service"];
});

export const layer = Layer.effect(ProviderAccountSwitchReactor, make);
