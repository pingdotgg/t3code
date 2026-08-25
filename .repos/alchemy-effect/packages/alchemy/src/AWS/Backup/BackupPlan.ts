import * as backup from "@distilled.cloud/aws/backup";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays, toWireMinutes } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * Lifecycle policy controlling when a recovery point transitions to cold
 * storage and when it is deleted.
 */
export interface BackupRuleLifecycle {
  /**
   * Time after creation that a recovery point is moved to cold storage,
   * e.g. `"30 days"` (whole days on the wire). Must be at least 90 days
   * less than `deleteAfter`.
   */
  moveToColdStorageAfter?: Duration.Input;
  /**
   * Time after creation that a recovery point is deleted, e.g. `"365 days"`
   * (whole days on the wire).
   */
  deleteAfter?: Duration.Input;
  /**
   * Opt recovery points of supported resources into archive-tier storage.
   */
  optInToArchiveForSupportedResources?: boolean;
}

/**
 * A single scheduled backup rule within a backup plan.
 */
export interface BackupPlanRule {
  /**
   * Display name for the rule. Must be unique within the plan.
   */
  ruleName: string;
  /**
   * Name of the target backup vault where recovery points are stored.
   */
  targetBackupVaultName: string;
  /**
   * CRON expression (in UTC) specifying when the backup is taken, e.g.
   * `cron(0 5 ? * * *)`. Omit for continuous backup or on-demand plans.
   */
  scheduleExpression?: string;
  /**
   * Timezone the schedule expression is evaluated in.
   */
  scheduleExpressionTimezone?: string;
  /**
   * Time after the scheduled time within which a backup must start, or it
   * is canceled, e.g. `"1 hour"` (whole minutes on the wire).
   */
  startWindow?: Duration.Input;
  /**
   * Time within which a backup must complete, or it is canceled, e.g.
   * `"3 hours"` (whole minutes on the wire).
   */
  completionWindow?: Duration.Input;
  /**
   * Enables continuous backups (point-in-time restore) for supported
   * resources.
   */
  enableContinuousBackup?: boolean;
  /**
   * Lifecycle policy for the recovery points created by this rule.
   */
  lifecycle?: BackupRuleLifecycle;
  /**
   * Tags applied to recovery points created by this rule.
   */
  recoveryPointTags?: Record<string, string>;
}

