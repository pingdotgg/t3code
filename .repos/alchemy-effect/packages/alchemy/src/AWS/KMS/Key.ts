import * as kms from "@distilled.cloud/aws/kms";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { toWireDays } from "../../Util/Duration.ts";

export type KeyId = string;
export type KeyArn = `arn:aws:kms:${RegionID}:${AccountID}:key/${KeyId}`;

export type { KeySpec, KeyState, KeyUsageType } from "@distilled.cloud/aws/kms";

export interface KeyProps {
  /**
   * Description for the KMS key.
   */
  description?: string;
  /**
   * Cryptographic operations that the key supports.
   * @default "ENCRYPT_DECRYPT"
   */
  keyUsage?: kms.KeyUsageType;
  /**
   * Type of key material for the KMS key.
   * @default "SYMMETRIC_DEFAULT"
   */
  keySpec?: kms.KeySpec;
  /**
   * Key policy, either as a structured {@link PolicyDocument} or a raw JSON
   * string (escape hatch). If omitted, AWS creates and manages the default
   * key policy.
   */
  policy?: PolicyDocument | string;
  /**
   * Whether to bypass KMS policy lockout safety checks when creating or updating
   * the key policy.
   * @default false
   */
  bypassPolicyLockoutSafetyCheck?: boolean;
  /**
   * Whether the KMS key is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Whether automatic key rotation is enabled.
   * @default false
   */
  enableKeyRotation?: boolean;
  /**
   * Rotation period when automatic key rotation is enabled. Accepts any
   * `Duration.Input` (e.g. `"90 days"`, `Duration.days(90)`; a bare number
   * is milliseconds); the wire unit is whole days.
   */
  rotationPeriod?: Duration.Input;
  /**
   * Whether to create a multi-region primary key.
   * @default false
   */
  multiRegion?: boolean;
  /**
   * Waiting period before AWS permanently deletes the key after destroy
   * schedules deletion. Accepts any `Duration.Input` (e.g. `"7 days"`,
   * `Duration.days(7)`; a bare number is milliseconds); the wire unit is
   * whole days.
   * @default 30 days
   */
  deletionWindow?: Duration.Input;
  /**
   * User-defined tags to apply to the key.
   */
  tags?: Record<string, string>;
}

