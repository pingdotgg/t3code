import { importRelayPrivateKey, RelayJwtError, signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
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

const KEY_PAIR_RESOURCE = "environment signing key pair";

const keyPairDecodeError = (cause: unknown): ServerSecretStore.SecretStoreDecodeError =>
  new ServerSecretStore.SecretStoreDecodeError({ resource: KEY_PAIR_RESOURCE, cause });

const keyPairEncodeError = (cause: unknown): ServerSecretStore.SecretStoreEncodeError =>
  new ServerSecretStore.SecretStoreEncodeError({ resource: KEY_PAIR_RESOURCE, cause });

const keyPairConcurrentReadError = (): ServerSecretStore.SecretStoreConcurrentReadError =>
  new ServerSecretStore.SecretStoreConcurrentReadError({ resource: KEY_PAIR_RESOURCE });

const readEnvironmentKeyPair = Effect.fn("readEnvironmentKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const encoded = yield* secrets.get(CLOUD_LINK_KEY_PAIR);
  if (Option.isNone(encoded)) {
    return Option.none<EnvironmentKeyPair>();
  }
  const decoded = yield* decodeEnvironmentKeyPair(bytesToString(encoded.value)).pipe(
    Effect.mapError(keyPairDecodeError),
  );
  return Option.some(decoded);
});

const persistEnvironmentKeyPair = Effect.fn("persistEnvironmentKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  keyPair: EnvironmentKeyPair,
) {
  const encoded = yield* encodeEnvironmentKeyPair(keyPair).pipe(
    Effect.mapError(keyPairEncodeError),
  );
  return yield* secrets.create(CLOUD_LINK_KEY_PAIR, stringToBytes(encoded)).pipe(
    Effect.as(keyPair),
    Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
      ServerSecretStore.isSecretAlreadyExistsError(error)
        ? readEnvironmentKeyPair(secrets).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => Effect.fail(keyPairConcurrentReadError()),
              }),
            ),
          )
        : Effect.fail(error),
    ),
  );
});

export const getOrCreateEnvironmentKeyPairFromSecretStore = Effect.fn(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
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

  const keyPair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" }).pipe(
    Effect.flatMap((pair) =>
      Effect.all({
        privateKey: Jwk.importPrivate(pair.privateKey, "EdDSA").pipe(
          Effect.flatMap((key) => Jwk.exportPkcs8(key, { format: "pem" })),
          Effect.map(Redacted.value),
        ),
        publicKey: Jwk.importPublic(pair.publicKey, "EdDSA").pipe(
          Effect.flatMap((key) => Jwk.exportSpki(key, { format: "pem" })),
        ),
      }),
    ),
    Effect.orDie,
  );
  return yield* persistEnvironmentKeyPair(secrets, keyPair);
});

/** The environment's Ed25519 relay signing key, loaded at startup and parsed on first use. */
export class EnvironmentSigningKey extends Context.Service<
  EnvironmentSigningKey,
  {
    /** SPKI PEM, as relays and linked clients receive it. */
    readonly publicKey: string;
    readonly sign: (input: {
      readonly typ: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<string, RelayJwtError>;
  }
>()("t3/cloud/environmentKeys/EnvironmentSigningKey") {}

export const layer = Layer.effect(
  EnvironmentSigningKey,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const signature = yield* Signature.Signature;
    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
    // Parsed lazily so corrupt key material fails Connect operations, not server startup.
    let privateKey: Jwk.PrivateKey | undefined;
    return EnvironmentSigningKey.of({
      publicKey: keyPair.publicKey,
      sign: Effect.fn("EnvironmentSigningKey.sign")(function* (input) {
        if (privateKey === undefined) {
          privateKey = yield* importRelayPrivateKey(keyPair.privateKey).pipe(
            Effect.mapError(
              (cause) => new RelayJwtError({ operation: "sign", typ: input.typ, cause }),
            ),
          );
        }
        return yield* signRelayJwt({ ...input, privateKey }).pipe(
          Effect.provideService(Signature.Signature, signature),
        );
      }),
    });
  }),
);
