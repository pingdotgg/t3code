import type { TaskIntakeMessage } from "./contracts.ts";

export interface SlackTaskIntakeEnvelope {
  readonly eventId: string;
  readonly teamId?: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly text: string;
  readonly url?: string;
  readonly receivedAt: number;
}

interface SlackEventCallbackPayload {
  readonly event_id?: unknown;
  readonly team_id?: unknown;
  readonly event?: {
    readonly type?: unknown;
    readonly subtype?: unknown;
    readonly channel?: unknown;
    readonly event_ts?: unknown;
    readonly thread_ts?: unknown;
    readonly ts?: unknown;
    readonly user?: unknown;
    readonly username?: unknown;
    readonly text?: unknown;
    readonly bot_id?: unknown;
  };
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isHumanMessageEvent(payload: SlackEventCallbackPayload) {
  const event = payload.event;
  if (event?.type !== "app_mention" && event?.type !== "message") {
    return false;
  }
  if (asTrimmedString(event.subtype) !== undefined) {
    return false;
  }
  return asTrimmedString(event.bot_id) === undefined;
}

export function normalizeSlackWebhookInput(input: unknown): SlackTaskIntakeEnvelope | null {
  if (input === null || typeof input !== "object") {
    throw new Error("Slack webhook payload must be an object");
  }

  const payload = input as SlackEventCallbackPayload;
  if (!isHumanMessageEvent(payload)) {
    return null;
  }

  const channelId = asTrimmedString(payload.event?.channel);
  const messageTs = asTrimmedString(payload.event?.ts) ?? asTrimmedString(payload.event?.event_ts);
  const text = asTrimmedString(payload.event?.text) ?? "";
  if (channelId === undefined || messageTs === undefined) {
    throw new Error("Slack event payload is missing channel or message timestamp");
  }

  const threadTs = asTrimmedString(payload.event?.thread_ts) ?? messageTs;
  const teamId = asTrimmedString(payload.team_id);
  const eventId = asTrimmedString(payload.event_id) ?? `slack:${channelId}:${messageTs}`;
  const userId = asTrimmedString(payload.event?.user);
  const userName = asTrimmedString(payload.event?.username);

  return {
    eventId,
    channelId,
    threadTs,
    messageTs,
    text,
    receivedAt: Date.now(),
    ...(teamId !== undefined ? { teamId } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(userName !== undefined ? { userName } : {}),
  };
}

export function slackEnvelopeToTaskIntakeMessage(
  envelope: SlackTaskIntakeEnvelope,
): TaskIntakeMessage {
  const externalId =
    envelope.teamId === undefined
      ? `${envelope.channelId}:${envelope.threadTs}`
      : `${envelope.teamId}:${envelope.channelId}:${envelope.threadTs}`;

  return {
    eventId: envelope.eventId,
    source: "slack",
    conversation: {
      source: "slack",
      externalLinkKind: "slack_thread",
      externalId,
      channelId: envelope.channelId,
      ...(envelope.teamId !== undefined ? { teamId: envelope.teamId } : {}),
      ...(envelope.url !== undefined ? { url: envelope.url } : {}),
    },
    messageId: envelope.messageTs,
    text: envelope.text,
    receivedAt: new Date(envelope.receivedAt).toISOString(),
    ...(envelope.url !== undefined ? { url: envelope.url } : {}),
    ...(envelope.userId !== undefined || envelope.userName !== undefined
      ? {
          actor: {
            ...(envelope.userId !== undefined ? { externalId: envelope.userId } : {}),
            ...(envelope.userName !== undefined ? { displayName: envelope.userName } : {}),
          },
        }
      : {}),
  };
}
