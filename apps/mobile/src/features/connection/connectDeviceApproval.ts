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
