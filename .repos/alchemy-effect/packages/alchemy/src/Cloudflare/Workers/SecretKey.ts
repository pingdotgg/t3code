import type * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "./Binding.ts";
import type { SecretKeyBinding } from "./SecretKeyBinding.ts";

const TypeId = "Cloudflare.Workers.SecretKey" as const;
type TypeId = typeof TypeId;

/**
 * Data format of the key material, mirroring
 * [`SubtleCrypto.importKey`](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey#format).
 */
export type SecretKeyFormat = "raw" | "pkcs8" | "spki" | "jwk";

/**
 * Operations the imported key may be used for, mirroring
 * [`SubtleCrypto.importKey`](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey#keyUsages).
 */
export type SecretKeyUsage =
  | "encrypt"
  | "decrypt"
  | "sign"
  | "verify"
  | "deriveKey"
  | "deriveBits"
  | "wrapKey"
  | "unwrapKey";

/**
 * Algorithm-specific import parameters, mirroring
 * [`SubtleCrypto.importKey`](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey#algorithm)
 * (e.g. `{ name: "HMAC", hash: "SHA-256" }`, `{ name: "AES-GCM" }`).
 */
export interface SecretKeyAlgorithm {
  /** WebCrypto algorithm name, e.g. `"HMAC"`, `"AES-GCM"`, `"RSA-PSS"`. */
  readonly name: string;
  /** Algorithm-specific parameters (`hash`, `length`, `namedCurve`, …). */
  readonly [param: string]: unknown;
}

/**
 * Key material in [JSON Web Key](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey#json_web_key)
 * format, e.g. `{ kty: "oct", k: "<base64url>", alg: "HS256" }`.
 */
export interface SecretKeyJwk {
  /** JWK key type, e.g. `"oct"`, `"RSA"`, `"EC"`. */
  readonly kty: string;
  /** Remaining JWK members (`k`, `n`, `e`, `crv`, `alg`, …). */
  readonly [member: string]: unknown;
}

export type SecretKeyProps = {
  /**
   * Algorithm-specific key parameters passed to WebCrypto's `importKey`,
   * e.g. `{ name: "HMAC", hash: "SHA-256" }`.
   */
  algorithm: SecretKeyAlgorithm;
  /**
   * Allowed operations with the key (`"sign"`, `"verify"`, `"encrypt"`, …).
   */
  usages: ReadonlyArray<SecretKeyUsage>;
} & (
  | {
      /**
       * Data format of the key material. `raw` / `pkcs8` / `spki` formats
       * carry the key as base64 in `keyBase64`.
       */
      format: "raw" | "pkcs8" | "spki";
      /**
       * Base64-encoded key data (raw bytes, or DER for `pkcs8`/`spki`).
       * Accepts a `Redacted` value — it is unwrapped when the binding is
       * registered, since the Cloudflare API accepts only the plain value.
       */
      keyBase64: string | Redacted.Redacted<string>;
      keyJwk?: never;
    }
  | {
      /** Data format of the key material — a JSON Web Key in `keyJwk`. */
      format: "jwk";
      /**
       * Key data in JSON Web Key format. Accepts a `Redacted` value — it is
       * unwrapped when the binding is registered, since the Cloudflare API
       * accepts only the plain value.
       */
      keyJwk: SecretKeyJwk | Redacted.Redacted<SecretKeyJwk>;
      keyBase64?: never;
    }
);

/**
 * Deferred accessor for the bound key. The env binding only exists at the
 * *exec* phase on the deployed Worker, so reading it is behind an Effect
 * requiring {@link RuntimeContext}. Yield it inside a handler to obtain the
 * native `CryptoKey`, then use `crypto.subtle` directly.
 */
export type SecretKeyAccessor = Effect.Effect<
  // The ambient global type, matching InferEnv's SecretKeyBinding mapping:
  // resolves to @cloudflare/workers-types' CryptoKey inside a Worker program
  // and to the platform CryptoKey elsewhere.
  CryptoKey,
  never,
  RuntimeContext
>;

/** The resolved (plain, non-Redacted) binding payload carried on a {@link SecretKeyBinding}. */
export interface SecretKeyPayload {
  format: SecretKeyFormat;
  algorithm: SecretKeyAlgorithm;
  usages: SecretKeyUsage[];
  keyBase64?: string;
  keyJwk?: SecretKeyJwk;
}

