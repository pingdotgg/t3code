import * as glacier from "@distilled.cloud/aws/glacier";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

// Glacier's REST API takes the AWS account ID as a path segment; `-` means
// "the account that signed the request".
const ACCOUNT = "-";

export interface VaultNotificationConfigProps {
  /**
   * ARN of the SNS topic that Amazon S3 Glacier publishes job-completion
   * notifications to.
   */
  snsTopic: string;
  /**
   * Job-completion events to publish. Valid values are
   * `ArchiveRetrievalCompleted` and `InventoryRetrievalCompleted`.
   */
  events: string[];
}

export interface VaultProps {
  /**
   * Name of the vault. 1-255 characters; allowed characters are a-z, A-Z,
   * 0-9, `_` (underscore), `-` (hyphen), and `.` (period). Changing the
   * name replaces the vault.
   * @default ${app}-${stage}-${id}
   */
  vaultName?: string;
  /**
   * Notification configuration publishing job-completion events to an SNS
   * topic. Removing the prop deletes the vault's notification
   * configuration.
   */
  notificationConfig?: VaultNotificationConfigProps;
  /**
   * Vault access policy (a resource-based IAM policy document), provided
   * as a JSON string or a plain object. Removing the prop deletes the
   * vault's access policy.
   */
  accessPolicy?: string | Record<string, any>;
  /**
   * Vault lock policy (an IAM policy document enforcing compliance
   * controls), provided as a JSON string or a plain object. Setting it
   * initiates the vault lock, leaving it in the `InProgress` state — the
   * policy is in effect but can still be changed or removed for 24 hours.
   * Alchemy never calls `CompleteVaultLock`, so the lock is never made
   * immutable by this resource. Removing the prop aborts an in-progress
   * lock.
   */
  lockPolicy?: string | Record<string, any>;
  /**
   * Tags to apply to the vault (up to 10). Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface Vault extends Resource<
  "AWS.Glacier.Vault",
  VaultProps,
  {
    /** The name of the vault. */
    vaultName: string;
    /** The ARN of the vault. */
    vaultArn: string;
    /** ISO-8601 timestamp of when the vault was created. */
    creationDate: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon S3 Glacier vault — a container for archives in the original
 * (vault-based) S3 Glacier service.
 *
 * Vault creation is idempotent and free; storage is billed per archive.
 * A vault must be empty to be deleted, which is always the case for vaults
 * that only ever held configuration.
 * @resource
 * @section Creating Vaults
 * @example Basic Vault
 * ```typescript
 * import * as Glacier from "alchemy/AWS/Glacier";
 *
 * const vault = yield* Glacier.Vault("Backups");
 * ```
 *
 * @example Vault with Tags
 * ```typescript
 * const vault = yield* Glacier.Vault("Backups", {
 *   tags: { team: "storage" },
 * });
 * ```
 *
 * @section Notifications
 * @example Publish job-completion events to SNS
 * ```typescript
 * const topic = yield* SNS.Topic("VaultEvents");
 * const vault = yield* Glacier.Vault("Backups", {
 *   notificationConfig: {
 *     snsTopic: topic.topicArn,
 *     events: ["ArchiveRetrievalCompleted", "InventoryRetrievalCompleted"],
 *   },
 * });
 * ```
 *
 * @section Access Control
 * @example Vault access policy
 * ```typescript
 * const vault = yield* Glacier.Vault("Backups", {
 *   accessPolicy: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Sid: "deny-archive-deletes",
 *       Effect: "Deny",
 *       Principal: "*",
 *       Action: ["glacier:DeleteArchive"],
 *       Resource: ["arn:aws:glacier:us-east-1:123456789012:vaults/backups"],
 *     }],
 *   },
 * });
 * ```
 *
 * @example Vault lock policy (left in-progress, never completed)
 * ```typescript
 * const vault = yield* Glacier.Vault("Compliance", {
 *   lockPolicy: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Sid: "deny-archive-deletes",
 *       Effect: "Deny",
 *       Principal: "*",
 *       Action: ["glacier:DeleteArchive"],
 *       Resource: ["arn:aws:glacier:us-east-1:123456789012:vaults/compliance"],
 *     }],
 *   },
 * });
 * ```
 */
export const Vault = Resource<Vault>("AWS.Glacier.Vault");

/**
 * Raised when the desired `lockPolicy` differs from (or removes) a vault
 * lock that is already in the `Locked` state. A locked vault lock policy is
 * immutable — it can never be changed or removed.
 */
export class GlacierVaultLockImmutable extends Data.TaggedError(
  "GlacierVaultLockImmutable",
)<{ message: string }> {}

/**
 * Raised when DescribeVault returns a vault record missing its ARN or
 * creation date — never expected from the live API.
 */
export class GlacierVaultIncomplete extends Data.TaggedError(
  "GlacierVaultIncomplete",
)<{ message: string }> {}

// Explicitly-typed pipeable retry helper. Inlining `Effect.retry` in a
// provider lifecycle op leaks `Retry.Return`'s conditional into declaration
// emit and widens the provider layer to `unknown` R for every consumer of
// `AWS.providers()`.
const retryWhileVaultNotFound = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceNotFoundException",
    schedule: Schedule.max([Schedule.fixed(1000), Schedule.recurs(10)]),
  });

