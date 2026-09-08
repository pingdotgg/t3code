import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext.ts";
import { ConfigError } from "../RuntimeError.shared.ts";
import type { Worker_Binding_CryptoKey } from "../workerd/Config.ts";
import { Worker_Binding_CryptoKey_Usage } from "../workerd/Config.ts";

/**
 * Props for a `secret_key` (CryptoKey) binding, mirroring the Cloudflare
 * API's `secret_key` binding shape (WebCrypto `importKey` parameters plus
 * the key material).
 */
export interface SecretKeyProps {
  binding: string;
  /**
   * Data format of the key material — the WebCrypto `importKey` format.
   */
  format: "raw" | "pkcs8" | "spki" | "jwk" | (string & {});
  /**
   * WebCrypto `importKey` algorithm: a name (e.g. `"AES-GCM"`) or a full
   * algorithm object (e.g. `{ name: "HMAC", hash: "SHA-256" }`).
   */
  algorithm: unknown;
  /**
   * Allowed key operations (WebCrypto `keyUsages`).
   */
  usages: ReadonlyArray<string>;
  /**
   * Base64-encoded key material (raw bytes for `"raw"`, DER for `"pkcs8"`
   * / `"spki"`). Required unless `format` is `"jwk"`.
   */
  keyBase64?: string | null | undefined;
  /**
   * Key material in JSON Web Key format (an object, or pre-serialized JSON
   * text). Required when `format` is `"jwk"`.
   */
  keyJwk?: unknown;
  /**
   * Whether the worker may export the key material.
   * @default false
   */
  extractable?: boolean | undefined;
}

const USAGES: Record<string, Worker_Binding_CryptoKey_Usage> = {
  encrypt: Worker_Binding_CryptoKey_Usage.ENCRYPT,
  decrypt: Worker_Binding_CryptoKey_Usage.DECRYPT,
  sign: Worker_Binding_CryptoKey_Usage.SIGN,
  verify: Worker_Binding_CryptoKey_Usage.VERIFY,
  deriveKey: Worker_Binding_CryptoKey_Usage.DERIVE_KEY,
  deriveBits: Worker_Binding_CryptoKey_Usage.DERIVE_BITS,
  wrapKey: Worker_Binding_CryptoKey_Usage.WRAP_KEY,
  unwrapKey: Worker_Binding_CryptoKey_Usage.UNWRAP_KEY,
};

/**
 * Wrap base64 DER key data in PEM armor. The Cloudflare API carries
 * `pkcs8` / `spki` key material as bare base64 DER (`key_base64`), while
 * workerd's `cryptoKey.pkcs8` / `.spki` config fields expect PEM text.
 */
const toPem = (base64: string, label: string): string => {
  const body = base64.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

const invalid = (
  subtag: string,
  message: string,
  props: SecretKeyProps,
  hint?: string,
) =>
  new ConfigError({
    subtag,
    message,
    ...(hint !== undefined ? { hint } : {}),
    detail: { binding: props.binding, format: props.format },
  });

const keyMaterial = (
  props: SecretKeyProps,
): Effect.Effect<Worker_Binding_CryptoKey, ConfigError> =>
  Effect.gen(function* () {
    switch (props.format) {
      case "raw":
      case "pkcs8":
      case "spki": {
        const keyBase64 = props.keyBase64;
        if (typeof keyBase64 !== "string" || keyBase64.length === 0) {
          return yield* invalid(
            "MissingSecretKeyMaterial",
            `secret_key binding "${props.binding}" with format "${props.format}" requires base64-encoded key material`,
            props,
            'Provide the key data as base64 (the Cloudflare API\'s "key_base64" field).',
          );
        }
        return props.format === "raw"
          ? { base64: keyBase64 }
          : props.format === "pkcs8"
            ? { pkcs8: toPem(keyBase64, "PRIVATE KEY") }
            : { spki: toPem(keyBase64, "PUBLIC KEY") };
      }
      case "jwk": {
        const keyJwk = props.keyJwk;
        if (keyJwk === undefined || keyJwk === null) {
          return yield* invalid(
            "MissingSecretKeyMaterial",
            `secret_key binding "${props.binding}" with format "jwk" requires key material in JSON Web Key format`,
            props,
            'Provide the key as a JWK object (the Cloudflare API\'s "key_jwk" field).',
          );
        }
        return {
          jwk: typeof keyJwk === "string" ? keyJwk : JSON.stringify(keyJwk),
        };
      }
      default:
        return yield* invalid(
          "UnsupportedSecretKeyFormat",
          `secret_key binding "${props.binding}" has unsupported key format "${props.format}"`,
          props,
          'Supported formats are "raw", "pkcs8", "spki", and "jwk".',
        );
    }
  });

export const local = (props: SecretKeyProps): BindingHook =>
  Effect.gen(function* () {
    const material = yield* keyMaterial(props);

    if (props.algorithm === undefined || props.algorithm === null) {
      return yield* invalid(
        "MissingSecretKeyAlgorithm",
        `secret_key binding "${props.binding}" requires an algorithm`,
        props,
        'Provide a WebCrypto importKey algorithm, e.g. { name: "HMAC", hash: "SHA-256" }.',
      );
    }
    const algorithm =
      typeof props.algorithm === "string"
        ? { name: props.algorithm }
        : { json: JSON.stringify(props.algorithm) };

    const usages = yield* Effect.forEach(props.usages, (usage) => {
      const mapped = USAGES[usage];
      return mapped !== undefined
        ? Effect.succeed(mapped)
        : Effect.fail(
            invalid(
              "InvalidSecretKeyUsage",
              `secret_key binding "${props.binding}" has invalid key usage "${usage}"`,
              props,
              `Valid usages are ${Object.keys(USAGES)
                .map((u) => `"${u}"`)
                .join(", ")}.`,
            ),
          );
    });

    return {
      name: props.binding,
      cryptoKey: {
        ...material,
        algorithm,
        extractable: props.extractable ?? false,
        usages,
      },
    };
  });
