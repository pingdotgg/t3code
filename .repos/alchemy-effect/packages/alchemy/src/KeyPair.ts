import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "./Provider.ts";
import { Resource } from "./Resource.ts";

export type KeyPairAlgorithm = "ed25519" | "rsa" | "ec";

export interface KeyPairProps {
  /**
   * Key algorithm used to generate the pair.
   * @default "ed25519"
   */
  algorithm?: KeyPairAlgorithm;
  /**
   * Modulus length in bits. Only used when {@link algorithm} is `"rsa"`.
   * @default 2048
   */
  modulusLength?: number;
  /**
   * Named curve. Only used when {@link algorithm} is `"ec"`.
   * @default "P-256"
   */
  namedCurve?: string;
}

export type KeyPair = Resource<
  "Alchemy.KeyPair",
  KeyPairProps,
  {
    algorithm: KeyPairAlgorithm;
    privateKey: Redacted.Redacted<string>;
    publicKey: string;
  }
>;

/**
 * A deterministic-in-state public/private keypair generator.
 *
 * The keypair is generated once on first reconcile and then persisted in
 * state so subsequent deploys keep the same keys unless the resource is
 * replaced. `privateKey` is PEM-encoded `pkcs8` and `publicKey` is
 * PEM-encoded `spki`.
 *
 * @resource
 *
 * @section Generating a Keypair
 * @example Default ed25519 keypair
 * ```typescript
 * const keys = yield* KeyPair("signing-key");
 * // keys.privateKey: Redacted<string>  (PEM pkcs8)
 * // keys.publicKey:  string            (PEM spki)
 * // keys.algorithm:  "ed25519"
 * ```
 *
 * @example RSA keypair
 * ```typescript
 * const keys = yield* KeyPair("rsa-key", {
 *   algorithm: "rsa",
 *   modulusLength: 2048,
 * });
 * ```
 *
 * @example EC keypair on a named curve
 * ```typescript
 * const keys = yield* KeyPair("ec-key", {
 *   algorithm: "ec",
 *   namedCurve: "P-256",
 * });
 * ```
 *
 * @section Consuming the Keys
 * @example Pass the private key to a Worker as a secret
 * ```typescript
 * const keys = yield* KeyPair("signing-key");
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   bindings: {
 *     SIGNING_KEY: keys.privateKey,
 *     PUBLIC_KEY: keys.publicKey,
 *   },
 * });
 * ```
 */
export const KeyPair = Resource<KeyPair>("Alchemy.KeyPair");

const pemEncoding = {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
} as const;

const generate = (
  props: KeyPairProps,
): {
  privateKey: string;
  publicKey: string;
  algorithm: KeyPairAlgorithm;
} => {
  const algorithm = props.algorithm ?? "ed25519";
  if (algorithm === "rsa") {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: props.modulusLength ?? 2048,
      ...pemEncoding,
    });
    return { algorithm, privateKey, publicKey };
  }
  if (algorithm === "ec") {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: props.namedCurve ?? "P-256",
      ...pemEncoding,
    });
    return { algorithm, privateKey, publicKey };
  }
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync(
    "ed25519",
    pemEncoding,
  );
  return { algorithm, privateKey, publicKey };
};

export const KeyPairProvider = () =>
  Provider.succeed(KeyPair, {
    reconcile: Effect.fn(function* ({ news = {}, output }) {
      // Observe — there is no remote state. The cached `output` is the
      // authoritative current value; once minted the keypair is preserved
      // across reconciles to keep it stable.
      if (output?.privateKey && output?.publicKey) {
        return output;
      }

      // Ensure — no observed value: mint a fresh keypair. The next
      // reconcile will see this in `output` and short-circuit above.
      const generated = yield* Effect.sync(() => generate(news));
      return {
        algorithm: generated.algorithm,
        privateKey: Redacted.make(generated.privateKey),
        publicKey: generated.publicKey,
      };
    }),
    delete: Effect.fn(function* () {
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
  });
