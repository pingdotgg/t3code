import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  base64ToBytes,
  bytesToBase64,
  makeHttpSecretKeyBinding,
} from "./SecretKeyHttp.ts";
import { Sign, type SignRequest } from "./Sign.ts";

/**
 * HTTP implementation of {@link Sign}. Provide it on the
 * {@link Service} or Action Effect.
 *
 *
 * ### Provide the layer
 * **Example:** On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const sign = yield* Fly.Sign(Signing);
 *   // ...
 * }).pipe(Effect.provide(Fly.SignHttp))
 * ```
 *
 * @layer
 * @provides Fly.Sign
 */
export const SignHttp = Layer.effect(
  Sign,
  Effect.suspend(() =>
    makeHttpSecretKeyBinding({
      makeClient: (auth, appName, secretName) =>
        Effect.fn("Fly.Sign")(function* (request: SignRequest) {
          const res = yield* auth.authorize(
            machines.signSecretKey({
              app_name: yield* appName,
              secret_name: yield* secretName,
              plaintext: bytesToBase64(request.plaintext),
            }),
          );
          return { signature: base64ToBytes(res.signature) };
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
