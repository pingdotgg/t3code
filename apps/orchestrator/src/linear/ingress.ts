export type LinearThreadKind = "issue" | "comment";

export interface LinearIngressEnvelope {
  readonly eventId: string;
  readonly threadKind: LinearThreadKind;
  readonly linearThreadKey: string;
  readonly issueId: string;
  readonly commentId?: string;
  readonly messageId?: string;
  readonly teamId?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly authorName?: string;
  readonly body: string;
  readonly bodyPreview?: string;
  readonly commentUrl?: string;
  readonly receivedAt: number;
  readonly shouldStartRun: boolean;
}

interface LinearWebhookActor {
  readonly name?: unknown;
  readonly type?: unknown;
}

interface LinearWebhookCommentData {
  readonly body?: unknown;
  readonly createdAt?: unknown;
  readonly id?: unknown;
  readonly issueId?: unknown;
  readonly parentId?: unknown;
  readonly updatedAt?: unknown;
  readonly url?: unknown;
}

interface LinearWebhookPayload {
  readonly action?: unknown;
  readonly actor?: LinearWebhookActor;
  readonly data?: LinearWebhookCommentData;
  readonly type?: unknown;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function previewBody(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

function containsLinearBotMention(body: string, botUserName: string | undefined) {
  const normalizedBotUserName = botUserName?.trim().toLowerCase();
  if (!normalizedBotUserName) {
    return false;
  }

  // Linear mentions are plain-text in webhook comment bodies, so a case-insensitive
  // substring match is the least fragile MVP detector.
  return body.toLowerCase().includes(`@${normalizedBotUserName}`);
}

function isHumanAuthored(actor: LinearWebhookActor | undefined, authorName: string | undefined) {
  const actorType = asTrimmedString(actor?.type)?.toLowerCase();
  if (actorType !== undefined && actorType !== "user") {
    return false;
  }

  return authorName === undefined || actorType === "user";
}

export function linearThreadKeyFor(input: {
  readonly issueId: string;
  readonly commentId?: string;
}) {
  return input.commentId !== undefined
    ? `linear:${input.issueId}:c:${input.commentId}`
    : `linear:${input.issueId}`;
}

export function normalizeLinearWebhookInput(
  input: unknown,
  options?: {
    readonly botUserName?: string;
  },
): LinearIngressEnvelope | null {
  if (input === null || typeof input !== "object") {
    throw new Error("Linear webhook payload must be an object");
  }

  const payload = input as LinearWebhookPayload;
  if (payload.type !== "Comment" || payload.action !== "create") {
    return null;
  }

  const issueId = asTrimmedString(payload.data?.issueId);
  const messageId = asTrimmedString(payload.data?.id);
  if (issueId === undefined || messageId === undefined) {
    throw new Error("Linear comment webhook payload is missing issueId or comment id");
  }

  const rootCommentId = asTrimmedString(payload.data?.parentId) ?? messageId;
  const body = asTrimmedString(payload.data?.body) ?? "";
  const authorName = asTrimmedString(payload.actor?.name);
  const updatedAt = asTrimmedString(payload.data?.updatedAt);
  const createdAt = asTrimmedString(payload.data?.createdAt);
  const eventTimestamp = updatedAt ?? createdAt ?? "unknown";
  const eventId = `linear:comment:create:${messageId}:${eventTimestamp}`;
  const bodyPreview = previewBody(body);
  const commentUrl = asTrimmedString(payload.data?.url);
  const shouldStartRun =
    body.length > 0 &&
    containsLinearBotMention(body, options?.botUserName) &&
    isHumanAuthored(payload.actor, authorName);

  return {
    eventId,
    threadKind: "comment",
    linearThreadKey: linearThreadKeyFor({
      issueId,
      commentId: rootCommentId,
    }),
    issueId,
    commentId: rootCommentId,
    messageId,
    body,
    receivedAt: Date.now(),
    shouldStartRun,
    ...(authorName !== undefined ? { authorName } : {}),
    ...(bodyPreview !== undefined ? { bodyPreview } : {}),
    ...(commentUrl !== undefined ? { commentUrl } : {}),
  };
}

export { containsLinearBotMention };
