import {
  isListedThreadLineage,
  type OrchestrationV2DomainEvent,
  type Project,
  type ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { BRAND_APP_NAME, BRAND_URL_SCHEME } from "@t3tools/shared/brand";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import * as ThreadViewers from "../orchestration-v2/ThreadViewers.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";

const SEND_TIMEOUT = Duration.seconds(10);
const TELEGRAM_API_ORIGIN = "https://api.telegram.org";

export class WebhookNotificationDeliveryError extends Schema.TaggedError<WebhookNotificationDeliveryError>()(
  "WebhookNotificationDeliveryError",
  {
    channel: Schema.Literals(["ntfy", "telegram"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to deliver ${this.channel} webhook notification.`;
  }
}

export interface CustomWebhookNotification {
  readonly event: "sandbox_auto_stopped" | "sandbox_warning" | "custom";
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string;
  readonly priority?: "default" | "high";
}

interface ResolvedWebhookConfig {
  readonly ntfy: {
    readonly topicUrl: string;
    readonly authToken: Redacted.Redacted<string> | undefined;
  } | null;
  readonly telegram: {
    readonly botToken: Redacted.Redacted<string>;
    readonly chatId: string;
  } | null;
  readonly deepLinkScheme: string;
}

interface OutboundNotification {
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string;
  readonly priority: "default" | "high";
  readonly tags: ReadonlyArray<string>;
}

export class WebhookNotificationService extends Context.Service<
  WebhookNotificationService,
  {
    readonly evaluateThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly notifyCustom: (input: CustomWebhookNotification) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/notifications/WebhookNotificationService") {}

function parseHttpUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function normalizeScheme(raw: string | undefined): string {
  const trimmed = raw?.trim().toLowerCase().replace(/:$/, "");
  return trimmed && /^[a-z][a-z0-9+.-]*$/.test(trimmed) ? trimmed : BRAND_URL_SCHEME;
}

function buildThreadDeepLink(scheme: string, threadId: ThreadId): string {
  return `${scheme}://thread/${encodeURIComponent(threadId)}`;
}

function shouldEvaluateWebhookEvent(event: Pick<OrchestrationV2DomainEvent, "type">): boolean {
  switch (event.type) {
    case "run.updated":
    case "runtime-request.updated":
    case "thread.settled":
    case "thread.archived":
    case "thread.deleted":
      return true;
    default:
      return false;
  }
}

const readWebhookConfig = Effect.fn("WebhookNotificationService.readConfig")(function* () {
  const [ntfyTopicRaw, ntfyAuthToken, telegramBotToken, telegramChatIdRaw, schemeRaw] =
    yield* Effect.all([
      Config.option(Config.String("NTFY_TOPIC_URL")),
      Config.option(Config.Redacted("NTFY_AUTH_TOKEN")),
      Config.option(Config.Redacted("TELEGRAM_BOT_TOKEN")),
      Config.option(Config.String("TELEGRAM_CHAT_ID")),
      Config.option(Config.String("NOTIFICATION_DEEP_LINK_SCHEME")),
    ]).pipe(
      Effect.orElseSucceed(
        () => [Option.none(), Option.none(), Option.none(), Option.none(), Option.none()] as const,
      ),
    );

  const ntfyTopicUrl = parseHttpUrl(Option.getOrUndefined(ntfyTopicRaw));
  if (Option.isSome(ntfyTopicRaw) && ntfyTopicRaw.value.trim().length > 0 && !ntfyTopicUrl) {
    yield* Effect.logWarning("Ignoring invalid NTFY_TOPIC_URL; expected http(s) URL.");
  }
  const ntfyToken = Option.getOrUndefined(
    Option.filter(ntfyAuthToken, (value) => Redacted.value(value).trim().length > 0),
  );

  const botToken = Option.getOrUndefined(
    Option.filter(telegramBotToken, (value) => Redacted.value(value).trim().length > 0),
  );
  const chatId = Option.getOrUndefined(telegramChatIdRaw)?.trim() || undefined;

  return {
    ntfy: ntfyTopicUrl ? { topicUrl: ntfyTopicUrl, authToken: ntfyToken } : null,
    telegram: botToken && chatId ? { botToken, chatId } : null,
    deepLinkScheme: normalizeScheme(Option.getOrUndefined(schemeRaw)),
  } satisfies ResolvedWebhookConfig;
});

function hasAnyChannel(config: ResolvedWebhookConfig): boolean {
  return config.ntfy !== null || config.telegram !== null;
}

const sendNtfy = Effect.fn("WebhookNotificationService.sendNtfy")(function* (
  httpClient: HttpClient.HttpClient,
  ntfy: NonNullable<ResolvedWebhookConfig["ntfy"]>,
  notification: OutboundNotification,
) {
  const body = notification.deepLink
    ? `${notification.body}\n${notification.deepLink}`
    : notification.body;
  let request = HttpClientRequest.post(ntfy.topicUrl).pipe(
    HttpClientRequest.setHeader("Title", notification.title),
    HttpClientRequest.setHeader("Priority", notification.priority),
    HttpClientRequest.setHeader("Tags", notification.tags.join(",")),
    HttpClientRequest.bodyText(body, "text/plain; charset=utf-8"),
  );
  if (notification.deepLink) {
    request = HttpClientRequest.setHeader(request, "Click", notification.deepLink);
  }
  if (ntfy.authToken) {
    request = HttpClientRequest.setHeader(
      request,
      "Authorization",
      `Bearer ${Redacted.value(ntfy.authToken).trim()}`,
    );
  }
  yield* httpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.timeout(SEND_TIMEOUT),
    Effect.mapError((cause) => new WebhookNotificationDeliveryError({ channel: "ntfy", cause })),
    Effect.asVoid,
  );
});

const sendTelegram = Effect.fn("WebhookNotificationService.sendTelegram")(function* (
  httpClient: HttpClient.HttpClient,
  telegram: NonNullable<ResolvedWebhookConfig["telegram"]>,
  notification: OutboundNotification,
) {
  const lines = [
    notification.title,
    notification.body,
    ...(notification.deepLink ? ["", notification.deepLink] : []),
  ];
  const url = `${TELEGRAM_API_ORIGIN}/bot${encodeURIComponent(Redacted.value(telegram.botToken).trim())}/sendMessage`;
  yield* HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      chat_id: telegram.chatId,
      text: lines.join("\n"),
      disable_web_page_preview: true,
    }),
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.timeout(SEND_TIMEOUT),
    Effect.mapError(
      (cause) => new WebhookNotificationDeliveryError({ channel: "telegram", cause }),
    ),
    Effect.asVoid,
  );
});

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threadViewers = yield* ThreadViewers.ThreadViewers;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* readWebhookConfig();
  const startedAtMs = (yield* DateTime.now).epochMilliseconds;
  const lastDispatchedKeyByThread = new Map<ThreadId, string>();

  const deliver = Effect.fn("WebhookNotificationService.deliver")(function* (
    notification: OutboundNotification,
  ) {
    if (!hasAnyChannel(config)) return;
    const tasks: Array<Effect.Effect<void, WebhookNotificationDeliveryError>> = [];
    if (config.ntfy) {
      tasks.push(sendNtfy(httpClient, config.ntfy, notification));
    }
    if (config.telegram) {
      tasks.push(sendTelegram(httpClient, config.telegram, notification));
    }
    yield* Effect.forEach(
      tasks,
      (task) =>
        task.pipe(
          Effect.catchTags({
            WebhookNotificationDeliveryError: (error) =>
              Effect.logWarning(error.message, { channel: error.channel }),
          }),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  // Runs per thread evaluation inside the drainable worker; its outer span covers delivery.
  const evaluateThreadUnsafe = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (!hasAnyChannel(config)) return;
    const snapshot = yield* threads.getAgentAwarenessSnapshot(threadId);
    const thread = snapshot.threads[0] ?? null;
    if (thread === null || thread.archivedAt !== null || !isListedThreadLineage(thread.lineage)) {
      lastDispatchedKeyByThread.delete(threadId);
      return;
    }

    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project)) return;

    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const awareness = projectThreadAwarenessV2({
      environmentId,
      project: project.value satisfies Project,
      thread,
    });
    if (awareness === null) {
      lastDispatchedKeyByThread.delete(threadId);
      return;
    }

    const isActionablePhase =
      awareness.phase === "waiting_for_approval" ||
      awareness.phase === "waiting_for_input" ||
      awareness.phase === "completed" ||
      awareness.phase === "failed";
    if (!isActionablePhase) {
      lastDispatchedKeyByThread.delete(threadId);
      return;
    }

    if (
      (awareness.phase === "completed" || awareness.phase === "failed") &&
      (thread.latestRunCompletedAt == null ||
        DateTime.toEpochMillis(thread.latestRunCompletedAt) <= startedAtMs)
    ) {
      return;
    }
    if (
      awareness.phase === "completed" &&
      thread.latestRunCompletedAt != null &&
      isSnoozed(thread, DateTime.toEpochMillis(thread.latestRunCompletedAt))
    ) {
      return;
    }

    const dedupeId = thread.pendingRuntimeRequest?.id ?? thread.latestRunId ?? awareness.updatedAt;
    const dispatchKey = `${awareness.phase}:${dedupeId}`;
    if (lastDispatchedKeyByThread.get(threadId) === dispatchKey) {
      return;
    }

    if (threadViewers.isViewed(threadId)) {
      lastDispatchedKeyByThread.set(threadId, dispatchKey);
      return;
    }

    lastDispatchedKeyByThread.set(threadId, dispatchKey);
    const highPriority =
      awareness.phase === "waiting_for_approval" ||
      awareness.phase === "waiting_for_input" ||
      awareness.phase === "failed";
    const tags =
      awareness.phase === "waiting_for_approval" || awareness.phase === "waiting_for_input"
        ? ["bell", "robot"]
        : awareness.phase === "failed"
          ? ["x", "robot"]
          : ["white_check_mark", "robot"];

    yield* deliver({
      title: `${BRAND_APP_NAME}: ${awareness.headline}`,
      body: `${awareness.projectTitle} / ${awareness.threadTitle}`,
      deepLink: buildThreadDeepLink(config.deepLinkScheme, threadId),
      priority: highPriority ? "high" : "default",
      tags,
    });
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    evaluateThreadUnsafe(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("webhook notification evaluation failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const evaluateThread: WebhookNotificationService["Service"]["evaluateThread"] = Effect.fn(
    "WebhookNotificationService.evaluateThread",
  )(function* (threadId) {
    yield* worker.enqueue(threadId);
    yield* worker.drain;
  });

  const notifyCustom: WebhookNotificationService["Service"]["notifyCustom"] = Effect.fn(
    "WebhookNotificationService.notifyCustom",
  )(function* (input) {
    const tags =
      input.event === "sandbox_warning"
        ? ["warning", "cloud"]
        : input.event === "sandbox_auto_stopped"
          ? ["zzz", "cloud"]
          : ["bell"];
    yield* deliver({
      title: input.title,
      body: input.body,
      ...(input.deepLink === undefined ? {} : { deepLink: input.deepLink }),
      priority: input.priority ?? (input.event === "sandbox_warning" ? "high" : "default"),
      tags,
    });
  });

  const start: WebhookNotificationService["Service"]["start"] = Effect.fn(
    "WebhookNotificationService.start",
  )(function* () {
    if (!hasAnyChannel(config)) {
      yield* Effect.logDebug("webhook notifications disabled; no ntfy or Telegram target set");
      return;
    }
    yield* Effect.logInfo("webhook notifications enabled", {
      ntfy: config.ntfy !== null,
      telegram: config.telegram !== null,
      deepLinkScheme: config.deepLinkScheme,
    });
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        shouldEvaluateWebhookEvent(event) ? worker.enqueue(event.threadId) : Effect.void,
      ),
    );
  });

  return WebhookNotificationService.of({
    evaluateThread,
    notifyCustom,
    drain: worker.drain,
    start,
  });
});

export const layer = Layer.effect(WebhookNotificationService, make);

export const subscriberLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* WebhookNotificationService;
    yield* service.start();
  }),
).pipe(Layer.provideMerge(layer));
