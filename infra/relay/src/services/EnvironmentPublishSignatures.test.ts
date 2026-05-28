import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityPublishRequest,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { RELAY_ACTIVITY_PUBLISH_TYP } from "@t3tools/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import * as DpopProofs from "../persistence/DpopProofs.ts";
import * as Settings from "../settings.ts";
import * as EnvironmentPublishSignatures from "./EnvironmentPublishSignatures.ts";
import { environmentPublishReplayThumbprint } from "./EnvironmentPublishSignatures.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const settings = Settings.Settings.of({
  relayIssuer: "https://relay.example.test",
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
const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-05-25T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};

function signTestJwt(payload: object, privateKey: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_ACTIVITY_PUBLISH_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const freshRequest = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const payload = {
    iss: "t3-env:env",
    aud: "https://relay.example.test",
    sub: "env",
    jti: "publish-jti",
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.add(now, { minutes: 5 }).epochMilliseconds / 1_000),
    environmentId: state.environmentId,
    threadId: state.threadId,
    state,
  } satisfies RelayAgentActivityPublishProofPayload;
  return {
    state,
    proof: signTestJwt(payload, keyPair.privateKey),
  } satisfies RelayAgentActivityPublishRequest;
});

function layer(replay?: Partial<DpopProofs.DpopProofReplayShape>) {
  return EnvironmentPublishSignatures.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(Settings.Settings, settings),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          consume: () => Effect.succeed(true),
          ...replay,
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("EnvironmentPublishSignatures", () => {
  it.effect("verifies activity JWTs and scopes replay storage to the environment key", () => {
    let replayThumbprint: string | null = null;
    return Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      yield* signatures.verify({
        environmentId: state.environmentId,
        environmentPublicKey: keyPair.publicKey,
        threadId: state.threadId,
        request,
      });
      expect(replayThumbprint).toBe(
        yield* environmentPublishReplayThumbprint({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
        }),
      );
    }).pipe(
      Effect.provide(
        layer({
          consume: (input) =>
            Effect.sync(() => {
              replayThumbprint = input.thumbprint;
              return true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects top-level state tampering", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request: { ...request, state: { ...state, headline: "Tampered" } },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects replayed activity JWT ids", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(Effect.provide(layer({ consume: () => Effect.succeed(false) }))),
  );
});
