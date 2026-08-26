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

export function formattedSetupGuidance(
  label: string,
  executable: string | null,
  installHint: string,
): string {
  if (executable !== null) {
    return `${label} is not authenticated on this server. Run \`${executable} login add\` on the server host to enable change request features.`;
  }
  return `${label} is not authenticated on this server. ${installHint}`;
}
