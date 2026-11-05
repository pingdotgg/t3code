import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
  connectAvailable: boolean,
): WebhookAddress {
  const connect = connectAvailable ? " Link T3 Connect for a public URL." : "";
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: connectAvailable ? "Link this environment to T3 Connect for a public URL." : null,
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? `Only this computer can call this address.${connect}`
      : `Works wherever this environment's address is reachable, for example over Tailscale or your own proxy.${connect}`,
  };
}
