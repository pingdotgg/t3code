import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  RELAY_WEBHOOK_MAX_BODY_BYTES,
  RELAY_WEBHOOK_MAX_PENDING_PER_INBOX,
  RelayApi,
  RelayEnvironmentAuth,
  RelayEnvironmentPrincipal,
  type RelayWebhookDelivery,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import { RELAY_HTTP_ROUTER_CONFIG, relayCors, relayNotFoundRoute, serverApi } from "../http/Api.ts";
import { relayWebhookDeliveries } from "../persistence/schema.ts";
import * as WebhookDeliveries from "./WebhookDeliveries.ts";
import * as WebhookInboxes from "./WebhookInboxes.ts";
import { webhookInboxRoute } from "./WebhookInboxRoute.ts";

const relaySettings = {
  relayIssuer: "https://relay.example.test",
} as unknown as RelayConfiguration.RelayConfiguration["Service"];

const runRequest = (routes: Layer.Layer<never, never, HttpRouter.HttpRouter>, request: Request) =>
  HttpRouter.toHttpEffect(Layer.mergeAll(routes, relayNotFoundRoute)).pipe(
    Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
    Effect.flatMap((httpEffect) =>
      httpEffect.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      ),
    ),
    Effect.map(HttpServerResponse.toWeb),
  );

