import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ApiKey, DataKey } from "./resources.ts";

/** Constant-time comparison so response timing does not leak the key. */
const sameKey = (expected: string, given: string | undefined) => {
  if (given === undefined || given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return diff === 0;
};

const toBase64 = (text: string) =>
  Effect.sync(() => Buffer.from(text, "utf8").toString("base64"));

const fromBase64 = (data: string) =>
  Effect.sync(() => Buffer.from(data, "base64").toString("utf8"));

const error = (status: number, message: string) =>
  HttpServerResponse.json({ error: message }, { status });

/**
 * Encryption as a service on Cloud Run.
 *
 * Callers never hold key material: `/encrypt` hands plaintext to Cloud KMS
 * and returns the ciphertext, `/decrypt` does the reverse. Both routes are
 * gated by an API key the service reads from Secret Manager per request,
 * so rotating the key is `gcloud secrets versions add` — no redeploy.
 *
 * - `POST /encrypt` — `{ plaintext }` → `{ ciphertext }` (base64).
 * - `POST /decrypt` — `{ ciphertext }` → `{ plaintext }`.
 *
 * Each binding grants one role on the service's runtime service account,
 * scoped to the one resource it was bound to.
 */
export default class Api extends GCP.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const dataKey = yield* DataKey;
    const apiKey = yield* ApiKey;

    // roles/cloudkms.cryptoKeyEncrypter / cryptoKeyDecrypter on DataKey.
    const encrypt = yield* GCP.KMS.Encrypt(dataKey);
    const decrypt = yield* GCP.KMS.Decrypt(dataKey);
    // roles/secretmanager.secretAccessor on ApiKey.
    const apiKeySecret = yield* GCP.SecretManager.ReadSecret(apiKey);

    /**
     * Read the `latest` version on every call so a rotated key takes
     * effect immediately. With no version yet the API refuses everyone
     * instead of failing open.
     */
    const authorize = (request: HttpServerRequest) =>
      apiKeySecret.access().pipe(
        Effect.map((expected) =>
          expected === undefined
            ? ("unconfigured" as const)
            : sameKey(expected, request.headers["x-api-key"])
              ? ("ok" as const)
              : ("denied" as const),
        ),
        Effect.orDie,
      );

    const readField = (request: HttpServerRequest, field: string) =>
      request.json.pipe(
        Effect.map((body) => {
          const value = (body as Record<string, unknown> | null)?.[field];
          return typeof value === "string" && value.length > 0
            ? value
            : undefined;
        }),
        Effect.catch(() => Effect.succeed(undefined)),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const { pathname } = new URL(request.originalUrl);

        if (request.method === "GET" && pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        const route =
          request.method === "POST" &&
          (pathname === "/encrypt" || pathname === "/decrypt")
            ? pathname
            : undefined;
        if (route === undefined) return yield* error(404, "not found");

        const auth = yield* authorize(request);
        if (auth === "unconfigured") {
          return yield* error(
            503,
            "no api key version has been added to the secret",
          );
        }
        if (auth === "denied") return yield* error(401, "invalid api key");

        if (route === "/encrypt") {
          const plaintext = yield* readField(request, "plaintext");
          if (plaintext === undefined) {
            return yield* error(400, "plaintext is required");
          }
          const { ciphertext } = yield* encrypt({
            body: { plaintext: yield* toBase64(plaintext) },
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ciphertext });
        }

        const ciphertext = yield* readField(request, "ciphertext");
        if (ciphertext === undefined) {
          return yield* error(400, "ciphertext is required");
        }
        // KMS rejects ciphertext it did not produce (or that was tampered
        // with) as a bad request; that is the caller's fault, not ours.
        const decrypted = yield* decrypt({ body: { ciphertext } }).pipe(
          Effect.map((response) => response.plaintext),
          Effect.catchTag("BadRequest", () => Effect.succeed(null)),
          Effect.orDie,
        );
        if (decrypted === null) {
          return yield* error(400, "ciphertext could not be decrypted");
        }
        return yield* HttpServerResponse.json({
          plaintext: yield* fromBase64(decrypted ?? ""),
        });
      }),
    };
  }).pipe(
    Effect.provide([
      GCP.KMS.EncryptHttp,
      GCP.KMS.DecryptHttp,
      GCP.SecretManager.ReadSecretHttp,
    ]),
  ),
) {}
