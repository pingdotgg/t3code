import { Buffer } from "node:buffer";

import {
  Chat,
  type Attachment,
  type Message,
  type MessageContext,
  type StateAdapter,
  type Thread,
} from "chat";
import type { SlackEvent } from "@chat-adapter/slack";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import {
  chatUserName,
  createTaskIntakeChatSdkAdapters,
  type TaskIntakeChatSdkSource,
} from "./chatSdkAdapters.ts";
import type { TaskIntakeAttachment, TaskIntakeMessage } from "./contracts.ts";
import { stripSlackClientAttribution } from "./slackMessageText.ts";

export interface TaskIntakeChatSdkOptions {
  readonly sources?: ReadonlySet<TaskIntakeChatSdkSource>;
  readonly state: StateAdapter;
  readonly onAttachmentFetchFailure?: (failure: SlackAttachmentFetchFailure) => void;
  readonly onMessage: (input: {
    readonly source: "slack";
    readonly thread: Thread;
    readonly message: Message;
    readonly context?: MessageContext;
    readonly intakeMessage: TaskIntakeMessage;
  }) => Promise<void>;
}

export interface SlackAttachmentFetchFailure {
  readonly name?: string;
  readonly mimeType?: string;
  readonly url?: string;
  readonly stage: string;
  readonly error: string;
}

let slackAttachmentFetchFailureSink: ((failure: SlackAttachmentFetchFailure) => void) | undefined;

export function setSlackAttachmentFetchFailureSink(
  sink: ((failure: SlackAttachmentFetchFailure) => void) | undefined,
) {
  slackAttachmentFetchFailureSink = sink;
}

function messageReceivedAt(message: Message) {
  return message.metadata.dateSent.toISOString();
}

function attachmentName(attachment: Attachment, index: number) {
  return attachment.name?.trim() || `Attachment ${index + 1}`;
}

function linkedAttachment(attachment: Attachment, index: number): TaskIntakeAttachment | null {
  const url = attachment.url?.trim();
  if (!url) return null;

  return {
    name: attachmentName(attachment, index),
    url,
    ...(attachment.type !== undefined ? { type: attachment.type } : {}),
    ...(attachment.mimeType?.trim() ? { mimeType: attachment.mimeType.trim() } : {}),
    ...(typeof attachment.size === "number" ? { sizeBytes: attachment.size } : {}),
  };
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

function reportSlackAttachmentFetchFailure(attachment: Attachment, stage: string, error: unknown) {
  const failure = {
    ...(attachment.name !== undefined ? { name: attachment.name } : {}),
    ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.url !== undefined ? { url: attachment.url } : {}),
    stage,
    error: error instanceof Error ? error.message : String(error),
  };
  console.warn("taskIntake.slackAttachment.fetch.failed", failure);
  slackAttachmentFetchFailureSink?.(failure);
}

async function fetchSlackFileUrl(url: string, token: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream,image/*,*/*",
      Authorization: `Bearer ${token}`,
      "User-Agent": "t3code-orchestrator/1.0",
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

  const infoUrl = `https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`;
  const infoResponse = await fetch(infoUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
  } catch (error) {
    reportSlackAttachmentFetchFailure(attachment, "chat_sdk_fetch_data", error);
  }

  const url = attachment.url?.trim();
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!url || !botToken) {
    throw new Error("Slack attachment data is not fetchable.");
  }

  try {
    return await fetchSlackFileViaFilesInfo(attachment, botToken);
  } catch (error) {
    reportSlackAttachmentFetchFailure(attachment, "slack_files_info_fetch", error);
  }

  return fetchSlackFileUrl(url, botToken);
}

async function imageAttachment(
  attachment: Attachment,
  index: number,
): Promise<TaskIntakeAttachment | null> {
  const mimeType = inferImageMimeType(attachment);
  if (mimeType === null) {
    return linkedAttachment(attachment, index);
  }
  try {
    const data = await fetchAttachmentData(attachment);
    if (data.byteLength === 0 || data.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return linkedAttachment(attachment, index);
    }

    return {
      type: "image",
      name: attachmentName(attachment, index),
      mimeType,
      sizeBytes: data.byteLength,
      dataUrl: `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`,
      ...(attachment.url?.trim() ? { url: attachment.url.trim() } : {}),
    };
  } catch (error) {
    reportSlackAttachmentFetchFailure(attachment, "native_image_conversion", error);
    return linkedAttachment(attachment, index);
  }
}

