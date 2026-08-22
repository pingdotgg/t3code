export function getSshPasswordPromptRemainingMs(input: {
  readonly nowMs: number;
  readonly receivedAtMs: number;
  readonly expiresInMs: number;
}): number {
  return Math.max(0, input.receivedAtMs + input.expiresInMs - input.nowMs);
}

export function canSubmitSshPassword(input: {
  readonly password: string;
  readonly isResponding: boolean;
  readonly isExpired: boolean;
}): boolean {
  return input.password.length > 0 && !input.isResponding && !input.isExpired;
}
