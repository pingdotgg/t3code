const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 40;

export async function waitForThreadShellReady(input: {
  readonly read: () => boolean;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly delay?: (durationMs: number) => Promise<void>;
}): Promise<boolean> {
  const now = input.now ?? Date.now;
  const delay =
    input.delay ??
    ((durationMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
      }));
  const deadline = now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (!input.read() && now() < deadline) {
    await delay(Math.min(pollIntervalMs, deadline - now()));
  }

  return input.read();
}
