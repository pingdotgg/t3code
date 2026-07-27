/**
 * KMS binding tests (Encrypt / Decrypt / GenerateDataKey* / ReEncrypt /
 * Sign / Verify / GenerateMac / VerifyMac / GetPublicKey /
 * DeriveSharedSecret / DescribeKey / GenerateRandom).
 *
 * COST + CLEANUP NOTE — the shared test keys:
 * KMS keys cost $1/mo while enabled and have a 7-day minimum pending-deletion
 * window (pending-deletion keys are NOT billed), so this suite neither keeps
 * permanently-enabled keys nor creates brand-new keys per run. The `Key`
 * resource has no user-assignable identity (only a cloud-generated keyId), so
 * it can't be adopted across runs from the scratch stack's in-memory state.
 * Instead FOUR standing keys (symmetric encryption, HMAC, ECDSA signing, and
 * ECDH key agreement — each crypto operation requires its matching KeyUsage)
 * are acquired/released out-of-band via distilled KMS around the whole suite:
 *
 * - During the run each key is addressed by its deterministic alias (see the
 *   `STANDING_*_ALIAS` constants in `handler.ts`).
 * - `beforeAll` (`ensureStandingKeys`) reclaims the previous run's keys — via
 *   the alias if an interrupted run left it behind, otherwise by each key's
 *   unique description — cancelling scheduled deletion and re-creating the
 *   alias. Only on the first-ever run (or >7 days after the last run) does
 *   it `createKey`.
 * - `afterAll` (`releaseStandingKeys`) deletes the aliases and schedules the
 *   keys for deletion (7-day window, idempotent) so a passing run leaves no
 *   aliases and no enabled/billed keys behind — PendingDeletion is KMS's
 *   terminal "deleted" state; keys pending deletion are not billed and
 *   cannot be removed any faster.
 * - The Lambda fixture binds the crypto operations by alias name — the
 *   bindings accept `Key | AliasName`, and the alias form scopes IAM with the
 *   `kms:RequestAlias` condition so the keys never need to live in the stack.
 *
 * The fixture stack (Lambda only) is destroyed normally.
 */