describe("webhook inbox route", () => {
  const receiveWith = (result: WebhookInboxes.WebhookReceiveResult) => {
    const received: Array<Parameters<WebhookInboxes.WebhookInboxes["Service"]["receive"]>[0]> = [];
    const enqueued: Array<string> = [];
    const routes = webhookInboxRoute.pipe(
      Layer.provide([
        Layer.mock(WebhookInboxes.WebhookInboxes, {
          receive: (input) =>
            Effect.sync(() => {
              received.push(input);
              return result;
            }),
        }),
        Layer.mock(WebhookDeliveries.WebhookDeliveries, {
          enqueue: (deliveryId) =>
            Effect.sync(() => {
              enqueued.push(deliveryId);
            }),
        }),
      ]),
    );
    return { received, enqueued, routes };
  };

  it.effect("stores the raw request without credentials and queues it for its environment", () =>
    Effect.gen(function* () {
      const { received, enqueued, routes } = receiveWith({
        status: "stored",
        deliveryId: "delivery-1",
      });
      const body = '{"action":"created","data":{"issue":{"id":"1"}}}';
      const response = yield* runRequest(
        routes,
        new Request("https://relay.example.test/v1/inbox/inbox-1", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "sentry-hook-resource": "issue",
            authorization: "Bearer secret",
            cookie: "session=1",
            "cf-connecting-ip": "203.0.113.7",
            "x-forwarded-for": "203.0.113.7",
          },
          body,
        }),
      );

      expect(response.status).toBe(202);
      expect(received).toHaveLength(1);
      expect(received[0]?.inboxId).toBe("inbox-1");
      expect(received[0]?.body).toBe(body);
      expect(received[0]?.headers).toEqual({
        "content-type": "application/json",
        "sentry-hook-resource": "issue",
      });
      expect(enqueued).toEqual(["delivery-1"]);
    }).pipe(Effect.scoped),
  );

  it.effect("reports unknown and full inboxes without queueing anything", () =>
    Effect.gen(function* () {
      for (const [status, code] of [
        ["inbox_not_found", 404],
        ["inbox_full", 429],
      ] as const) {
        const { enqueued, routes } = receiveWith({ status });
        const response = yield* runRequest(
          routes,
          new Request("https://relay.example.test/v1/inbox/inbox-1", {
            method: "POST",
            body: "{}",
          }),
        );
        expect(response.status).toBe(code);
        expect(enqueued).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("stops reading a chunked body without Content-Length once it passes the cap", () =>
    Effect.gen(function* () {
      const { received, routes } = receiveWith({ status: "stored", deliveryId: "delivery-1" });
      const chunk = new Uint8Array(64 * 1024).fill(120);
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(chunk);
        },
      });
      const response = yield* runRequest(
        routes,
        new Request("https://relay.example.test/v1/inbox/inbox-1", {
          method: "POST",
          body,
          duplex: "half",
        } as RequestInit),
      );
      expect(response.status).toBe(413);
      expect(received).toHaveLength(0);
      // An endless body is abandoned after a handful of chunks past the cap.
      expect(pulled).toBeLessThan(RELAY_WEBHOOK_MAX_BODY_BYTES / chunk.byteLength + 4);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects bodies that are not UTF-8 instead of storing mangled text", () =>
    Effect.gen(function* () {
      const { received, routes } = receiveWith({ status: "stored", deliveryId: "delivery-1" });
      const response = yield* runRequest(
        routes,
        new Request("https://relay.example.test/v1/inbox/inbox-1", {
          method: "POST",
          body: new Uint8Array([0xff, 0xfe, 0x00, 0x81]),
        }),
      );
      expect(response.status).toBe(415);
      expect(received).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects bodies over the size cap without storing them", () =>
    Effect.gen(function* () {
      const { received, routes } = receiveWith({ status: "stored", deliveryId: "delivery-1" });
      const response = yield* runRequest(
        routes,
        new Request("https://relay.example.test/v1/inbox/inbox-1", {
          method: "POST",
          body: "x".repeat(RELAY_WEBHOOK_MAX_BODY_BYTES + 1),
        }),
      );

      expect(response.status).toBe(413);
      expect(received).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
});

describe("webhook inbox environment endpoints", () => {
  const owner = { environmentId: "environment-1", environmentPublicKey: "environment-key" };

  it.effect("creates inboxes only for the authenticated environment", () =>
    Effect.gen(function* () {
      const createdFor: Array<Parameters<WebhookInboxes.WebhookInboxes["Service"]["create"]>[0]> =
        [];
      const routes = HttpApiBuilder.layer(
        HttpApi.make("RelayApi").add(RelayApi.groups.server),
      ).pipe(
        Layer.provide(
          serverApi.pipe(
            HttpRouter.provideRequest(
              Layer.mergeAll(
                Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
                Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
                Layer.mock(ManagedEndpointAllocations.ManagedEndpointAllocations, {}),
                Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
              ),
            ),
            Layer.provide([
              Layer.mock(AgentActivityPublisher.AgentActivityPublisher, {}),
              Layer.mock(EnvironmentPublishSignatures.EnvironmentPublishSignatures, {}),
              Layer.mock(WebhookInboxes.WebhookInboxes, {
                create: (input) =>
                  Effect.sync(() => {
                    createdFor.push(input);
                    return {
                      inboxId: "inbox-1",
                      url: "https://relay.example.test/v1/inbox/inbox-1",
                      createdAt: "2026-10-01T10:00:00.000Z",
                    };
                  }),
              }),
            ]),
          ),
        ),
        Layer.provide(
          Layer.succeed(RelayEnvironmentAuth, {
            environmentBearer: (effect) =>
              effect.pipe(Effect.provideService(RelayEnvironmentPrincipal, owner)),
          }),
        ),
        Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak, relayCors]),
      );
      const create = (environmentId: string) =>
        runRequest(
          routes,
          new Request(
            `https://relay.example.test/v1/environments/${environmentId}/webhook-inboxes`,
            {
              method: "POST",
              headers: {
                authorization: "Bearer environment-credential",
                "content-type": "application/json",
              },
              body: '{"cloudUserId":"user-1"}',
            },
          ),
        );

      expect((yield* create("environment-1")).status).toBe(200);
      expect(createdFor).toEqual([{ ...owner, userId: "user-1" }]);
      expect((yield* create("environment-2")).status).toBe(401);
      expect(createdFor).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});

describe("WebhookInboxes", () => {
  const withDb = (db: unknown) =>
    Effect.provide(
      WebhookInboxes.layer.pipe(
        Layer.provide([
          Layer.succeed(RelayDb.RelayDb, db as RelayDb.RelayDb["Service"]),
          Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
          NodeCryptoLayer.layer,
        ]),
      ),
    );

  /** Fake for receive: a locked inbox lookup, a backlog count, then the insert, in one transaction. */
  const lookupDb = (options: { readonly inboxFound: boolean; readonly pending?: number }) => {
    const inserted: Array<unknown> = [];
    const locks: Array<unknown> = [];
    let transactions = 0;
    const db = {
      $client: {
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.sync(() => {
            transactions += 1;
          }).pipe(Effect.andThen(effect)),
      },
      select: (selection: Record<string, unknown>) => ({
        from: () =>
          "pending" in selection
            ? { where: () => Effect.succeed([{ pending: options.pending ?? 0 }]) }
            : {
                innerJoin: () => ({
                  where: () => ({
                    limit: () => ({
                      for: (strength: unknown) => {
                        locks.push(strength);
                        return Effect.succeed(options.inboxFound ? [{ inboxId: "inbox-1" }] : []);
                      },
                    }),
                  }),
                }),
              },
      }),
      insert: (table: unknown) => {
        expect(table).toBe(relayWebhookDeliveries);
        return {
          values: (values: unknown) => {
            inserted.push(values);
            return Effect.void;
          },
        };
      },
    };
    return { db, inserted, locks, transactions: () => transactions };
  };

  it.effect("drops deliveries for inboxes without an active environment link", () => {
    const { db, inserted } = lookupDb({ inboxFound: false });
    return Effect.gen(function* () {
      const inboxes = yield* WebhookInboxes.WebhookInboxes;
      expect(yield* inboxes.receive({ inboxId: "inbox-1", headers: {}, body: "{}" })).toEqual({
        status: "inbox_not_found",
      });
      expect(inserted).toHaveLength(0);
    }).pipe(withDb(db));
  });

  it.effect("stops storing once an inbox's backlog reaches the cap", () => {
    const { db, inserted } = lookupDb({
      inboxFound: true,
      pending: RELAY_WEBHOOK_MAX_PENDING_PER_INBOX,
    });
    return Effect.gen(function* () {
      const inboxes = yield* WebhookInboxes.WebhookInboxes;
      expect(yield* inboxes.receive({ inboxId: "inbox-1", headers: {}, body: "{}" })).toEqual({
        status: "inbox_full",
      });
      expect(inserted).toHaveLength(0);
    }).pipe(withDb(db));
  });

  it.effect("stores a delivery with its headers and body as received", () => {
    const { db, inserted, locks, transactions } = lookupDb({ inboxFound: true, pending: 0 });
    return Effect.gen(function* () {
      const inboxes = yield* WebhookInboxes.WebhookInboxes;
      const result = yield* inboxes.receive({
        inboxId: "inbox-1",
        headers: { "x-github-event": "pull_request" },
        body: '{"action":"opened"}',
      });
      expect(result.status).toBe("stored");
      // The count and insert run under a lock on the inbox row.
      expect(transactions()).toBe(1);
      expect(locks).toEqual(["update"]);
      expect(inserted).toEqual([
        expect.objectContaining({
          deliveryId: result.status === "stored" ? result.deliveryId : null,
          inboxId: "inbox-1",
          headers: { "x-github-event": "pull_request" },
          body: '{"action":"opened"}',
        }),
      ]);
    }).pipe(withDb(db));
  });

  const createDb = (linkActive: boolean) => {
    const inserted: Array<{ readonly inboxId: string; readonly userId: string }> = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Effect.succeed(linkActive ? [{ userId: "user-1" }] : []),
          }),
        }),
      }),
      insert: () => ({
        values: (values: { readonly inboxId: string; readonly userId: string }) => {
          inserted.push(values);
          return Effect.void;
        },
      }),
    };
    return { db, inserted };
  };
  const owner = {
    userId: "user-1",
    environmentId: "environment-1",
    environmentPublicKey: "environment-key",
  };

  it.effect("creates unguessable inbox URLs owned by the linked user", () => {
    const { db, inserted } = createDb(true);
    return Effect.gen(function* () {
      const inboxes = yield* WebhookInboxes.WebhookInboxes;
      const first = yield* inboxes.create(owner);
      const second = yield* inboxes.create(owner);
      expect(first?.inboxId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first?.inboxId).not.toBe(second?.inboxId);
      expect(first?.url).toBe(`https://relay.example.test/v1/inbox/${first?.inboxId}`);
      expect(inserted.map((row) => [row.inboxId, row.userId])).toEqual([
        [first?.inboxId, "user-1"],
        [second?.inboxId, "user-1"],
      ]);
    }).pipe(withDb(db));
  });

  it.effect("refuses an inbox for a user without an active link to the environment", () => {
    const { db, inserted } = createDb(false);
    return Effect.gen(function* () {
      const inboxes = yield* WebhookInboxes.WebhookInboxes;
      expect(yield* inboxes.create(owner)).toBeNull();
      expect(inserted).toEqual([]);
    }).pipe(withDb(db));
  });
});

