import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { RelayConfiguration } from "../Config.ts";
import { FcmClient, layer } from "./FcmClient.ts";

import * as WebCrypto from "../WebCrypto.ts";
import * as FcmAssertionSigner from "./FcmAssertionSigner.ts";

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const account = {
  project_id: "test-project",
  client_email: "push@test-project.iam.gserviceaccount.com",
  private_key: privateKey,
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const config = {
  relayIssuer: "https://relay.test",
  apns: {
    environment: "sandbox",
    teamId: "team",
    keyId: "key",
    bundleId: "app",
    privateKey: Redacted.make("unused"),
  },
  fcmServiceAccount: Redacted.make(encodeJson(account)),
  clerkSecretKey: Redacted.make("unused"),
  clerkPublishableKey: "unused",
  clerkJwtAudience: "unused",
  apnsDeliveryJobSigningSecret: Redacted.make("unused"),
  cloudMintPrivateKey: Redacted.make("unused"),
  cloudMintPublicKey: "unused",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
} satisfies RelayConfiguration["Service"];
const input = {
  token: "device-token",
  packageName: "com.t3tools.t3code.dev",
  data: { t3_kind: "agent_activity", active: "true" },
  alert: false,
};

function testLayer(requests: HttpClientRequest.HttpClientRequest[], responses: Response[]) {
  const http = HttpClient.make((request) => {
    requests.push(request);
    const response = responses.shift();
    return response
      ? Effect.succeed(HttpClientResponse.fromWeb(request, response))
      : Effect.die("unexpected request");
  });
  return layer.pipe(
    Layer.provide(
      FcmAssertionSigner.layer.pipe(
        Layer.provide(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayConfiguration, config),
        Layer.succeed(HttpClient.HttpClient, http),
      ),
    ),
  );
}

describe("FCM delivery", () => {
  it.effect.each([
    { operation: "authorize", stage: "headers", status: null },
    { operation: "authorize", stage: "body", status: 200 },
    { operation: "send", stage: "headers", status: null },
    { operation: "send", stage: "body", status: 503 },
  ] as const)("bounds a stalled $operation $stage and allows the next delivery", (scenario) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let shouldStall = true;
      const http = HttpClient.make((request) => {
        const isAuthorization = request.url === "https://oauth2.googleapis.com/token";
        const stall = shouldStall && isAuthorization === (scenario.operation === "authorize");
        const response = HttpClientResponse.fromWeb(
          request,
          isAuthorization
            ? Response.json({ access_token: "access-token" })
            : Response.json({}, { status: stall ? 503 : 200 }),
        );
        if (stall) {
          shouldStall = false;
          const stalled = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
          if (scenario.stage === "headers") return stalled;
          Object.defineProperty(response, "json", { value: stalled });
        }
        return Effect.succeed(response);
      });
      yield* Effect.gen(function* () {
        const client = yield* FcmClient;
        const delivery = yield* client.send(input).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(delivery)).toMatchObject({
          _tag: "FcmClientError",
          operation: scenario.operation,
          status: scenario.status,
          cause: expect.objectContaining({ _tag: "TimeoutError" }),
        });
        expect(yield* client.send(input)).toEqual({ unregistered: false });
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              FcmAssertionSigner.layer.pipe(
                Layer.provide(
                  Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle }),
                ),
              ),
            ),
            Layer.provide(Layer.succeed(RelayConfiguration, config)),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          ),
        ),
      );
    }),
  );

  it.effect("signs a verifiable Google OAuth assertion scoped to messaging", () =>
    Effect.gen(function* () {
      const signer = yield* FcmAssertionSigner.FcmAssertionSigner;
      const assertion = yield* signer.sign({
        privateKey: account.private_key,
        clientEmail: account.client_email,
        issuedAt: 1000,
      });
      const [header, claims, signature] = assertion.split(".");
      expect(
        NodeCrypto.verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature!, "base64url"),
        ),
      ).toBe(true);
      expect(decodeJson(Buffer.from(claims!, "base64url").toString())).toEqual({
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: 1000,
        exp: 4600,
      });
    }).pipe(
      Effect.provide(
        FcmAssertionSigner.layer.pipe(
          Layer.provide(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
        ),
      ),
    ),
  );

  it.effect(
    "reuses OAuth authorization and sends native data messages to the correct package",
    () => {
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      return Effect.gen(function* () {
        const client = yield* FcmClient;
        yield* client.send(input);
        yield* client.send({ ...input, alert: true });
        expect(requests.map((request) => request.url)).toEqual([
          "https://oauth2.googleapis.com/token",
          "https://fcm.googleapis.com/v1/projects/test-project/messages:send",
          "https://fcm.googleapis.com/v1/projects/test-project/messages:send",
        ]);
        expect(requests[1]!.headers.authorization).toBe("Bearer access-token");
        const body = requests[1]!.body;
        if (body._tag !== "Uint8Array") throw new Error("Expected encoded FCM body");
        expect(decodeJson(new TextDecoder().decode(body.body))).toEqual({
          message: {
            token: input.token,
            data: input.data,
            android: {
              priority: "HIGH",
              ttl: "300s",
              collapse_key: "t3-agent-activity",
              restricted_package_name: input.packageName,
            },
          },
        });
      }).pipe(
        Effect.provide(
          testLayer(requests, [
            Response.json({ access_token: "access-token" }),
            Response.json({ name: "one" }),
            Response.json({ name: "two" }),
          ]),
        ),
      );
    },
  );

  it.effect("invalidates authorization after 401 and recognizes unregistered device tokens", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    return Effect.gen(function* () {
      const client = yield* FcmClient;
      const first = yield* client.send(input).pipe(Effect.flip);
      expect(first.status).toBe(401);
      expect(yield* client.send(input)).toEqual({ unregistered: true });
      expect(requests[2]!.url).toBe("https://oauth2.googleapis.com/token");
      expect(requests[3]!.headers.authorization).toBe("Bearer fresh-token");
    }).pipe(
      Effect.provide(
        testLayer(requests, [
          Response.json({ access_token: "old-token" }),
          Response.json({}, { status: 401 }),
          Response.json({ access_token: "fresh-token" }),
          Response.json(
            {
              error: {
                details: [
                  {
                    "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                    errorCode: "UNREGISTERED",
                  },
                ],
              },
            },
            { status: 404 },
          ),
        ]),
      ),
    );
  });
  it.effect("rejects oversized data before contacting Firebase", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    return Effect.gen(function* () {
      const client = yield* FcmClient;
      const error = yield* client
        .send({ ...input, data: { body: "漢".repeat(1500) } })
        .pipe(Effect.flip);
      expect(error.operation).toBe("send");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(testLayer(requests, [])));
  });
});
