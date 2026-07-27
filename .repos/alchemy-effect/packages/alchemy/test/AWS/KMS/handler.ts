import * as AWS from "@/AWS";
import * as kms from "@distilled.cloud/aws/kms";
import crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Standing test key aliases — see the header comment in `Bindings.test.ts`.
 * The keys behind these aliases are acquired out-of-band by the test's
 * `beforeAll` (reclaiming the previous run's pending-deletion keys when
 * possible) and released in `afterAll` by deleting the aliases and
 * scheduling the keys for deletion (7-day minimum window — KMS's terminal
 * "deleted" state; pending-deletion keys are not billed). A passing run
 * therefore leaves no aliases and no enabled keys behind.
 */
export const STANDING_KEY_ALIAS = "alias/alchemy-test-kms-bindings" as const;
export const STANDING_HMAC_KEY_ALIAS =
  "alias/alchemy-test-bindings-hmac" as const;
export const STANDING_SIGNING_KEY_ALIAS =
  "alias/alchemy-test-bindings-sign" as const;
export const STANDING_AGREEMENT_KEY_ALIAS =
  "alias/alchemy-test-bindings-ecdh" as const;

export class KMSTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "KMSTestFunction",
) {}

const fromBase64 = (value: string) =>
  Effect.sync(() => new Uint8Array(Buffer.from(value, "base64")));

const toBase64 = (value: Uint8Array) =>
  Effect.sync(() => Buffer.from(value).toString("base64"));

const unwrapSensitive = (
  value: Uint8Array | Redacted.Redacted<Uint8Array> | undefined,
): Uint8Array | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