describe("WebhookDeliveries", () => {
  const delivery: RelayWebhookDelivery = {
    deliveryId: "delivery-1",
    inboxId: "inbox-1",
    receivedAt: "2026-10-01T10:00:00.000Z",
    headers: {},
    body: "{}",
  };
  const target = { delivery, userId: "user-1", environmentId: "environment-1" };

  const harness = (options: {
    readonly target: WebhookInboxes.WebhookDeliveryTarget | null;
    readonly push: EnvironmentConnector.EnvironmentConnector["Service"]["deliverWebhook"];
    readonly retryable?: ReadonlyArray<string>;
  }) => {
    const calls: Array<string> = [];
    const record = (entry: string) =>
      Effect.sync(() => {
        calls.push(entry);
      });
    const layer = WebhookDeliveries.layer.pipe(
      Layer.provide([
        Layer.mock(WebhookInboxes.WebhookInboxes, {
          getForDelivery: () => Effect.succeed(options.target),
          markAttempted: ({ deliveryId }) => record(`attempt:${deliveryId}`),
          complete: (deliveryId) => record(`complete:${deliveryId}`),
          listRetryable: () => Effect.succeed(options.retryable ?? []),
        }),
        Layer.mock(EnvironmentConnector.EnvironmentConnector, {
          deliverWebhook: (input) =>
            record(`push:${input.delivery.deliveryId}`).pipe(Effect.andThen(options.push(input))),
        }),
        Layer.succeed(WebhookDeliveries.WebhookDeliveryQueueSender, {
          send: ({ deliveryId }) => record(`queue:${deliveryId}`),
        }),
      ]),
    );
    return { calls, layer };
  };

  it.effect("deletes a delivery once the environment accepts it", () => {
    const { calls, layer } = harness({ target, push: () => Effect.void });
    return Effect.gen(function* () {
      const deliveries = yield* WebhookDeliveries.WebhookDeliveries;
      yield* deliveries.process({ deliveryId: "delivery-1" });
      expect(calls).toEqual(["attempt:delivery-1", "push:delivery-1", "complete:delivery-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the delivery for a retry when the environment is unreachable", () => {
    const { calls, layer } = harness({
      target,
      push: () =>
        Effect.fail(
          new EnvironmentConnector.EnvironmentMintRequestFailed({
            environmentId: "environment-1",
            operation: "webhook",
            cause: "offline",
          }),
        ),
    });
    return Effect.gen(function* () {
      const deliveries = yield* WebhookDeliveries.WebhookDeliveries;
      const error = yield* Effect.flip(deliveries.process({ deliveryId: "delivery-1" }));
      expect(error._tag).toBe("EnvironmentMintRequestFailed");
      expect(calls).toEqual(["attempt:delivery-1", "push:delivery-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops a delivery its environment can never receive", () => {
    const { calls, layer } = harness({
      target,
      push: () =>
        Effect.fail(
          new EnvironmentConnector.EnvironmentConnectNotAuthorized({
            environmentId: "environment-1",
            operation: "webhook",
            reason: "endpoint_provider_not_managed",
          }),
        ),
    });
    return Effect.gen(function* () {
      const deliveries = yield* WebhookDeliveries.WebhookDeliveries;
      yield* deliveries.process({ deliveryId: "delivery-1" });
      expect(calls).toEqual(["attempt:delivery-1", "push:delivery-1", "complete:delivery-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes deliveries whose environment was unlinked without pushing", () => {
    const { calls, layer } = harness({ target: null, push: () => Effect.void });
    return Effect.gen(function* () {
      const deliveries = yield* WebhookDeliveries.WebhookDeliveries;
      yield* deliveries.process({ deliveryId: "delivery-1" });
      expect(calls).toEqual(["complete:delivery-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the delivery while the environment's tunnel is recovering", () => {
    const { calls, layer } = harness({
      target,
      push: () =>
        Effect.fail(
          new EnvironmentConnector.EnvironmentConnectNotAuthorized({
            environmentId: "environment-1",
            operation: "webhook",
            reason: "managed_endpoint_allocation_not_ready",
          }),
        ),
    });
    return Effect.gen(function* () {
      const deliveries = yield* WebhookDeliveries.WebhookDeliveries;
      const error = yield* Effect.flip(deliveries.process({ deliveryId: "delivery-1" }));
      expect(error._tag).toBe("EnvironmentConnectNotAuthorized");
      expect(calls).toEqual(["attempt:delivery-1", "push:delivery-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("requeues stale pending deliveries from the cron sweep", () => {
    const { calls, layer } = harness({
      target,
      push: () => Effect.void,
      retryable: ["delivery-1", "delivery-2"],
    });
    return Effect.gen(function* () {
      const deliveries = yield* WebhookDeliveries.WebhookDeliveries;
      expect(yield* deliveries.retryPending).toBe(2);
      expect(calls).toEqual(["queue:delivery-1", "queue:delivery-2"]);
    }).pipe(Effect.provide(layer));
  });
});
