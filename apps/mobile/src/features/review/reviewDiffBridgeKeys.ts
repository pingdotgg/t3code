import type { NativeReviewDiffHighlightScheme } from "../diffs/nativeReviewDiffHighlighter";

// Pure key-derivation helpers for the native review diff bridge. Kept free of
// react-native / hook imports so they stay unit-testable in node.

export function hashReviewDiffKey(diff: string | null | undefined): string {
  if (!diff) {
    return "empty";
  }

  let hash = 5381;
  for (let index = 0; index < diff.length; index += 1) {
    hash = (hash * 33) ^ diff.charCodeAt(index);
  }

  return `${diff.length}:${(hash >>> 0).toString(36)}`;
}

export function buildNativeReviewTokensResetKey(input: {
  readonly threadKey: string | null;
  readonly sectionId: string | null;
  readonly scheme: NativeReviewDiffHighlightScheme;
  readonly diff: string | null | undefined;
  readonly fileCount: number;
  readonly rowCount: number;
}): string {
  return [
    input.threadKey ?? "none",
    input.sectionId ?? "none",
    input.scheme,
    hashReviewDiffKey(input.diff),
    input.fileCount,
    input.rowCount,
  ].join(":");
}
