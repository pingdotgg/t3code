export interface SshPasswordPromptTiming {
  readonly isExpired: boolean;
  readonly remainingLabel: string | null;
  readonly remainingSeconds: number | null;
}

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function getSshPasswordPromptTiming(
  expiresInMs: number,
  receivedAtMs: number,
  nowMs: number,
): SshPasswordPromptTiming {
  const remainingMs = Math.max(0, receivedAtMs + expiresInMs - nowMs);
  const remainingSeconds = Math.ceil(remainingMs / 1_000);
  return {
    isExpired: remainingMs <= 0,
    remainingLabel: formatRemainingSeconds(remainingSeconds),
    remainingSeconds,
  };
}
