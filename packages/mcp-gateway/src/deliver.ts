import * as NodeDnsPromises from "node:dns/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Native TLS request preserves SNI while pinning the validated DNS address and does not follow redirects.
import * as NodeHttps from "node:https";
import * as NodeTimers from "node:timers";

import { isPrivateWebhookAddress, type GatewayEventStore, type WebhookTarget } from "./events.ts";

export interface WebhookDestination {
  readonly address: string;
  readonly family: 4 | 6;
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
}

export type WebhookLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ readonly address: string; readonly family: 4 | 6 }>>;

const defaultLookup: WebhookLookup = (hostname) =>
  NodeDnsPromises.lookup(hostname, { all: true, verbatim: true }) as Promise<
    ReadonlyArray<{ readonly address: string; readonly family: 4 | 6 }>
  >;

export async function resolveWebhookDestination(
  value: string,
  lookup: WebhookLookup = defaultLookup,
): Promise<WebhookDestination> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("Webhook URLs must use HTTPS and a public network destination.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const literalFamily = isPrivateWebhookAddress(hostname)
    ? 0
    : hostname.includes(":")
      ? 6
      : /^\d+(?:\.\d+){3}$/u.test(hostname)
        ? 4
        : 0;
  const answers =
    literalFamily === 0 && !hostname.includes(":") && !/^\d+(?:\.\d+){3}$/u.test(hostname)
      ? await lookup(hostname)
      : literalFamily === 0
        ? []
        : [{ address: hostname, family: literalFamily as 4 | 6 }];
  if (answers.length === 0 || answers.some(({ address }) => isPrivateWebhookAddress(address))) {
    throw new Error("Webhook URL must resolve only to a public network destination.");
  }
  const selected = answers[0];
  if (selected === undefined) {
    throw new Error("Webhook URL did not resolve to a network destination.");
  }
  return {
    address: selected.address,
    family: selected.family,
    hostname,
    port: url.port === "" ? 443 : Number.parseInt(url.port, 10),
    path: `${url.pathname}${url.search}`,
  };
}

export function createPinnedWebhookRequestOptions(
  target: WebhookTarget,
  destination: WebhookDestination,
): NodeHttps.RequestOptions {
  return {
    protocol: "https:",
    hostname: destination.hostname,
    servername: destination.hostname,
    port: destination.port,
    path: destination.path,
    method: "POST",
    headers: {
      ...target.headers,
      "Content-Length": Buffer.byteLength(target.body),
    },
    lookup: (_hostname, _options, callback) =>
      callback(null, destination.address, destination.family),
  };
}

export interface WebhookSendResult {
  readonly ok: boolean;
  readonly retryable: boolean;
  readonly ackedSequence?: number;
  readonly error?: string;
}

export async function fetchWebhookSender(target: WebhookTarget): Promise<WebhookSendResult> {
  let destination: WebhookDestination;
  try {
    destination = await resolveWebhookDestination(target.url);
  } catch (error) {
    return {
      ok: false,
      retryable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return new Promise((resolve) => {
    const request = NodeHttps.request(
      createPinnedWebhookRequestOptions(target, destination),
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        const rawAck = response.headers["x-t3-ack-sequence"];
        const ack = Array.isArray(rawAck) ? rawAck[0] : rawAck;
        const ackedSequence = ack === undefined ? undefined : Number.parseInt(ack, 10);
        if (status >= 200 && status < 300) {
          if (Number.isInteger(ackedSequence) && (ackedSequence as number) >= 0) {
            resolve({ ok: true, retryable: false, ackedSequence: ackedSequence as number });
          } else {
            resolve({ ok: true, retryable: false });
          }
          return;
        }
        // Native https.request never follows redirects. Treat redirects and
        // other permanent 4xx responses as terminal; retry throttling and 5xx.
        resolve({
          ok: false,
          retryable: status === 408 || status === 425 || status === 429 || status >= 500,
          error: `Webhook returned HTTP ${status}.`,
        });
      },
    );
    request.setTimeout(15_000, () => request.destroy(new Error("Webhook request timed out.")));
    request.once("error", (error) => resolve({ ok: false, retryable: true, error: error.message }));
    request.end(target.body);
  });
}

export function startWebhookDeliveryWorker(
  store: GatewayEventStore,
  input: {
    readonly intervalMs?: number;
    readonly batchSize?: number;
    readonly sender?: (target: WebhookTarget) => Promise<WebhookSendResult>;
    readonly isAuthorized: (environmentId: string) => boolean;
  },
): { readonly stop: () => Promise<void>; readonly runOnce: () => Promise<void> } {
  const sender = input.sender ?? fetchWebhookSender;
  let stopped = false;
  let activeRun: Promise<void> | undefined;
  const deliverBatch = async () => {
    const batchSize = input.batchSize ?? 32;
    const excludedEnvironmentIds = new Set<string>();
    const visited = new Set<string>();
    let attempted = 0;
    while (attempted < batchSize) {
      if (stopped) return;
      const due = store.dueDeliveries(batchSize - attempted, [...excludedEnvironmentIds]);
      const unseen = due.filter((row) => !visited.has(`${row.webhookId}:${row.eventId}`));
      if (unseen.length === 0) break;
      for (const delivery of unseen) {
        if (stopped) return;
        visited.add(`${delivery.webhookId}:${delivery.eventId}`);
        const webhook = store.webhookById(delivery.webhookId);
        if (webhook === undefined) continue;
        if (!input.isAuthorized(webhook.environmentId)) {
          excludedEnvironmentIds.add(webhook.environmentId);
          continue;
        }
        const target = store.buildDelivery(delivery.webhookId, delivery.eventId);
        if (target === undefined) {
          attempted += 1;
          store.reportDeliveryAttempt(
            delivery.webhookId,
            delivery.eventId,
            { ok: false, retryable: false },
            "Delivery no longer matches the webhook configuration.",
          );
          continue;
        }
        attempted += 1;
        const result = await sender(target);
        store.reportDeliveryAttempt(
          delivery.webhookId,
          delivery.eventId,
          { ok: result.ok, retryable: result.retryable },
          result.error,
          result.ackedSequence,
        );
      }
    }
  };
  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    activeRun ??= deliverBatch().finally(() => {
      activeRun = undefined;
    });
    return activeRun;
  };
  // @effect-diagnostics-next-line globalTimers:off - This worker is a Node sidecar lifecycle loop, not an Effect service.
  const timer = NodeTimers.setInterval(() => void runOnce(), input.intervalMs ?? 1_000);
  timer.unref();
  void runOnce();
  return {
    runOnce,
    stop: async () => {
      stopped = true;
      NodeTimers.clearInterval(timer);
      await activeRun;
    },
  };
}
