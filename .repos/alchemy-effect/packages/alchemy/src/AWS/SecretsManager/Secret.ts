import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export interface GenerateSecretStringProps
  extends secretsmanager.GetRandomPasswordRequest {
  /**
   * JSON template merged with the generated password.
   * @default "{}"
   */
  secretStringTemplate?: string;
  /**
   * Key written into the generated secret payload.
   * @default "password"
   */
  generateStringKey?: string;
}

export interface SecretProps {
  /**
   * Secret name. If omitted, Alchemy generates a deterministic physical name.
   */
  name?: string;
  /**
   * Optional description for the secret.
   */
  description?: string;
  /**
   * Optional KMS key used to encrypt the secret.
   */
  kmsKeyId?: string;
  /**
   * Plain string secret value.
   */
  secretString?: Redacted.Redacted<string>;
  /**
   * Binary secret value.
   */
  secretBinary?: Redacted.Redacted<Uint8Array<ArrayBufferLike>>;
  /**
   * Generate a password and store it inside a JSON secret string.
   */
  generateSecretString?: GenerateSecretStringProps;
  /**
   * Resource-based permission policy attached to the secret
   * (`PutResourcePolicy`). Accepts a typed {@link PolicyDocument} or a raw
   * JSON string as an escape hatch (e.g. for adoption of an existing
   * policy). Omitting the prop removes any policy previously attached by
   * Alchemy.
   */
  resourcePolicy?: PolicyDocument | string;
  /**
   * User-defined tags for the secret.
   */
  tags?: Record<string, string>;
}

