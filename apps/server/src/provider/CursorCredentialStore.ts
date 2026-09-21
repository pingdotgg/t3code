import type { SdkCredentialStore } from "@cursor/sdk";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeProviderCredentialStore } from "./ProviderCredentialStore.ts";

const Credentials = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    backendUrl: Schema.String,
    apiKey: Schema.String,
    createdAtMs: Schema.Finite,
    apiKeyExpiresAtMs: Schema.optionalKey(Schema.Finite),
    email: Schema.optionalKey(Schema.String),
  }),
);

const decodeCredentials = Schema.decodeUnknownEffect(Credentials);
const encodeCredentials = Schema.encodeEffect(Credentials);

/** The SDK owns the credential format; persistence uses the environment's secret store. */
export const makeCursorCredentialStore = Effect.fn("makeCursorCredentialStore")(function* (
  instanceId: ProviderInstanceId,
) {
  const credentials = yield* makeProviderCredentialStore("cursor", instanceId);
  const store: SdkCredentialStore = {
    load: () =>
      Effect.runPromise(
        credentials.get.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(undefined),
              onSome: (bytes) =>
                decodeCredentials(new TextDecoder().decode(bytes)).pipe(
                  Effect.orElseSucceed(() => undefined),
                ),
            }),
          ),
        ),
      ),
    save: (value) =>
      Effect.runPromise(
        encodeCredentials(value).pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "credentials",
                detail: "Cursor returned an unsupported credential format.",
              }),
          ),
          Effect.flatMap((encoded) => credentials.set(new TextEncoder().encode(encoded))),
        ),
      ),
    clear: () => Effect.runPromise(credentials.remove),
  };
  return { store, binding: credentials.binding };
});
