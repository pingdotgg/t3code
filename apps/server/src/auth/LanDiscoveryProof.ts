// @effect-diagnostics-next-line nodeBuiltinImport:off -- The session signature uses Node's HMAC implementation.
import * as NodeCrypto from "node:crypto";
import { lanDiscoveryProofMessage } from "@t3tools/contracts";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as PayloadSigner from "./PayloadSigner.ts";

export class LanDiscoveryProof extends Context.Service<
  LanDiscoveryProof,
  {
    readonly prove: (input: {
      readonly payload: string;
      readonly nonce: string;
      readonly address: string;
      readonly port: number;
    }) => Effect.Effect<string, SessionStore.SessionCredentialError>;
  }
>()("t3/auth/LanDiscoveryProof") {}

const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const secret = yield* secretStore.getOrCreateRandom(SessionStore.SIGNING_SECRET_NAME, 32);
  const signer = yield* PayloadSigner.fromSecret(secret);

  const prove = Effect.fn("LanDiscoveryProof.prove")(function* (input: {
    readonly payload: string;
    readonly nonce: string;
    readonly address: string;
    readonly port: number;
  }) {
    const address = input.address.startsWith("::ffff:")
      ? input.address.slice("::ffff:".length)
      : input.address;
    if (
      input.payload.length > 4096 ||
      !/^[A-Za-z0-9_-]+$/.test(input.payload) ||
      Buffer.from(input.payload, "base64url").toString("base64url") !== input.payload ||
      !/^[a-f0-9]{64}$/.test(input.nonce) ||
      NodeNet.isIP(address) !== 4 ||
      !Number.isInteger(input.port) ||
      input.port < 1 ||
      input.port > 65535
    ) {
      return yield* new SessionStore.MalformedSessionTokenError({});
    }
    const signature = yield* signer.sign(input.payload);
    const session = yield* sessions.verify(`${input.payload}.${signature}`);
    if (session.method !== "bearer-access-token" && session.method !== "dpop-access-token") {
      return yield* new SessionStore.MalformedSessionTokenError({});
    }
    return NodeCrypto.createHmac("sha256", Buffer.from(signature, "base64url"))
      .update(lanDiscoveryProofMessage(input.nonce, environmentId, address, input.port))
      .digest("base64url");
  });
  return LanDiscoveryProof.of({ prove });
});

export const layer = Layer.effect(LanDiscoveryProof, make);
