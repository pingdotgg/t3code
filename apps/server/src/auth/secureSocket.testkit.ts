import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { AuthSessionId, EnvironmentId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import { SecureChannelError, type SecureChannelIdentity } from "@t3tools/shared/secureChannel";
import { makeSecureClientSocket } from "@t3tools/shared/secureChannelSocket";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as EnvironmentAuth from "./EnvironmentAuth.ts";

const ENVIRONMENT_ID = EnvironmentId.make("secure-socket-test");

/** What `upgradeMediaSocket` reads; a fixture without `identity` cannot run the handshake. */
export const layerMediaSocketTest = (
  identity: Effect.Effect<SecureChannelIdentity, SecureChannelError> = Effect.die(
    "This fixture has no environment key.",
  ),
) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
    }),
    Layer.mock(EnvironmentSigningKey)({ publicKey: "", secureChannelIdentity: identity }),
  );

/** A client DPoP key and the environment key, and the client's end of the channel. */
export const makeSecureSocketKeys = Effect.gen(function* () {
  const signature = yield* Signature.Signature;
  const identityOf = Effect.fnUntraced(function* (algorithm: Signature.Algorithm) {
    const pair = yield* signature.generateKeyPair(algorithm);
    const identity: SecureChannelIdentity = {
      publicKey: yield* Signature.toBytes(pair.publicKey),
      sign: (message) =>
        signature
          .sign(pair.privateKey, message)
          .pipe(
            Effect.mapError((cause) => new SecureChannelError({ reason: "crypto_failure", cause })),
          ),
    };
    return { identity, publicKey: pair.publicKey };
  }, Effect.orDie);
  const client = yield* identityOf(Signature.ecdsaP256);
  const environment = yield* identityOf(Signature.ed25519);
  const session = (
    scopes: ReadonlyArray<AuthEnvironmentScope>,
  ): EnvironmentAuth.AuthenticatedSession => ({
    sessionId: AuthSessionId.make("secure-socket-test"),
    subject: "secure-socket-test",
    method: "dpop-access-token",
    scopes,
    proofKeyThumbprint: computeDpopJwkThumbprint({
      kty: "EC",
      crv: "P-256",
      x: Base64Url.encode(client.identity.publicKey.subarray(1, 33)),
      y: Base64Url.encode(client.identity.publicKey.subarray(33)),
    }),
    secureChannel: true,
  });
  const connect = (url: string) =>
    Socket.makeWebSocket(url).pipe(
      Effect.flatMap((socket) =>
        makeSecureClientSocket(socket, {
          context: new TextEncoder().encode(ENVIRONMENT_ID),
          identity: client.identity,
          verifyPeer: (input) =>
            signature
              .verify(environment.publicKey, input.signature, input.message)
              .pipe(Effect.orElseSucceed(() => false)),
        }),
      ),
      Effect.provide(NodeWS.layerWebSocketConstructor),
    );
  return { environment: environment.identity, session, connect };
});