export interface Key extends Resource<
  "AWS.KMS.Key",
  KeyProps,
  {
    keyId: KeyId;
    keyArn: KeyArn;
    description: string | undefined;
    keyUsage: kms.KeyUsageType;
    keySpec: kms.KeySpec;
    keyState: kms.KeyState | undefined;
    enabled: boolean;
    keyRotationEnabled: boolean | undefined;
    rotationPeriodInDays: number | undefined;
    multiRegion: boolean;
    policy: string | undefined;
    deletionWindowInDays: number;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A customer managed AWS KMS key.
 *
 * @section Creating Keys
 * @example Symmetric Encryption Key
 * ```typescript
 * import * as KMS from "alchemy/AWS/KMS";
 *
 * const key = yield* KMS.Key("AppKey", {
 *   description: "Application encryption key",
 *   enableKeyRotation: true,
 *   deletionWindow: "7 days",
 * });
 * ```
 *
 * @section Key Policies
 * @example Key with Inline Policy
 * ```typescript
 * const key = yield* KMS.Key("PolicyKey", {
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { AWS: "arn:aws:iam::123456789012:root" },
 *       Action: ["kms:*"],
 *       Resource: "*",
 *     }],
 *   },
 * });
 * ```
 *
 * @section Runtime Operations
 * Bind the KMS crypto operations to the key inside a Lambda function.
 * Each binding grants least-privilege IAM (the exact key ARN) and injects
 * the `KeyId` automatically.
 *
 * @example Encrypt and Decrypt from a Lambda Function
 * ```typescript
 * // init
 * const key = yield* AWS.KMS.Key("AppKey");
 * const encrypt = yield* AWS.KMS.Encrypt(key);
 * const decrypt = yield* AWS.KMS.Decrypt(key);
 *
 * // runtime
 * const { CiphertextBlob } = yield* encrypt({
 *   Plaintext: new TextEncoder().encode("secret"),
 * });
 * const { Plaintext } = yield* decrypt({ CiphertextBlob });
 * ```
 *
 * @example Envelope Encryption with a Data Key
 * ```typescript
 * // init
 * const generateDataKey = yield* AWS.KMS.GenerateDataKey(key);
 *
 * // runtime — encrypt locally with the plaintext key, store the blob
 * const { Plaintext, CiphertextBlob } = yield* generateDataKey({
 *   KeySpec: "AES_256",
 * });
 * ```
 */
export const Key = Resource<Key>("AWS.KMS.Key");

const defaultKeyUsage = "ENCRYPT_DECRYPT" as const;
const defaultKeySpec = "SYMMETRIC_DEFAULT" as const;
const defaultDeletionWindowInDays = 30;

export const KeyProvider = () =>
  Provider.succeed(Key, {
    stables: ["keyId", "keyArn"],
    list: () =>
      Effect.gen(function* () {
        const keys = yield* kms.listKeys.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.Keys ?? [])
                .map((key) => key.KeyId)
                .filter((keyId): keyId is string => keyId !== undefined),
            ),
          ),
        );

        const hydrated = yield* Effect.forEach(
          keys,
          (keyId) =>
            readKey({
              keyId,
              deletionWindowInDays: defaultDeletionWindowInDays,
            }),
          { concurrency: 5 },
        );

        return hydrated.filter(
          (key): key is Key["Attributes"] =>
            key !== undefined && key.keyState !== "PendingDeletion",
        );
      }),
    read: Effect.fn(function* ({ olds = {}, output }) {
      // KMS keys have no stable user-assignable identity — only a
      // cloud-generated keyId — so there is nothing to adopt. We only refresh
      // a key we already own (via output.keyId); with no prior output the
      // engine treats this as a greenfield create and mints a fresh key.
      if (!output?.keyId) return undefined;
      return yield* readKey({
        keyId: output.keyId,
        deletionWindowInDays:
          output.deletionWindowInDays ??
          toWireDays(olds.deletionWindow) ??
          defaultDeletionWindowInDays,
      });
    }),
    diff: Effect.fn(function* ({ news = {}, olds = {} }) {
      if (!isResolved(news)) return;
      if (
        (news.keyUsage ?? defaultKeyUsage) !==
          (olds.keyUsage ?? defaultKeyUsage) ||
        (news.keySpec ?? defaultKeySpec) !== (olds.keySpec ?? defaultKeySpec) ||
        (news.multiRegion ?? false) !== (olds.multiRegion ?? false)
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
      const internalTags = yield* createInternalTags(id);
      const desiredTags = { ...internalTags, ...news.tags };
      const keyUsage = news.keyUsage ?? defaultKeyUsage;
      const keySpec = news.keySpec ?? defaultKeySpec;
      const enabled = news.enabled ?? true;
      const enableKeyRotation = news.enableKeyRotation ?? false;
      const multiRegion = news.multiRegion ?? false;
      const deletionWindowInDays =
        toWireDays(news.deletionWindow) ?? defaultDeletionWindowInDays;
      const rotationPeriodInDays = toWireDays(news.rotationPeriod);
      const desiredPolicy =
        news.policy === undefined
          ? undefined
          : typeof news.policy === "string"
            ? news.policy
            : stringifyPolicyDocument(news.policy);

      // Observe via the cached identifier only — no tag-based discovery. On a
      // create or replacement the engine calls reconcile with
      // `output === undefined`, so we fall through to `createKey` and mint a
      // fresh key rather than adopting an unrelated one (which would collapse a
      // replacement into a no-op).
      let state = output?.keyId
        ? yield* readKey({ keyId: output.keyId, deletionWindowInDays })
        : undefined;

      if (state?.keyState === "PendingDeletion") {
        yield* kms
          .cancelKeyDeletion({ KeyId: state.keyId })
          .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        state = yield* readKey({ keyId: state.keyId, deletionWindowInDays });
      }

      if (state === undefined) {
        const created = yield* kms.createKey({
          Description: news.description,
          KeyUsage: keyUsage,
          KeySpec: keySpec,
          Policy: desiredPolicy,
          BypassPolicyLockoutSafetyCheck: news.bypassPolicyLockoutSafetyCheck,
          Tags: toKmsTags(desiredTags),
          MultiRegion: multiRegion,
        });
        const keyId = created.KeyMetadata?.KeyId;
        if (!keyId) {
          return yield* Effect.die(new Error("createKey returned no key ID"));
        }
        state = yield* readKey({ keyId, deletionWindowInDays });
        if (!state) {
          return yield* Effect.die(
            new Error(`failed to read created KMS key ${keyId}`),
          );
        }
      }

      const desiredDescription = news.description ?? "";
      if ((state.description ?? "") !== desiredDescription) {
        yield* kms
          .updateKeyDescription({
            KeyId: state.keyId,
            Description: desiredDescription,
          })
          .pipe(
            Effect.retry({
              while: isKmsEventuallyConsistent,
              schedule: kmsRetrySchedule,
            }),
          );
      }

      if (enabled && !state.enabled) {
        yield* kms.enableKey({ KeyId: state.keyId }).pipe(
          Effect.retry({
            while: isKmsEventuallyConsistent,
            schedule: kmsRetrySchedule,
          }),
        );
      }

      if (
        desiredPolicy !== undefined &&
        !samePolicy(state.policy, desiredPolicy)
      ) {
        yield* kms
          .putKeyPolicy({
            KeyId: state.keyId,
            PolicyName: "default",
            Policy: desiredPolicy,
            BypassPolicyLockoutSafetyCheck: news.bypassPolicyLockoutSafetyCheck,
          })
          .pipe(
            Effect.retry({
              while: isKmsEventuallyConsistent,
              schedule: kmsRetrySchedule,
            }),
          );
      }

      if (
        enableKeyRotation &&
        (state.keyRotationEnabled !== true ||
          (rotationPeriodInDays !== undefined &&
            state.rotationPeriodInDays !== rotationPeriodInDays))
      ) {
        yield* kms
          .enableKeyRotation({
            KeyId: state.keyId,
            RotationPeriodInDays: rotationPeriodInDays,
          })
          .pipe(
            Effect.retry({
              while: isKmsEventuallyConsistent,
              schedule: kmsRetrySchedule,
            }),
          );
      } else if (!enableKeyRotation && state.keyRotationEnabled) {
        yield* kms.disableKeyRotation({ KeyId: state.keyId }).pipe(
          Effect.retry({
            while: isKmsEventuallyConsistent,
            schedule: kmsRetrySchedule,
          }),
        );
      }

      if (!enabled && state.enabled) {
        yield* kms.disableKey({ KeyId: state.keyId }).pipe(
          Effect.retry({
            while: isKmsEventuallyConsistent,
            schedule: kmsRetrySchedule,
          }),
        );
      }

      const observedTags = yield* listKeyTags(state.keyId);
      const { removed, upsert } = diffTags(observedTags, desiredTags);
      if (upsert.length > 0) {
        yield* kms
          .tagResource({
            KeyId: state.keyId,
            Tags: toKmsTags(
              Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
            ),
          })
          .pipe(
            Effect.retry({
              while: isKmsEventuallyConsistent,
              schedule: kmsRetrySchedule,
            }),
          );
      }
      if (removed.length > 0) {
        yield* kms
          .untagResource({
            KeyId: state.keyId,
            TagKeys: removed,
          })
          .pipe(
            Effect.retry({
              while: isKmsEventuallyConsistent,
              schedule: kmsRetrySchedule,
            }),
          );
      }

      const updated = yield* readConvergedKey({
        keyId: state.keyId,
        deletionWindowInDays,
        desiredDescription,
        desiredEnabled: enabled,
        desiredKeyRotationEnabled: enableKeyRotation,
        desiredPolicy,
        desiredRotationPeriodInDays: rotationPeriodInDays,
        desiredTags,
      });

      yield* session.note(updated.keyArn);
      return updated;
    }),
    delete: Effect.fn(function* ({ output, session }) {
      yield* kms
        .scheduleKeyDeletion({
          KeyId: output.keyId,
          PendingWindowInDays: output.deletionWindowInDays,
        })
        .pipe(
          Effect.catchTag("NotFoundException", () => Effect.void),
          Effect.catchTag("KMSInvalidStateException", () => Effect.void),
        );

      const remaining = yield* Effect.repeat(
        kms.describeKey({ KeyId: output.keyId }).pipe(
          Effect.map((response) => response.KeyMetadata?.KeyState),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        ),
        {
          schedule: Schedule.fixed("250 millis"),
          until: (state) => state === undefined || state === "PendingDeletion",
          times: 20,
        },
      );
      if (remaining !== undefined && remaining !== "PendingDeletion") {
        yield* Effect.die(
          new Error(
            `KMS key ${output.keyId} remained ${remaining} after scheduling deletion`,
          ),
        );
      }
      yield* session.note(`Scheduled KMS key deletion: ${output.keyId}`);
    }),
  });

