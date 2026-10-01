import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ScheduledTaskError } from "@t3tools/contracts";
import type {
  RelayCloudWebhookDeliveryProofPayload,
  RelayCloudWebhookDeliveryRequest,
  RelayWebhookDelivery,
} from "@t3tools/contracts/relay";
import { RELAY_WEBHOOK_DELIVERY_REQUEST_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import { sha256StableJson } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import { CLOUD_LINKED_USER_ID, CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "./config.ts";
import { cloudWebhookDeliveryHandler } from "./http.ts";

const relayKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const environmentId = EnvironmentId.make("env-webhook-test");

function memorySecretStore(initial: Record<string, string>) {
  const values = new Map<string, Uint8Array<ArrayBuffer>>(
    Object.entries(initial).map(([name, value]) => [name, new TextEncoder().encode(value)]),
  );
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, new Uint8Array(value))),
    create: (name, value) =>
      values.has(name)
        ? Effect.fail(
            new ServerSecretStore.SecretStorePersistError({
              resource: name,
              cause: PlatformError.systemError({
                _tag: "AlreadyExists",
                module: "FileSystem",
                method: "open",
                pathOrDescriptor: name,
              }),
            }),
          )
        : Effect.sync(() => void values.set(name, new Uint8Array(value))),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
}

const delivery: RelayWebhookDelivery = {
  deliveryId: "delivery-1",
  inboxId: "inbox-1",
  receivedAt: "2026-10-01T10:00:00.000Z",
  headers: { "content-type": "application/json" },
  body: '{"action":"created"}',
};

const signedRequest = (signed: RelayWebhookDelivery, sent: RelayWebhookDelivery = signed) =>
  Effect.gen(function* () {
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const payload = {
      iss: "https://relay.example.test",
      aud: `t3-env:${environmentId}`,
      sub: "user_123",
      jti: NodeCrypto.randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + 120,
      environmentId,
      nonce: NodeCrypto.randomUUID(),
      scope: ["environment:webhook"],
      deliveryId: signed.deliveryId,
      deliveryDigest: yield* Effect.promise(() => sha256StableJson(signed)),
    } satisfies RelayCloudWebhookDeliveryProofPayload;
    const proof = yield* signRelayJwt({
      privateKey: relayKeys.privateKey,
      typ: RELAY_WEBHOOK_DELIVERY_REQUEST_TYP,
      payload,
    });
    return { proof, delivery: sent } satisfies RelayCloudWebhookDeliveryRequest;
  });

const harness = (
  accept: ScheduledTasks.ScheduledTaskService["Service"]["acceptWebhookDelivery"],
) => {
  const accepted: Array<string> = [];
  const dependencies = {
    secrets: memorySecretStore({
      [CLOUD_MINT_PUBLIC_KEY]: relayKeys.publicKey,
      [RELAY_ISSUER_SECRET]: "https://relay.example.test",
      [CLOUD_LINKED_USER_ID]: "user_123",
    }),
    environment: ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused"),
    }),
  } as unknown as Parameters<typeof cloudWebhookDeliveryHandler>[0];
  const scheduledTasks = {
    acceptWebhookDelivery: (input: RelayWebhookDelivery) =>
      Effect.sync(() => void accepted.push(input.deliveryId)).pipe(Effect.andThen(accept(input))),
  } as unknown as ScheduledTasks.ScheduledTaskService["Service"];
  const handle = (request: RelayCloudWebhookDeliveryRequest) =>
    cloudWebhookDeliveryHandler(dependencies, scheduledTasks, request).pipe(
      Effect.provide(NodeCryptoLayer.layer),
    );
  return { accepted, handle };
};

describe("cloud webhook delivery", () => {
  it.effect("accepts a relay-signed delivery once and answers with a signed ack", () =>
    Effect.gen(function* () {
      const { accepted, handle } = harness(() => Effect.succeed("started"));
      const request = yield* signedRequest(delivery);

      const response = yield* handle(request);
      expect(response.deliveryId).toBe("delivery-1");
      expect(response.proof.split(".")).toHaveLength(3);
      expect(accepted).toEqual(["delivery-1"]);

      const replay = yield* Effect.flip(handle(request));
      expect(replay._tag).toBe("EnvironmentHttpConflictError");
      expect(accepted).toEqual(["delivery-1"]);
    }),
  );

  it.effect("rejects a delivery whose body differs from what the relay signed", () =>
    Effect.gen(function* () {
      const { accepted, handle } = harness(() => Effect.succeed("started"));
      const request = yield* signedRequest(delivery, { ...delivery, body: '{"action":"other"}' });

      const error = yield* Effect.flip(handle(request));
      expect(error._tag).toBe("EnvironmentHttpUnauthorizedError");
      expect(accepted).toEqual([]);
    }),
  );

  it.effect("answers a busy task with a conflict so the relay retries", () =>
    Effect.gen(function* () {
      const { handle } = harness(() =>
        Effect.fail(new ScheduledTaskError({ message: "Schedule task is already running." })),
      );
      const error = yield* Effect.flip(handle(yield* signedRequest(delivery)));
      expect(error).toMatchObject({
        _tag: "EnvironmentHttpConflictError",
        message: "Schedule task is already running.",
      });
    }),
  );
});
