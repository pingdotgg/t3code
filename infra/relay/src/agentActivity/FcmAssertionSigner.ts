import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as WebCrypto from "../WebCrypto.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class FcmAssertionSigningError extends Schema.TaggedError<FcmAssertionSigningError>()(
  "FcmAssertionSigningError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Failed to sign Firebase authorization assertion.";
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export class FcmAssertionSigner extends Context.Service<
  FcmAssertionSigner,
  {
    readonly sign: (input: {
      readonly privateKey: string;
      readonly clientEmail: string;
      readonly issuedAt: number;
    }) => Effect.Effect<string, FcmAssertionSigningError>;
  }
>()("t3code-relay/agentActivity/FcmAssertionSigner") {}

export const make = Effect.gen(function* () {
  const { subtle } = yield* WebCrypto.WebCrypto;
  return FcmAssertionSigner.of({
    sign: Effect.fn("relay.fcm.assertion")(function* (input) {
      return yield* Effect.tryPromise({
        try: async () => {
          const encoder = new TextEncoder();
          const header = base64Url(encoder.encode(encodeJson({ alg: "RS256", typ: "JWT" })));
          const claims = base64Url(
            encoder.encode(
              encodeJson({
                iss: input.clientEmail,
                scope: "https://www.googleapis.com/auth/firebase.messaging",
                aud: "https://oauth2.googleapis.com/token",
                iat: input.issuedAt,
                exp: input.issuedAt + 3600,
              }),
            ),
          );
          const pem = input.privateKey.replace(/-----[^-]+-----|\s/g, "");
          const key = await subtle.importKey(
            "pkcs8",
            Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["sign"],
          );
          const signature = await subtle.sign(
            "RSASSA-PKCS1-v1_5",
            key,
            encoder.encode(`${header}.${claims}`),
          );
          return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
        },
        catch: (cause) => new FcmAssertionSigningError({ cause }),
      });
    }),
  });
});
export const layer = Layer.effect(FcmAssertionSigner, make);