const readKey = Effect.fn(function* ({
  keyId,
  deletionWindowInDays,
}: {
  keyId: string;
  deletionWindowInDays: number;
}) {
  const described = yield* kms
    .describeKey({ KeyId: keyId })
    .pipe(
      Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
    );

  const metadata = described?.KeyMetadata;
  if (!metadata?.Arn) return undefined;
  if (metadata.KeyManager !== undefined && metadata.KeyManager !== "CUSTOMER") {
    return undefined;
  }

  const [tags, rotation, policy] = yield* Effect.all(
    [
      listKeyTags(metadata.KeyId),
      readKeyRotation(metadata.KeyId),
      readKeyPolicy(metadata.KeyId),
    ],
    { concurrency: "unbounded" },
  );

  return toAttrs({
    metadata,
    tags,
    rotation,
    policy,
    deletionWindowInDays,
  });
});

const readConvergedKey = Effect.fn(function* ({
  keyId,
  deletionWindowInDays,
  desiredDescription,
  desiredEnabled,
  desiredKeyRotationEnabled,
  desiredPolicy,
  desiredRotationPeriodInDays,
  desiredTags,
}: {
  keyId: string;
  deletionWindowInDays: number;
  desiredDescription: string;
  desiredEnabled: boolean;
  desiredKeyRotationEnabled: boolean;
  desiredPolicy: string | undefined;
  desiredRotationPeriodInDays: number | undefined;
  desiredTags: Record<string, string>;
}) {
  const observeConverged = Effect.gen(function* () {
    const key = yield* readKey({ keyId, deletionWindowInDays });
    if (!key) {
      return yield* Effect.fail(new KmsKeyNotConverged());
    }
    if ((key.description ?? "") !== desiredDescription) {
      return yield* Effect.fail(new KmsKeyNotConverged());
    }
    if (key.enabled !== desiredEnabled) {
      return yield* Effect.fail(new KmsKeyNotConverged());
    }
    if (
      !Object.entries(desiredTags).every(
        ([name, value]) => key.tags[name] === value,
      ) ||
      !Object.keys(key.tags).every(
        (name) => desiredTags[name] === key.tags[name],
      )
    ) {
      return yield* Effect.fail(new KmsKeyNotConverged());
    }
    if (desiredPolicy !== undefined && !samePolicy(key.policy, desiredPolicy)) {
      return yield* Effect.fail(new KmsKeyNotConverged());
    }
    if (desiredEnabled) {
      if (desiredKeyRotationEnabled && key.keyRotationEnabled !== true) {
        return yield* Effect.fail(new KmsKeyNotConverged());
      }
      if (!desiredKeyRotationEnabled && key.keyRotationEnabled === true) {
        return yield* Effect.fail(new KmsKeyNotConverged());
      }
      if (
        desiredKeyRotationEnabled &&
        desiredRotationPeriodInDays !== undefined &&
        key.rotationPeriodInDays !== desiredRotationPeriodInDays
      ) {
        return yield* Effect.fail(new KmsKeyNotConverged());
      }
    }
    return key;
  });

  return yield* Effect.gen(function* () {
    // KMS reads can briefly move backwards after a successful mutation (for
    // example, GetKeyPolicy may serve the new policy once and then an older
    // replica's default policy). A single matching read is therefore not a
    // sufficient convergence signal under high concurrency. Require two
    // consecutive observations before returning the resource to the engine.
    yield* observeConverged;
    yield* Effect.sleep("500 millis");
    return yield* observeConverged;
  }).pipe(
    Effect.retry({
      while: (error: { _tag: string }) =>
        error._tag === "KmsKeyNotConverged" || isKmsEventuallyConsistent(error),
      schedule: kmsRetrySchedule,
    }),
  );
});