async function taskIntakeAttachments(attachments: readonly Attachment[]) {
  const intakeAttachments: TaskIntakeAttachment[] = [];
  let nativeImageCount = 0;

  for (const [index, attachment] of attachments.entries()) {
    if (
      inferImageMimeType(attachment) !== null &&
      nativeImageCount < PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      const intakeAttachment = await imageAttachment(attachment, index);
      if (intakeAttachment !== null) {
        intakeAttachments.push(intakeAttachment);
        if ("dataUrl" in intakeAttachment) nativeImageCount += 1;
      }
      continue;
    }

    const intakeAttachment = linkedAttachment(attachment, index);
    if (intakeAttachment !== null) intakeAttachments.push(intakeAttachment);
  }

  return intakeAttachments;
}

export async function slackChatMessageToTaskIntakeMessage(input: {
  readonly thread: Thread;
  readonly message: Message<SlackEvent>;
}): Promise<TaskIntakeMessage> {
  const raw = input.message.raw;
  const attachments = await taskIntakeAttachments(input.message.attachments);
  const [, channelFromThread, tsFromThread] = input.thread.id.split(":");
  const channelId = raw.channel ?? channelFromThread ?? input.thread.channelId;
  const threadTs = raw.thread_ts ?? tsFromThread ?? raw.ts ?? input.message.id;
  const teamId = raw.team_id ?? raw.team;
  const externalId =
    teamId === undefined ? `${channelId}:${threadTs}` : `${teamId}:${channelId}:${threadTs}`;

  return {
    eventId: `slack:${input.message.id}`,
    source: "slack",
    conversation: {
      source: "slack",
      externalLinkKind: "slack_thread",
      externalId,
      channelId,
      ...(teamId !== undefined ? { teamId } : {}),
    },
    messageId: input.message.id,
    text: stripSlackClientAttribution(input.message.text),
    ...(attachments.length > 0 ? { attachments } : {}),
    receivedAt: messageReceivedAt(input.message),
    actor: {
      externalId: input.message.author.userId,
      displayName: input.message.author.userName || input.message.author.fullName,
    },
  };
}

async function handleChatSdkMessage(
  thread: Thread,
  message: Message,
  context: MessageContext | undefined,
  options: TaskIntakeChatSdkOptions,
) {
  setSlackAttachmentFetchFailureSink(options.onAttachmentFetchFailure);
  try {
    await options.onMessage({
      source: "slack",
      thread,
      message,
      ...(context !== undefined ? { context } : {}),
      intakeMessage: await slackChatMessageToTaskIntakeMessage({
        thread,
        message: message as Message<SlackEvent>,
      }),
    });
  } finally {
    setSlackAttachmentFetchFailureSink(undefined);
  }
}

export function chatSdkSourceFromThreadId(threadId: string): "slack" | null {
  if (threadId.startsWith("slack:")) return "slack";
  return null;
}

export function createTaskIntakeChatSdkBot(options: TaskIntakeChatSdkOptions) {
  const bot = new Chat({
    userName: chatUserName(),
    adapters: createTaskIntakeChatSdkAdapters(
      options.sources === undefined ? undefined : { sources: options.sources },
    ),
    state: options.state,
    dedupeTtlMs: 10 * 60 * 1000,
    concurrency: "queue",
    logger: "info",
  });

  bot.onNewMention(async (thread, message, context) => {
    await thread.subscribe();
    const source = chatSdkSourceFromThreadId(message.threadId);
    if (source !== null) {
      await handleChatSdkMessage(thread, message, context, options);
    }
  });

  bot.onSubscribedMessage(async (thread, message, context) => {
    const source = chatSdkSourceFromThreadId(message.threadId);
    if (source !== null) {
      await handleChatSdkMessage(thread, message, context, options);
    }
  });

  return bot;
}
