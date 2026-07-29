import * as aiops from "@distilled.cloud/aws/aiops";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export interface InvestigationGroupEncryptionConfiguration {
  /**
   * How investigation data is encrypted — `"AWS_OWNED_KEY"` (the default,
   * an AWS owned key) or `"CUSTOMER_MANAGED_KMS_KEY"`.
   * @default "AWS_OWNED_KEY"
   */
  type?: aiops.EncryptionConfigurationType;
  /**
   * ID or ARN of the customer managed KMS key to encrypt investigation data
   * with. Required when `type` is `"CUSTOMER_MANAGED_KMS_KEY"`.
   */
  kmsKeyId?: string;
}

export interface InvestigationGroupCrossAccountConfiguration {
  /**
   * ARN of an IAM role in a source account that CloudWatch investigations
   * assumes to retrieve telemetry during cross-account investigations.
   */
  sourceRoleArn: string;
}

export interface InvestigationGroupProps {
  /**
   * Name of the investigation group. If omitted, a deterministic physical
   * name is generated from the app, stage, and logical ID.
   *
   * Changing the name replaces the investigation group.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * ARN of the IAM role that CloudWatch investigations assumes to access
   * telemetry (CloudWatch, X-Ray, CloudTrail, ...) during investigations.
   * The role's trust policy must allow the `aiops.amazonaws.com` service
   * principal to assume it.
   */
  roleArn: string;
  /**
   * How long investigations and their data are retained (e.g. `"7 days"`
   * or `Duration.days(7)`). Rounded to whole days on the wire
   * (`retentionInDays`).
   * The retention period cannot be updated in place — changing it replaces
   * the investigation group.
   * @default 90 days
   */
  retention?: Duration.Input;
  /**
   * Encryption configuration for investigation data. Omit to use an AWS
   * owned key.
   * @default AWS owned key
   */
  encryptionConfiguration?: InvestigationGroupEncryptionConfiguration;
  /**
   * Tag keys whose values CloudWatch investigations uses as boundaries to
   * narrow the search for related telemetry (useful when resource names
   * repeat across applications).
   */
  tagKeyBoundaries?: string[];
  /**
   * Map of Amazon Q Developer in chat applications configuration ARNs to
   * SNS topic ARNs, used to send investigation updates to chat channels.
   */
  chatbotNotificationChannel?: Record<string, string[]>;
  /**
   * Whether investigations can query CloudTrail event history for the past
   * seven days of events.
   * @default true
   */
  isCloudTrailEventHistoryEnabled?: boolean;
  /**
   * Source-account role configurations for cross-account investigations.
   */
  crossAccountConfigurations?: InvestigationGroupCrossAccountConfiguration[];
  /**
   * IAM resource-policy statements attached to the investigation group,
   * granting other principals or AWS services (for example
   * `aiops.alarms.cloudwatch.amazonaws.com`, so CloudWatch alarms can start
   * investigations) access to it. Serialized as a `2012-10-17` policy
   * document via `PutInvestigationGroupPolicy`.
   *
   * Omit to leave any existing policy unmanaged; pass `[]` to delete a
   * previously attached policy.
   */
  policy?: PolicyStatement[];
  /**
   * Tags to apply to the investigation group. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface InvestigationGroup extends Resource<
  "AWS.AIOps.InvestigationGroup",
  InvestigationGroupProps,
  {
    /** Name of the investigation group. */
    name: string;
    /** ARN of the investigation group. */
    arn: string;
    /** ARN of the IAM role investigations assume to access telemetry. */
    roleArn: string | undefined;
    /**
     * How long investigations and their data are retained, in whole days
     * (the AWS wire unit for the `retention` prop).
     */
    retentionInDays: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch investigations *investigation group* — the one-time,
 * per-Region container that configures who can run AI-assisted operational
 * investigations, which IAM role is used to access telemetry, how long
 * investigation data is retained, and how it is encrypted.
 *
 * You can have at most one investigation group per Region in an account, so
 * replacements are performed delete-first.
 * @resource
 * @section Creating an Investigation Group
 * @example Basic Investigation Group
 * ```typescript
 * import * as AIOps from "alchemy/AWS/AIOps";
 * import * as IAM from "alchemy/AWS/IAM";
 *
 * const role = yield* IAM.Role("InvestigationsRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "aiops.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 *   managedPolicyArns: ["arn:aws:iam::aws:policy/AIOpsAssistantPolicy"],
 * });
 *
 * const group = yield* AIOps.InvestigationGroup("Investigations", {
 *   roleArn: role.roleArn,
 * });
 * ```
 *
 * @example Short Retention and Tag Boundaries
 * ```typescript
 * const group = yield* AIOps.InvestigationGroup("Investigations", {
 *   roleArn: role.roleArn,
 *   retention: "7 days",
 *   tagKeyBoundaries: ["Application"],
 *   tags: { Environment: "test" },
 * });
 * ```
 *
 * @section Resource Policy
 * @example Let CloudWatch Alarms Start Investigations
 * ```typescript
 * const group = yield* AIOps.InvestigationGroup("Investigations", {
 *   roleArn: role.roleArn,
 *   policy: [{
 *     Effect: "Allow",
 *     Principal: { Service: "aiops.alarms.cloudwatch.amazonaws.com" },
 *     Action: ["aiops:CreateInvestigation", "aiops:CreateInvestigationEvent"],
 *     Resource: "*",
 *     Condition: {
 *       StringEquals: { "aws:SourceAccount": "111122223333" },
 *       ArnLike: { "aws:SourceArn": "arn:aws:cloudwatch:us-east-1:111122223333:alarm:*" },
 *     },
 *   }],
 * });
 * ```
 */
export const InvestigationGroup = Resource<InvestigationGroup>(
  "AWS.AIOps.InvestigationGroup",
);

/**
 * Bounded retry for `createInvestigationGroup` while the freshly created IAM
 * role propagates — AIOps validates that it can assume the role at create
 * time, which surfaces as a ValidationException/AccessDeniedException that
 * mentions the role for the first seconds of the role's life.
 *
 * Explicitly annotated so the conditional `Retry.Return` type never leaks
 * into declaration emit (it would widen `AWS.providers()` for consumers).
 */
const retryWhileRolePropagates = <A, R>(
  self: Effect.Effect<A, aiops.CreateInvestigationGroupError, R>,
): Effect.Effect<A, aiops.CreateInvestigationGroupError, R> =>
  Effect.retry(self, {
    while: (e) =>
      (e._tag === "ValidationException" ||
        e._tag === "AccessDeniedException") &&
      /role/i.test(e.message ?? ""),
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
  });

const sameStringArray = (l: readonly string[], r: readonly string[]) =>
  l.length === r.length && l.every((v, i) => v === r[i]);

export const InvestigationGroupProvider = () =>
  Provider.effect(
    InvestigationGroup,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<InvestigationGroupProps, "name">,
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
      });

      const observeByArn = (arn: string) =>
        aiops
          .getInvestigationGroup({ identifier: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // At most one investigation group exists per Region, so scanning the
      // list for our name is a single cheap call.
      const findArnByName = (name: string) =>
        aiops.listInvestigationGroups.items({}).pipe(
          Stream.runCollect,
          Effect.map(
            (items) => Array.from(items).find((g) => g.name === name)?.arn,
          ),
        );

      const observe = Effect.fn(function* (
        name: string,
        arnHint: string | undefined,
      ) {
        if (arnHint !== undefined) {
          const found = yield* observeByArn(arnHint);
          if (found !== undefined) return found;
        }
        const arn = yield* findArnByName(name);
        return arn === undefined ? undefined : yield* observeByArn(arn);
      });

      const observedTags = (arn: string) =>
        aiops.listTagsForResource({ resourceArn: arn }).pipe(
          Effect.map((r) => {
            const tags: Record<string, string> = {};
            for (const [key, value] of Object.entries(r.tags ?? {})) {
              if (value !== undefined) tags[key] = value;
            }
            return tags;
          }),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const toAttributes = (live: aiops.GetInvestigationGroupResponse) => ({
        name: live.name!,
        arn: live.arn!,
        roleArn: live.roleArn,
        retentionInDays: live.retentionInDays,
      });

      return InvestigationGroup.Provider.of({
        stables: ["name", "arn"],
        list: () =>
          Effect.gen(function* () {
            const items = yield* aiops.listInvestigationGroups
              .items({})
              .pipe(Stream.runCollect);
            const groups: {
              name: string;
              arn: string;
              roleArn: string | undefined;
              retentionInDays: number | undefined;
            }[] = [];
            for (const item of Array.from(items)) {
              if (item.arn === undefined) continue;
              const live = yield* observeByArn(item.arn);
              if (live?.arn !== undefined && live.name !== undefined) {
                groups.push(toAttributes(live));
              }
            }
            return groups;
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const live = yield* observe(name, output?.arn);
          if (live?.arn === undefined || live.name === undefined) {
            return undefined;
          }
          const attrs = toAttributes(live);
          const tags = yield* observedTags(live.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          // Only one investigation group may exist per Region, so a
          // replacement must delete the old group before creating the new.
          if (oldName !== newName) {
            return { action: "replace", deleteFirst: true } as const;
          }
          // The retention period has no update API — replace to change it.
          if (toWireDays(olds?.retention) !== toWireDays(news?.retention)) {
            return { action: "replace", deleteFirst: true } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output.arn is only a
          //    cache of the identifier.
          let live = yield* observe(name, output?.arn);

          // 2. ENSURE — create when missing. A ConflictException here means
          //    a concurrent create raced us (one group per Region): if a
          //    group with OUR name now exists we converge on it, otherwise
          //    the conflict is a real error (a foreign group occupies the
          //    Region's single slot) and is propagated.
          if (live === undefined) {
            live = yield* aiops
              .createInvestigationGroup({
                name,
                roleArn: news.roleArn,
                retentionInDays: toWireDays(news.retention),
                encryptionConfiguration: news.encryptionConfiguration,
                tagKeyBoundaries: news.tagKeyBoundaries,
                chatbotNotificationChannel: news.chatbotNotificationChannel,
                isCloudTrailEventHistoryEnabled:
                  news.isCloudTrailEventHistoryEnabled,
                crossAccountConfigurations: news.crossAccountConfigurations,
                tags: desiredTags,
              })
              .pipe(
                retryWhileRolePropagates,
                Effect.flatMap((created) =>
                  created.arn === undefined
                    ? observe(name, undefined)
                    : observeByArn(created.arn),
                ),
                Effect.catchTag("ConflictException", (error) =>
                  observe(name, undefined).pipe(
                    Effect.flatMap((existing) =>
                      existing === undefined
                        ? Effect.fail(error)
                        : Effect.succeed(existing),
                    ),
                  ),
                ),
              );
          }

          const arn = live?.arn ?? output?.arn;

          // 3. SYNC — diff each OBSERVED mutable aspect against the desired
          //    state and PATCH only on drift. Aspects the user leaves
          //    undefined are unmanaged (left as observed).
          if (live !== undefined && arn !== undefined) {
            const update: Omit<
              aiops.UpdateInvestigationGroupRequest,
              "identifier"
            > = {};
            if (live.roleArn !== news.roleArn) {
              update.roleArn = news.roleArn;
            }
            if (
              news.encryptionConfiguration !== undefined &&
              ((live.encryptionConfiguration?.type ?? "AWS_OWNED_KEY") !==
                (news.encryptionConfiguration.type ?? "AWS_OWNED_KEY") ||
                live.encryptionConfiguration?.kmsKeyId !==
                  news.encryptionConfiguration.kmsKeyId)
            ) {
              update.encryptionConfiguration = news.encryptionConfiguration;
            }
            if (
              news.tagKeyBoundaries !== undefined &&
              !sameStringArray(
                live.tagKeyBoundaries ?? [],
                news.tagKeyBoundaries,
              )
            ) {
              update.tagKeyBoundaries = news.tagKeyBoundaries;
            }
            if (
              news.isCloudTrailEventHistoryEnabled !== undefined &&
              live.isCloudTrailEventHistoryEnabled !==
                news.isCloudTrailEventHistoryEnabled
            ) {
              update.isCloudTrailEventHistoryEnabled =
                news.isCloudTrailEventHistoryEnabled;
            }
            if (
              news.chatbotNotificationChannel !== undefined &&
              JSON.stringify(live.chatbotNotificationChannel ?? {}) !==
                JSON.stringify(news.chatbotNotificationChannel)
            ) {
              update.chatbotNotificationChannel =
                news.chatbotNotificationChannel;
            }
            if (
              news.crossAccountConfigurations !== undefined &&
              JSON.stringify(live.crossAccountConfigurations ?? []) !==
                JSON.stringify(news.crossAccountConfigurations)
            ) {
              update.crossAccountConfigurations =
                news.crossAccountConfigurations;
            }
            if (Object.keys(update).length > 0) {
              yield* aiops.updateInvestigationGroup({
                identifier: arn,
                ...update,
              });
              live = (yield* observeByArn(arn)) ?? live;
            }
          }

          // 3b. SYNC POLICY — diff the OBSERVED resource policy against the
          //     desired policy document and put/delete only on drift.
          //     `policy: undefined` leaves any existing policy unmanaged;
          //     `policy: []` deletes it.
          if (arn !== undefined && news.policy !== undefined) {
            const observedPolicy = yield* aiops
              .getInvestigationGroupPolicy({ identifier: arn })
              .pipe(
                Effect.map((r) => r.policy),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (news.policy.length === 0) {
              if (observedPolicy !== undefined) {
                yield* aiops
                  .deleteInvestigationGroupPolicy({ identifier: arn })
                  .pipe(
                    Effect.catchTag(
                      "ResourceNotFoundException",
                      () => Effect.void,
                    ),
                  );
              }
            } else {
              const desiredPolicy = JSON.stringify({
                Version: "2012-10-17",
                Statement: news.policy,
              });
              const inSync = yield* Effect.sync(() => {
                if (observedPolicy === undefined) return false;
                try {
                  return (
                    JSON.stringify(JSON.parse(observedPolicy)) === desiredPolicy
                  );
                } catch {
                  return false;
                }
              });
              if (!inSync) {
                yield* aiops.putInvestigationGroupPolicy({
                  identifier: arn,
                  policy: desiredPolicy,
                });
              }
            }
          }

          // 3c. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (create-time tags only apply on first create).
          if (arn !== undefined) {
            const currentTags = yield* observedTags(arn);
            const { upsert, removed } = diffTags(currentTags, desiredTags);
            if (upsert.length > 0) {
              yield* aiops.tagResource({
                resourceArn: arn,
                tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              });
            }
            if (removed.length > 0) {
              yield* aiops.untagResource({
                resourceArn: arn,
                tagKeys: removed,
              });
            }
          }

          yield* session.note(name);
          return {
            name: live?.name ?? name,
            arn: arn!,
            roleArn: live?.roleArn ?? news.roleArn,
            retentionInDays:
              live?.retentionInDays ?? toWireDays(news.retention),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* aiops
            .deleteInvestigationGroup({ identifier: output.arn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
