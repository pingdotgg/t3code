/**
 * Pure formatting helpers for the Source Control settings card.
 * Extracted to enable focused unit tests without a React render harness.
 */

export function formattedAuthSuffix(host: string | null, detail: string | null): string {
  let text = "";
  if (host !== null) {
    text += ` on ${host}`;
  }
  if (detail !== null) {
    text += ` \u2014 ${detail}`;
  }
  return text;
}

export function formattedSetupGuidance(label: string): string {
  return `${label} is not authenticated on this server. Sign in or configure credentials using the`;
}