export interface BackupPlanProps {
  /**
   * Display name of the backup plan. If omitted, a unique name is generated
   * from the app, stage, and logical ID.
   */
  backupPlanName?: string;
  /**
   * One or more scheduled backup rules that make up the plan.
   */
  rules: BackupPlanRule[];
  /**
   * Tags to apply to the backup plan. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface BackupPlan extends Resource<
  "AWS.Backup.BackupPlan",
  BackupPlanProps,
  {
    /**
     * Service-assigned unique ID of the backup plan.
     */
    backupPlanId: string;
    /**
     * ARN of the backup plan.
     */
    backupPlanArn: string;
    /**
     * Name of the backup plan.
     */
    backupPlanName: string;
    /**
     * Version ID of the plan; updated each time the plan document changes.
     */
    versionId: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Backup plan — a policy expression that defines *when* and *how* you
 * want to back up your resources, composed of one or more scheduled rules
 * that each target a backup vault.
 *
 * Pair a plan with a {@link BackupSelection} to assign the AWS resources it
 * protects.
 *
 * @resource
 * @section Creating a Plan
 * @example Daily backups retained for 30 days
 * ```typescript
 * import * as Backup from "alchemy/AWS/Backup";
 *
 * const vault = yield* Backup.BackupVault("AppBackups");
 *
 * const plan = yield* Backup.BackupPlan("DailyPlan", {
 *   rules: [
 *     {
 *       ruleName: "DailyBackups",
 *       targetBackupVaultName: vault.backupVaultName,
 *       scheduleExpression: "cron(0 5 ? * * *)",
 *       startWindow: "1 hour",
 *       completionWindow: "3 hours",
 *       lifecycle: { deleteAfter: "30 days" },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Move to cold storage then delete
 * ```typescript
 * const plan = yield* Backup.BackupPlan("ArchivePlan", {
 *   rules: [
 *     {
 *       ruleName: "MonthlyArchive",
 *       targetBackupVaultName: vault.backupVaultName,
 *       scheduleExpression: "cron(0 5 1 * ? *)",
 *       lifecycle: {
 *         moveToColdStorageAfter: "30 days",
 *         deleteAfter: "365 days",
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export const BackupPlan = Resource<BackupPlan>("AWS.Backup.BackupPlan");

const toRuleInput = (rule: BackupPlanRule): backup.BackupRuleInput => ({
  RuleName: rule.ruleName,
  TargetBackupVaultName: rule.targetBackupVaultName,
  ScheduleExpression: rule.scheduleExpression,
  ScheduleExpressionTimezone: rule.scheduleExpressionTimezone,
  StartWindowMinutes: toWireMinutes(rule.startWindow),
  CompletionWindowMinutes: toWireMinutes(rule.completionWindow),
  EnableContinuousBackup: rule.enableContinuousBackup,
  RecoveryPointTags: rule.recoveryPointTags,
  Lifecycle: rule.lifecycle
    ? {
        MoveToColdStorageAfterDays: toWireDays(
          rule.lifecycle.moveToColdStorageAfter,
        ),
        DeleteAfterDays: toWireDays(rule.lifecycle.deleteAfter),
        OptInToArchiveForSupportedResources:
          rule.lifecycle.optInToArchiveForSupportedResources,
      }
    : undefined,
});

export const BackupPlanProvider = () =>
  Provider.effect(
    BackupPlan,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { backupPlanName?: string | undefined },
      ) {
        return (
          props.backupPlanName ??
          (yield* createPhysicalName({ id, maxLength: 50 }))
        );
      });

      return BackupPlan.Provider.of({
        stables: ["backupPlanId", "backupPlanArn"],
        list: () =>
          backup.listBackupPlans.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.BackupPlansList ?? [])
                .filter(
                  (p) =>
                    p.BackupPlanId !== undefined &&
                    p.BackupPlanArn !== undefined &&
                    // Service-managed plans (e.g. EFS automatic backups'
                    // `aws/efs/automatic-backup-plan`) reject DeleteBackupPlan
                    // with AccessDenied (verified live) — keep them out of
                    // enumeration for account-wide teardown (nuke).
                    !(p.BackupPlanName ?? "").startsWith("aws/"),
                )
                .map((p) => ({
                  backupPlanId: p.BackupPlanId!,
                  backupPlanArn: p.BackupPlanArn!,
                  backupPlanName: p.BackupPlanName ?? "",
                  versionId: p.VersionId ?? "",
                })),
            ),
          ),
        read: Effect.fn(function* ({ id, output }) {
          if (!output?.backupPlanId) return undefined;
          const found = yield* backup
            .getBackupPlan({ BackupPlanId: output.backupPlanId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!found?.BackupPlanArn) return undefined;
          const attrs = {
            backupPlanId: output.backupPlanId,
            backupPlanArn: found.BackupPlanArn,
            backupPlanName:
              found.BackupPlan?.BackupPlanName ?? output.backupPlanName,
            versionId: found.VersionId ?? output.versionId,
          };
          const tags = yield* backup
            .listTags({ ResourceArn: found.BackupPlanArn })
            .pipe(
              Effect.map((r) => r.Tags ?? {}),
              Effect.catch(() =>
                Effect.succeed({} as Record<string, string | undefined>),
              ),
            );
          return (yield* hasAlchemyTags(id, tags as Record<string, string>))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name = output?.backupPlanName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const backupPlanInput: backup.BackupPlanInput = {
            BackupPlanName: name,
            Rules: (news.rules ?? []).map(toRuleInput),
          };

          // OBSERVE — resolve the plan by its stable id when we have one.
          const live = output?.backupPlanId
            ? yield* backup
                .getBackupPlan({ BackupPlanId: output.backupPlanId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : undefined;

          let backupPlanId: string;
          let backupPlanArn: string;
          let versionId: string;

          if (!live?.BackupPlanArn) {
            // ENSURE — create.
            const created = yield* backup.createBackupPlan({
              BackupPlan: backupPlanInput,
              BackupPlanTags: { ...internalTags, ...news.tags },
            });
            backupPlanId = created.BackupPlanId!;
            backupPlanArn = created.BackupPlanArn!;
            versionId = created.VersionId ?? "";
          } else {
            // SYNC — a plan is a true upsert via updateBackupPlan; converge
            // rule/name changes unconditionally (the API is idempotent).
            backupPlanId = output!.backupPlanId!;
            const updated = yield* backup.updateBackupPlan({
              BackupPlanId: backupPlanId,
              BackupPlan: backupPlanInput,
            });
            backupPlanArn = updated.BackupPlanArn ?? live.BackupPlanArn;
            versionId = updated.VersionId ?? live.VersionId ?? "";
          }

          // SYNC tags — diff against observed cloud tags.
          const currentTags = yield* backup
            .listTags({ ResourceArn: backupPlanArn })
            .pipe(
              Effect.map((r) => r.Tags ?? {}),
              Effect.catch(() =>
                Effect.succeed({} as Record<string, string | undefined>),
              ),
            );
          const { upsert, removed } = diffTags(
            currentTags as Record<string, string>,
            { ...news.tags, ...internalTags },
          );
          if (upsert.length > 0) {
            yield* backup.tagResource({
              ResourceArn: backupPlanArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* backup.untagResource({
              ResourceArn: backupPlanArn,
              TagKeyList: removed,
            });
          }

          yield* session.note(backupPlanId);
          return {
            backupPlanId,
            backupPlanArn,
            backupPlanName: name,
            versionId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A plan cannot be deleted while it still has resource selections
          // attached — delete those first (idempotent: a vanished selection
          // is already gone).
          const selections = yield* backup.listBackupSelections
            .pages({ BackupPlanId: output.backupPlanId })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap(
                  (page) => page.BackupSelectionsList ?? [],
                ),
              ),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed([]),
              ),
            );
          yield* Effect.forEach(
            selections,
            (s) =>
              s.SelectionId
                ? backup
                    .deleteBackupSelection({
                      BackupPlanId: output.backupPlanId,
                      SelectionId: s.SelectionId,
                    })
                    .pipe(
                      Effect.catchTag(
                        "ResourceNotFoundException",
                        () => Effect.void,
                      ),
                    )
                : Effect.void,
            { discard: true },
          );
          yield* backup
            .deleteBackupPlan({ BackupPlanId: output.backupPlanId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // Selection deletion is eventually consistent; the plan delete
              // rejects with InvalidRequestException until it settles.
              Effect.retry({
                while: (e) => e._tag === "InvalidRequestException",
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
            );
        }),
      });
    }),
  );
