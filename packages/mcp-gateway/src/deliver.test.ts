import { describe, expect, it, vi } from "@effect/vitest";

import {
  createPinnedWebhookRequestOptions,
  resolveWebhookDestination,
  startWebhookDeliveryWorker,
} from "./deliver.ts";
import { createGatewayEventStore, type WebhookTarget } from "./events.ts";

const target = {
  url: "https://hooks.example.com/status?source=t3",
  headers: { "Content-Type": "application/json" },
  body: "{}",
};

describe("webhook delivery network policy", () => {
  it("rejects a DNS answer set containing private addresses", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ]);

    await expect(resolveWebhookDestination(target.url, lookup)).rejects.toThrow(
      "public network destination",
    );
  });

  it("rejects carrier-grade NAT destinations used by private overlay networks", async () => {
    const lookup = vi.fn(async () => [{ address: "100.100.100.100", family: 4 as const }]);

    await expect(resolveWebhookDestination(target.url, lookup)).rejects.toThrow(
      "public network destination",
    );
  });

  it("stops webhook delivery immediately when delivery scope is revoked", async () => {
    const store = createGatewayEventStore();
    const { webhook } = store.registerWebhook({
      environmentId: "env-1",
      url: "https://example.com/hook",
    });
    store.emit({ environmentId: "env-1", type: "thread.completed" });
    let authorized = false;
    const sender = vi.fn(async () => ({ ok: true, retryable: false }));
    const worker = startWebhookDeliveryWorker(store, {
      intervalMs: 60_000,
      isAuthorized: () => authorized,
      sender,
    });

    await worker.runOnce();
    expect(sender).not.toHaveBeenCalled();
    expect(store.webhookById(webhook.webhookId)?.ackedSequence).toBe(0);

    authorized = true;
    await worker.runOnce();
    expect(sender).toHaveBeenCalledOnce();
    expect(store.webhookById(webhook.webhookId)?.ackedSequence).toBe(1);
    await worker.stop();
    store.close();
  });

  it("does not let revoked deliveries starve authorized webhooks in the same due batch", async () => {
    const store = createGatewayEventStore();
    for (let index = 0; index < 32; index += 1) {
      store.registerWebhook({
        environmentId: "revoked",
        url: `https://example.com/revoked-${index}`,
      });
    }
    store.registerWebhook({ environmentId: "allowed", url: "https://example.com/allowed" });
    store.emit({ environmentId: "revoked", type: "thread.completed" });
    store.emit({ environmentId: "allowed", type: "thread.completed" });
    const sender = vi.fn(async (_delivery: WebhookTarget) => ({ ok: true, retryable: false }));
    const worker = startWebhookDeliveryWorker(store, {
      intervalMs: 60_000,
      batchSize: 32,
      isAuthorized: (environmentId) => environmentId === "allowed",
      sender,
    });

    await worker.runOnce();

    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0]?.[0].url).toBe("https://example.com/allowed");
    await worker.stop();
    store.close();
  });

  it("drains an in-flight delivery before the owner closes its store", async () => {
    const store = createGatewayEventStore();
    store.registerWebhook({ environmentId: "local", url: "https://example.com/hook" });
    store.emit({ environmentId: "local", type: "thread.completed" });
    store.emit({ environmentId: "local", type: "thread.completed" });
    const started = Promise.withResolvers<void>();
    let attempts = 0;
    const finish = Promise.withResolvers<{ ok: boolean; retryable: boolean }>();
    const worker = startWebhookDeliveryWorker(store, {
      isAuthorized: () => true,
      sender: async () => {
        attempts += 1;
        started.resolve();
        return finish.promise;
      },
    });
    await started.promise;
    let stopped = false;
    const drained = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish.resolve({ ok: true, retryable: false });
    await drained;
    expect(stopped).toBe(true);
    expect(attempts).toBe(1);
    store.close();
  });

  it("pins the validated DNS address and cannot follow redirects", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const destination = await resolveWebhookDestination(target.url, lookup);
    const options = createPinnedWebhookRequestOptions(target, destination);

    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "hooks.example.com",
      servername: "hooks.example.com",
      method: "POST",
      path: "/status?source=t3",
    });
    expect(options).not.toHaveProperty("maxRedirects");

    const pinnedLookup = options.lookup;
    if (typeof pinnedLookup !== "function") throw new Error("Expected a pinned lookup callback.");
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinnedLookup("hooks.example.com", {}, (error, address, family) => {
        if (error !== null) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });
    expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
  });
});

it("retires pending deliveries invalidated by a filter change and keeps shutdown finite", async () => {
  const store = createGatewayEventStore();
  const { webhook } = store.registerWebhook({
    environmentId: "local",
    url: "https://example.com/hook",
  });
  store.emit({ environmentId: "local", type: "thread.completed" });
  store.updateWebhook("local", webhook.webhookId, { types: ["thread.started"] });
  const sender = vi.fn(async () => ({ ok: true, retryable: false }));
  const worker = startWebhookDeliveryWorker(store, { isAuthorized: () => true, sender });
  try {
    await worker.runOnce();
    expect(sender).not.toHaveBeenCalled();
    expect(store.dueDeliveries(32)).toHaveLength(0);
    store.emit({ environmentId: "local", type: "thread.started" });
    await worker.runOnce();
    expect(sender).toHaveBeenCalledOnce();
  } finally {
    await worker.stop();
    store.close();
  }
});
