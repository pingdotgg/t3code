import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const CLOUD_LINK_KEY_PAIR = "cloud-link-ed25519-key-pair";
const CLOUD_LINK_PRIVATE_KEY = "cloud-link-ed25519-private-key";
const CLOUD_LINK_PUBLIC_KEY = "cloud-link-ed25519-public-key";

const EnvironmentKeyPair = Schema.Struct({
  privateKey: Schema.String,
  publicKey: Schema.String,
});
type EnvironmentKeyPair = typeof EnvironmentKeyPair.Type;

const EnvironmentKeyPairJson = Schema.fromJsonString(EnvironmentKeyPair);
const decodeEnvironmentKeyPair = Schema.decodeUnknownEffect(EnvironmentKeyPairJson);
const encodeEnvironmentKeyPair = Schema.encodeEffect(EnvironmentKeyPairJson);

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const keyPairPersistenceError = (message: string, cause?: unknown) =>
  new ServerSecretStore.SecretStoreError({ message, cause });

const readEnvironmentKeyPair = Effect.fn("readEnvironmentKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStoreShape,
) {
  const encoded = yield* secrets.get(CLOUD_LINK_KEY_PAIR);
  if (Option.isNone(encoded)) {
    return Option.none<EnvironmentKeyPair>();
  }
  const decoded = yield* decodeEnvironmentKeyPair(bytesToString(encoded.value)).pipe(
    Effect.mapError((cause) =>
      keyPairPersistenceError("Failed to decode environment signing key pair.", cause),
    ),
  );
  return Option.some(decoded);
});

const persistEnvironmentKeyPair = Effect.fn("persistEnvironmentKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStoreShape,
  keyPair: EnvironmentKeyPair,
) {
  const encoded = yield* encodeEnvironmentKeyPair(keyPair).pipe(
    Effect.mapError((cause) =>
      keyPairPersistenceError("Failed to encode environment signing key pair.", cause),
    ),
  );
  return yield* secrets.create(CLOUD_LINK_KEY_PAIR, stringToBytes(encoded)).pipe(
    Effect.as(keyPair),
    Effect.catchTag("SecretStoreError", (error) =>
      ServerSecretStore.isSecretAlreadyExistsError(error)
        ? readEnvironmentKeyPair(secrets).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  Effect.fail(
                    keyPairPersistenceError(
                      "Failed to read environment signing key pair after concurrent creation.",
                    ),
                  ),
              }),
            ),
          )
        : Effect.fail(error),
    ),
  );
});

export const getOrCreateEnvironmentKeyPairFromSecretStore = Effect.fn(function* (
  secrets: ServerSecretStore.ServerSecretStoreShape,
) {
  const existing = yield* readEnvironmentKeyPair(secrets);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const existingPrivate = yield* secrets.get(CLOUD_LINK_PRIVATE_KEY);
  const existingPublic = yield* secrets.get(CLOUD_LINK_PUBLIC_KEY);
  if (Option.isSome(existingPrivate) && Option.isSome(existingPublic)) {
    return yield* persistEnvironmentKeyPair(secrets, {
      privateKey: bytesToString(existingPrivate.value),
      publicKey: bytesToString(existingPublic.value),
    });
  }

  const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return yield* persistEnvironmentKeyPair(secrets, {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  });
});
