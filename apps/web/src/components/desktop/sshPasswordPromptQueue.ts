import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";

export type QueuedDesktopSshPasswordPromptRequest = DesktopSshPasswordPromptRequest & {
  readonly receivedAtMs: number;
};

export function enqueueDesktopSshPasswordPrompt(
  queue: readonly QueuedDesktopSshPasswordPromptRequest[],
  request: DesktopSshPasswordPromptRequest,
  receivedAtMs: number,
): readonly QueuedDesktopSshPasswordPromptRequest[] {
  return [...queue, { ...request, receivedAtMs }];
}