const unwrap = <A>(
  value: A | Redacted.Redacted<A> | undefined,
): A | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * A Cloudflare Workers Secret Key binding — key material uploaded once and
 * exposed to the Worker as a native, non-extractable
 * [`CryptoKey`](https://developers.cloudflare.com/workers/runtime-apis/bindings/secret-key/).
 * The Worker can sign, verify, encrypt, or decrypt with the key via
 * `crypto.subtle`, but can never read the raw key material back out.
 *
 * `SecretKey` is a single value that is at once the `Binding.Service` tag, the
 * callable that produces a {@link SecretKeyBinding}, and the type. Declare it
 * on a Worker's `env` (it flows through `InferEnv` → the native `CryptoKey`)
 * or `yield*` it inside an Effect-native Worker to attach the binding and
 * obtain a deferred {@link SecretKeyAccessor}.
 *
 * ### Binding inside an Effect-native Worker
 * **Example:** HMAC sign and verify
 * ```typescript
 * Cloudflare.Worker(
 *   "SignerWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Attaches the binding to this Worker AND returns a deferred accessor.
 *     const hmacKey = yield* Cloudflare.Workers.SecretKey("HMAC_KEY", {
 *       format: "raw",
 *       algorithm: { name: "HMAC", hash: "SHA-256" },
 *       usages: ["sign", "verify"],
 *       keyBase64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
 *     });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const key = yield* hmacKey;
 *         const data = new TextEncoder().encode("hello");
 *         const signature = yield* Effect.promise(() =>
 *           crypto.subtle.sign("HMAC", key, data),
 *         );
 *         const valid = yield* Effect.promise(() =>
 *           crypto.subtle.verify("HMAC", key, signature, data),
 *         );
 *         return HttpServerResponse.json({ valid });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.SecretKeyBinding)),
 * );
 * ```
 *
 * **Example:** JSON Web Key format
 * ```typescript
 * const jwkKey = yield* Cloudflare.Workers.SecretKey("HMAC_KEY_JWK", {
 *   format: "jwk",
 *   algorithm: { name: "HMAC", hash: "SHA-256" },
 *   usages: ["sign", "verify"],
 *   keyJwk: {
 *     kty: "oct",
 *     k: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
 *     alg: "HS256",
 *   },
 * });
 * ```
 *
 * ### Declaring on a Worker's env
 * **Example:** Async (non-Effect) Worker
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     HMAC_KEY: Cloudflare.Workers.SecretKey("HMAC_KEY", {
 *       format: "raw",
 *       algorithm: { name: "HMAC", hash: "SHA-256" },
 *       usages: ["sign", "verify"],
 *       keyBase64: Redacted.make("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="),
 *     }),
 *   },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { HMAC_KEY: CryptoKey } — the native runtime binding
 *
 * // worker.ts
 * export default {
 *   fetch: async (req: Request, env: WorkerEnv) => {
 *     const signature = await crypto.subtle.sign(
 *       "HMAC",
 *       env.HMAC_KEY,
 *       new TextEncoder().encode("hello"),
 *     );
 *     return new Response(btoa(String.fromCharCode(...new Uint8Array(signature))));
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/secret-key/
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export interface SecretKey extends Binding.Service<
  SecretKey,
  TypeId,
  SecretKeyAccessor
> {
  /**
   * @param name Binding name (logical id) — the `env` key it resolves to.
   * @param props Key format, algorithm, usages, and the key material.
   */
  (name: string, props: SecretKeyProps): SecretKeyBinding;
}

export const SecretKey = Binding.Service<SecretKey, SecretKeyPayload>({
  id: TypeId,
  defaultName: "SECRET_KEY",
  parse: (name: string, props: SecretKeyProps) => ({
    name,
    format: props.format,
    algorithm: props.algorithm,
    usages: [...props.usages],
    // The wire shape is plain — Redacted key material is unwrapped at bind
    // time (same convention as Redacted env values → `secret_text`).
    keyBase64: unwrap(props.keyBase64),
    keyJwk: unwrap(props.keyJwk),
  }),
  toWorkerBinding: (binding) => ({
    type: "secret_key",
    name: binding.name,
    format: binding.format,
    algorithm: binding.algorithm,
    usages: binding.usages,
    keyBase64: binding.keyBase64,
    keyJwk: binding.keyJwk,
  }),
});

export const isSecretKey = (value: unknown): value is SecretKeyBinding =>
  Binding.isBinding(value) && value.kind === TypeId;
