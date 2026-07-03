import {
  type EnvironmentId,
  PREVIEW_TITLE_MAX_LENGTH,
  PreviewInvalidUrlError,
} from "@t3tools/contracts";

const HOST_PORT_RE = /^[a-zA-Z0-9.-]+:\d{1,5}(?:[/#?]|$)/;
const PROTOCOL_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
export const PREVIEW_PARTITION_PREFIX = "persist:t3-preview-";

export function newPreviewTabId(): string {
  return `preview-${crypto.randomUUID()}`;
}

export function clampPreviewTitle(title: string): string {
  return title.length <= PREVIEW_TITLE_MAX_LENGTH
    ? title
    : title.slice(0, PREVIEW_TITLE_MAX_LENGTH);
}

export function previewPartitionForEnvironment(environmentId: EnvironmentId): string {
  return `${PREVIEW_PARTITION_PREFIX}${environmentId}`;
}

export function isPreviewPartition(partition: string): boolean {
  return (
    partition.startsWith(PREVIEW_PARTITION_PREFIX) &&
    partition.length > PREVIEW_PARTITION_PREFIX.length
  );
}

export function normalizePreviewUrl(input: string): string | PreviewInvalidUrlError {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return new PreviewInvalidUrlError({
      inputLength: input.length,
      reason: "empty",
    });
  }

  const candidate =
    HOST_PORT_RE.test(trimmed) || !PROTOCOL_RE.test(trimmed) ? `http://${trimmed}` : trimmed;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return new PreviewInvalidUrlError({
        inputLength: input.length,
        reason: "unsupported-protocol",
        protocol: url.protocol,
      });
    }
    return url.toString();
  } catch (cause) {
    return new PreviewInvalidUrlError({
      inputLength: input.length,
      reason: "parse",
      cause,
    });
  }
}
