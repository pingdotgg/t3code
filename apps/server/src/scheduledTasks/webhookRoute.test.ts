import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { RELAY_HOOK_DELIVERY_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  ScheduledTaskWebhookDeliveryId,
  ScheduledTaskError,
} from "@t3tools/contracts";
import {
  ScheduledTaskService,
  type WebhookTriggerRequest,
  type WebhookTriggerResult,
} from "./ScheduledTaskService.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RelayDeliveryProof from "./RelayDeliveryProof.ts";
import { WEBHOOK_MAX_BODY_BYTES } from "./webhookRoute.ts";
import * as WebhookRoute from "./webhookRoute.ts";

class WebhookTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

const environmentId = EnvironmentId.make("env-1");
const relayIssuer = "https://relay.example.test";
const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
/** The secrets a T3 Connect-linked environment holds, keyed by name. */
const linkedSecrets: ReadonlyMap<string, string> = new Map([
  [CLOUD_MINT_PUBLIC_KEY, mintKeys.publicKey],
  [RELAY_ISSUER_SECRET, relayIssuer],
]);

/** A proof as the relay signs it for one delivery. */
const relayProof = Effect.fn("relayProof")(function* (claims: {
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly hookId: string;
  readonly privateKey?: string;
}) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
  return yield* signRelayJwt({
    privateKey: claims.privateKey ?? mintKeys.privateKey,
    typ: RELAY_HOOK_DELIVERY_TYP,
    payload: {
      iss: relayIssuer,
      aud: `t3-env:${environmentId}`,
      sub: environmentId,
      jti: `proof:${claims.deliveryId}`,
      iat: now,
      exp: now + 3_600,
      environmentId,
      deliveryId: claims.deliveryId,
      receivedAt: claims.receivedAt,
      hookId: claims.hookId,
    },
  });
});