export default KMSTestFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    // Symmetric encryption key
    const encrypt = yield* AWS.KMS.Encrypt(STANDING_KEY_ALIAS);
    const decrypt = yield* AWS.KMS.Decrypt(STANDING_KEY_ALIAS);
    const generateDataKey = yield* AWS.KMS.GenerateDataKey(STANDING_KEY_ALIAS);
    const generateDataKeyWithoutPlaintext =
      yield* AWS.KMS.GenerateDataKeyWithoutPlaintext(STANDING_KEY_ALIAS);
    const generateDataKeyPair =
      yield* AWS.KMS.GenerateDataKeyPair(STANDING_KEY_ALIAS);
    const generateDataKeyPairWithoutPlaintext =
      yield* AWS.KMS.GenerateDataKeyPairWithoutPlaintext(STANDING_KEY_ALIAS);
    const reEncrypt = yield* AWS.KMS.ReEncrypt(STANDING_KEY_ALIAS);
    const describeKey = yield* AWS.KMS.DescribeKey(STANDING_KEY_ALIAS);
    // HMAC key
    const generateMac = yield* AWS.KMS.GenerateMac(STANDING_HMAC_KEY_ALIAS);
    const verifyMac = yield* AWS.KMS.VerifyMac(STANDING_HMAC_KEY_ALIAS);
    // Asymmetric signing key
    const sign = yield* AWS.KMS.Sign(STANDING_SIGNING_KEY_ALIAS);
    const verify = yield* AWS.KMS.Verify(STANDING_SIGNING_KEY_ALIAS);
    const getSigningPublicKey = yield* AWS.KMS.GetPublicKey(
      STANDING_SIGNING_KEY_ALIAS,
    );
    // ECDH key-agreement key
    const deriveSharedSecret = yield* AWS.KMS.DeriveSharedSecret(
      STANDING_AGREEMENT_KEY_ALIAS,
    );
    const getAgreementPublicKey = yield* AWS.KMS.GetPublicKey(
      STANDING_AGREEMENT_KEY_ALIAS,
    );
    // Account-level (not key-scoped)
    const generateRandom = yield* AWS.KMS.GenerateRandom();
    // Deliberately NOT a binding: used by /unauthorized to prove the Lambda
    // role received ONLY the bound kms actions (least privilege).
    const getKeyRotationStatus = yield* kms.getKeyRotationStatus;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/encrypt") {
          const body = (yield* request.json) as {
            plaintextBase64: string;
            context?: Record<string, string>;
          };
          const result = yield* encrypt({
            Plaintext: yield* fromBase64(body.plaintextBase64),
            EncryptionContext: body.context,
          });
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            ciphertextBase64: result.CiphertextBlob
              ? yield* toBase64(result.CiphertextBlob)
              : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/decrypt") {
          const body = (yield* request.json) as {
            ciphertextBase64: string;
            context?: Record<string, string>;
          };
          const ciphertext = yield* fromBase64(body.ciphertextBase64);
          const result = yield* decrypt({
            CiphertextBlob: ciphertext,
            EncryptionContext: body.context,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error: error._tag,
              }),
              onSuccess: (response) => ({
                ok: true as const,
                keyId: response.KeyId,
                plaintext: unwrapSensitive(response.Plaintext),
              }),
            }),
          );
          if (!result.ok) {
            return yield* HttpServerResponse.json(result);
          }
          return yield* HttpServerResponse.json({
            ok: true,
            keyId: result.keyId,
            plaintextBase64: result.plaintext
              ? yield* toBase64(result.plaintext)
              : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/generate-data-key") {
          const result = yield* generateDataKey({ KeySpec: "AES_256" });
          const plaintext = unwrapSensitive(result.Plaintext);
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            plaintextBase64: plaintext ? yield* toBase64(plaintext) : undefined,
            ciphertextBase64: result.CiphertextBlob
              ? yield* toBase64(result.CiphertextBlob)
              : undefined,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/generate-data-key-without-plaintext"
        ) {
          const result = yield* generateDataKeyWithoutPlaintext({
            KeySpec: "AES_256",
          });
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            ciphertextBase64: result.CiphertextBlob
              ? yield* toBase64(result.CiphertextBlob)
              : undefined,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/generate-data-key-pair"
        ) {
          const result = yield* generateDataKeyPair({
            KeyPairSpec: "ECC_NIST_P256",
          });
          const privateKeyPlaintext = unwrapSensitive(
            result.PrivateKeyPlaintext,
          );
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            keyPairSpec: result.KeyPairSpec,
            publicKeyBase64: result.PublicKey
              ? yield* toBase64(result.PublicKey)
              : undefined,
            privateKeyPlaintextBase64: privateKeyPlaintext
              ? yield* toBase64(privateKeyPlaintext)
              : undefined,
            privateKeyCiphertextBase64: result.PrivateKeyCiphertextBlob
              ? yield* toBase64(result.PrivateKeyCiphertextBlob)
              : undefined,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/generate-data-key-pair-without-plaintext"
        ) {
          const result = yield* generateDataKeyPairWithoutPlaintext({
            KeyPairSpec: "ECC_NIST_P256",
          });
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            publicKeyBase64: result.PublicKey
              ? yield* toBase64(result.PublicKey)
              : undefined,
            privateKeyCiphertextBase64: result.PrivateKeyCiphertextBlob
              ? yield* toBase64(result.PrivateKeyCiphertextBlob)
              : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/re-encrypt") {
          const body = (yield* request.json) as {
            ciphertextBase64: string;
            sourceContext?: Record<string, string>;
            destinationContext?: Record<string, string>;
          };
          const result = yield* reEncrypt({
            CiphertextBlob: yield* fromBase64(body.ciphertextBase64),
            SourceEncryptionContext: body.sourceContext,
            DestinationEncryptionContext: body.destinationContext,
          });
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            sourceKeyId: result.SourceKeyId,
            ciphertextBase64: result.CiphertextBlob
              ? yield* toBase64(result.CiphertextBlob)
              : undefined,
          });
        }

        if (request.method === "GET" && pathname === "/describe-key") {
          const result = yield* describeKey();
          return yield* HttpServerResponse.json({
            keyId: result.KeyMetadata?.KeyId,
            keySpec: result.KeyMetadata?.KeySpec,
            keyState: result.KeyMetadata?.KeyState,
          });
        }

        if (request.method === "POST" && pathname === "/mac") {
          const body = (yield* request.json) as { messageBase64: string };
          const result = yield* generateMac({
            Message: yield* fromBase64(body.messageBase64),
            MacAlgorithm: "HMAC_SHA_256",
          });
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            macBase64: result.Mac ? yield* toBase64(result.Mac) : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/verify-mac") {
          const body = (yield* request.json) as {
            messageBase64: string;
            macBase64: string;
          };
          const result = yield* verifyMac({
            Message: yield* fromBase64(body.messageBase64),
            Mac: yield* fromBase64(body.macBase64),
            MacAlgorithm: "HMAC_SHA_256",
          }).pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error: error._tag,
              }),
              onSuccess: (response) => ({
                ok: true as const,
                macValid: response.MacValid,
              }),
            }),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/sign") {
          const body = (yield* request.json) as { messageBase64: string };
          const result = yield* sign({
            Message: yield* fromBase64(body.messageBase64),
            SigningAlgorithm: "ECDSA_SHA_256",
          });
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            signatureBase64: result.Signature
              ? yield* toBase64(result.Signature)
              : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/verify") {
          const body = (yield* request.json) as {
            messageBase64: string;
            signatureBase64: string;
          };
          const result = yield* verify({
            Message: yield* fromBase64(body.messageBase64),
            Signature: yield* fromBase64(body.signatureBase64),
            SigningAlgorithm: "ECDSA_SHA_256",
          }).pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error: error._tag,
              }),
              onSuccess: (response) => ({
                ok: true as const,
                signatureValid: response.SignatureValid,
              }),
            }),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/public-key") {
          const result = yield* getSigningPublicKey();
          return yield* HttpServerResponse.json({
            keyId: result.KeyId,
            keyUsage: result.KeyUsage,
            publicKeyBase64: result.PublicKey
              ? yield* toBase64(result.PublicKey)
              : undefined,
            signingAlgorithms: result.SigningAlgorithms,
          });
        }

        if (request.method === "POST" && pathname === "/derive-shared-secret") {
          // Generate an ephemeral local P-256 key pair, run ECDH inside KMS
          // against the local public key, then recompute the shared secret
          // locally against the KMS key's public key. Both sides must agree.
          const localPair = yield* Effect.sync(() =>
            crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
          );
          const localPublicDer = yield* Effect.sync(
            () =>
              new Uint8Array(
                localPair.publicKey.export({ type: "spki", format: "der" }),
              ),
          );
          const kmsResult = yield* deriveSharedSecret({
            KeyAgreementAlgorithm: "ECDH",
            PublicKey: localPublicDer,
          });
          const kmsShared = unwrapSensitive(kmsResult.SharedSecret);
          const kmsPublic = yield* getAgreementPublicKey();
          const localShared = kmsPublic.PublicKey
            ? yield* Effect.sync(() =>
                crypto.diffieHellman({
                  privateKey: localPair.privateKey,
                  publicKey: crypto.createPublicKey({
                    key: Buffer.from(kmsPublic.PublicKey!),
                    format: "der",
                    type: "spki",
                  }),
                }),
              )
            : undefined;
          return yield* HttpServerResponse.json({
            keyId: kmsResult.KeyId,
            byteLength: kmsShared?.length,
            match:
              kmsShared !== undefined &&
              localShared !== undefined &&
              Buffer.from(kmsShared).equals(localShared),
          });
        }

        if (request.method === "POST" && pathname === "/random") {
          const result = yield* generateRandom({ NumberOfBytes: 32 });
          const bytes = unwrapSensitive(result.Plaintext);
          return yield* HttpServerResponse.json({
            randomBase64: bytes ? yield* toBase64(bytes) : undefined,
          });
        }

        if (request.method === "GET" && pathname === "/unauthorized") {
          // kms:GetKeyRotationStatus is not bound — the role must reject it.
          // The API only accepts a key id/ARN (not an alias), so resolve the
          // real key id through the bound DescribeKey first.
          const described = yield* describeKey();
          const result = yield* getKeyRotationStatus({
            KeyId: described.KeyMetadata!.KeyId,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error: error._tag,
              }),
              onSuccess: () => ({ ok: true as const }),
            }),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.KMS.DecryptHttp,
        AWS.KMS.EncryptHttp,
        AWS.KMS.GenerateDataKeyHttp,
        AWS.KMS.GenerateDataKeyWithoutPlaintextHttp,
        AWS.KMS.GenerateDataKeyPairHttp,
        AWS.KMS.GenerateDataKeyPairWithoutPlaintextHttp,
        AWS.KMS.ReEncryptHttp,
        AWS.KMS.DescribeKeyHttp,
        AWS.KMS.GenerateMacHttp,
        AWS.KMS.VerifyMacHttp,
        AWS.KMS.SignHttp,
        AWS.KMS.VerifyHttp,
        AWS.KMS.GetPublicKeyHttp,
        AWS.KMS.DeriveSharedSecretHttp,
        AWS.KMS.GenerateRandomHttp,
      ),
    ),
  ),
);
