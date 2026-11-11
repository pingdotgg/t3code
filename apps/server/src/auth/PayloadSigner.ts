import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

import * as ServerSecretStore from "./ServerSecretStore.ts";

/** HMAC-SHA256 signatures over UTF-8 payloads, as unpadded base64url. */
export interface PayloadSigner<E = never> {
  readonly sign: (payload: string) => Effect.Effect<string, E>;
  readonly verify: (payload: string, signature: string) => Effect.Effect<boolean, E>;
}

const utf8 = (value: string) => new TextEncoder().encode(value);

const fromKey = <E>(mac: Mac.Mac["Service"], key: Effect.Effect<Mac.Key, E>): PayloadSigner<E> => ({
  sign: (payload) =>
    key.pipe(
      Effect.flatMap((loaded) => mac.sign(loaded, utf8(payload)).pipe(Effect.orDie)),
      Effect.map(Base64Url.encode),
    ),
  verify: (payload, signature) => {
    const tag = Base64Url.decode(signature);
    return Result.isFailure(tag)
      ? Effect.succeed(false)
      : key.pipe(
          Effect.flatMap((loaded) =>
            mac.verify(loaded, tag.success, utf8(payload)).pipe(Effect.orDie),
          ),
        );
  },
});

/** A signer for secret bytes the caller already holds. */
export const fromSecret = Effect.fn("PayloadSigner.fromSecret")(function* (secret: Uint8Array) {
  const mac = yield* Mac.Mac;
  const key = yield* Mac.key(Mac.hmacSha256, secret).pipe(Effect.orDie);
  return fromKey(mac, Effect.succeed(key));
});

/** A signer keyed by a named server secret, loaded on first use so store failures reach callers. */
export const make = Effect.fn("PayloadSigner.make")(function* (secretName: string) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const mac = yield* Mac.Mac;
  let key: Mac.Key | undefined;
  const loadKey = Effect.suspend(() =>
    key !== undefined
      ? Effect.succeed(key)
      : secrets.getOrCreateRandom(secretName, 32).pipe(
          Effect.flatMap((bytes) => Mac.key(Mac.hmacSha256, bytes).pipe(Effect.orDie)),
          Effect.tap((loaded) =>
            Effect.sync(() => {
              key = loaded;
            }),
          ),
        ),
  );
  return fromKey(mac, loadKey);
});