const toPolicyString = (
  policy: string | Record<string, any> | undefined,
): string | undefined =>
  policy === undefined
    ? undefined
    : typeof policy === "string"
      ? policy
      : JSON.stringify(policy);

// Structural comparison for policy documents: AWS may re-serialize the
// stored policy, so compare parsed shapes rather than raw strings. Falls
// back to raw string equality if either side is not valid JSON.
const samePolicy = (left: string, right: string): boolean => {
  if (left === right) return true;
  try {
    return (
      JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right))
    );
  } catch {
    return false;
  }
};

const sameStringSet = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, i) => value === sortedRight[i]);
};

export const VaultProvider = () =>
  Provider.effect(
    Vault,
    Effect.gen(function* () {
      const createVaultName = Effect.fn(function* (
        id: string,
        props: VaultProps,
      ) {
        return (
          props.vaultName ?? (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      const describeVault = (vaultName: string) =>
        glacier
          .describeVault({ accountId: ACCOUNT, vaultName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const readVaultTags = (vaultName: string) =>
        glacier.listTagsForVault({ accountId: ACCOUNT, vaultName }).pipe(
          Effect.map((r) => (r.Tags ?? {}) as Record<string, string>),
          Effect.catch(() => Effect.succeed({} as Record<string, string>)),
        );

      return Vault.Provider.of({
        stables: ["vaultName", "vaultArn", "creationDate"],

        // Enumerate every vault in the ambient account/region. Vaults whose
        // list entry is missing identifying fields (never expected from the
        // live API) are dropped.
        list: () =>
          Effect.gen(function* () {
            const pages = yield* glacier.listVaults
              .pages({ accountId: ACCOUNT })
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.VaultList ?? [])
              .flatMap((vault) =>
                vault.VaultName !== undefined &&
                vault.VaultARN !== undefined &&
                vault.CreationDate !== undefined
                  ? [
                      {
                        vaultName: vault.VaultName,
                        vaultArn: vault.VaultARN,
                        creationDate: vault.CreationDate,
                      },
                    ]
                  : [],
              );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const vaultName =
            output?.vaultName ?? (yield* createVaultName(id, olds ?? {}));
          const found = yield* describeVault(vaultName);
          if (found?.VaultARN === undefined) return undefined;
          const attrs = {
            vaultName,
            vaultArn: found.VaultARN,
            creationDate: found.CreationDate ?? "",
          };
          const tags = yield* readVaultTags(vaultName);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createVaultName(id, olds ?? {});
          const newName = yield* createVaultName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // undefined → default update path (reconcile syncs the rest)
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? {};
          const vaultName =
            output?.vaultName ?? (yield* createVaultName(id, props));
          const internalTags = yield* createInternalTags(id);

          // 1. OBSERVE — cloud state is authoritative; output is only a
          //    name cache.
          let live = yield* describeVault(vaultName);

          // 2. ENSURE — CreateVault is an idempotent PUT; re-observe for the
          //    full record (create only returns a Location header). A brief
          //    bounded retry covers read-after-create consistency.
          if (live === undefined) {
            yield* glacier.createVault({ accountId: ACCOUNT, vaultName });
            live = yield* glacier
              .describeVault({ accountId: ACCOUNT, vaultName })
              .pipe(retryWhileVaultNotFound);
          }
          if (live.VaultARN === undefined || live.CreationDate === undefined) {
            return yield* Effect.fail(
              new GlacierVaultIncomplete({
                message: `DescribeVault for '${vaultName}' returned no VaultARN/CreationDate`,
              }),
            );
          }

          // 3a. SYNC notification configuration — observed vs desired.
          const observedNotifications = yield* glacier
            .getVaultNotifications({ accountId: ACCOUNT, vaultName })
            .pipe(
              Effect.map((r) => r.vaultNotificationConfig),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const desiredNotifications = props.notificationConfig;
          if (desiredNotifications !== undefined) {
            const inSync =
              observedNotifications !== undefined &&
              observedNotifications.SNSTopic ===
                desiredNotifications.snsTopic &&
              sameStringSet(
                observedNotifications.Events ?? [],
                desiredNotifications.events,
              );
            if (!inSync) {
              yield* glacier.setVaultNotifications({
                accountId: ACCOUNT,
                vaultName,
                vaultNotificationConfig: {
                  SNSTopic: desiredNotifications.snsTopic,
                  Events: desiredNotifications.events,
                },
              });
            }
          } else if (observedNotifications !== undefined) {
            yield* glacier
              .deleteVaultNotifications({ accountId: ACCOUNT, vaultName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }

          // 3b. SYNC access policy — observed vs desired.
          const observedPolicy = yield* glacier
            .getVaultAccessPolicy({ accountId: ACCOUNT, vaultName })
            .pipe(
              Effect.map((r) => r.policy?.Policy),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const desiredPolicy = toPolicyString(props.accessPolicy);
          if (desiredPolicy !== undefined) {
            if (
              observedPolicy === undefined ||
              !samePolicy(observedPolicy, desiredPolicy)
            ) {
              yield* glacier.setVaultAccessPolicy({
                accountId: ACCOUNT,
                vaultName,
                policy: { Policy: desiredPolicy },
              });
            }
          } else if (observedPolicy !== undefined) {
            yield* glacier
              .deleteVaultAccessPolicy({ accountId: ACCOUNT, vaultName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }

          // 3c. SYNC vault lock — observed vs desired. An `InProgress` lock
          //     can be aborted and re-initiated; a `Locked` lock is immutable
          //     forever, so any drift from the desired state is surfaced as a
          //     typed failure rather than silently ignored.
          const observedLock = yield* glacier
            .getVaultLock({ accountId: ACCOUNT, vaultName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const desiredLock = toPolicyString(props.lockPolicy);
          if (desiredLock !== undefined) {
            if (observedLock === undefined) {
              yield* glacier.initiateVaultLock({
                accountId: ACCOUNT,
                vaultName,
                policy: { Policy: desiredLock },
              });
            } else if (
              observedLock.Policy === undefined ||
              !samePolicy(observedLock.Policy, desiredLock)
            ) {
              if (observedLock.State === "Locked") {
                return yield* Effect.fail(
                  new GlacierVaultLockImmutable({
                    message: `Vault '${vaultName}' lock is in the Locked state; its lock policy can never be changed.`,
                  }),
                );
              }
              // InProgress with a different policy: abort and re-initiate.
              yield* glacier
                .abortVaultLock({ accountId: ACCOUNT, vaultName })
                .pipe(
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                );
              yield* glacier.initiateVaultLock({
                accountId: ACCOUNT,
                vaultName,
                policy: { Policy: desiredLock },
              });
            }
          } else if (observedLock !== undefined) {
            if (observedLock.State === "Locked") {
              return yield* Effect.fail(
                new GlacierVaultLockImmutable({
                  message: `Vault '${vaultName}' lock is in the Locked state; it can never be removed.`,
                }),
              );
            }
            yield* glacier
              .abortVaultLock({ accountId: ACCOUNT, vaultName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }

          // 3d. SYNC tags — diff against OBSERVED cloud tags so adoption
          //     converges.
          const observedTags = yield* readVaultTags(vaultName);
          const desiredTags: Record<string, string> = {
            ...props.tags,
            ...internalTags,
          };
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* glacier.addTagsToVault({
              accountId: ACCOUNT,
              vaultName,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* glacier.removeTagsFromVault({
              accountId: ACCOUNT,
              vaultName,
              TagKeys: removed,
            });
          }

          // 4. RETURN fresh Attributes.
          yield* session.note(vaultName);
          return {
            vaultName,
            vaultArn: live.VaultARN,
            creationDate: live.CreationDate,
          };
        }),

        // Idempotent delete. An in-progress vault lock is aborted first so a
        // lock policy that denies deletes cannot strand the vault; deleting
        // an already-deleted vault is not an error.
        delete: Effect.fn(function* ({ output }) {
          const lock = yield* glacier
            .getVaultLock({
              accountId: ACCOUNT,
              vaultName: output.vaultName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (lock !== undefined && lock.State !== "Locked") {
            yield* glacier
              .abortVaultLock({
                accountId: ACCOUNT,
                vaultName: output.vaultName,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }
          yield* glacier
            .deleteVault({ accountId: ACCOUNT, vaultName: output.vaultName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
