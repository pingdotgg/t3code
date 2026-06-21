// @effect-diagnostics globalFetch:off

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { Buffer } from "node:buffer";
import {
  Chat,
  type AdapterPostableMessage,
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
import { postableReplyBody, postableTaskStartedStatus } from "./postableReply.ts";

export class ExternalChatError extends Data.TaggedError("ExternalChatError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type SlackConversationKind = "channel" | "dm" | "mpim";

interface RawSlackFile {
  readonly name?: string;
  readonly title?: string;
  readonly mimetype?: string;
  readonly url_private?: string;
  readonly url_private_download?: string;
  readonly permalink?: string;
}

interface RawSlackMessageEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly channel?: string;
  readonly channel_type?: string;
  readonly thread_ts?: string;
  readonly ts?: string;
  readonly text?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly team?: string;
  readonly team_id?: string;
  readonly files?: ReadonlyArray<RawSlackFile>;
}

interface RawSlackEventCallbackPayload {
  readonly type?: string;
  readonly team_id?: string;
  readonly event?: RawSlackMessageEvent;
}

export interface ExternalChatShape {
  readonly handleSlackWebhook: (request: Request) => Effect.Effect<Response, ExternalChatError>;
  readonly postToThread: (input: {
    readonly source: "slack";
    readonly externalThreadId: string;
    readonly message: PostableMessage;
  }) => Effect.Effect<{ readonly externalMessageId: string }, ExternalChatError>;
  readonly uploadFilesToThread: (input: {
    readonly source: "slack";
    readonly externalThreadId: string;
    readonly files: ReadonlyArray<{
      readonly name: string;
      readonly mimeType: string;
      readonly data: Uint8Array;
    }>;
    readonly initialComment?: string;
  }) => Effect.Effect<{ readonly externalFileIds: ReadonlyArray<string> }, ExternalChatError>;
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
  readonly updateThreadMessage: (input: {
    readonly source: "slack";
    readonly externalThreadId: string;
    readonly externalMessageId: string;
    readonly message: PostableMessage;
  }) => Effect.Effect<void, ExternalChatError>;
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

function rawProperty(raw: SlackEvent, key: string) {
  const value = (raw as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function slackConversationKind(input: {
  readonly channelId: string;
  readonly raw?: SlackEvent | RawSlackMessageEvent | undefined;
}): SlackConversationKind {
  const channelType =
    input.raw === undefined ? undefined : (input.raw as Record<string, unknown>)["channel_type"];
  if (channelType === "im") return "dm";
  if (channelType === "mpim") return "mpim";
  if (input.channelId.startsWith("D")) return "dm";
  if (input.channelId.startsWith("G") && channelType === "mpim") return "mpim";
  return "channel";
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

function attachmentName(attachment: Attachment, index: number) {
  return attachment.name?.trim() || `Attachment ${index + 1}`;
}

function inferImageMimeType(attachment: Attachment): string | null {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType?.startsWith("image/")) return mimeType;

  const nameOrUrl = `${attachment.name ?? ""} ${attachment.url ?? ""}`.toLowerCase();
  if (/\.(?:png)(?:$|[?#\s])/.test(nameOrUrl)) return "image/png";
  if (/\.(?:jpe?g)(?:$|[?#\s])/.test(nameOrUrl)) return "image/jpeg";
  if (/\.(?:webp)(?:$|[?#\s])/.test(nameOrUrl)) return "image/webp";
  if (/\.(?:gif)(?:$|[?#\s])/.test(nameOrUrl)) return "image/gif";
  if (/\.(?:avif)(?:$|[?#\s])/.test(nameOrUrl)) return "image/avif";
  if (/\.(?:heic)(?:$|[?#\s])/.test(nameOrUrl)) return "image/heic";
  if (/\.(?:heif)(?:$|[?#\s])/.test(nameOrUrl)) return "image/heif";

  return null;
}

function slackFileIdFromUrl(url: string | undefined) {
  const match = /(?:^|[-/])(F[0-9A-Z]{8,})(?:[-/]|$)/i.exec(url ?? "");
  return match?.[1];
}

async function fetchSlackFileUrl(url: string, token: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream,image/*,*/*",
      Authorization: `Bearer ${token}`,
      "User-Agent": "t3code-server/1.0",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Slack file fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());
  const prefix = buffer.subarray(0, 128).toString("utf8").toLowerCase();
  if (contentType.toLowerCase().includes("text/html") || prefix.includes("<html")) {
    throw new Error(`Slack file fetch returned HTML (${contentType || "unknown content type"}).`);
  }

  return buffer;
}

async function fetchSlackFileViaFilesInfo(attachment: Attachment, token: string): Promise<Buffer> {
  const fileId = slackFileIdFromUrl(attachment.url);
  if (!fileId) {
    throw new Error("Could not infer Slack file id from attachment URL.");
  }

  const infoResponse = await fetch(
    `https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!infoResponse.ok) {
    throw new Error(`Slack files.info failed: ${infoResponse.status} ${infoResponse.statusText}`);
  }

  const info = (await infoResponse.json()) as {
    readonly ok?: boolean;
    readonly error?: string;
    readonly file?: {
      readonly url_private_download?: string;
      readonly url_private?: string;
    };
  };
  if (info.ok !== true) {
    throw new Error(`Slack files.info rejected file: ${info.error ?? "unknown_error"}`);
  }

  const downloadUrl = info.file?.url_private_download ?? info.file?.url_private;
  if (!downloadUrl) {
    throw new Error("Slack files.info response did not include a private download URL.");
  }

  return fetchSlackFileUrl(downloadUrl, token);
}

async function fetchAttachmentData(attachment: Attachment): Promise<Buffer> {
  try {
    if (attachment.fetchData !== undefined) {
      const data = await attachment.fetchData();
      const prefix = data.subarray(0, 128).toString("utf8").toLowerCase();
      if (prefix.includes("<html")) {
        throw new Error("Chat SDK attachment fetch returned HTML.");
      }
      return data;
    }
  } catch {
    // Fall back to Slack API download below when the Chat SDK attachment handle is stale.
  }

  const url = attachment.url?.trim();
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!url || !botToken) {
    throw new Error("Slack attachment data is not fetchable.");
  }

  try {
    return await fetchSlackFileViaFilesInfo(attachment, botToken);
  } catch {
    // Some Slack URLs are directly fetchable with the bot token even when files.info fails.
  }

  return fetchSlackFileUrl(url, botToken);
}

async function slackFormApi<T>(
  token: string,
  method: string,
  body: Record<string, number | string | undefined>,
): Promise<T> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) {
      form.set(key, String(value));
    }
  }
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Slack ${method} failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as { readonly ok?: boolean; readonly error?: string };
  if (payload.ok !== true) {
    throw new Error(`Slack ${method} rejected request: ${payload.error ?? "unknown_error"}`);
  }
  return payload as T;
}

export async function uploadSlackFiles(input: {
  readonly token: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly files: ReadonlyArray<{
    readonly name: string;
    readonly mimeType: string;
    readonly data: Uint8Array;
  }>;
  readonly initialComment?: string;
}): Promise<ReadonlyArray<string>> {
  const files: Array<{ id: string; title: string }> = [];
  for (const file of input.files) {
    const prepared = await slackFormApi<{
      readonly file_id: string;
      readonly upload_url: string;
    }>(input.token, "files.getUploadURLExternal", {
      filename: file.name,
      length: file.data.byteLength,
    });
    const uploadResponse = await fetch(prepared.upload_url, {
      method: "POST",
      headers: {
        "Content-Type": file.mimeType,
      },
      body: Buffer.from(file.data),
    });
    if (!uploadResponse.ok) {
      throw new Error(
        `Slack file upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
      );
    }
    files.push({ id: prepared.file_id, title: file.name });
  }

  if (files.length === 0) {
    return [];
  }

  await slackFormApi(input.token, "files.completeUploadExternal", {
    files: JSON.stringify(files),
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    ...(input.initialComment ? { initial_comment: input.initialComment } : {}),
  });
  return files.map((file) => file.id);
}

async function nativeImageAttachment(
  attachment: Attachment,
  index: number,
): Promise<UploadChatAttachment | null> {
  const mimeType = inferImageMimeType(attachment);
  if (mimeType === null) return null;

  try {
    const data = await fetchAttachmentData(attachment);
    if (data.byteLength === 0 || data.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return null;
    }

    return {
      type: "image",
      name: attachmentName(attachment, index),
      mimeType,
      sizeBytes: data.byteLength,
      dataUrl: `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`,
    };
  } catch {
    return null;
  }
}

async function nativeImageAttachments(attachments: readonly Attachment[]) {
  const uploadAttachments: UploadChatAttachment[] = [];

  for (const [index, attachment] of attachments.entries()) {
    if (uploadAttachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) break;
    const uploadAttachment = await nativeImageAttachment(attachment, index);
    if (uploadAttachment !== null) uploadAttachments.push(uploadAttachment);
  }

  return uploadAttachments;
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
  const channelId =
    rawProperty(raw, "channel") ?? channelFromThread ?? thread.channelId.replace(/^slack:/, "");
  const threadTs =
    rawProperty(raw, "thread_ts") ?? tsFromThread ?? rawProperty(raw, "ts") ?? message.id;
  const teamId = rawProperty(raw, "team_id") ?? rawProperty(raw, "team");
  const conversationKind = slackConversationKind({ channelId, raw });
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
    conversationKind,
    raw,
  };
}

function rawSlackFileLines(files: ReadonlyArray<RawSlackFile> | undefined) {
  return (files ?? []).flatMap((file, index) => {
    const name = file.title?.trim() || file.name?.trim() || `Attachment ${index + 1}`;
    const url =
      file.permalink?.trim() || file.url_private_download?.trim() || file.url_private?.trim();
    if (!url) return [];
    const detail = file.mimetype?.trim() ? ` (${file.mimetype.trim()})` : "";
    return [`- ${name}${detail}: ${url}`];
  });
}

function rawSlackMessageText(event: RawSlackMessageEvent) {
  const body = stripSlackClientAttribution(event.text ?? "");
  const attachments = rawSlackFileLines(event.files);
  return attachments.length === 0
    ? body
    : [body, "", "Attachments:", ...attachments].join("\n").trim();
}

function rawSlackDateSentIso(ts: string | undefined) {
  const seconds = Number(ts);
  return DateTime.formatIso(
    Number.isFinite(seconds) ? DateTime.makeUnsafe(seconds * 1000) : DateTime.nowUnsafe(),
  );
}

function postableMessageText(message: PostableMessage) {
  const record = message as unknown as Record<string, unknown>;
  const markdown = record.markdown;
  if (typeof markdown === "string" && markdown.trim().length > 0) return markdown;
  const fallbackText = record.fallbackText;
  if (typeof fallbackText === "string" && fallbackText.trim().length > 0) return fallbackText;
  return "T3 task update.";
}

async function slackPostMessage(input: {
  readonly token: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly message: PostableMessage;
}) {
  const response = await slackFormApi<{ readonly ts: string }>(input.token, "chat.postMessage", {
    channel: input.channelId,
    thread_ts: input.threadTs,
    text: postableMessageText(input.message),
    unfurl_links: "false",
    unfurl_media: "false",
  });
  return { externalMessageId: response.ts };
}

async function slackAddReaction(input: {
  readonly token: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly name: string;
}) {
  await slackFormApi(input.token, "reactions.add", {
    channel: input.channelId,
    timestamp: input.messageTs,
    name: input.name,
  });
}

function parseRawSlackEventCallback(rawBody: string): RawSlackEventCallbackPayload | null {
  try {
    const payload = JSON.parse(rawBody) as RawSlackEventCallbackPayload;
    return payload.type === "event_callback" ? payload : null;
  } catch {
    return null;
  }
}

function rawSlackDirectMessageEvent(
  payload: RawSlackEventCallbackPayload | null,
): RawSlackMessageEvent | null {
  const event = payload?.event;
  if (event?.type !== "message") return null;
  if (event.channel_type !== "im") return null;
  if (!event.channel || !event.ts) return null;
  if (event.bot_id !== undefined) return null;
  if (event.subtype !== undefined && event.subtype !== "file_share") return null;
  return event;
}

function titleFromText(text: string, fallback: string) {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? fallback).slice(0, 120);
}

function messageTimestamp(message: Message) {
  return message.metadata.dateSent.getTime();
}

function messageAuthorLabel(message: Message) {
  return (
    message.author.fullName.trim() ||
    message.author.userName.trim() ||
    message.author.userId.trim() ||
    "Someone"
  );
}

function formatContextMessage(message: Message) {
  const text = messageTextWithAttachments(message);
  if (text.length === 0) return null;
  return `${messageAuthorLabel(message)}: ${text}`;
}

async function collectSlackThreadContext(
  thread: Thread,
  triggerMessage: Message,
  options: {
    readonly maxMessages?: number;
    readonly maxChars?: number;
  } = {},
) {
  const maxMessages = options.maxMessages ?? 30;
  const maxChars = options.maxChars ?? 8_000;
  const triggerTime = messageTimestamp(triggerMessage);
  const priorMessages: Message[] = [];

  for await (const message of thread.messages) {
    if (message.id === triggerMessage.id) continue;
    if (message.author.isMe === true || message.author.isBot === true) continue;
    if (messageTimestamp(message) > triggerTime) continue;
    priorMessages.push(message);
    if (priorMessages.length >= maxMessages) break;
  }

  const lines = priorMessages
    .toSorted((left, right) => messageTimestamp(left) - messageTimestamp(right))
    .map(formatContextMessage)
    .filter((line): line is string => line !== null);

  if (lines.length === 0) return undefined;

  const context = lines.join("\n\n");
  return context.length > maxChars ? context.slice(0, maxChars).trimEnd() : context;
}

function buildSlackInitialPromptContext(input: { readonly slackThreadContext?: string }) {
  const context = input.slackThreadContext?.trim();
  if (!context) return undefined;
  return [
    "- This task was started from a Slack thread where Vevin was invoked.",
    "- Use the prior Slack thread context below to interpret the user request.",
    "",
    "Prior Slack thread context:",
    "",
    context,
  ].join("\n");
}

function buildSlackProjectHintText(input: {
  readonly currentText: string;
  readonly slackThreadContext?: string | undefined;
}) {
  const parts = [input.currentText, input.slackThreadContext ?? ""].map((part) => part.trim());
  return parts.filter(Boolean).join("\n\n");
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

      const existingLink = yield* repository.getThreadLink({
        source: "slack",
        externalThreadId: ref.externalThreadId,
      });
      const uploadAttachments = yield* Effect.promise(() =>
        nativeImageAttachments(input.message.attachments),
      );
      const isSlackThreadReply =
        ref.raw.thread_ts !== undefined && ref.raw.thread_ts !== (ref.raw.ts ?? input.message.id);
      const slackThreadContext =
        Option.isNone(existingLink) && input.message.isMention === true && isSlackThreadReply
          ? yield* Effect.tryPromise(() =>
              collectSlackThreadContext(input.thread, input.message),
            ).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
      const initialPromptContext = buildSlackInitialPromptContext(
        slackThreadContext === undefined ? {} : { slackThreadContext },
      );

      const intakeMessage: ExternalIntakeMessage = {
        source: "slack",
        externalThreadId: ref.externalThreadId,
        externalMessageId: input.message.id,
        text,
        title: titleFromText(text, "Slack request"),
        ...(uploadAttachments.length > 0 ? { attachments: uploadAttachments } : {}),
        url: ref.url,
        receivedAt: input.message.metadata.dateSent.toISOString(),
        projectHintText: buildSlackProjectHintText({
          currentText: ref.raw.text ?? input.message.text,
          slackThreadContext,
        }),
        slack: {
          rawText: ref.raw.text ?? input.message.text,
          isMention: input.message.isMention,
          conversationKind: ref.conversationKind,
          botUserId: process.env.SLACK_BOT_USER_ID,
          botUserName: process.env.SLACK_BOT_USERNAME,
        },
        ...(initialPromptContext !== undefined ? { initialPromptContext } : {}),
      };

      const result = yield* intake.handleMessage(intakeMessage).pipe(
        Effect.catch((error) =>
          Effect.promise(() =>
            input.thread.post(
              postableReplyBody({
                kind: "slack_thread",
                body: [
                  "I couldn't start a T3 task from this message.",
                  "",
                  `Reason: ${error.message}`,
                ].join("\n"),
              }),
            ),
          ).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.as({
              status: "ignored" as const,
              reason: `intake_failed:${error.message}`,
              reaction: undefined,
            }),
          ),
        ),
      );
      if (result.status === "created") {
        const sentMessage = input.thread.createSentMessageFromMessage(input.message);
        yield* Effect.promise(() => sentMessage.addReaction("eyes")).pipe(
          Effect.ignoreCause({ log: true }),
        );
        if (result.projectReaction !== undefined) {
          yield* Effect.promise(() => sentMessage.addReaction(result.projectReaction!)).pipe(
            Effect.ignoreCause({ log: true }),
          );
        }
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

  const processRawSlackDirectMessage = (payload: RawSlackEventCallbackPayload | null) =>
    Effect.gen(function* () {
      const event = rawSlackDirectMessageEvent(payload);
      if (event === null) return;

      const token = process.env.SLACK_BOT_TOKEN?.trim();
      if (!token) return;

      const channelId = event.channel!;
      const threadTs = event.thread_ts ?? event.ts!;
      const teamId = event.team_id ?? event.team ?? payload?.team_id;
      const externalThreadId = slackExternalThreadId({
        channelId,
        threadTs,
        ...(teamId !== undefined ? { teamId } : {}),
      });
      const externalMessageId = event.ts!;
      const eventId = `slack:${externalThreadId}:${externalMessageId}`;
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
          channelId,
          messageId: externalMessageId,
          source: "message.im",
        },
        createdAt: optionCreatedAt(existingReceipt, now),
        updatedAt: now,
      });

      const text = rawSlackMessageText(event);
      const intakeMessage: ExternalIntakeMessage = {
        source: "slack",
        externalThreadId,
        externalMessageId,
        text,
        title: titleFromText(text, "Slack DM request"),
        url: slackThreadUrl({ channelId, threadTs }),
        receivedAt: rawSlackDateSentIso(event.ts),
        projectHintText: event.text ?? "",
        slack: {
          rawText: event.text ?? "",
          isMention: false,
          conversationKind: "dm",
          botUserId: process.env.SLACK_BOT_USER_ID,
          botUserName: process.env.SLACK_BOT_USERNAME,
        },
      };

      const result = yield* intake.handleMessage(intakeMessage).pipe(
        Effect.catch((error) =>
          Effect.tryPromise(() =>
            slackPostMessage({
              token,
              channelId,
              threadTs,
              message: postableReplyBody({
                kind: "slack_thread",
                body: [
                  "I couldn't start a T3 task from this message.",
                  "",
                  `Reason: ${error.message}`,
                ].join("\n"),
              }),
            }),
          ).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.as({
              status: "ignored" as const,
              reason: `intake_failed:${error.message}`,
              reaction: undefined,
            }),
          ),
        ),
      );

      if (result.status === "created") {
        yield* Effect.tryPromise(() =>
          slackAddReaction({
            token,
            channelId,
            messageTs: externalMessageId,
            name: "eyes",
          }),
        ).pipe(Effect.ignoreCause({ log: true }));
        if (result.projectReaction !== undefined) {
          yield* Effect.tryPromise(() =>
            slackAddReaction({
              token,
              channelId,
              messageTs: externalMessageId,
              name: result.projectReaction!,
            }),
          ).pipe(Effect.ignoreCause({ log: true }));
        }
        const environment = yield* serverEnvironment.getDescriptor;
        const threadUrl = t3ThreadUrl({
          baseUrl: process.env.T3_WEB_APP_BASE_URL ?? process.env.T3CODE_PUBLIC_BASE_URL,
          environmentId: result.environmentId ?? String(environment.environmentId),
          t3ThreadId: String(result.t3ThreadId),
        });
        if (threadUrl !== undefined) {
          yield* Effect.tryPromise(() =>
            slackPostMessage({
              token,
              channelId,
              threadTs,
              message: postableTaskStartedStatus({
                kind: "slack_thread",
                t3ThreadUrl: threadUrl,
              }),
            }),
          ).pipe(Effect.ignoreCause({ log: true }));
        }
      } else if (result.status === "ignored" && result.reaction !== undefined) {
        yield* Effect.tryPromise(() =>
          slackAddReaction({
            token,
            channelId,
            messageTs: externalMessageId,
            name: result.reaction!,
          }),
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

  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);

  bot.onNewMention(async (thread, message, context) => {
    await runPromise(processSlackMessage({ thread, message, context }));
  });

  bot.onSubscribedMessage(async (thread, message, context) => {
    await runPromise(processSlackMessage({ thread, message, context }));
  });

  const slackChatThreadId = (externalThreadId: string) => {
    const { channelId, threadTs } = parseSlackExternalThreadId(externalThreadId);
    return `slack:${channelId}:${threadTs}`;
  };

  const handleSlackWebhook: ExternalChatShape["handleSlackWebhook"] = (request) =>
    Effect.tryPromise({
      try: async () => {
        const rawBody = await request.clone().text();
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
        if (response.ok) {
          const payload = parseRawSlackEventCallback(rawBody);
          pendingTasks.push(runPromise(processRawSlackDirectMessage(payload)));
        }
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

  const uploadFilesToThread: ExternalChatShape["uploadFilesToThread"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const token = process.env.SLACK_BOT_TOKEN?.trim();
        if (!token) {
          throw new Error("SLACK_BOT_TOKEN is required to upload files to Slack.");
        }
        const { channelId, threadTs } = parseSlackExternalThreadId(input.externalThreadId);
        const externalFileIds = await uploadSlackFiles({
          token,
          channelId,
          threadTs,
          files: input.files,
          ...(input.initialComment ? { initialComment: input.initialComment } : {}),
        });
        return { externalFileIds };
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

  const updateThreadMessage: ExternalChatShape["updateThreadMessage"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        await bot.initialize();
        const threadId = slackChatThreadId(input.externalThreadId);
        await bot
          .thread(threadId)
          .adapter.editMessage(
            threadId,
            input.externalMessageId,
            input.message as AdapterPostableMessage,
          );
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
    uploadFilesToThread,
    postToChannel,
    updateThreadMessage,
    addReaction,
  } satisfies ExternalChatShape;
});

export const ExternalChatLive = Layer.effect(ExternalChat, makeExternalChat);
