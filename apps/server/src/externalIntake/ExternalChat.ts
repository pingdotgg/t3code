import {
  Chat,
  type Attachment,
  type Message,
  type MessageContext,
  type PostableMessage,
  type Thread,
} from "chat";
import type { SlackEvent } from "@chat-adapter/slack";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ExternalIntegrationRepository } from "../persistence/Services/ExternalIntegrations.ts";
import { ExternalIntake, type ExternalIntakeMessage } from "./ExternalIntake.ts";
import { createExternalChatSdkAdapters } from "./chatSdkAdapters.ts";
import { createSqlChatSdkState } from "./chatSdkState.ts";
import {
  parseSlackExternalThreadId,
  slackExternalThreadId,
  slackThreadUrl,
  stripSlackClientAttribution,
  t3ThreadUrl,
} from "./slack.ts";
import { postableTaskStartedStatus } from "./postableReply.ts";

export class ExternalChatError extends Data.TaggedError("ExternalChatError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface ExternalChatShape {
  readonly handleSlackWebhook: (request: Request) => Effect.Effect<Response, ExternalChatError>;
  readonly postToThread: (input: {
    readonly source: "slack";
    readonly externalThreadId: string;
    readonly message: PostableMessage;
  }) => Effect.Effect<{ readonly externalMessageId: string }, ExternalChatError>;
  readonly postToChannel: (input: {
    readonly source: "slack";
    readonly channelId: string;
    readonly message: PostableMessage;
  }) => Effect.Effect<
    {
      readonly externalThreadId: string;
      readonly externalMessageId: string;
      readonly channelId: string;
      readonly threadTs: string;
    },
    ExternalChatError
  >;
  readonly addReaction: (input: {
    readonly source: "slack";
    readonly externalThreadId: string;
    readonly externalMessageId: string;
    readonly name: string;
  }) => Effect.Effect<void, ExternalChatError>;
}

export class ExternalChat extends Context.Service<ExternalChat, ExternalChatShape>()(
  "t3/externalIntake/ExternalChat",
) {}

function nowIso() {
  return DateTime.formatIso(DateTime.toUtc(DateTime.nowUnsafe()));
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function toExternalChatError(error: unknown) {
  return new ExternalChatError({ message: errorMessage(error), cause: error });
}

function slackRaw(message: Message): SlackEvent {
  return (message.raw ?? {}) as SlackEvent;
}

function attachmentLines(attachments: readonly Attachment[]) {
  return attachments.flatMap((attachment, index) => {
    const name = attachment.name?.trim() || `Attachment ${index + 1}`;
    const url = attachment.url?.trim();
    if (!url) return [];
    const detail = attachment.mimeType?.trim() ? ` (${attachment.mimeType.trim()})` : "";
    return [`- ${name}${detail}: ${url}`];
  });
}

function messageTextWithAttachments(message: Message) {
  const body = stripSlackClientAttribution(message.text);
  const attachments = attachmentLines(message.attachments);
  return attachments.length === 0
    ? body
    : [body, "", "Attachments:", ...attachments].join("\n").trim();
}

function slackMessageRef(thread: Thread, message: Message) {
  const raw = slackRaw(message);
  const [, channelFromThread, tsFromThread] = thread.id.split(":");
  const channelId = raw.channel ?? channelFromThread ?? thread.channelId.replace(/^slack:/, "");
  const threadTs = raw.thread_ts ?? tsFromThread ?? raw.ts ?? message.id;
  const teamId = raw.team_id ?? raw.team;
  const externalThreadId = slackExternalThreadId({
    channelId,
    threadTs,
    ...(teamId !== undefined ? { teamId } : {}),
  });
  return {
    channelId,
    threadTs,
    externalThreadId,
    url: slackThreadUrl({ channelId, threadTs }),
    raw,
  };
}

function titleFromText(text: string, fallback: string) {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? fallback).slice(0, 120);
}

function optionCreatedAt<T extends { readonly createdAt: string }>(
  option: Option.Option<T>,
  fallback: string,
) {
  return Option.getOrElse(
    Option.map(option, (value) => value.createdAt),
    () => fallback,
  );
}

