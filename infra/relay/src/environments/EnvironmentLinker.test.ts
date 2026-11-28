// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";
import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
} from "@t3tools/contracts/relay";
import { RELAY_LINK_PROOF_TYP } from "@t3tools/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as CloudMintSigner from "../auth/CloudMintSigner.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinker from "./EnvironmentLinker.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

const relayKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const environmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(relayKeyPair.privateKey),
  cloudMintPublicKey: relayKeyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const isEnvironmentLinkProofInvalid = Schema.is(EnvironmentLinker.EnvironmentLinkProofInvalid);

function signTestJwt(payload: object, typ: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const makeRequest = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const relayTokens = yield* RelayTokens.RelayTokens;
  const challenge = yield* relayTokens.issueLinkChallenge({
    userId: "user_123",
    request: {
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: true,
    },
    jti: "challenge-jti",
    issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
    expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
  });
  const payload = {
    iss: "t3-env:env-link-test",
    aud: "https://relay.example.test",
    sub: "env-link-test",
    jti: "link-proof-jti",
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    challenge,
    environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
    descriptor: {
      environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
      label: "Link Test Environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    environmentPublicKey: environmentKeyPair.publicKey.trim(),
    endpoint: {
      httpBaseUrl: "https://env.example.test/",
      wsBaseUrl: "wss://env.example.test/",
      providerKind: "manual",
    },
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
    scopes: ["agent_activity_notifications", "managed_tunnels"],
  } satisfies RelayEnvironmentLinkProofPayload;
  return {
    request: {
      proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: false,
    } satisfies RelayEnvironmentLinkRequest,
    payload,
  };
});

function layerTest(input?: {
  readonly upsert?: EnvironmentLinks.EnvironmentLinks["Service"]["upsert"];
  readonly getForUser?: EnvironmentLinks.EnvironmentLinks["Service"]["getForUser"];
  readonly prepareDeprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["prepareDeprovision"];
  readonly consume?: DpopProofs.DpopProofReplay["Service"]["consume"];
  readonly deprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["deprovision"];
}) {
  return EnvironmentLinker.layer.pipe(
    Layer.provideMerge(RelayTokens.layer.pipe(Layer.provide(CloudMintSigner.layer))),
    Layer.provide(
      Layer.mergeAll(
        RelayConfiguration.layer(config),
        Layer.succeed(RelayDb.RelayTransactions, { withTransaction: (effect) => effect }),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verifyAndConsume: () => Effect.die("unexpected DPoP proof verification"),
          consume: input?.consume ?? (() => Effect.succeed(true)),
          pruneExpired: Effect.void,
        }),
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, {
          upsert: input?.upsert ?? (() => Effect.void),
          listDeliveryUsersForEnvironment: () => Effect.succeed([]),
          listForUser: () => Effect.succeed([]),
          getForUser: input?.getForUser ?? (() => Effect.succeed(null)),
          findActiveManagedForEnvironment: () => Effect.succeed([]),
          updateLiveActivityPreference: () =>
            Effect.die("unexpected Live Activity preference update"),
          setHoldWebhooksWhileOffline: () => Effect.void,
          revokeForUser: () => Effect.succeed(false),
          pruneRevoked: Effect.succeed(0),
        }),
        Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, {
          create: () => Effect.succeed("t3env_credential_secret"),
          authenticate: () => Effect.succeedNone,
          revokeForEnvironmentPublicKey: () => Effect.succeed(false),
          pruneRevoked: Effect.succeed(0),
        }),
        Layer.succeed(ManagedEndpointProvider.ManagedEndpointProvider, {
          reconcileOrigin: () => Effect.succeed("ready"),
          prepareDeprovision: input?.prepareDeprovision ?? (() => Effect.succeed(null)),
          deprovision: input?.deprovision ?? (() => Effect.succeed(true)),
          release: () => Effect.succeed(true),
          provision: () =>
            Effect.succeed({
              endpoint: {
                httpBaseUrl: "https://managed.example.test/",
                wsBaseUrl: "wss://managed.example.test/ws",
                providerKind: "cloudflare_tunnel",
              },
              runtime: { providerKind: "cloudflare_tunnel", connectorToken: "connector-token" },
            }),
        }),
      ),
    ),
    Layer.provideMerge(EffectNodeCrypto.layerSignature),
  );
}

