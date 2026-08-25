import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import PaymentCryptographyTestFunctionLive, {
  PaymentCryptographyTestFunction,
} from "./handler.ts";
import { reapLeakedKeys } from "./reapKeys.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PaymentCryptoBindings");

// The whole suite deploys real Payment Cryptography keys (billed monthly),
// so it is gated behind AWS_TEST_PAYMENTCRYPTO=1 alongside the Key lifecycle.
const gated = !process.env.AWS_TEST_PAYMENTCRYPTO;

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(60),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from cold re-inits; genuine 4xx fails immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

describe.skipIf(gated)("PaymentCryptography Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Pre-clean: schedule deletion for any ACTIVE keys a previously
      // crashed run leaked under this stack's tags (the scratch state is
      // in-memory, so the destroy above cannot see them).
      yield* Core.withProviders(
        reapLeakedKeys([sharedStack.name]),
        testOptions,
        sharedStack.name,
      );

      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* PaymentCryptographyTestFunction;
        }).pipe(Effect.provide(PaymentCryptographyTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }).pipe(Effect.orDie),
    { timeout: 240_000 },
  );

  // Destroy schedules key deletion (mandatory >=3 day window — keys cannot
  // be hard-deleted, DELETE_PENDING is the terminal state a test can reach);
  // the trailing reap catches any key the destroy missed so even a partial
  // failure leaves nothing ACTIVE.
  afterAll(
    sharedStack
      .destroy()
      .pipe(
        Effect.ensuring(
          Core.withProviders(
            reapLeakedKeys([sharedStack.name]),
            testOptions,
            sharedStack.name,
          ),
        ),
        Effect.orDie,
      ),
    { timeout: 120_000 },
  );

  describe("EncryptData", () => {
    test.provider("encrypts hex-encoded plaintext under the key", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/encrypt-decrypt`),
            // "1234567890123456" — one full AES block, hex-encoded
            { plainTextHex: "31323334353637383930313233343536" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          keyArn: string;
          cipherText: string;
          plainText: string;
        };

        expect(response.keyArn).toContain(":key/");
        expect(response.cipherText).toBeTruthy();
        expect(response.cipherText).not.toBe(
          "31323334353637383930313233343536",
        );
      }),
    );
  });

  describe("DecryptData", () => {
    test.provider("round-trips ciphertext back to the plaintext", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/encrypt-decrypt`),
            { plainTextHex: "41414141414141414141414141414141" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          plainText: string;
        };

        expect(response.plainText.toUpperCase()).toBe(
          "41414141414141414141414141414141",
        );
      }),
    );
  });

  describe("GenerateMac", () => {
    test.provider("generates an HMAC over message data", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/mac`),
            { messageDataHex: "31323334353637383930313233343536" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          mac: string;
        };

        expect(response.mac).toBeTruthy();
        expect(response.mac).toMatch(/^[0-9A-Fa-f]+$/);
      }),
    );
  });

  describe("VerifyMac", () => {
    test.provider(
      "verifies a generated MAC and rejects a tampered one",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/mac`),
              { messageDataHex: "39393939393939393939393939393939" },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            verifiedKeyArn: string;
            tampered: string;
          };

          expect(response.verifiedKeyArn).toContain(":key/");
          expect(response.tampered).toBe("verification-failed");
        }),
    );
  });

  describe("ReEncryptData", () => {
    test.provider(
      "translates DUKPT ciphertext to the working key and round-trips",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/re-encrypt`),
              // "ABCDABCDABCDABCD" — one full AES block, hex-encoded
              { plainTextHex: "41424344414243444142434441424344" },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            outgoingKeyArn: string;
            plainText: string;
          };

          expect(response.outgoingKeyArn).toContain(":key/");
          expect(response.plainText.toUpperCase()).toBe(
            "41424344414243444142434441424344",
          );
        }),
    );
  });

  describe("GenerateCardValidationData", () => {
    test.provider("generates a CVV2 for a PAN + expiry", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/card`),
            { pan: "9123456789012345", expiry: "0130" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          cvv2: string;
        };

        expect(response.cvv2).toMatch(/^\d{3}$/);
      }),
    );
  });

  describe("VerifyCardValidationData", () => {
    test.provider(
      "verifies the generated CVV2 and rejects a tampered one",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/card`),
              { pan: "9123456789012345", expiry: "0130" },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            verifiedKeyArn: string;
            tampered: string;
          };

          expect(response.verifiedKeyArn).toContain(":key/");
          expect(response.tampered).toBe("verification-failed");
        }),
    );
  });

  describe("GeneratePinData / VerifyPinData / TranslatePinData", () => {
    test.provider(
      "issues a Visa PIN, verifies the PVV, and translates the PIN block",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/pin`),
              { pan: "9123456789012345" },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            pvv: string;
            verificationKeyArn: string;
            translatedKeyArn: string;
            translatedPinBlock: string;
          };

          expect(response.pvv).toMatch(/^\d+$/);
          expect(response.verificationKeyArn).toContain(":key/");
          // The translated block comes back under the outgoing PEK.
          expect(response.translatedKeyArn).toContain(":key/");
          expect(response.translatedKeyArn).not.toBe(
            response.verificationKeyArn,
          );
          expect(response.translatedPinBlock).toMatch(/^[0-9A-Fa-f]+$/);
        }),
    );
  });

  describe("GetPublicKeyCertificate", () => {
    test.provider(
      "exports the public key certificate of the signing key pair",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/public-key-cert`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            keyCertificate: string;
            keyCertificateChain: string;
          };

          expect(response.keyCertificate.length).toBeGreaterThan(0);
          expect(response.keyCertificateChain.length).toBeGreaterThan(0);
        }),
    );
  });
});
