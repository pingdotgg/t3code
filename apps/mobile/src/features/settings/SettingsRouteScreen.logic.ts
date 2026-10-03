export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "iOS only" };
}

/**
 * Commits a days text input against its current server value. Returns the
 * days to write, or null when the draft is invalid or unchanged (no write).
 *
 * Whole-string digit check so "3.5" and "3days" are rejected instead of
 * silently becoming 3 on every eligible sync target. Shared by the
 * auto-settle and auto-archive days inputs so both validate identically.
 */
export function resolveDaysDraftCommit(input: {
  readonly draft: string | null;
  readonly current: number | null;
  readonly minDays: number;
  readonly maxDays: number;
}): number | null {
  const text = (input.draft ?? "").trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (
    Number.isInteger(parsed) &&
    parsed >= input.minDays &&
    parsed <= input.maxDays &&
    parsed !== input.current
  ) {
    return parsed;
  }
  return null;
}