import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as kms from "@distilled.cloud/aws/kms";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import KMSTestFunctionLive, {
  KMSTestFunction,
  STANDING_AGREEMENT_KEY_ALIAS,
  STANDING_HMAC_KEY_ALIAS,
  STANDING_KEY_ALIAS,
  STANDING_SIGNING_KEY_ALIAS,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "KMSBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let standingKeyId: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class CryptoNotAuthorized extends Data.TaggedError("CryptoNotAuthorized") {}

class StandingKeyNotReady extends Data.TaggedError("StandingKeyNotReady")<{
  readonly actualState: kms.KeyState | undefined;
  readonly expectedState: kms.KeyState;
  readonly keyId: string;
}> {}

// Cold re-inits under parallel load surface as transient 5xx from the fixture
// — retry those; a genuine 4xx/assertion failure is returned immediately.
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

const postJson = (path: string, body: object) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}${path}`),
      body,
    ),
  ).pipe(Effect.flatMap((response) => response.json));

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((response) => response.json),
  );

const toBase64 = (value: string) =>
  Effect.sync(() => Buffer.from(value, "utf8").toString("base64"));

const fromBase64 = (value: string) =>
  Effect.sync(() => Buffer.from(value, "base64").toString("utf8"));

interface StandingKeySpec {
  readonly alias: `alias/${string}`;
  /**
   * Unique marker for the key. The alias is deleted at teardown, so this
   * description is what identifies the previous run's (pending-deletion)
   * key for reclaim.
   */
  readonly description: string;
  readonly keySpec?: kms.KeySpec;
  readonly keyUsage?: kms.KeyUsageType;
}

const RECLAIM_NOTE =
  "scheduled for deletion after each run, reclaimed by description (see test/AWS/KMS/Bindings.test.ts)";

const STANDING_KEYS: readonly StandingKeySpec[] = [
  {
    alias: STANDING_KEY_ALIAS,
    // Keep this exact text stable — it reclaims keys minted by earlier runs.
    description: `Shared key for alchemy AWS.KMS binding tests — ${RECLAIM_NOTE}`,
  },
  {
    alias: STANDING_HMAC_KEY_ALIAS,
    description: `Shared HMAC key for alchemy AWS.KMS binding tests — ${RECLAIM_NOTE}`,
    keySpec: "HMAC_256",
    keyUsage: "GENERATE_VERIFY_MAC",
  },
  {
    alias: STANDING_SIGNING_KEY_ALIAS,
    description: `Shared ECDSA signing key for alchemy AWS.KMS binding tests — ${RECLAIM_NOTE}`,
    keySpec: "ECC_NIST_P256",
    keyUsage: "SIGN_VERIFY",
  },
  {
    alias: STANDING_AGREEMENT_KEY_ALIAS,
    description: `Shared ECDH key-agreement key for alchemy AWS.KMS binding tests — ${RECLAIM_NOTE}`,
    keySpec: "ECC_NIST_P256",
    keyUsage: "KEY_AGREEMENT",
  },
];

/**
 * One scan of the account's customer keys, hydrated with metadata. Used to
 * reclaim previous runs' pending-deletion keys by their unique descriptions
 * once the aliases are gone.
 */
const scanKeyMetadatas = Effect.gen(function* () {
  const keys = yield* kms.listKeys.pages({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).flatMap((page) => page.Keys ?? [])),
  );
  return yield* Effect.all(
    keys.map((key) =>
      kms.describeKey({ KeyId: key.KeyId! }).pipe(
        Effect.map((response) => response.KeyMetadata),
        Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      ),
    ),
    { concurrency: 5 },
  );
});

/**
 * Wait for KMS's eventually-consistent state transition to become visible.
 * Ten seconds is ample in practice and keeps a broken transition bounded.
 */
const waitForKeyState = Effect.fn(function* (
  keyId: string,
  expectedState: kms.KeyState,
) {
  return yield* kms.describeKey({ KeyId: keyId }).pipe(
    Effect.flatMap((response) => {
      const actualState = response.KeyMetadata?.KeyState;
      return actualState === expectedState
        ? Effect.succeed(response.KeyMetadata!)
        : Effect.fail(
            new StandingKeyNotReady({
              actualState,
              expectedState,
              keyId,
            }),
          );
    }),
    Effect.retry({
      while: (error) => error._tag === "StandingKeyNotReady",
      schedule: Schedule.max([
        Schedule.fixed("250 millis"),
        Schedule.recurs(40),
      ]),
    }),
  );
});

/** Converge an existing (possibly pending-deletion/disabled) key to enabled. */
const reviveKey = Effect.fn(function* (metadata: kms.KeyMetadata) {
  const keyId = metadata.KeyId!;
  if (metadata.KeyState === "PendingDeletion") {
    yield* kms.cancelKeyDeletion({ KeyId: keyId });
    // CancelKeyDeletion leaves the key disabled, but that transition is not
    // immediately visible. Enabling or aliasing it too early is rejected as
    // KMSInvalidStateException (the c64 sweep's 17-test setup cascade).
    yield* waitForKeyState(keyId, "Disabled");
    yield* kms.enableKey({ KeyId: keyId });
  } else if (metadata.Enabled === false) {
    yield* kms.enableKey({ KeyId: keyId });
  }
  return yield* waitForKeyState(keyId, "Enabled");
});

/**
 * Acquire one standing key: reclaim the previous run's key (cancelling its
 * scheduled deletion and re-creating the alias), or create it on the
 * first-ever run. `scan` is the lazily-computed account key scan, shared
 * across the four keys.
 */
const ensureStandingKey = Effect.fn(function* (
  spec: StandingKeySpec,
  scanned: { metadatas?: readonly (kms.KeyMetadata | undefined)[] },
) {
  const existing = yield* kms.describeKey({ KeyId: spec.alias }).pipe(
    Effect.map((response) => response.KeyMetadata),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

  if (existing?.KeyId) {
    // The alias survived (a previous run was interrupted before release, or
    // external interference disabled the key) — converge to enabled.
    yield* reviveKey(existing);
    return existing.KeyId;
  }

  // Alias absent — the normal case after a clean release. Reclaim the
  // previous run's pending-deletion key by its unique description before
  // resorting to creating a new one.
  if (scanned.metadatas === undefined) {
    scanned.metadatas = yield* scanKeyMetadatas;
  }
  const reclaimed = scanned.metadatas?.find(
    (metadata) => metadata?.Description === spec.description,
  );
  const keyId = reclaimed?.KeyId
    ? yield* reviveKey(reclaimed).pipe(Effect.map(() => reclaimed.KeyId!))
    : yield* kms
        .createKey({
          Description: spec.description,
          KeySpec: spec.keySpec,
          KeyUsage: spec.keyUsage,
          Tags: [
            { TagKey: "alchemy:standing-fixture", TagValue: "kms-bindings" },
          ],
        })
        .pipe(
          Effect.flatMap((created) =>
            created.KeyMetadata?.KeyId
              ? Effect.succeed(created.KeyMetadata.KeyId)
              : Effect.die(new Error("createKey returned no key ID")),
          ),
        );

  yield* kms.createAlias({ AliasName: spec.alias, TargetKeyId: keyId }).pipe(
    // DescribeKey reaches Enabled before CreateAlias's internal view of the
    // key always converges. Retry only that exact transient state error.
    Effect.retry({
      while: (error) => error._tag === "KMSInvalidStateException",
      schedule: Schedule.max([
        Schedule.fixed("250 millis"),
        Schedule.recurs(40),
      ]),
    }),
    Effect.catchTag("AlreadyExistsException", () =>
      // Lost a create race with a parallel run: the alias already points at
      // another key. Schedule ours for deletion so it doesn't become an
      // orphan, and fall through to the alias's actual target.
      kms
        .scheduleKeyDeletion({ KeyId: keyId, PendingWindowInDays: 7 })
        .pipe(Effect.ignore),
    ),
  );
  // CreateAlias is eventually consistent: the immediate read-back can 404
  // under load. Retry the alias lookup for a bounded window.
  const described = yield* kms.describeKey({ KeyId: spec.alias }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFoundException",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(8),
      ]),
    }),
  );
  return described.KeyMetadata!.KeyId;
});

/** Acquire all four standing keys; returns the symmetric key's id. */
const ensureStandingKeys = Effect.gen(function* () {
  const scanned: { metadatas?: readonly (kms.KeyMetadata | undefined)[] } = {};
  let symmetricKeyId = "";
  for (const spec of STANDING_KEYS) {
    const keyId = yield* ensureStandingKey(spec, scanned);
    if (spec.alias === STANDING_KEY_ALIAS) {
      symmetricKeyId = keyId;
    }
  }
  return symmetricKeyId;
});

/**
 * Release the shared test keys: delete each alias and schedule its key for
 * deletion (7-day minimum window — KMS keys cannot be hard-deleted) so a
 * passing run leaves no aliases and no enabled/billed keys behind.
 * Idempotent — tolerates aliases/keys already gone or keys already pending
 * deletion (a concurrent run's release, or a re-run after partial teardown).
 */
const releaseStandingKeys = Effect.gen(function* () {
  const scanned: { metadatas?: readonly (kms.KeyMetadata | undefined)[] } = {};
  for (const spec of STANDING_KEYS) {
    const viaAlias = yield* kms.describeKey({ KeyId: spec.alias }).pipe(
      Effect.map((response) => response.KeyMetadata),
      Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
    );

    yield* kms
      .deleteAlias({ AliasName: spec.alias })
      .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

    // If the alias was already gone (interrupted earlier release), fall back
    // to the description lookup so an enabled key never survives teardown.
    if (viaAlias === undefined && scanned.metadatas === undefined) {
      scanned.metadatas = yield* scanKeyMetadatas;
    }
    const target =
      viaAlias ??
      scanned.metadatas?.find(
        (metadata) => metadata?.Description === spec.description,
      );
    if (target?.KeyId && target.KeyState !== "PendingDeletion") {
      yield* kms
        .scheduleKeyDeletion({ KeyId: target.KeyId, PendingWindowInDays: 7 })
        .pipe(
          // Already pending deletion (raced with another run) or already gone.
          Effect.catchTag(
            ["KMSInvalidStateException", "NotFoundException"],
            () => Effect.void,
          ),
        );
    }
  }
});

describe("KMS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("KMS test setup: ensuring standing keys");
      // `beforeAll` doesn't run inside `test.provider`'s environment, so
      // provide the AWS providers (Credentials/Region) explicitly for the
      // out-of-band distilled calls.
      standingKeyId = yield* Core.withProviders(
        ensureStandingKeys,
        testOptions,
        "KMSBindings",
      );
      yield* Effect.logInfo(
        `KMS test setup: standing key ${standingKeyId} (${STANDING_KEY_ALIAS})`,
      );

      yield* Effect.logInfo("KMS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("KMS test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* KMSTestFunction;
        }).pipe(Effect.provide(KMSTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `KMS test setup: probing readiness at ${baseUrl}/ready`,
      );
      yield* HttpClient.get(`${baseUrl}/ready`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // The fresh Lambda role's IAM policy propagates eventually — /ready
      // exercises no KMS permission, so also probe a full encrypt/decrypt
      // round-trip plus one operation per standing key (bounded) before
      // letting the tests run. Without this the first calls occasionally
      // land before the role policy is authorized.
      yield* Effect.logInfo("KMS test setup: probing crypto authorization");
      yield* Effect.gen(function* () {
        const probePlaintext = yield* toBase64("kms-iam-propagation-probe");
        const encrypted = (yield* postJson("/encrypt", {
          plaintextBase64: probePlaintext,
        })) as { ciphertextBase64?: string };
        if (!encrypted.ciphertextBase64) {
          return yield* Effect.fail(new CryptoNotAuthorized());
        }
        const decrypted = (yield* postJson("/decrypt", {
          ciphertextBase64: encrypted.ciphertextBase64,
        })) as { ok: boolean };
        if (!decrypted.ok) {
          return yield* Effect.fail(new CryptoNotAuthorized());
        }
        const mac = (yield* postJson("/mac", {
          messageBase64: probePlaintext,
        })) as { macBase64?: string };
        if (!mac.macBase64) {
          return yield* Effect.fail(new CryptoNotAuthorized());
        }
        const signed = (yield* postJson("/sign", {
          messageBase64: probePlaintext,
        })) as { signatureBase64?: string };
        if (!signed.signatureBase64) {
          return yield* Effect.fail(new CryptoNotAuthorized());
        }
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "CryptoNotAuthorized",
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(30),
          ]),
        }),
      );
    }),
    { timeout: 240_000 },
  );

  // Release the out-of-band keys even if the stack destroy fails — a passing
  // (or failing) run must never leave enabled KMS keys behind.
  afterAll(
    sharedStack
      .destroy()
      .pipe(
        Effect.ensuring(
          Core.withProviders(
            releaseStandingKeys,
            testOptions,
            "KMSBindings",
          ).pipe(Effect.orDie),
        ),
      ),
    { timeout: 120_000 },
  );

  describe("Encrypt", () => {
    test.provider("encrypts a payload under the standing key", (_stack) =>
      Effect.gen(function* () {
        const plaintextBase64 = yield* toBase64("alchemy kms encrypt");
        const response = (yield* postJson("/encrypt", {
          plaintextBase64,
        })) as { keyId?: string; ciphertextBase64?: string };

        expect(response.ciphertextBase64).toBeTruthy();
        expect(response.ciphertextBase64).not.toEqual(plaintextBase64);
        // KMS resolves the alias and reports the backing key ARN.
        expect(response.keyId).toContain(standingKeyId);
      }),
    );
  });

  describe("Decrypt", () => {
    test.provider("round-trips plaintext through encrypt/decrypt", (_stack) =>
      Effect.gen(function* () {
        const message = "alchemy kms round-trip: attack at dawn";
        const encrypted = (yield* postJson("/encrypt", {
          plaintextBase64: yield* toBase64(message),
          context: { tenant: "alchemy-test" },
        })) as { ciphertextBase64: string };

        const decrypted = (yield* postJson("/decrypt", {
          ciphertextBase64: encrypted.ciphertextBase64,
          context: { tenant: "alchemy-test" },
        })) as { ok: boolean; keyId?: string; plaintextBase64?: string };

        expect(decrypted.ok).toBe(true);
        expect(yield* fromBase64(decrypted.plaintextBase64!)).toEqual(message);
        expect(decrypted.keyId).toContain(standingKeyId);
      }),
    );

    test.provider(
      "fails with a typed InvalidCiphertextException on context mismatch",
      (_stack) =>
        Effect.gen(function* () {
          const encrypted = (yield* postJson("/encrypt", {
            plaintextBase64: yield* toBase64("context-bound secret"),
            context: { tenant: "alpha" },
          })) as { ciphertextBase64: string };

          const decrypted = (yield* postJson("/decrypt", {
            ciphertextBase64: encrypted.ciphertextBase64,
            context: { tenant: "beta" },
          })) as { ok: boolean; error?: string };

          expect(decrypted.ok).toBe(false);
          expect(decrypted.error).toEqual("InvalidCiphertextException");
        }),
    );
  });

  describe("GenerateDataKey", () => {
    test.provider(
      "returns a plaintext data key whose ciphertext blob decrypts back",
      (_stack) =>
        Effect.gen(function* () {
          const generated = (yield* postJson("/generate-data-key", {})) as {
            keyId?: string;
            plaintextBase64?: string;
            ciphertextBase64?: string;
          };

          expect(generated.plaintextBase64).toBeTruthy();
          expect(generated.ciphertextBase64).toBeTruthy();
          expect(generated.keyId).toContain(standingKeyId);
          // AES_256 data key = 32 bytes.
          const dataKey = yield* Effect.sync(() =>
            Buffer.from(generated.plaintextBase64!, "base64"),
          );
          expect(dataKey.length).toBe(32);

          // The encrypted copy must decrypt (via the Decrypt binding) back to
          // the exact plaintext data key.
          const decrypted = (yield* postJson("/decrypt", {
            ciphertextBase64: generated.ciphertextBase64,
          })) as { ok: boolean; plaintextBase64?: string };

          expect(decrypted.ok).toBe(true);
          expect(decrypted.plaintextBase64).toEqual(generated.plaintextBase64);
        }),
    );
  });

  describe("GenerateDataKeyWithoutPlaintext", () => {
    test.provider(
      "returns only a ciphertext blob that decrypts to a 32-byte key",
      (_stack) =>
        Effect.gen(function* () {
          const generated = (yield* postJson(
            "/generate-data-key-without-plaintext",
            {},
          )) as { keyId?: string; ciphertextBase64?: string };

          expect(generated.ciphertextBase64).toBeTruthy();
          expect(generated.keyId).toContain(standingKeyId);

          const decrypted = (yield* postJson("/decrypt", {
            ciphertextBase64: generated.ciphertextBase64,
          })) as { ok: boolean; plaintextBase64?: string };

          expect(decrypted.ok).toBe(true);
          const dataKey = yield* Effect.sync(() =>
            Buffer.from(decrypted.plaintextBase64!, "base64"),
          );
          expect(dataKey.length).toBe(32);
        }),
    );
  });

  describe("GenerateDataKeyPair", () => {
    test.provider(
      "returns a key pair whose private blob decrypts back to the plaintext",
      (_stack) =>
        Effect.gen(function* () {
          const generated = (yield* postJson(
            "/generate-data-key-pair",
            {},
          )) as {
            keyId?: string;
            keyPairSpec?: string;
            publicKeyBase64?: string;
            privateKeyPlaintextBase64?: string;
            privateKeyCiphertextBase64?: string;
          };

          expect(generated.keyPairSpec).toEqual("ECC_NIST_P256");
          expect(generated.publicKeyBase64).toBeTruthy();
          expect(generated.privateKeyPlaintextBase64).toBeTruthy();
          expect(generated.privateKeyCiphertextBase64).toBeTruthy();

          const decrypted = (yield* postJson("/decrypt", {
            ciphertextBase64: generated.privateKeyCiphertextBase64,
          })) as { ok: boolean; plaintextBase64?: string };

          expect(decrypted.ok).toBe(true);
          expect(decrypted.plaintextBase64).toEqual(
            generated.privateKeyPlaintextBase64,
          );
        }),
    );
  });

  describe("GenerateDataKeyPairWithoutPlaintext", () => {
    test.provider(
      "returns a public key and an encrypted private key only",
      (_stack) =>
        Effect.gen(function* () {
          const generated = (yield* postJson(
            "/generate-data-key-pair-without-plaintext",
            {},
          )) as {
            publicKeyBase64?: string;
            privateKeyCiphertextBase64?: string;
          };

          expect(generated.publicKeyBase64).toBeTruthy();
          expect(generated.privateKeyCiphertextBase64).toBeTruthy();

          const decrypted = (yield* postJson("/decrypt", {
            ciphertextBase64: generated.privateKeyCiphertextBase64,
          })) as { ok: boolean; plaintextBase64?: string };
          expect(decrypted.ok).toBe(true);
          expect(decrypted.plaintextBase64).toBeTruthy();
        }),
    );
  });

  describe("ReEncrypt", () => {
    test.provider(
      "rotates the encryption context without exposing the plaintext",
      (_stack) =>
        Effect.gen(function* () {
          const message = "re-encrypt me in place";
          const encrypted = (yield* postJson("/encrypt", {
            plaintextBase64: yield* toBase64(message),
            context: { tenant: "alpha" },
          })) as { ciphertextBase64: string };

          const reEncrypted = (yield* postJson("/re-encrypt", {
            ciphertextBase64: encrypted.ciphertextBase64,
            sourceContext: { tenant: "alpha" },
            destinationContext: { tenant: "beta" },
          })) as {
            keyId?: string;
            sourceKeyId?: string;
            ciphertextBase64?: string;
          };

          expect(reEncrypted.ciphertextBase64).toBeTruthy();
          expect(reEncrypted.ciphertextBase64).not.toEqual(
            encrypted.ciphertextBase64,
          );
          expect(reEncrypted.keyId).toContain(standingKeyId);

          const decrypted = (yield* postJson("/decrypt", {
            ciphertextBase64: reEncrypted.ciphertextBase64,
            context: { tenant: "beta" },
          })) as { ok: boolean; plaintextBase64?: string };

          expect(decrypted.ok).toBe(true);
          expect(yield* fromBase64(decrypted.plaintextBase64!)).toEqual(
            message,
          );
        }),
    );
  });

  describe("DescribeKey", () => {
    test.provider("describes the bound key through the alias", (_stack) =>
      Effect.gen(function* () {
        const described = (yield* getJson("/describe-key")) as {
          keyId?: string;
          keySpec?: string;
          keyState?: string;
        };
        expect(described.keyId).toEqual(standingKeyId);
        expect(described.keySpec).toEqual("SYMMETRIC_DEFAULT");
        expect(described.keyState).toEqual("Enabled");
      }),
    );
  });

  describe("GenerateMac / VerifyMac", () => {
    test.provider("computes an HMAC that verifies", (_stack) =>
      Effect.gen(function* () {
        const messageBase64 = yield* toBase64("hmac-protected payload");
        const mac = (yield* postJson("/mac", { messageBase64 })) as {
          macBase64?: string;
        };
        expect(mac.macBase64).toBeTruthy();

        const verified = (yield* postJson("/verify-mac", {
          messageBase64,
          macBase64: mac.macBase64,
        })) as { ok: boolean; macValid?: boolean };

        expect(verified.ok).toBe(true);
        expect(verified.macValid).toBe(true);
      }),
    );

    test.provider(
      "rejects a tampered message with a typed KMSInvalidMacException",
      (_stack) =>
        Effect.gen(function* () {
          const mac = (yield* postJson("/mac", {
            messageBase64: yield* toBase64("original message"),
          })) as { macBase64?: string };

          const verified = (yield* postJson("/verify-mac", {
            messageBase64: yield* toBase64("tampered message"),
            macBase64: mac.macBase64,
          })) as { ok: boolean; error?: string };

          expect(verified.ok).toBe(false);
          expect(verified.error).toEqual("KMSInvalidMacException");
        }),
    );
  });

  describe("Sign / Verify", () => {
    test.provider("signs a message that verifies inside KMS", (_stack) =>
      Effect.gen(function* () {
        const messageBase64 = yield* toBase64("release-manifest-v1");
        const signed = (yield* postJson("/sign", { messageBase64 })) as {
          signatureBase64?: string;
        };
        expect(signed.signatureBase64).toBeTruthy();

        const verified = (yield* postJson("/verify", {
          messageBase64,
          signatureBase64: signed.signatureBase64,
        })) as { ok: boolean; signatureValid?: boolean };

        expect(verified.ok).toBe(true);
        expect(verified.signatureValid).toBe(true);
      }),
    );

    test.provider(
      "rejects a tampered message with a typed KMSInvalidSignatureException",
      (_stack) =>
        Effect.gen(function* () {
          const signed = (yield* postJson("/sign", {
            messageBase64: yield* toBase64("original manifest"),
          })) as { signatureBase64?: string };

          const verified = (yield* postJson("/verify", {
            messageBase64: yield* toBase64("forged manifest"),
            signatureBase64: signed.signatureBase64,
          })) as { ok: boolean; error?: string };

          expect(verified.ok).toBe(false);
          expect(verified.error).toEqual("KMSInvalidSignatureException");
        }),
    );
  });

  describe("GetPublicKey", () => {
    test.provider(
      "downloads the signing key's DER-encoded public key",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/public-key")) as {
            keyUsage?: string;
            publicKeyBase64?: string;
            signingAlgorithms?: string[];
          };
          expect(response.keyUsage).toEqual("SIGN_VERIFY");
          expect(response.publicKeyBase64).toBeTruthy();
          expect(response.signingAlgorithms).toContain("ECDSA_SHA_256");
        }),
    );
  });

  describe("DeriveSharedSecret", () => {
    test.provider(
      "KMS-side ECDH matches a locally computed shared secret",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/derive-shared-secret", {})) as {
            byteLength?: number;
            match?: boolean;
          };
          // P-256 ECDH shared secret = 32 bytes.
          expect(response.byteLength).toBe(32);
          expect(response.match).toBe(true);
        }),
    );
  });

  describe("GenerateRandom", () => {
    test.provider("returns distinct 32-byte random payloads", (_stack) =>
      Effect.gen(function* () {
        const first = (yield* postJson("/random", {})) as {
          randomBase64?: string;
        };
        const second = (yield* postJson("/random", {})) as {
          randomBase64?: string;
        };
        expect(first.randomBase64).toBeTruthy();
        expect(second.randomBase64).toBeTruthy();
        const bytes = yield* Effect.sync(() =>
          Buffer.from(first.randomBase64!, "base64"),
        );
        expect(bytes.length).toBe(32);
        expect(first.randomBase64).not.toEqual(second.randomBase64);
      }),
    );
  });

  describe("least privilege", () => {
    test.provider(
      "the role only receives the bound actions (kms:GetKeyRotationStatus is denied)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/unauthorized")) as {
            ok: boolean;
            error?: string;
          };

          expect(response.ok).toBe(false);
          expect(response.error).toEqual("AccessDeniedException");
        }),
    );
  });
});
