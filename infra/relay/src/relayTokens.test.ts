import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vitest";
import { signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as Settings from "./settings.ts";
import {
  issueDpopAccessToken,
  issueLinkChallengeToken,
  resolveDpopAccessTokenScopes,
  verifyDpopAccessToken,
  verifyLinkChallengeToken,
} from "./relayTokens.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const settings = Settings.Settings.of({
  relayIssuer: "https://relay.example.test/",
  apns: {
    environment: "sandbox",
    teamId: Redacted.make("team-id"),
    keyId: Redacted.make("key-id"),
    privateKey: Redacted.make("private-key"),
    bundleId: Redacted.make("com.t3tools.t3code.dev"),
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: Redacted.make(keyPair.publicKey),
  managedEndpointBaseDomain: undefined,
  cloudflareAccountId: undefined,
  cloudflareZoneId: undefined,
  cloudflareApiToken: undefined,
});

describe("relay tokens", () => {
  it("issues a user-bound environment link challenge", async () => {
    const token = await Effect.runPromise(
      issueLinkChallengeToken({
        settings,
        userId: "user_123",
        request: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        },
        jti: "challenge-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 200,
      }),
    );

    expect(
      await Effect.runPromise(
        verifyLinkChallengeToken({
          settings,
          token,
          userId: "user_123",
          request: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled: true,
          },
          nowEpochSeconds: 150,
        }),
      ),
    ).toMatchObject({ sub: "user_123", jti: "challenge-1" });
    expect(
      await Effect.runPromise(
        verifyLinkChallengeToken({
          settings,
          token,
          userId: "attacker",
          request: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled: true,
          },
          nowEpochSeconds: 150,
        }),
      ),
    ).toBeNull();
  });

  it("issues and verifies DPoP access tokens bound to one proof-key thumbprint", async () => {
    const token = await Effect.runPromise(
      issueDpopAccessToken({
        settings,
        userId: "user_123",
        proofKeyThumbprint: "proof-key-thumbprint",
        jti: "access-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 200,
        clientId: "t3-mobile",
        scopes: ["environment:connect", "environment:status", "mobile:registration"],
      }),
    );

    expect(
      await Effect.runPromise(verifyDpopAccessToken({ settings, token, nowEpochSeconds: 150 })),
    ).toMatchObject({
      sub: "user_123",
      cnf: { jkt: "proof-key-thumbprint" },
      client_id: "t3-mobile",
      scope: ["environment:connect", "environment:status", "mobile:registration"],
    });
    expect(
      await Effect.runPromise(verifyDpopAccessToken({ settings, token, nowEpochSeconds: 261 })),
    ).toBeNull();
  });

  it("issues tunnel-only DPoP access tokens to web public clients", async () => {
    const token = await Effect.runPromise(
      issueDpopAccessToken({
        settings,
        userId: "user_123",
        proofKeyThumbprint: "web-proof-key-thumbprint",
        jti: "web-access-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 200,
        clientId: "t3-web",
        scopes: ["environment:connect", "environment:status"],
      }),
    );

    expect(
      await Effect.runPromise(verifyDpopAccessToken({ settings, token, nowEpochSeconds: 150 })),
    ).toMatchObject({
      client_id: "t3-web",
      scope: ["environment:connect", "environment:status"],
      cnf: { jkt: "web-proof-key-thumbprint" },
    });
  });

  it("treats requested scope as an order-independent set", () => {
    expect(
      resolveDpopAccessTokenScopes({
        clientId: "t3-mobile",
        scope: "environment:status environment:connect environment:status",
      }),
    ).toEqual(["environment:status", "environment:connect"]);
  });

  it("rejects signed DPoP tokens whose scope is outside the relay policy", async () => {
    const token = await Effect.runPromise(
      signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "t3-relay-dpop-access+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          jti: "access-token-invalid-scope",
          iat: 100,
          exp: 200,
          client_id: "t3-mobile",
          scope: "environment:admin",
          cnf: { jkt: "proof-key-thumbprint" },
        },
      }),
    );

    expect(
      await Effect.runPromise(verifyDpopAccessToken({ settings, token, nowEpochSeconds: 150 })),
    ).toBeNull();
  });

  it("rejects mobile registration scope on a web public client token", async () => {
    const token = await Effect.runPromise(
      signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "t3-relay-dpop-access+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          jti: "web-token-invalid-mobile-scope",
          iat: 100,
          exp: 200,
          client_id: "t3-web",
          scope: "environment:connect mobile:registration",
          cnf: { jkt: "proof-key-thumbprint" },
        },
      }),
    );

    expect(
      await Effect.runPromise(verifyDpopAccessToken({ settings, token, nowEpochSeconds: 150 })),
    ).toBeNull();
  });
});
