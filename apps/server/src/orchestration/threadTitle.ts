import { truncate } from "@t3tools/shared/String";

const DEFAULT_THREAD_TITLE = "New thread";

function normalizeTitleSeedCandidate(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function canReplaceThreadTitle(
  currentTitle: string,
  titleSeed?: string,
  sourceMessageText?: string,
): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  if (trimmedTitleSeed === undefined || trimmedTitleSeed.length === 0) {
    return false;
  }

  if (trimmedCurrentTitle === trimmedTitleSeed) {
    return true;
  }

  // Truncated seed expansion matching is only valid for client titles that
  // explicitly use an ellipsis marker.
  if (!trimmedTitleSeed.endsWith("...")) {
    return false;
  }

  const normalizedCurrentTitle = normalizeTitleSeedCandidate(trimmedCurrentTitle);
  const normalizedSourceMessage = sourceMessageText
    ? normalizeTitleSeedCandidate(sourceMessageText)
    : undefined;
  const seededFromExpandedPrompt =
    normalizedSourceMessage !== undefined && normalizedCurrentTitle === normalizedSourceMessage;
  if (!seededFromExpandedPrompt) {
    return false;
  }

  return (
    truncate(trimmedCurrentTitle, Math.max(0, trimmedTitleSeed.length - 3)) === trimmedTitleSeed
  );
}
