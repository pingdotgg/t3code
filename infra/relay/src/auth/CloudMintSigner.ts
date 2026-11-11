import {
  importRelayPrivateKey,
  importRelayPublicKey,
  RelayJwtError,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Signature from "effect/crypto/Signature";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

/** Signs and verifies relay-issued tokens with the cloud mint key pair. */
export class CloudMintSigner extends Context.Service<
  CloudMintSigner,
  {
    readonly sign: (input: {
      readonly typ: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<string, RelayJwtError>;
    readonly verify: <A>(
      schema: Schema.ConstraintDecoder<A>,
      input: {
        readonly token: string;
        readonly typ: string;
        readonly issuer: string;
        readonly audience: string;
        readonly maxTokenAge?: Duration.Input;
      },
    ) => Effect.Effect<A, RelayJwtError>;
  }
>()("t3code-relay/auth/CloudMintSigner") {}

// Parsed on first use and kept; a failed parse is retried so a bad key fails requests, not boot.
const cacheSuccess = <A, E>(load: Effect.Effect<A, E>) => {
  let value: A | undefined;
  return Effect.suspend(() =>
    value !== undefined
      ? Effect.succeed(value)
      : Effect.tap(load, (loaded) =>
          Effect.sync(() => {
            value = loaded;
          }),
        ),
  );
};

export const layer = Layer.effect(
  CloudMintSigner,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const signature = yield* Signature.Signature;
    const privateKey = cacheSuccess(
      importRelayPrivateKey(Redacted.value(config.cloudMintPrivateKey)),
    );
    const publicKey = cacheSuccess(importRelayPublicKey(config.cloudMintPublicKey));

    return CloudMintSigner.of({
      sign: Effect.fn("CloudMintSigner.sign")(function* (input) {
        const key = yield* privateKey.pipe(
          Effect.mapError(
            (cause) => new RelayJwtError({ operation: "sign", typ: input.typ, cause }),
          ),
        );
        return yield* signRelayJwt({ ...input, privateKey: key }).pipe(
          Effect.provideService(Signature.Signature, signature),
        );
      }),
      verify: Effect.fn("CloudMintSigner.verify")(function* (schema, input) {
        return yield* publicKey.pipe(
          Effect.mapError(
            (cause) =>
              new RelayJwtError({
                operation: "verify",
                typ: input.typ,
                issuer: input.issuer,
                audience: input.audience,
                cause,
              }),
          ),
          Effect.flatMap((key) => verifyRelayJwt(schema, { ...input, publicKey: key })),
          Effect.provideService(Signature.Signature, signature),
        );
      }),
    });
  }),
);