const listKeyTags = Effect.fn(function* (keyId: string) {
  const pages = yield* kms.listResourceTags.pages({ KeyId: keyId }).pipe(
    Stream.runCollect,
    Effect.catchTag("NotFoundException", () => Effect.succeed([])),
  );

  return toTagRecord(Array.from(pages).flatMap((page) => page.Tags ?? []));
});

const readKeyRotation = Effect.fn(function* (keyId: string) {
  return yield* kms.getKeyRotationStatus({ KeyId: keyId }).pipe(
    Effect.map((response) => ({
      enabled: response.KeyRotationEnabled,
      periodInDays: response.RotationPeriodInDays,
    })),
    Effect.catchTag("UnsupportedOperationException", () =>
      Effect.succeed(undefined),
    ),
    Effect.catchTag("KMSInvalidStateException", () =>
      Effect.succeed(undefined),
    ),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );
});

const readKeyPolicy = Effect.fn(function* (keyId: string) {
  return yield* kms.getKeyPolicy({ KeyId: keyId, PolicyName: "default" }).pipe(
    Effect.map((response) => response.Policy),
    Effect.catchTag("KMSInvalidStateException", () =>
      Effect.succeed(undefined),
    ),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );
});

const toAttrs = ({
  metadata,
  tags,
  rotation,
  policy,
  deletionWindowInDays,
}: {
  metadata: kms.KeyMetadata;
  tags: Record<string, string>;
  rotation: { enabled?: boolean; periodInDays?: number } | undefined;
  policy: string | undefined;
  deletionWindowInDays: number;
}): Key["Attributes"] => ({
  keyId: metadata.KeyId,
  keyArn: metadata.Arn as KeyArn,
  description: metadata.Description,
  keyUsage: metadata.KeyUsage ?? defaultKeyUsage,
  keySpec: metadata.KeySpec ?? defaultKeySpec,
  keyState: metadata.KeyState,
  enabled: metadata.Enabled ?? false,
  keyRotationEnabled: rotation?.enabled,
  rotationPeriodInDays: rotation?.periodInDays,
  multiRegion: metadata.MultiRegion ?? false,
  policy,
  deletionWindowInDays,
  tags,
});

const toTagRecord = (tags: kms.Tag[] | undefined): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is kms.Tag =>
          typeof tag.TagKey === "string" && typeof tag.TagValue === "string",
      )
      .map((tag) => [tag.TagKey, tag.TagValue]),
  );

const toKmsTags = (tags: Record<string, string>): kms.Tag[] =>
  Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue }));

/**
 * Compare the observed key policy against the desired one using the shared
 * IAM canonicalizer so a re-deploy of an equivalent document (different key
 * order, whitespace, or PolicyDocument-vs-string form) is a no-op.
 */
const samePolicy = (
  observed: string | undefined,
  desired: string | undefined,
) => {
  if (observed === desired) return true;
  if (observed === undefined || desired === undefined) return false;
  return normalizePolicyDocument(observed) === normalizePolicyDocument(desired);
};

const isKmsEventuallyConsistent = (error: { _tag: string }) =>
  error._tag === "DependencyTimeoutException" ||
  error._tag === "KMSInternalException" ||
  error._tag === "KMSInvalidStateException";

class KmsKeyNotConverged extends Error {
  readonly _tag = "KmsKeyNotConverged";
}

const kmsRetrySchedule = Schedule.max([
  Schedule.exponential(250),
  Schedule.recurs(7),
]);