export interface Secret extends Resource<
  "AWS.SecretsManager.Secret",
  SecretProps,
  {
    /**
     * ARN of the secret.
     */
    secretArn: string;
    /**
     * Name of the secret.
     */
    secretName: string;
    /**
     * Version ID of the `AWSCURRENT` secret value, if a value has been set.
     */
    versionId: string | undefined;
    /**
     * Description of the secret.
     */
    description: string | undefined;
    /**
     * KMS key ID (or ARN) used to encrypt the secret value, if a
     * customer-managed key was configured.
     */
    kmsKeyId: string | undefined;
    /**
     * Tags on the secret.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Secrets Manager secret.
 *
 * `Secret` owns the lifecycle of the secret metadata and current value. It can
 * store a caller-provided value or generate a password-backed JSON payload for
 * downstream resources such as Aurora clusters and RDS proxies.
 * @resource
 * @section Creating Secrets
 * @example Static Secret String
 * ```typescript
 * const secret = yield* Secret("DbSecret", {
 *   secretString: Redacted.make(JSON.stringify({
 *     username: "app",
 *     password: "super-secret",
 *   })),
 * });
 * ```
 *
 * @example Generated Password Secret
 * ```typescript
 * const secret = yield* Secret("DbSecret", {
 *   generateSecretString: {
 *     secretStringTemplate: JSON.stringify({ username: "app" }),
 *     generateStringKey: "password",
 *     PasswordLength: 32,
 *   },
 * });
 * ```
 *
 * @section Resource Policies
 * @example Typed Resource Policy
 * ```typescript
 * const secret = yield* Secret("SharedSecret", {
 *   secretString: Redacted.make("shared-value"),
 *   resourcePolicy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: `arn:aws:iam::${accountId}:root` },
 *         Action: ["secretsmanager:GetSecretValue"],
 *         Resource: "*",
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const Secret = Resource<Secret>("AWS.SecretsManager.Secret");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

/**
 * Bounded retry through the async `ForceDeleteWithoutRecovery` window
 * (`InvalidRequestException` "already scheduled for deletion"; force
 * deletions complete within seconds).
 *
 * Expressed as an explicitly-typed helper: inlining `Effect.retry` here
 * leaves `Retry.Return`'s conditional type unresolved in the provider's
 * inferred layer type, which TypeScript's declaration emit widens to an
 * `unknown` R — poisoning the whole `AWS.providers()` union for every
 * downstream consumer.
 */
const retryThroughDeletionWindow = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InvalidRequestException" &&
      isDeletionInProgress((e as { Message?: string }).Message),
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

const isDeletionInProgress = (message: string | undefined): boolean => {
  const normalized = message?.toLowerCase();
  return (
    normalized?.includes("scheduled for deletion") === true ||
    normalized?.includes("marked for deletion") === true
  );
};

class SecretNotVisible extends Data.TaggedError("SecretNotVisible")<{
  readonly secretId: string;
}> {}

class SecretStillExists extends Data.TaggedError("SecretStillExists")<{
  readonly secretId: string;
}> {}

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      const toSecretName = (id: string, props: SecretProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 512 });

      const createValue = Effect.fn(function* (props: SecretProps) {
        if (props.secretBinary !== undefined) {
          return { SecretBinary: props.secretBinary } as const;
        }

        if (props.secretString !== undefined) {
          return { SecretString: props.secretString } as const;
        }

        if (props.generateSecretString) {
          const {
            secretStringTemplate = "{}",
            generateStringKey = "password",
            ...request
          } = props.generateSecretString;
          const password = yield* secretsmanager.getRandomPassword(request);
          const generated = password.RandomPassword
            ? typeof password.RandomPassword === "string"
              ? password.RandomPassword
              : Redacted.value(password.RandomPassword)
            : "";
          const template = JSON.parse(secretStringTemplate) as Record<
            string,
            unknown
          >;
          return {
            SecretString: JSON.stringify({
              ...template,
              [generateStringKey]: generated,
            }),
          } as const;
        }

        return {} as const;
      });

      const readSecret = Effect.fn(function* (secretId: string) {
        const described = yield* secretsmanager
          .describeSecret({
            SecretId: secretId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        // A secret with `DeletedDate` set is scheduled for deletion (our
        // delete uses `ForceDeleteWithoutRecovery`, which still completes
        // asynchronously). It cannot be updated, so treat it as missing —
        // reconcile recreates it once the pending deletion finishes.
        return described?.DeletedDate ? undefined : described;
      });

      // `CreateSecret` may return before `DescribeSecret` can observe the new
      // secret. Keep this wait provider-local so every caller (including nuke
      // recovery and adoption) gets the same bounded consistency handling.
      const readSecretAfterCreate = (secretId: string) =>
        Effect.retry(
          readSecret(secretId).pipe(
            Effect.flatMap((secret) =>
              secret?.ARN && secret.Name
                ? Effect.succeed(secret)
                : Effect.fail(new SecretNotVisible({ secretId })),
            ),
          ),
          {
            while: (error) => error._tag === "SecretNotVisible",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(10),
            ]),
          },
        );

      // Force deletion is asynchronous. `DeletedDate` means the operation was
      // accepted, not that the resource is absent, so deletion completion must
      // be checked with the raw API rather than `readSecret`.
      const waitForSecretAbsence = (secretId: string) =>
        Effect.retry(
          secretsmanager
            .describeSecret({ SecretId: secretId })
            .pipe(
              Effect.flatMap(() =>
                Effect.fail(new SecretStillExists({ secretId })),
              ),
            ),
          {
            while: (error) => error._tag === "SecretStillExists",
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(10),
            ]),
          },
        ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));

      return {
        stables: ["secretArn", "secretName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toSecretName(id, olds ?? {})) !==
            (yield* toSecretName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const secretName =
            output?.secretName ?? (yield* toSecretName(id, olds ?? {}));
          const described = yield* readSecret(output?.secretArn ?? secretName);
          if (!described?.ARN || !described.Name) {
            return undefined;
          }

          return {
            secretArn: described.ARN,
            secretName: described.Name,
            versionId: output?.versionId,
            description: described.Description,
            kmsKeyId: described.KmsKeyId,
            tags: toTagRecord(described.Tags),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const secretName =
            output?.secretName ?? (yield* toSecretName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const hasNewValue =
            news.secretString !== undefined ||
            news.secretBinary !== undefined ||
            news.generateSecretString !== undefined;

          // Observe — describe the secret using whichever identifier we
          // have (ARN preferred, name as fallback).
          let observed = yield* readSecret(output?.secretArn ?? secretName);

          // Ensure — create if missing. Tolerate `ResourceExistsException`
          // by re-describing; the sync step below converges metadata and
          // value. Recreating a physical name right after our own
          // `ForceDeleteWithoutRecovery` can race the asynchronous deletion
          // and fail with `InvalidRequestException` ("already scheduled for
          // deletion") — force deletions complete within seconds, so retry
          // through that window (bounded).
          if (!observed?.ARN) {
            // Data-FIRST `Effect.retry(self, options)`: the data-last form
            // infers `Retry.Options<E>`'s `E` from BOTH `while` and the
            // schedule's input slot (`unknown` for `Schedule.fixed`), and the
            // unioned candidates collapse this provider's layer to an
            // `unknown` R that then poisons all of `AWS.providers()`.
            yield* retryThroughDeletionWindow(
              secretsmanager
                .createSecret({
                  Name: secretName,
                  Description: news.description,
                  KmsKeyId: news.kmsKeyId,
                  Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                    Key,
                    Value,
                  })),
                  ...(yield* createValue(news)),
                })
                .pipe(
                  Effect.catchTag("ResourceExistsException", () => Effect.void),
                ),
            );
            observed = yield* readSecretAfterCreate(secretName);
          }

          if (!observed?.ARN || !observed.Name) {
            return yield* Effect.fail(
              new Error(`Failed to describe Secret '${secretName}'`),
            );
          }

          const secretArn = observed.ARN;

          // Sync metadata + value. `updateSecret` accepts description,
          // KMS key, and the secret value in one call. We always send
          // metadata (idempotent) and only send a new value if the user
          // provided one — `updateSecret` requires SecretString or
          // SecretBinary to actually rotate, but is fine to call without
          // them to update description/kmsKeyId only.
          const valuePayload = yield* createValue(news);
          const updated = yield* secretsmanager.updateSecret({
            SecretId: secretArn,
            Description: news.description,
            KmsKeyId: news.kmsKeyId,
            ...valuePayload,
          });

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = toTagRecord(observed.Tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (upsert.length > 0) {
            yield* secretsmanager.tagResource({
              SecretId: secretArn,
              Tags: upsert,
            });
          }

          if (removed.length > 0) {
            yield* secretsmanager.untagResource({
              SecretId: secretArn,
              TagKeys: removed,
            });
          }

          // Sync the resource-based policy — diff the observed policy
          // against the desired one (both canonicalized via
          // `normalizePolicyDocument`) so a re-deploy of an equivalent
          // document is a no-op API-wise.
          const desiredPolicy =
            news.resourcePolicy === undefined
              ? undefined
              : typeof news.resourcePolicy === "string"
                ? news.resourcePolicy
                : stringifyPolicyDocument(news.resourcePolicy);
          const observedPolicy = yield* secretsmanager
            .getResourcePolicy({ SecretId: secretArn })
            .pipe(
              Effect.map((response) => response.ResourcePolicy),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (desiredPolicy !== undefined) {
            if (
              observedPolicy === undefined ||
              normalizePolicyDocument(observedPolicy) !==
                normalizePolicyDocument(desiredPolicy)
            ) {
              yield* secretsmanager.putResourcePolicy({
                SecretId: secretArn,
                ResourcePolicy: desiredPolicy,
              });
            }
          } else if (observedPolicy !== undefined) {
            yield* secretsmanager
              .deleteResourcePolicy({ SecretId: secretArn })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }

          yield* session.note(secretArn);
          return {
            secretArn,
            secretName: observed.Name,
            versionId: hasNewValue
              ? (updated.VersionId ?? output?.versionId)
              : output?.versionId,
            description: news.description,
            kmsKeyId: news.kmsKeyId,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* secretsmanager
            .deleteSecret({
              SecretId: output.secretArn,
              ForceDeleteWithoutRecovery: true,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.catchTag("InvalidRequestException", (error) =>
                isDeletionInProgress(error.Message)
                  ? Effect.void
                  : Effect.fail(error),
              ),
            );
          yield* waitForSecretAbsence(output.secretArn);
        }),
        // `listSecrets` returns full secret metadata (ARN, name, description,
        // KMS key, and tags) inline, so we hydrate the exact `read` Attributes
        // shape directly — without fetching plaintext values via
        // `getSecretValue`. `versionId` is per-value state not surfaced by the
        // list API, so it is `undefined` (matching `read` when there is no
        // prior output).
        list: () =>
          secretsmanager.listSecrets.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.SecretList ?? [])
                  .filter(
                    (
                      entry,
                    ): entry is secretsmanager.SecretListEntry & {
                      ARN: string;
                      Name: string;
                    } => entry.ARN != null && entry.Name != null,
                  )
                  .map((entry) => ({
                    secretArn: entry.ARN,
                    secretName: entry.Name,
                    versionId: undefined,
                    description: entry.Description,
                    kmsKeyId: entry.KmsKeyId,
                    tags: toTagRecord(entry.Tags),
                  })),
              ),
            ),
          ),
      };
    }),
  );