const makeExternalChat = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ExternalIntegrationRepository;
  const intake = yield* ExternalIntake;
  const serverEnvironment = yield* ServerEnvironment;
  const state = createSqlChatSdkState(sql);

  const processSlackMessage = (input: {
    readonly thread: Thread;
    readonly message: Message;
    readonly context?: MessageContext | undefined;
  }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => input.thread.subscribe());

      const text = messageTextWithAttachments(input.message);
      const ref = slackMessageRef(input.thread, input.message);
      const eventId = `slack:${ref.externalThreadId}:${input.message.id}`;
      const now = nowIso();
      const existingReceipt = yield* repository.getEventReceipt({ source: "slack", eventId });
      if (Option.isSome(existingReceipt) && existingReceipt.value.status === "completed") {
        return;
      }

      yield* repository.upsertEventReceipt({
        source: "slack",
        eventId,
        status: "processing",
        metadata: {
          threadId: input.thread.id,
          messageId: input.message.id,
          skippedCount: input.context?.skipped.length ?? 0,
        },
        createdAt: optionCreatedAt(existingReceipt, now),
        updatedAt: now,
      });

      const intakeMessage: ExternalIntakeMessage = {
        source: "slack",
        externalThreadId: ref.externalThreadId,
        externalMessageId: input.message.id,
        text,
        title: titleFromText(text, "Slack request"),
        url: ref.url,
        receivedAt: input.message.metadata.dateSent.toISOString(),
        projectHintText: ref.raw.text ?? input.message.text,
        slack: {
          rawText: ref.raw.text ?? input.message.text,
          isMention: input.message.isMention,
          botUserId: process.env.SLACK_BOT_USER_ID,
          botUserName: process.env.SLACK_BOT_USERNAME,
        },
      };

      const result = yield* intake.handleMessage(intakeMessage);
      if (result.status === "created") {
        yield* Effect.promise(() =>
          input.thread.createSentMessageFromMessage(input.message).addReaction("eyes"),
        ).pipe(Effect.ignoreCause({ log: true }));
        const environment = yield* serverEnvironment.getDescriptor;
        const threadUrl = t3ThreadUrl({
          baseUrl: process.env.T3_WEB_APP_BASE_URL ?? process.env.T3CODE_PUBLIC_BASE_URL,
          environmentId: result.environmentId ?? String(environment.environmentId),
          t3ThreadId: String(result.t3ThreadId),
        });
        if (threadUrl !== undefined) {
          yield* Effect.promise(() =>
            input.thread.post(
              postableTaskStartedStatus({
                kind: "slack_thread",
                t3ThreadUrl: threadUrl,
              }),
            ),
          ).pipe(Effect.ignoreCause({ log: true }));
        }
      } else if (result.status === "ignored" && result.reaction !== undefined) {
        yield* Effect.promise(() =>
          input.thread.createSentMessageFromMessage(input.message).addReaction(result.reaction!),
        ).pipe(Effect.ignoreCause({ log: true }));
      }

      yield* repository.upsertEventReceipt({
        source: "slack",
        eventId,
        status: "completed",
        metadata: result,
        createdAt: optionCreatedAt(existingReceipt, now),
        updatedAt: nowIso(),
      });
    });

  const bot = new Chat({
    userName: process.env.SLACK_BOT_USERNAME?.trim() || "vevin",
    adapters: createExternalChatSdkAdapters({ sources: new Set(["slack"]) }),
    state,
    dedupeTtlMs: 10 * 60 * 1000,
    concurrency: "queue",
    logger: "info",
  });

  bot.onNewMention(async (thread, message, context) => {
    await Effect.runPromise(processSlackMessage({ thread, message, context }));
  });

  bot.onSubscribedMessage(async (thread, message, context) => {
    await Effect.runPromise(processSlackMessage({ thread, message, context }));
  });

  const slackChatThreadId = (externalThreadId: string) => {
    const { channelId, threadTs } = parseSlackExternalThreadId(externalThreadId);
    return `slack:${channelId}:${threadTs}`;
  };

  const handleSlackWebhook: ExternalChatShape["handleSlackWebhook"] = (request) =>
    Effect.tryPromise({
      try: async () => {
        const webhook = bot.webhooks.slack;
        if (webhook === undefined) {
          throw new ExternalChatError({
            message: "Slack Chat SDK webhook handler is not configured.",
            cause: null,
          });
        }
        const pendingTasks: Promise<unknown>[] = [];
        const response = await webhook(request, {
          waitUntil(task) {
            pendingTasks.push(task);
          },
        });
        void Promise.allSettled(pendingTasks);
        return response;
      },
      catch: toExternalChatError,
    });

  const postToThread: ExternalChatShape["postToThread"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        await bot.initialize();
        const posted = await bot
          .thread(slackChatThreadId(input.externalThreadId))
          .post(input.message);
        return { externalMessageId: posted.id };
      },
      catch: toExternalChatError,
    });

  const postToChannel: ExternalChatShape["postToChannel"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        await bot.initialize();
        const channel = bot.channel(`slack:${input.channelId}`);
        const posted = await channel.post(input.message);
        return {
          externalThreadId: slackExternalThreadId({
            channelId: input.channelId,
            threadTs: posted.id,
          }),
          externalMessageId: posted.id,
          channelId: input.channelId,
          threadTs: posted.id,
        };
      },
      catch: toExternalChatError,
    });

  const addReaction: ExternalChatShape["addReaction"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        await bot.initialize();
        await bot
          .thread(slackChatThreadId(input.externalThreadId))
          .adapter.addReaction(
            slackChatThreadId(input.externalThreadId),
            input.externalMessageId,
            input.name,
          );
      },
      catch: toExternalChatError,
    });

  return {
    handleSlackWebhook,
    postToThread,
    postToChannel,
    addReaction,
  } satisfies ExternalChatShape;
});

export const ExternalChatLive = Layer.effect(ExternalChat, makeExternalChat);
