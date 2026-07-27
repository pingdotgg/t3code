import * as Lambda from "@/AWS/Lambda";
import * as PaymentCryptography from "@/AWS/PaymentCryptography";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Decoded distilled Sensitive* outputs are Redacted at runtime.
const unwrap = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

// Deterministic IV for the CBC round-trip routes (test-only).
const IV = "00000000000000000000000000000000";

export class PaymentCryptographyTestFunction extends Lambda.Function<Lambda.Function>()(
  "PaymentCryptographyTestFunction",
) {}

export default PaymentCryptographyTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const dataKey = yield* PaymentCryptography.Key("DataKey", {
      keyAttributes: {
        keyAlgorithm: "AES_128",
        keyClass: "SYMMETRIC_KEY",
        keyUsage: "TR31_D0_SYMMETRIC_DATA_ENCRYPTION_KEY",
        keyModesOfUse: {
          encrypt: true,
          decrypt: true,
          wrap: true,
          unwrap: true,
        },
      },
    });
    // DUKPT Base Derivation Key — the ReEncryptData incoming side (the
    // service rejects symmetric->symmetric re-encryption; the operation
    // translates DUKPT terminal ciphertext to a working key).
    const bdk = yield* PaymentCryptography.Key("Bdk", {
      keyAttributes: {
        keyAlgorithm: "TDES_2KEY",
        keyClass: "SYMMETRIC_KEY",
        keyUsage: "TR31_B0_BASE_DERIVATION_KEY",
        keyModesOfUse: { deriveKey: true },
      },
    });
    const macKey = yield* PaymentCryptography.Key("MacKey", {
      keyAttributes: {
        keyAlgorithm: "HMAC_SHA256",
        keyClass: "SYMMETRIC_KEY",
        keyUsage: "TR31_M7_HMAC_KEY",
        keyModesOfUse: { generate: true, verify: true },
      },
    });
    // Card Verification Key for CVV2 generation/verification.
    const cvk = yield* PaymentCryptography.Key("Cvk", {
      keyAttributes: {
        keyAlgorithm: "TDES_2KEY",
        keyClass: "SYMMETRIC_KEY",
        keyUsage: "TR31_C0_CARD_VERIFICATION_KEY",
        keyModesOfUse: { generate: true, verify: true },
      },
    });
    // PIN Encryption Keys — PIN blocks are encrypted/translated under these.
    const pek = yield* PaymentCryptography.Key("Pek", {
      keyAttributes: {
        keyAlgorithm: "TDES_2KEY",
        keyClass: "SYMMETRIC_KEY",
        keyUsage: "TR31_P0_PIN_ENCRYPTION_KEY",
        keyModesOfUse: {
          encrypt: true,
          decrypt: true,
          wrap: true,
          unwrap: true,
        },
      },
    });
    const pek2 = yield* PaymentCryptography.Key("Pek2", {
      keyAttributes: {
        keyAlgorithm: "TDES_2KEY",
        keyClass: "SYMMETRIC_KEY",
        keyUsage: "TR31_P0_PIN_ENCRYPTION_KEY",
        keyModesOfUse: {
          encrypt: true,
          decrypt: true,
          wrap: true,
          unwrap: true,
        },
      },
    });
    // Visa PIN Verification Key — generates/verifies PVVs.
    const pvk = yield* PaymentCryptography.Key("Pvk", {
      keyAttributes: {
        keyAlgorithm: "TDES_2KEY",
        keyClass: "SYMMETRIC_KEY",
        keyUsage: "TR31_V2_VISA_PIN_VERIFICATION_KEY",
        keyModesOfUse: { generate: true, verify: true },
      },
    });
    // Asymmetric signing key pair — GetPublicKeyCertificate target.
    const signKey = yield* PaymentCryptography.Key("SignKey", {
      keyAttributes: {
        keyAlgorithm: "ECC_NIST_P256",
        keyClass: "ASYMMETRIC_KEY_PAIR",
        keyUsage: "TR31_S0_ASYMMETRIC_KEY_FOR_DIGITAL_SIGNATURE",
        // S0 key pairs generated in-service sign with the private half; the
        // service rejects sign+verify combined on this usage.
        keyModesOfUse: { sign: true },
      },
    });

    const encryptData = yield* PaymentCryptography.EncryptData(dataKey);
    const encryptDukpt = yield* PaymentCryptography.EncryptData(bdk);
    const decryptData = yield* PaymentCryptography.DecryptData(dataKey);
    const generateMac = yield* PaymentCryptography.GenerateMac(macKey);
    const verifyMac = yield* PaymentCryptography.VerifyMac(macKey);
    const reEncryptData = yield* PaymentCryptography.ReEncryptData(
      bdk,
      dataKey,
    );
    const generateCardValidationData =
      yield* PaymentCryptography.GenerateCardValidationData(cvk);
    const verifyCardValidationData =
      yield* PaymentCryptography.VerifyCardValidationData(cvk);
    const generatePinData = yield* PaymentCryptography.GeneratePinData(
      pvk,
      pek,
    );
    const verifyPinData = yield* PaymentCryptography.VerifyPinData(pvk, pek);
    const translatePinData = yield* PaymentCryptography.TranslatePinData(
      pek,
      pek2,
    );
    const getPublicKeyCertificate =
      yield* PaymentCryptography.GetPublicKeyCertificate(signKey);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/encrypt-decrypt") {
          const body = (yield* request.json) as unknown as {
            plainTextHex: string;
          };
          const encrypted = yield* encryptData({
            PlainText: body.plainTextHex,
            EncryptionAttributes: {
              Symmetric: { Mode: "CBC", InitializationVector: IV },
            },
          });
          const cipherText = unwrap(encrypted.CipherText);
          const decrypted = yield* decryptData({
            CipherText: cipherText,
            DecryptionAttributes: {
              Symmetric: { Mode: "CBC", InitializationVector: IV },
            },
          });
          return yield* HttpServerResponse.json({
            keyArn: encrypted.KeyArn,
            cipherText,
            plainText: unwrap(decrypted.PlainText),
          });
        }

        if (request.method === "POST" && pathname === "/re-encrypt") {
          const body = (yield* request.json) as unknown as {
            plainTextHex: string;
          };
          // Simulate a DUKPT terminal: encrypt under a key derived from the
          // BDK at a fixed Key Serial Number.
          const KSN = "FFFF9876543210E00001";
          const encrypted = yield* encryptDukpt({
            PlainText: body.plainTextHex,
            EncryptionAttributes: {
              Dukpt: { KeySerialNumber: KSN, Mode: "CBC" },
            },
          });
          // Translate the DUKPT ciphertext to the symmetric working key
          // inside the service — the plaintext never leaves Payment
          // Cryptography.
          const reEncrypted = yield* reEncryptData({
            CipherText: unwrap(encrypted.CipherText),
            IncomingEncryptionAttributes: {
              Dukpt: { KeySerialNumber: KSN, Mode: "CBC" },
            },
            OutgoingEncryptionAttributes: {
              Symmetric: { Mode: "CBC", InitializationVector: IV },
            },
          });
          const decrypted = yield* decryptData({
            CipherText: unwrap(reEncrypted.CipherText),
            DecryptionAttributes: {
              Symmetric: { Mode: "CBC", InitializationVector: IV },
            },
          });
          return yield* HttpServerResponse.json({
            outgoingKeyArn: reEncrypted.KeyArn,
            plainText: unwrap(decrypted.PlainText),
          });
        }

        if (request.method === "POST" && pathname === "/card") {
          const body = (yield* request.json) as unknown as {
            pan: string;
            expiry: string;
          };
          const generated = yield* generateCardValidationData({
            PrimaryAccountNumber: body.pan,
            GenerationAttributes: {
              CardVerificationValue2: { CardExpiryDate: body.expiry },
            },
          });
          const cvv2 = unwrap(generated.ValidationData);
          const verified = yield* verifyCardValidationData({
            PrimaryAccountNumber: body.pan,
            VerificationAttributes: {
              CardVerificationValue2: { CardExpiryDate: body.expiry },
            },
            ValidationData: cvv2,
          });
          // A wrong CVV2 must fail with the typed
          // VerificationFailedException.
          const tamperedCvv2 = cvv2
            .split("")
            .map((d) => String((Number(d) + 1) % 10))
            .join("");
          const tampered = yield* verifyCardValidationData({
            PrimaryAccountNumber: body.pan,
            VerificationAttributes: {
              CardVerificationValue2: { CardExpiryDate: body.expiry },
            },
            ValidationData: tamperedCvv2,
          }).pipe(
            Effect.map(() => "verified"),
            Effect.catchTag("VerificationFailedException", () =>
              Effect.succeed("verification-failed"),
            ),
          );
          return yield* HttpServerResponse.json({
            cvv2,
            verifiedKeyArn: verified.KeyArn,
            tampered,
          });
        }

        if (request.method === "POST" && pathname === "/pin") {
          const body = (yield* request.json) as unknown as { pan: string };
          // Issue a Visa PIN: the PVK generates the PVV, the PEK encrypts
          // the PIN block.
          const generated = yield* generatePinData({
            GenerationAttributes: { VisaPin: { PinVerificationKeyIndex: 1 } },
            PrimaryAccountNumber: body.pan,
            PinBlockFormat: "ISO_FORMAT_0",
          });
          const encryptedPinBlock = unwrap(generated.EncryptedPinBlock);
          const pvv =
            generated.PinData.VerificationValue === undefined
              ? ""
              : unwrap(generated.PinData.VerificationValue);
          const verified = yield* verifyPinData({
            VerificationAttributes: {
              VisaPin: { PinVerificationKeyIndex: 1, VerificationValue: pvv },
            },
            EncryptedPinBlock: encryptedPinBlock,
            PrimaryAccountNumber: body.pan,
            PinBlockFormat: "ISO_FORMAT_0",
          });
          // Translate the PIN block from pek to pek2 (acquirer forwarding).
          const translated = yield* translatePinData({
            IncomingTranslationAttributes: {
              IsoFormat0: { PrimaryAccountNumber: body.pan },
            },
            OutgoingTranslationAttributes: {
              IsoFormat0: { PrimaryAccountNumber: body.pan },
            },
            EncryptedPinBlock: encryptedPinBlock,
          });
          return yield* HttpServerResponse.json({
            pvv,
            verificationKeyArn: verified.VerificationKeyArn,
            translatedKeyArn: translated.KeyArn,
            translatedPinBlock: unwrap(translated.PinBlock),
          });
        }

        if (request.method === "GET" && pathname === "/public-key-cert") {
          const certificate = yield* getPublicKeyCertificate();
          return yield* HttpServerResponse.json({
            keyCertificate: certificate.KeyCertificate,
            keyCertificateChain: certificate.KeyCertificateChain,
          });
        }

        if (request.method === "POST" && pathname === "/mac") {
          const body = (yield* request.json) as unknown as {
            messageDataHex: string;
          };
          // The hash function comes from the key's HMAC_SHA256 algorithm;
          // the MAC attribute is plain "HMAC".
          const generated = yield* generateMac({
            MessageData: body.messageDataHex,
            GenerationAttributes: { Algorithm: "HMAC" },
          });
          const mac = unwrap(generated.Mac);
          const verified = yield* verifyMac({
            MessageData: body.messageDataHex,
            Mac: mac,
            VerificationAttributes: { Algorithm: "HMAC" },
          });
          // A tampered MAC must fail with the typed
          // VerificationFailedException.
          const tamperedMac = (mac.startsWith("0") ? "1" : "0") + mac.slice(1);
          const tampered = yield* verifyMac({
            MessageData: body.messageDataHex,
            Mac: tamperedMac,
            VerificationAttributes: { Algorithm: "HMAC" },
          }).pipe(
            Effect.map(() => "verified"),
            Effect.catchTag("VerificationFailedException", () =>
              Effect.succeed("verification-failed"),
            ),
          );
          return yield* HttpServerResponse.json({
            mac,
            verifiedKeyArn: verified.KeyArn,
            tampered,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        PaymentCryptography.EncryptDataHttp,
        PaymentCryptography.DecryptDataHttp,
        PaymentCryptography.GenerateMacHttp,
        PaymentCryptography.VerifyMacHttp,
        PaymentCryptography.ReEncryptDataHttp,
        PaymentCryptography.GenerateCardValidationDataHttp,
        PaymentCryptography.VerifyCardValidationDataHttp,
        PaymentCryptography.GeneratePinDataHttp,
        PaymentCryptography.VerifyPinDataHttp,
        PaymentCryptography.TranslatePinDataHttp,
        PaymentCryptography.GetPublicKeyCertificateHttp,
      ),
    ),
  ),
);