const handlerFor = (
  trigger: (
    request: WebhookTriggerRequest,
  ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>,
  secrets: ReadonlyMap<string, string> = linkedSecrets,
) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(WebhookTestApi).pipe(
      Layer.provide(WebhookRoute.layer),
      Layer.provide(RelayDeliveryProof.layer),
      Layer.provide(Layer.mock(ScheduledTaskService)({ triggerWebhook: trigger })),
      Layer.provide(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) =>
            Effect.succeed(
              Option.map(Option.fromUndefinedOr(secrets.get(name)), (value) =>
                new TextEncoder().encode(value),
              ),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );

const post = (
  path: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) => new Request(`http://env.local${path}`, { method: "POST", body, headers });

describe("webhook route", () => {
  it("passes the raw request to the service and answers 202 with the delivery id", async () => {
    let received: WebhookTriggerRequest | undefined;
    const { handler, dispose } = handlerFor((request) => {
      received = request;
      return Effect.succeed({
        _tag: "accepted",
        deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
        outcome: "accepted",
      });
    });
    try {
      const response = await handler(
        post("/api/hooks/scheduled-task%3Ahook/tok?x=1", '{"a":1}', {
          "Content-Type": "application/json",
          "X-GitHub-Event": "push",
        }),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ deliveryId: "delivery:1" });
      expect(received?.hookId).toBe("scheduled-task:hook");
      expect(received?.token).toBe("tok");
      expect(received?.query).toBe("x=1");
      expect(received?.headers["x-github-event"]).toBe("push");
      expect(received?.bodyText).toBe('{"a":1}');
    } finally {
      await dispose();
    }
  });

  // Live clock: the server checks proofs against real time.
  it.live("trusts the relay's delivery id and receive time only with its signed proof", () =>
    Effect.gen(function* () {
      const received: Array<WebhookTriggerRequest> = [];
      const { handler, dispose } = handlerFor((request) => {
        received.push(request);
        return Effect.succeed({
          _tag: "accepted",
          deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
          outcome: "accepted",
        });
      });
      const send = (path: string, headers: Record<string, string>) =>
        Effect.promise(() => handler(post(path, "{}", headers)));
      const receivedAt = "2026-10-04T10:00:00.000Z";
      const relayHeaders = {
        "x-t3-relay-delivery-id": "relay-1",
        "x-t3-relay-received-at": receivedAt,
      };
      const forged = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const proof = yield* relayProof({ deliveryId: "relay-1", receivedAt, hookId: "id" });
      const forgedProof = yield* relayProof({
        deliveryId: "relay-1",
        receivedAt,
        hookId: "id",
        privateKey: forged.privateKey,
      });
      // 0: signed by the relay for exactly this delivery.
      yield* send("/api/hooks/id/tok", { ...relayHeaders, "x-t3-relay-delivery": proof });
      // 1: a direct caller claiming to be the relay, without a proof.
      yield* send("/api/hooks/id/tok", relayHeaders);
      // 2: a proof signed with any other key.
      yield* send("/api/hooks/id/tok", { ...relayHeaders, "x-t3-relay-delivery": forgedProof });
      // 3: a real proof lifted onto another delivery id.
      yield* send("/api/hooks/id/tok", {
        ...relayHeaders,
        "x-t3-relay-delivery-id": "relay-2",
        "x-t3-relay-delivery": proof,
      });
      // 4: a real proof for another hook.
      yield* send("/api/hooks/other/tok", { ...relayHeaders, "x-t3-relay-delivery": proof });
      yield* Effect.promise(() => dispose());
      expect(received.map((request) => request.relayDeliveryId)).toEqual([
        "relay-1",
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(received[0]?.receivedAt).toBe(receivedAt);
      expect(received.slice(1).every((request) => request.receivedAt === undefined)).toBe(true);
    }),
  );

  // Live clock: the server checks proofs against real time.
  it.live("trusts no relay headers on an environment not linked to T3 Connect", () =>
    Effect.gen(function* () {
      const received: Array<WebhookTriggerRequest> = [];
      const { handler, dispose } = handlerFor((request) => {
        received.push(request);
        return Effect.succeed({ _tag: "not_found" });
      }, new Map());
      const receivedAt = "2026-10-04T10:00:00.000Z";
      const proof = yield* relayProof({ deliveryId: "relay-1", receivedAt, hookId: "id" });
      yield* Effect.promise(() =>
        handler(
          post("/api/hooks/id/tok", "{}", {
            "x-t3-relay-delivery-id": "relay-1",
            "x-t3-relay-received-at": receivedAt,
            "x-t3-relay-delivery": proof,
          }),
        ),
      );
      yield* Effect.promise(() => dispose());
      expect(received[0]?.relayDeliveryId).toBeUndefined();
    }),
  );

  it("maps service outcomes to status codes and names each outcome for the relay", async () => {
    const deliveryId = ScheduledTaskWebhookDeliveryId.make("delivery:1");
    const cases: ReadonlyArray<[WebhookTriggerResult, number, string]> = [
      [{ _tag: "accepted", deliveryId, outcome: "accepted" }, 202, "accepted"],
      // Same status as a started run; only the header tells them apart.
      [{ _tag: "accepted", deliveryId, outcome: "duplicate" }, 202, "duplicate"],
      [{ _tag: "accepted", deliveryId, outcome: "prompt_too_long" }, 202, "prompt_too_long"],
      [{ _tag: "not_found" }, 404, "not_found"],
      [{ _tag: "rejected_signature" }, 401, "rejected_signature"],
      [{ _tag: "disabled" }, 409, "disabled"],
      [{ _tag: "rate_limited", outcome: "rate_limited" }, 429, "rate_limited"],
      [{ _tag: "rate_limited", outcome: "queue_full" }, 429, "queue_full"],
      [{ _tag: "expired" }, 410, "expired"],
    ];
    for (const [result, status, outcome] of cases) {
      const { handler, dispose } = handlerFor(() => Effect.succeed(result));
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(status);
        expect(response.headers.get("x-t3-hook-outcome")).toBe(outcome);
      } finally {
        await dispose();
      }
    }
  });

  // Live clock: the server checks proofs against real time.
  it.live("joins the relay's trace only for requests the relay forwarded", () =>
    Effect.gen(function* () {
      const parents: Array<string | undefined> = [];
      const { handler, dispose } = handlerFor(() =>
        Effect.gen(function* () {
          const span = yield* Effect.currentParentSpan.pipe(Effect.option);
          parents.push(span._tag === "Some" ? span.value.traceId : undefined);
          return { _tag: "not_found" } as const;
        }),
      );
      const send = (headers: Record<string, string>) =>
        Effect.promise(() => handler(post("/api/hooks/id/tok", "{}", headers)));
      const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
      const receivedAt = "2026-10-04T10:00:00.000Z";
      const relayHeaders = {
        "x-t3-relay-delivery-id": "relay-1",
        "x-t3-relay-received-at": receivedAt,
      };
      const proof = yield* relayProof({ deliveryId: "relay-1", receivedAt, hookId: "id" });
      yield* send({ ...relayHeaders, traceparent, "x-t3-relay-delivery": proof });
      // Claiming to be the relay without its proof cannot attach to our traces.
      yield* send({ ...relayHeaders, traceparent });
      yield* send({ traceparent });
      yield* Effect.promise(() => dispose());
      expect(parents).toEqual(["0af7651916cd43dd8448eb211c80319c", undefined, undefined]);
    }),
  );

  it("rejects oversized bodies and malformed paths before reaching the service", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(() => {
      calls += 1;
      return Effect.succeed({ _tag: "not_found" });
    });
    try {
      const big = new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1);
      expect((await handler(post("/api/hooks/id/tok", big))).status).toBe(413);
      expect((await handler(post("/api/hooks/id", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/id/tok/extra", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/%E0/tok", "{}"))).status).toBe(404);
      // No content-length: the reader cap must still apply.
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent <= WEBHOOK_MAX_BODY_BYTES; sent += 64 * 1024) {
            controller.enqueue(new Uint8Array(64 * 1024));
          }
          controller.close();
        },
      });
      const streamed = await handler(
        new Request("http://env.local/api/hooks/id/tok", {
          method: "POST",
          body: chunked,
          // Node's fetch needs duplex for streamed bodies.
          duplex: "half",
        }),
      );
      expect(streamed.status).toBe(413);
      expect(calls).toBe(0);
    } finally {
      await dispose();
    }
  });

  it("hides service failures and defects behind a fixed 500", async () => {
    const failures = [
      Effect.fail(new ScheduledTaskError({ message: "database locked" })),
      Effect.die(new Error("database exploded")),
    ];
    for (const failure of failures) {
      const { handler, dispose } = handlerFor(() => failure);
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal_error" });
      } finally {
        await dispose();
      }
    }
  });
});
