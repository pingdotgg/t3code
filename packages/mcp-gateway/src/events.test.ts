// @effect-diagnostics nodeBuiltinImport:off - exercises SQLite schema migration with a real file.
import { describe, expect, it } from "@effect/vitest";

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { createGatewayEventStore, isPrivateWebhookAddress, signWebhookPayload } from "./events.ts";

const clock = { value: "2026-09-03T12:00:00.000Z" };
let counter = 0;

function makeStore() {
  counter = 0;
  clock.value = "2026-09-03T12:00:00.000Z";
  return createGatewayEventStore({
    file: ":memory:",
    now: () => clock.value,
    newEventId: () => `evt-${++counter}`,
  });
}

describe("gateway event store", () => {
  it("reports bounded truthful status from store state and current grants", () => {
    const store = createGatewayEventStore({
      retentionEvents: 25,
      retentionDays: 3,
      allowPrivateWebhookTargets: true,
      now: () => "2026-09-05T00:00:00.000Z",
    });
    store.emit({ environmentId: "read-only", type: "thread.started" });
    store.registerWebhook({
      environmentId: "delivery",
      url: "http://127.0.0.1/hook?secret=no",
    });
    store.emit({ environmentId: "delivery", type: "thread.started" });
    const subscription = store.subscribe({ environmentId: "delivery", afterSequence: 0 });
    const snapshot = store.statusSnapshot({
      "read-only": ["read"],
      delivery: ["read", "delivery"],
      hidden: ["delivery"],
    });

    expect(snapshot.retention).toEqual({ maxEventsPerEnvironment: 25, maxAgeDays: 3 });
    expect(snapshot.environments.map((item) => item.environmentId)).toEqual([
      "delivery",
      "read-only",
    ]);
    expect(snapshot.environments[0]).toMatchObject({
      latestSequence: 1,
      retainedEventCount: 1,
      deliveryAccess: true,
      subscriptionCount: 1,
      webhookCount: 1,
      deliveries: { pending: 1, inFlight: 0, acked: 0, failed: 0 },
      subscriptions: [{ subscriptionId: subscription.subscriptionId, ackedSequence: 0 }],
    });
    expect(snapshot.environments[1]).toMatchObject({
      deliveryAccess: false,
      latestSequence: 1,
      retainedEventCount: 1,
    });
    expect(snapshot.environments[1]).not.toHaveProperty("subscriptions");
    expect(JSON.stringify(snapshot)).not.toContain("secret=no");
    expect(JSON.stringify(snapshot)).not.toContain("127.0.0.1");
    store.close();
  });

  it("migrates legacy idempotency rows without treating unknown null rows as dispatched", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-events-migrate-"));
    const file = NodePath.join(directory, "events.sqlite");
    const legacy = new NodeSqlite.DatabaseSync(file);
    legacy.exec(
      "CREATE TABLE idempotency (key TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL)",
    );
    legacy
      .prepare("INSERT INTO idempotency (key, payload, result) VALUES (?, ?, ?)")
      .run("completed", "{}", '{"accepted":true}');
    legacy
      .prepare("INSERT INTO idempotency (key, payload, result) VALUES (?, ?, ?)")
      .run("uncertain", "{}", "null");
    legacy.close();

    const store = createGatewayEventStore({ file });
    try {
      expect(store.requestState("completed")).toBe("completed");
      expect(store.recallRequest("completed")).toEqual({ accepted: true });
      expect(store.requestState("uncertain")).toBe("validating");
      expect(store.recallDispatchContext("uncertain")).toBeUndefined();
      store.markRequestDispatched("uncertain", { planRevision: 1 });
      expect(store.requestState("uncertain")).toBe("dispatched");
      expect(store.recallDispatchContext("uncertain")).toEqual({ planRevision: 1 });
      store.completeRequest("uncertain", { accepted: true });
      expect(store.requestState("uncertain")).toBe("completed");
      expect(store.recallRequest("uncertain")).toEqual({ accepted: true });
    } finally {
      store.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("assigns monotonic per-environment sequences and replays in order", () => {
    const store = makeStore();
    store.emit({ environmentId: "env-1", type: "thread.started" });
    store.emit({ environmentId: "env-2", type: "thread.started" });
    const third = store.emit({ environmentId: "env-1", type: "thread.completed" });

    expect(store.latestSequence("env-1")).toBe(2);
    expect(store.latestSequence("env-2")).toBe(1);
    expect(third.sequence).toBe(2);

    const replay = store.history("env-1", 0, 10);
    expect(replay.map((event) => event.sequence)).toEqual([1, 2]);
    expect(store.history("env-1", 1, 10).map((event) => event.sequence)).toEqual([2]);
  });

  it("marks deliveries and honours retention limits", () => {
    const store = createGatewayEventStore({
      file: ":memory:",
      retentionEvents: 2,
      retentionDays: 7,
      now: () => clock.value,
      newEventId: () => `evt-${++counter}`,
    });
    store.emit({ environmentId: "env-1", type: "a" });
    store.emit({ environmentId: "env-1", type: "b" });
    store.emit({ environmentId: "env-1", type: "c" });

    expect(() => store.history("env-1", 0, 10)).toThrowError(
      expect.objectContaining({ code: "cursor_expired" }),
    );
    expect(store.history("env-1", 1, 10).map((event) => event.type)).toEqual(["b", "c"]);
  });

  it("keeps subscriptions with monotonic idempotent acks and typed cursors", () => {
    const store = makeStore();
    store.emit({ environmentId: "env-1", type: "thread.started" });
    const subscription = store.subscribe({ environmentId: "env-1" });

    const pending = store.pendingFor(subscription.subscriptionId, 10);
    expect(pending.map((event) => event.sequence)).toEqual([1]);

    store.ack(subscription.subscriptionId, 1);
    expect(store.pendingFor(subscription.subscriptionId, 10)).toEqual([]);
    // Idempotent + monotonic: older or repeated acks never regress the cursor.
    store.ack(subscription.subscriptionId, 1);
    store.ack(subscription.subscriptionId, 0);
    expect(store.pendingFor(subscription.subscriptionId, 10)).toEqual([]);

    expect(() => store.ack("sub-missing", 3)).toThrowError(
      expect.objectContaining({ code: "unknown_subscription" }),
    );
    expect(() => store.ack(subscription.subscriptionId, -1)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("filters subscription events by type", () => {
    const store = makeStore();
    store.emit({ environmentId: "env-1", type: "thread.progress" });
    store.emit({ environmentId: "env-1", type: "approval.requested" });
    const subscription = store.subscribe({ environmentId: "env-1", types: ["approval.requested"] });

    expect(store.pendingFor(subscription.subscriptionId, 10).map((event) => event.type)).toEqual([
      "approval.requested",
    ]);
  });

  it("registers webhooks, returns the secret once, and signs deliveries", () => {
    const store = makeStore();
    const { webhook, secret } = store.registerWebhook({
      environmentId: "env-1",
      url: "https://example.com/hook",
    });
    expect(secret).not.toBe("");
    expect(webhook.secret).toBe("");
    expect(store.listWebhooks("env-1")[0]?.secret).toBe("");

    const event = store.emit({
      environmentId: "env-1",
      type: "thread.completed",
      correlationId: "corr-1",
    });
    const delivery = store.buildDelivery(webhook.webhookId, event.eventId);
    expect(delivery).toBeDefined();
    expect(delivery?.headers["X-T3-Event-Id"]).toBe(event.eventId);
    expect(delivery?.headers["X-T3-Event-Sequence"]).toBe(String(event.sequence));
    expect(delivery?.headers["X-T3-Correlation-Id"]).toBe("corr-1");
    expect(delivery?.headers["X-T3-Signature"]).toBe(
      `sha256=${signWebhookPayload(secret, delivery?.body ?? "")}`,
    );

    // Dedupe: a second build for the same event is delayed until the attempt is reported.
    expect(store.buildDelivery(webhook.webhookId, event.eventId)).toBeUndefined();
    store.reportDeliveryAttempt(webhook.webhookId, event.eventId, {
      ok: true,
      retryable: false,
    });
    expect(store.webhookById(webhook.webhookId)?.ackedSequence).toBe(event.sequence);
  });

  it("rejects non-HTTPS webhook URLs and unknown webhook operations", () => {
    const store = makeStore();
    expect(() =>
      store.registerWebhook({ environmentId: "env-1", url: "http://example.com/hook" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() => store.updateWebhook("env-1", "whk-missing", {})).toThrowError(
      expect.objectContaining({ code: "unknown_webhook" }),
    );
    expect(() => store.deleteWebhook("env-1", "whk-missing")).toThrowError(
      expect.objectContaining({ code: "unknown_webhook" }),
    );
  });

  it("filters webhook deliveries by type and environment", () => {
    const store = makeStore();
    const { webhook } = store.registerWebhook({
      environmentId: "env-1",
      url: "https://example.com/hook",
      types: ["approval.requested"],
    });
    const progress = store.emit({ environmentId: "env-1", type: "thread.progress" });
    const approval = store.emit({ environmentId: "env-2", type: "approval.requested" });

    expect(store.buildDelivery(webhook.webhookId, progress.eventId)).toBeUndefined();
    expect(store.buildDelivery(webhook.webhookId, approval.eventId)).toBeUndefined();
  });

  it("applies subscription type filters before the replay limit", () => {
    const store = makeStore();
    const subscription = store.subscribe({
      environmentId: "env-1",
      types: ["approval.requested"],
    });
    store.emit({ environmentId: "env-1", type: "thread.progress" });
    store.emit({ environmentId: "env-1", type: "thread.progress" });
    store.emit({ environmentId: "env-1", type: "approval.requested" });

    expect(store.pendingFor(subscription.subscriptionId, 1).map((event) => event.type)).toEqual([
      "approval.requested",
    ]);
  });

  it("rejects IPv4-mapped IPv6 private, loopback, and link-local destinations", () => {
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:172.16.0.1",
      "::ffff:192.168.1.1",
      "::ffff:169.254.169.254",
    ]) {
      expect(isPrivateWebhookAddress(address), address).toBe(true);
      expect(() =>
        makeStore().registerWebhook({
          environmentId: "env-1",
          url: `https://[${address}]/hook`,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    }
  });

  it("keeps delivery failures outside the server-authoritative sequence", () => {
    const store = createGatewayEventStore({
      file: ":memory:",
      webhookRetryBaseMs: 0,
      now: () => clock.value,
      newEventId: () => `evt-${++counter}`,
    });
    const { webhook } = store.registerWebhook({
      environmentId: "env-1",
      url: "https://example.com/hook",
    });
    const first = store.ingest({
      eventId: "server-1",
      environmentId: "env-1",
      sequence: 1,
      type: "thread.started",
      occurredAt: clock.value,
    });
    const delivery = store.buildDelivery(webhook.webhookId, first.eventId);
    expect(delivery).toBeDefined();
    const failed = store.reportDeliveryAttempt(
      webhook.webhookId,
      first.eventId,
      { ok: false, retryable: false },
      "receiver rejected event",
    );

    expect(store.latestSequence("env-1")).toBe(1);
    expect(store.history("env-1", 0, 10).map((event) => event.type)).toEqual(["thread.started"]);
    expect(failed.deliveryFailedEvent).toMatchObject({
      type: "delivery.failed",
      authoritativeSequence: null,
    });
    expect(() =>
      store.ingest({
        eventId: "server-2",
        environmentId: "env-1",
        sequence: 2,
        type: "thread.completed",
        occurredAt: clock.value,
      }),
    ).not.toThrow();
  });

  it("remembers and recalls request results exactly once", () => {
    const store = makeStore();
    expect(store.rememberRequest("key-1", '{"a":1}', { status: "accepted" })).toBe("accepted");
    expect(store.rememberRequest("key-1", '{"a":1}', { status: "accepted" })).toBe("duplicate");
    expect(store.recallRequest<{ status: string }>("key-1")).toEqual({ status: "accepted" });
    expect(store.rememberRequest("key-1", '{"a":2}', { status: "accepted" })).toBe("conflict");
    store.forgetRequest("key-1");
    expect(store.rememberRequest("key-1", '{"a":2}', { status: "accepted" })).toBe("accepted");
    expect(store.recallRequest("key-2")).toBeUndefined();
  });
});
