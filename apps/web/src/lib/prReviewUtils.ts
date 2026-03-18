export { buildReviewPrompt, normalizePrReference } from "@t3tools/shared/prReview";

export const GITHUB_PR_URL_REGEX = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

export function isLikelyPrReference(value: string): boolean {
  const trimmed = value.trim();
  if (GITHUB_PR_URL_REGEX.test(trimmed)) return true;
  // Numeric PR number (e.g. "123")
  if (/^\d+$/.test(trimmed)) return true;
  // owner/repo#number format
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(trimmed)) return true;
  return false;
}