describe("EnvironmentLinker", () => {
  it.effect("uses verified JWT claims when linking an environment", () => {
    let persistedEnvironmentId: string | null = null;
    return Effect.gen(function* () {
      const { request, payload } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({ userId: "user_123", request });
      expect(result.environmentId).toBe(payload.environmentId);
      expect(result.environmentCredential).toBe("t3env_credential_secret");
      expect(persistedEnvironmentId).toBe(payload.environmentId);
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: (input) =>
            Effect.sync(() => {
              persistedEnvironmentId = input.proof.environmentId;
            }),
        }),
      ),
    );
  });

  it.effect("links a publish-only environment with a non-secure nominal endpoint", () => {
    let persistedEndpoint: string | null = null;
    let deprovisionedEnvironmentId: string | null = null;
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { minutes: 5 });
      const relayTokens = yield* RelayTokens.RelayTokens;
      const challenge = yield* relayTokens.issueLinkChallenge({
        userId: "user_123",
        request: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: false,
        },
        jti: "publish-only-challenge-jti",
        issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
      });
      const payload = {
        iss: "t3-env:env-link-test",
        aud: "https://relay.example.test",
        sub: "env-link-test",
        jti: "publish-only-proof-jti",
        iat: Math.floor(now.epochMilliseconds / 1_000),
        exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
        challenge,
        environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
        descriptor: {
          environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
          label: "Link Test Environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        environmentPublicKey: environmentKeyPair.publicKey.trim(),
        endpoint: {
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          providerKind: "manual",
        },
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        scopes: ["agent_activity_notifications"],
      } satisfies RelayEnvironmentLinkProofPayload;
      const request = {
        proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: false,
      } satisfies RelayEnvironmentLinkRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({ userId: "user_123", request });
      expect(result.environmentCredential).toBe("t3env_credential_secret");
      expect(result.endpointRuntime).toBeNull();
      expect(persistedEndpoint).toBe("http://127.0.0.1:3773/");
      expect(deprovisionedEnvironmentId).toBe("env-link-test");
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: (input) =>
            Effect.sync(() => {
              persistedEndpoint = input.endpoint.httpBaseUrl;
            }),
          deprovision: (input) =>
            Effect.sync(() => {
              deprovisionedEnvironmentId = input.environmentId;
              return true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects a tampered compact proof before persistence", () => {
    let persisted = false;
    return Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const segments = request.proof.split(".");
      const signature = segments[2]!;
      segments[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
      const tampered = { ...request, proof: segments.join(".") };
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request: tampered }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkProofInvalid(result.failure)).toBe(true);
        if (isEnvironmentLinkProofInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            userId: "user_123",
            environmentId: "env-link-test",
            reason: "invalid_signature_or_scope",
            stage: "verify_proof",
            cause: { _tag: "RelayJwtError" },
          });
        }
      }
      expect(persisted).toBe(false);
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: () =>
            Effect.sync(() => {
              persisted = true;
            }),
        }),
      ),
    );
  });

  it.effect("refuses to move an active link to a different environment key", () => {
    const touched: Array<string> = [];
    const activeLink = (environmentPublicKey: string) => ({
      environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
      label: "Link Test Environment",
      endpoint: {
        httpBaseUrl: "https://managed.example.test/",
        wsBaseUrl: "wss://managed.example.test/ws",
        providerKind: "cloudflare_tunnel" as const,
      },
      environmentPublicKey,
      linkedAt: "2026-01-01T00:00:00.000Z",
    });
    let linkedKey = "another-environment-key";
    return Effect.gen(function* () {
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const refused = yield* linker
        .link({ userId: "user_123", request: (yield* makeRequest).request })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "EnvironmentLinkProofInvalid",
        reason: "environment_key_mismatch",
      });
      expect(touched).toEqual([]);

      linkedKey = environmentKeyPair.publicKey.trim();
      yield* linker.link({ userId: "user_123", request: (yield* makeRequest).request });
      expect(touched).toEqual(["deprovision", "upsert"]);
    }).pipe(
      Effect.provide(
        layerTest({
          getForUser: () => Effect.succeed(activeLink(linkedKey)),
          upsert: () => Effect.sync(() => void touched.push("upsert")),
          deprovision: () => Effect.sync(() => touched.push("deprovision") > 0),
        }),
      ),
    );
  });

  it.effect.each([{ managedTunnelsEnabled: true }, { managedTunnelsEnabled: false }])(
    "finishes a failed unlink teardown before a new link: %o",
    ({ managedTunnelsEnabled }) => {
      const touched: Array<string> = [];
      let tornDown = false;
      return Effect.gen(function* () {
        const linker = yield* EnvironmentLinker.EnvironmentLinker;
        const link = Effect.gen(function* () {
          const { request } = yield* makeRequest;
          return yield* linker.link({
            userId: "user_123",
            request: { ...request, managedTunnelsEnabled },
          });
        });
        expect((yield* link.pipe(Effect.flip))._tag).toBe("ManagedEndpointDeprovisioningFailed");
        expect(touched).toEqual(["deprovision"]);

        tornDown = true;
        yield* link;
        expect(touched).toEqual(["deprovision", "deprovision", "upsert"]);
      }).pipe(
        Effect.provide(
          layerTest({
            prepareDeprovision: () =>
              Effect.succeed({
                userId: "user_123",
                environmentId: "env-link-test",
                hostname: "managed.example.test",
                tunnelId: "left-behind-tunnel",
                tunnelName: "left-behind",
                dnsRecordId: null,
                readyAt: null,
                origin: null,
                updatedAt: "2026-01-01T00:00:00.000Z",
                generation: 1,
                tunnelReleasedAt: null,
              }),
            deprovision: () => Effect.sync(() => touched.push("deprovision") > 0 && tornDown),
            upsert: () => Effect.sync(() => void touched.push("upsert")),
          }),
        ),
      );
    },
  );

  it.effect("rejects replayed JWT ids", () =>
    Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkProofInvalid(result.failure)).toBe(true);
        if (isEnvironmentLinkProofInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            userId: "user_123",
            environmentId: "env-link-test",
            reason: "replayed_nonce",
            stage: "consume_proof_nonce",
          });
        }
      }
    }).pipe(Effect.provide(layerTest({ consume: () => Effect.succeed(false) }))),
  );
});
