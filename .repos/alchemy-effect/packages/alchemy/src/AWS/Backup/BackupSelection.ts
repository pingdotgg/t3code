import * as backup from "@distilled.cloud/aws/backup";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * A tag-based condition used to select resources for backup by matching the
 * tags attached to them.
 */
export interface BackupSelectionTagCondition {
  /**
   * How the tag is matched. `STRINGEQUALS` is the only supported operator
   * for the legacy `listOfTags` selector.
   */
  conditionType?: "STRINGEQUALS" | (string & {});
  /**
   * The tag key to match, e.g. `aws:ResourceTag/backup`.
   */
  conditionKey: string;
  /**
   * The tag value to match.
   */
  conditionValue: string;
}

export interface BackupSelectionProps {
  /**
   * ID of the backup plan this selection assigns resources to. Typically the
   * `backupPlanId` attribute of a {@link BackupPlan}.
   *
   * Changing the plan replaces the selection.
   */
  backupPlanId: string;
  /**
   * Display name for the selection. If omitted, a unique name is generated
   * from the app, stage, and logical ID.
   *
   * A backup selection is immutable — changing the name replaces it.
   */
  selectionName?: string;
  /**
   * ARN of the IAM role AWS Backup assumes to create and manage backups on
   * your behalf. The role's trust policy must allow `backup.amazonaws.com`.
   *
   * Immutable — changing the role replaces the selection.
   */
  iamRoleArn: string;
  /**
   * ARNs of the resources to assign to the backup plan. Use `["*"]` to
   * assign all supported resources.
   *
   * Immutable — changing the resource list replaces the selection.
   */
  resources?: string[];
  /**
   * ARNs of resources to explicitly exclude from the plan.
   *
   * Immutable — changing this replaces the selection.
   */
  notResources?: string[];
  /**
   * Tag-based conditions selecting resources by their tags (legacy
   * `ListOfTags` selector — conditions are ANDed together).
   *
   * Immutable — changing this replaces the selection.
   */
  listOfTags?: BackupSelectionTagCondition[];
}

