import type { MessageId, TurnId } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

interface ThreadArtifactSource {
  readonly messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
  readonly activities: ReadonlyArray<{
    readonly turnId: TurnId | null;
    readonly payload: unknown;
    readonly createdAt: string;
  }>;
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

export function normalizeThreadArtifactReference(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH.test(normalized) ||
    normalized.includes(":") ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    !isWorkspaceImagePreviewPath(normalized)
  ) {
    return null;
  }
  return normalized;
}

function activityArtifactPaths(payloadValue: unknown): ReadonlyArray<string> {
  const payload = asUnknownRecord(payloadValue);
  const data = asUnknownRecord(payload?.data);
  const rawOutput = asUnknownRecord(data?.rawOutput);
  const item = asUnknownRecord(data?.item);
  const paths = [rawOutput?.path];

  if (item?.type === "imageGeneration") {
    paths.push(item.savedPath);
  } else if (item?.type === "imageView") {
    paths.push(item.path);
  }

  return paths.filter((value): value is string => typeof value === "string");
}

function artifactMessageWindow(
  thread: ThreadArtifactSource,
  turnId: TurnId,
  messageId: MessageId,
): { readonly after: number; readonly before: number } | null {
  const messages = thread.messages
    .filter((message) => message.role === "assistant" && message.turnId === turnId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  const message = messages[messageIndex];
  if (!message) return null;

  const before = Date.parse(message.createdAt);
  const previousMessage = messages[messageIndex - 1];
  const after = previousMessage ? Date.parse(previousMessage.updatedAt) : Number.NEGATIVE_INFINITY;
  return Number.isNaN(before) || Number.isNaN(after) ? null : { after, before };
}

export function findThreadArtifactPath(
  thread: ThreadArtifactSource,
  turnId: TurnId,
  messageId: MessageId,
  reference: string,
): string | null {
  const normalizedReference = normalizeThreadArtifactReference(reference);
  if (!normalizedReference) return null;
  const window = artifactMessageWindow(thread, turnId, messageId);
  if (!window) return null;

  const matches = new Map<string, string>();
  for (const activity of thread.activities) {
    if (activity.turnId !== turnId) continue;
    const createdAt = Date.parse(activity.createdAt);
    if (Number.isNaN(createdAt) || createdAt <= window.after || createdAt > window.before) continue;

    for (const artifactPath of activityArtifactPaths(activity.payload)) {
      const candidate = artifactPath.trim();
      const normalizedCandidate = candidate.replaceAll("\\", "/");
      if (
        normalizedCandidate === normalizedReference ||
        normalizedCandidate.endsWith(`/${normalizedReference}`)
      ) {
        matches.set(normalizedCandidate, candidate);
      }
    }
  }

  return matches.size === 1 ? (matches.values().next().value ?? null) : null;
}
