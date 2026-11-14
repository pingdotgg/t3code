import type { AuthClientMetadata, AuthPairingLink } from "@t3tools/contracts";

export interface ConnectDeviceApprovalPrompt {
  readonly pairingLinkId: string;
  readonly title: string;
  readonly message: string;
}

export function describeConnectDevice(device: AuthClientMetadata | undefined): string {
  const { label, browser, os } = device ?? {};
  if (label) return label;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "A new device";
}

/** Requests waiting on approval that have not been shown yet, oldest first. */
export function connectDeviceApprovalPrompts(input: {
  readonly environmentLabel: string;
  readonly pairingLinks: ReadonlyArray<AuthPairingLink>;
  readonly shownIds: ReadonlySet<string>;
}): ReadonlyArray<ConnectDeviceApprovalPrompt> {
  const waiting = input.pairingLinks.flatMap((link) =>
    link.connectDeviceRequest !== undefined && !input.shownIds.has(link.id)
      ? [{ link, ...link.connectDeviceRequest }]
      : [],
  );
  return [...waiting]
    .sort(
      (left, right) =>
        left.link.createdAt.epochMilliseconds - right.link.createdAt.epochMilliseconds,
    )
    .map(({ link, verificationCode, client: device }) => ({
      pairingLinkId: link.id,
      title: "Approve this device?",
      message: `${describeConnectDevice(device)} wants to connect to ${input.environmentLabel} through T3 Connect. It shows code ${verificationCode}. Approve it only if that code matches.`,
    }));
}

/**
 * Shows approval prompts one at a time: an Android alert replaces the one on screen, which
 * would drop an unanswered request. A prompt answered with "retry" goes back to the front;
 * "later" puts it back without showing anything until the next offer.
 */
export function createApprovalPromptQueue<P extends { readonly pairingLinkId: string }>(
  present: (prompt: P, answer: (outcome: "done" | "retry" | "later") => void) => void,
) {
  const known = new Set<string>();
  const waiting: P[] = [];
  let showing: { readonly prompt: P; dropped: boolean } | null = null;
  const next = () => {
    if (showing) return;
    const prompt = waiting.shift();
    if (prompt === undefined) return;
    const current = { prompt, dropped: false };
    showing = current;
    let answered = false;
    present(prompt, (outcome) => {
      if (answered) return;
      answered = true;
      showing = null;
      // A dropped prompt is forgotten, so its host can offer it again when it comes back.
      if (outcome !== "done" && !current.dropped) waiting.unshift(prompt);
      if (outcome !== "later") next();
    });
  };
  return {
    known: known as ReadonlySet<string>,
    /** Forgets waiting prompts that match, such as a host that went away. */
    drop(matches: (prompt: P) => boolean) {
      if (showing && matches(showing.prompt)) {
        showing.dropped = true;
        known.delete(showing.prompt.pairingLinkId);
      }
      for (let index = waiting.length - 1; index >= 0; index--) {
        const prompt = waiting[index]!;
        if (!matches(prompt)) continue;
        waiting.splice(index, 1);
        known.delete(prompt.pairingLinkId);
      }
    },
    offer(prompts: ReadonlyArray<P>) {
      // Also re-shows a prompt deferred because another dialog took the screen.
      for (const prompt of prompts) {
        if (known.has(prompt.pairingLinkId)) continue;
        known.add(prompt.pairingLinkId);
        waiting.push(prompt);
      }
      next();
    },
  };
}
