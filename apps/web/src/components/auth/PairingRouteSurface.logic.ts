export function claimPairingToken(
  token: string | null,
  attemptedTokens: Set<string>,
): string | null {
  if (!token || attemptedTokens.has(token)) return null;
  attemptedTokens.add(token);
  return token;
}