export interface BackupSelection extends Resource<
  "AWS.Backup.BackupSelection",
  BackupSelectionProps,
  {
    /**
     * Service-assigned unique ID of the selection.
     */
    selectionId: string;
    /**
     * Name of the selection.
     */
    selectionName: string;
    /**
     * ID of the backup plan the selection is attached to.
     */
    backupPlanId: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Backup selection — assigns AWS resources to a {@link BackupPlan}
 * either by explicit ARN or by matching resource tags, using an IAM role that
 * AWS Backup assumes to perform the backups.
 *
 * A selection is immutable: any change to its name, role, or resource set
 * replaces it.
 *
 * @resource
 * @section Assigning Resources
 * @example Assign resources by tag
 * ```typescript
 * import * as Backup from "alchemy/AWS/Backup";
 *
 * const selection = yield* Backup.BackupSelection("TaggedResources", {
 *   backupPlanId: plan.backupPlanId,
 *   iamRoleArn: backupRole.roleArn,
 *   listOfTags: [
 *     {
 *       conditionType: "STRINGEQUALS",
 *       conditionKey: "aws:ResourceTag/backup",
 *       conditionValue: "daily",
 *     },
 *   ],
 * });
 * ```
 *
 * @example Assign resources by ARN
 * ```typescript
 * const selection = yield* Backup.BackupSelection("ExplicitResources", {
 *   backupPlanId: plan.backupPlanId,
 *   iamRoleArn: backupRole.roleArn,
 *   resources: [table.tableArn],
 * });
 * ```
 */
export const BackupSelection = Resource<BackupSelection>(
  "AWS.Backup.BackupSelection",
);

// A freshly-created IAM role is not immediately assumable by AWS Backup, so
// CreateBackupSelection can transiently reject the role with
// InvalidParameterValueException. Retry on a bounded schedule. The explicit
// return annotation keeps `Retry.Return`'s conditional type out of the
// provider's declaration emit (see SecretsManager/Secret.ts).
const retryRolePropagation = <A, E extends { _tag: string }, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  eff.pipe(
    Effect.retry({
      while: (e: E) => e._tag === "InvalidParameterValueException",
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

export const BackupSelectionProvider = () =>
  Provider.effect(
    BackupSelection,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { selectionName?: string | undefined },
      ) {
        return (
          props.selectionName ??
          (yield* createPhysicalName({ id, maxLength: 50 }))
        );
      });

      return BackupSelection.Provider.of({
        stables: ["selectionId", "selectionName", "backupPlanId"],
        // A selection is keyed by its parent plan; there is no account-wide
        // enumeration API. Return empty and rely on read/reconcile by id.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ output }) {
          if (!output?.selectionId || !output?.backupPlanId) return undefined;
          // AWS Backup returns InvalidParameterValueException (not
          // ResourceNotFoundException) for a selection id that no longer
          // exists — treat both as "absent".
          const found = yield* backup
            .getBackupSelection({
              BackupPlanId: output.backupPlanId,
              SelectionId: output.selectionId,
            })
            .pipe(
              Effect.catchTag(
                ["ResourceNotFoundException", "InvalidParameterValueException"],
                () => Effect.succeed(undefined),
              ),
            );
          if (!found?.SelectionId) return undefined;
          return {
            selectionId: found.SelectionId,
            selectionName:
              found.BackupSelection?.SelectionName ?? output.selectionName,
            backupPlanId: output.backupPlanId,
          };
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          // The selection API has no update operation, so every meaningful
          // change is a replacement.
          if (
            oldName !== newName ||
            (olds.backupPlanId ?? "") !== (news.backupPlanId ?? "") ||
            (olds.iamRoleArn ?? "") !== (news.iamRoleArn ?? "") ||
            JSON.stringify(olds.resources ?? []) !==
              JSON.stringify(news.resources ?? []) ||
            JSON.stringify(olds.notResources ?? []) !==
              JSON.stringify(news.notResources ?? []) ||
            JSON.stringify(olds.listOfTags ?? []) !==
              JSON.stringify(news.listOfTags ?? [])
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.selectionName ?? (yield* createName(id, news));
          const backupPlanId = news.backupPlanId;

          // OBSERVE — confirm an existing selection by id; a selection is
          // immutable so there is nothing to sync when it already exists.
          if (output?.selectionId) {
            const existing = yield* backup
              .getBackupSelection({
                BackupPlanId: backupPlanId,
                SelectionId: output.selectionId,
              })
              .pipe(
                Effect.catchTag(
                  [
                    "ResourceNotFoundException",
                    "InvalidParameterValueException",
                  ],
                  () => Effect.succeed(undefined),
                ),
              );
            if (existing?.SelectionId) {
              yield* session.note(existing.SelectionId);
              return {
                selectionId: existing.SelectionId,
                selectionName: name,
                backupPlanId,
              };
            }
          }

          // ENSURE — create (retrying while the IAM role propagates).
          const created = yield* retryRolePropagation(
            backup.createBackupSelection({
              BackupPlanId: backupPlanId,
              BackupSelection: {
                SelectionName: name,
                IamRoleArn: news.iamRoleArn!,
                Resources: news.resources,
                NotResources: news.notResources,
                ListOfTags: news.listOfTags?.map((c) => ({
                  ConditionType: c.conditionType ?? "STRINGEQUALS",
                  ConditionKey: c.conditionKey,
                  ConditionValue: c.conditionValue,
                })),
              },
            }),
          );
          yield* session.note(created.SelectionId!);
          return {
            selectionId: created.SelectionId!,
            selectionName: name,
            backupPlanId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A missing selection deletes as InvalidParameterValueException; a
          // deleted parent plan yields ResourceNotFoundException. Both are
          // "already gone".
          yield* backup
            .deleteBackupSelection({
              BackupPlanId: output.backupPlanId,
              SelectionId: output.selectionId,
            })
            .pipe(
              Effect.catchTag(
                ["ResourceNotFoundException", "InvalidParameterValueException"],
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
