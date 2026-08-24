import * as dlm from "@distilled.cloud/aws/dlm";
import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * The activation state of a lifecycle policy. `ERROR` is only ever observed
 * (e.g. when the execution role was deleted out-of-band) — it cannot be set.
 */
export type LifecyclePolicyState = "ENABLED" | "DISABLED" | "ERROR";

/**
 * The policy type. `EBS_SNAPSHOT_MANAGEMENT` manages the lifecycle of EBS
 * snapshots; `IMAGE_MANAGEMENT` manages the lifecycle of EBS-backed AMIs.
 */
export type LifecyclePolicyType =
  | "EBS_SNAPSHOT_MANAGEMENT"
  | "IMAGE_MANAGEMENT";

/** Unit for retention intervals. */
export type LifecyclePolicyRetentionUnit =
  | "DAYS"
  | "WEEKS"
  | "MONTHS"
  | "YEARS";

export interface LifecyclePolicyCreateRule {
  /**
   * Where snapshots are created for policies targeting resources on an
   * Outpost or in a Local Zone.
   * @default "CLOUD"
   */
  location?: "CLOUD" | "OUTPOST_LOCAL" | "LOCAL_ZONE";
  /**
   * The interval between policy runs, in `intervalUnit` units (`1`, `2`,
   * `3`, `4`, `6`, `8`, `12` or `24` hours). Mutually exclusive with
   * `cronExpression`.
   */
  interval?: number;
  /**
   * The unit for {@link LifecyclePolicyCreateRule.interval}.
   * @default "HOURS"
   */
  intervalUnit?: "HOURS";
  /**
   * The time(s) of day (UTC, `HH:MM`) the policy runs when using
   * interval-based scheduling.
   */
  times?: string[];
  /**
   * A cron expression (`cron(...)`, intervals of at least 1 hour) that
   * defines when the policy runs. Mutually exclusive with `interval`.
   */
  cronExpression?: string;
}

export interface LifecyclePolicyRetainRule {
  /**
   * Number of snapshots/AMIs to retain per volume/instance (`1` - `1000`).
   * Mutually exclusive with `interval`/`intervalUnit`.
   */
  count?: number;
  /**
   * Age-based retention interval. Mutually exclusive with `count`.
   */
  interval?: number;
  /**
   * The unit for {@link LifecyclePolicyRetainRule.interval}.
   */
  intervalUnit?: LifecyclePolicyRetentionUnit;
}

export interface LifecyclePolicyFastRestoreRule {
  /**
   * Number of snapshots to keep fast-restore enabled for. Mutually
   * exclusive with `interval`.
   */
  count?: number;
  /**
   * Age-based fast-restore window. Mutually exclusive with `count`.
   */
  interval?: number;
  /** The unit for `interval`. */
  intervalUnit?: LifecyclePolicyRetentionUnit;
  /** Availability Zones in which to enable fast snapshot restore. */
  availabilityZones?: string[];
}

export interface LifecyclePolicyCrossRegionCopyRule {
  /**
   * The target region (e.g. `us-east-1`) or the ARN of a target Outpost
   * for the snapshot/AMI copies.
   */
  target: string;
  /**
   * Whether the copies are encrypted. Copies of encrypted sources are
   * always encrypted regardless of this setting.
   */
  encrypted: boolean;
  /**
   * The ARN of the KMS key to use for the copies when encryption is
   * enabled. Defaults to the default EBS KMS key when omitted.
   */
  cmkArn?: string;
  /**
   * Whether tags on the source are copied to the cross-region copies.
   * @default false
   */
  copyTags?: boolean;
  /** Retention rule for the cross-region copies. */
  retainRule?: {
    /** How long to retain the copies. */
    interval?: number;
    /** The unit for `interval`. */
    intervalUnit?: LifecyclePolicyRetentionUnit;
  };
  /**
   * AMI deprecation rule for the cross-region AMI copies
   * (`IMAGE_MANAGEMENT` policies only).
   */
  deprecateRule?: {
    /** How long before the AMI copies are deprecated. */
    interval?: number;
    /** The unit for `interval`. */
    intervalUnit?: LifecyclePolicyRetentionUnit;
  };
}

export interface LifecyclePolicyShareRule {
  /** IDs of the AWS accounts to share the snapshots with. */
  targetAccounts: string[];
  /** Period after which the snapshots are unshared. */
  unshareInterval?: number;
  /** The unit for `unshareInterval`. */
  unshareIntervalUnit?: LifecyclePolicyRetentionUnit;
}

export interface LifecyclePolicySchedule {
  /** Name of the schedule (`0` - `120` characters). */
  name?: string;
  /**
   * Whether tags are copied from the source volume/instance to the
   * snapshot/AMI.
   * @default false
   */
  copyTags?: boolean;
  /** Tags added to every snapshot/AMI created by this schedule. */
  tagsToAdd?: Record<string, string>;
  /**
   * Variable tags added to snapshots (`EBS_SNAPSHOT_MANAGEMENT` policies
   * targeting instances only). Values may use `$(instance-id)` and
   * `$(timestamp)`.
   */
  variableTags?: Record<string, string>;
  /** When the schedule creates snapshots/AMIs. */
  createRule?: LifecyclePolicyCreateRule;
  /** How long the snapshots/AMIs are retained. */
  retainRule?: LifecyclePolicyRetainRule;
  /**
   * Fast snapshot restore rule (`EBS_SNAPSHOT_MANAGEMENT` policies only).
   */
  fastRestoreRule?: LifecyclePolicyFastRestoreRule;
  /** Cross-region copy rules (up to 3). */
  crossRegionCopyRules?: LifecyclePolicyCrossRegionCopyRule[];
  /**
   * Snapshot sharing rules (`EBS_SNAPSHOT_MANAGEMENT` policies only).
   */
  shareRules?: LifecyclePolicyShareRule[];
  /**
   * AMI deprecation rule (`IMAGE_MANAGEMENT` policies only). Mutually
   * exclusive constraints mirror the retain rule (`count` vs `interval`).
   */
  deprecateRule?: {
    /** Number of newest AMIs to keep un-deprecated. */
    count?: number;
    /** Age after which AMIs are deprecated. */
    interval?: number;
    /** The unit for `interval`. */
    intervalUnit?: LifecyclePolicyRetentionUnit;
  };
  /**
   * Snapshot archiving rule (`EBS_SNAPSHOT_MANAGEMENT` policies with
   * count-based retention only).
   */
  archiveRule?: {
    /** Retention for snapshots in the archive tier. */
    retainRule: {
      /** Archive-tier retention settings. */
      retentionArchiveTier: {
        /** Number of snapshots to retain in the archive tier. */
        count?: number;
        /** Age-based archive-tier retention. */
        interval?: number;
        /** The unit for `interval`. */
        intervalUnit?: LifecyclePolicyRetentionUnit;
      };
    };
  };
}

export interface LifecyclePolicyDetails {
  /**
   * The policy type. Changing the type triggers a replacement.
   * @default "EBS_SNAPSHOT_MANAGEMENT"
   */
  policyType?: LifecyclePolicyType;
  /**
   * The resource type targeted by the policy. `VOLUME` creates snapshots
   * of individual volumes; `INSTANCE` creates multi-volume snapshot sets
   * (or AMIs for `IMAGE_MANAGEMENT`).
   */
  resourceTypes?: ("VOLUME" | "INSTANCE")[];
  /**
   * The location of the targeted resources.
   * @default ["CLOUD"]
   */
  resourceLocations?: ("CLOUD" | "OUTPOST" | "LOCAL_ZONE")[];
  /**
   * The resource tags that identify the volumes/instances the policy
   * applies to.
   */
  targetTags?: Record<string, string>;
  /** The schedules (1 mandatory + up to 3 optional). */
  schedules?: LifecyclePolicySchedule[];
  /** Options specific to the policy/resource type. */
  parameters?: {
    /**
     * Exclude the boot volume from multi-volume snapshot sets
     * (`EBS_SNAPSHOT_MANAGEMENT` targeting instances only).
     * @default false
     */
    excludeBootVolume?: boolean;
    /**
     * Skip rebooting the instance when creating AMIs
     * (`IMAGE_MANAGEMENT` only).
     * @default true
     */
    noReboot?: boolean;
    /**
     * Exclude data volumes with these tags from multi-volume snapshot
     * sets (`EBS_SNAPSHOT_MANAGEMENT` targeting instances only).
     */
    excludeDataVolumeTags?: Record<string, string>;
  };
}

export interface LifecyclePolicyProps {
  /**
   * Description of the policy (`0` - `500` characters; letters, digits,
   * spaces, `_` and `-`). If omitted, a deterministic description is
   * generated from the app, stage, and logical ID.
   */
  description?: string;
  /**
   * The activation state of the policy.
   * @default "ENABLED"
   */
  state?: "ENABLED" | "DISABLED";
  /**
   * The ARN of an existing IAM role Amazon Data Lifecycle Manager assumes
   * to run the policy. When omitted, an execution role is created
   * automatically with `dlm.amazonaws.com` trust and the AWS managed
   * policy matching the policy type (`AWSDataLifecycleManagerServiceRole`
   * for snapshot policies, `AWSDataLifecycleManagerServiceRoleForAMIManagement`
   * for AMI policies).
   */
  executionRoleArn?: string;
  /**
   * The configuration of the policy: what it targets and when/how it
   * creates and retains snapshots or AMIs.
   */
  policyDetails: LifecyclePolicyDetails;
  /**
   * Tags to apply to the lifecycle policy. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface LifecyclePolicy extends Resource<
  "AWS.DLM.LifecyclePolicy",
  LifecyclePolicyProps,
  {
    /** The auto-assigned ID of the policy (e.g. `policy-0123456789abcdef0`). */
    policyId: string;
    /** ARN of the policy. */
    policyArn: string;
    /** The activation state of the policy. */
    state: LifecyclePolicyState;
    /** The ARN of the IAM role the policy runs as. */
    executionRoleArn: string;
    /**
     * Name of the auto-created execution role. `undefined` when an
     * explicit {@link LifecyclePolicyProps.executionRoleArn} is used.
     */
    roleName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Data Lifecycle Manager (DLM) lifecycle policy that automates the
 * creation, retention, and deletion of EBS snapshots or EBS-backed AMIs.
 *
 * `LifecyclePolicy` owns a custom `EBS_SNAPSHOT_MANAGEMENT` or
 * `IMAGE_MANAGEMENT` policy. Volumes/instances are targeted by tags, and an
 * execution role is created automatically unless an explicit
 * `executionRoleArn` is given.
 * @resource
 * @section Creating Policies
 * @example Daily EBS snapshots retained for a week
 * ```typescript
 * import * as DLM from "alchemy/AWS/DLM";
 *
 * const policy = yield* DLM.LifecyclePolicy("DailySnapshots", {
 *   policyDetails: {
 *     resourceTypes: ["VOLUME"],
 *     targetTags: { Backup: "daily" },
 *     schedules: [
 *       {
 *         name: "Daily",
 *         createRule: { interval: 24, intervalUnit: "HOURS", times: ["03:00"] },
 *         retainRule: { count: 7 },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @example Cron-scheduled snapshots
 * ```typescript
 * const policy = yield* DLM.LifecyclePolicy("WeeklySnapshots", {
 *   description: "Weekly volume snapshots",
 *   policyDetails: {
 *     resourceTypes: ["VOLUME"],
 *     targetTags: { Backup: "weekly" },
 *     schedules: [
 *       {
 *         name: "Weekly",
 *         copyTags: true,
 *         createRule: { cronExpression: "cron(0 4 ? * SUN *)" },
 *         retainRule: { interval: 1, intervalUnit: "MONTHS" },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @section AMI Policies
 * @example EBS-backed AMIs of tagged instances
 * ```typescript
 * const amis = yield* DLM.LifecyclePolicy("NightlyAmis", {
 *   policyDetails: {
 *     policyType: "IMAGE_MANAGEMENT",
 *     resourceTypes: ["INSTANCE"],
 *     targetTags: { Backup: "ami" },
 *     parameters: { noReboot: true },
 *     schedules: [
 *       {
 *         name: "Nightly",
 *         createRule: { interval: 24, intervalUnit: "HOURS", times: ["05:00"] },
 *         retainRule: { count: 3 },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @section Execution Role
 * @example Bring your own execution role
 * ```typescript
 * const role = yield* IAM.Role("DlmRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "dlm.amazonaws.com" },
 *         Action: "sts:AssumeRole",
 *       },
 *     ],
 *   },
 *   managedPolicyArns: [
 *     "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole",
 *   ],
 * });
 *
 * const policy = yield* DLM.LifecyclePolicy("Snapshots", {
 *   executionRoleArn: role.roleArn,
 *   state: "DISABLED",
 *   policyDetails: {
 *     resourceTypes: ["VOLUME"],
 *     targetTags: { Backup: "true" },
 *     schedules: [
 *       {
 *         name: "Daily",
 *         createRule: { interval: 24, intervalUnit: "HOURS" },
 *         retainRule: { count: 2 },
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const LifecyclePolicy = Resource<LifecyclePolicy>(
  "AWS.DLM.LifecyclePolicy",
);

/** AWS managed policy granting DLM the permissions for snapshot policies. */
const SNAPSHOT_MANAGED_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole";

/** AWS managed policy granting DLM the permissions for AMI policies. */
const AMI_MANAGED_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRoleForAMIManagement";

/** Convert a tag record to the DLM wire tag list, sorted for stable diffs. */
const toWireTagList = (
  tags: Record<string, string> | undefined,
): dlm.Tag[] | undefined =>
  tags === undefined
    ? undefined
    : Object.entries(tags)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([Key, Value]) => ({ Key, Value }));

/** Convert a wire tag map (values possibly undefined) to a plain record. */
const fromWireTagMap = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/** Map the camelCase schedule props to the DLM wire shape. */
const toWireSchedule = (schedule: LifecyclePolicySchedule): dlm.Schedule => ({
  Name: schedule.name,
  CopyTags: schedule.copyTags,
  TagsToAdd: toWireTagList(schedule.tagsToAdd),
  VariableTags: toWireTagList(schedule.variableTags),
  CreateRule:
    schedule.createRule === undefined
      ? undefined
      : {
          Location: schedule.createRule.location,
          Interval: schedule.createRule.interval,
          IntervalUnit: schedule.createRule.intervalUnit,
          Times: schedule.createRule.times,
          CronExpression: schedule.createRule.cronExpression,
        },
  RetainRule:
    schedule.retainRule === undefined
      ? undefined
      : {
          Count: schedule.retainRule.count,
          Interval: schedule.retainRule.interval,
          IntervalUnit: schedule.retainRule.intervalUnit,
        },
  FastRestoreRule:
    schedule.fastRestoreRule === undefined
      ? undefined
      : {
          Count: schedule.fastRestoreRule.count,
          Interval: schedule.fastRestoreRule.interval,
          IntervalUnit: schedule.fastRestoreRule.intervalUnit,
          AvailabilityZones: schedule.fastRestoreRule.availabilityZones,
        },
  CrossRegionCopyRules: schedule.crossRegionCopyRules?.map((rule) => ({
    Target: rule.target,
    Encrypted: rule.encrypted,
    CmkArn: rule.cmkArn,
    CopyTags: rule.copyTags,
    RetainRule:
      rule.retainRule === undefined
        ? undefined
        : {
            Interval: rule.retainRule.interval,
            IntervalUnit: rule.retainRule.intervalUnit,
          },
    DeprecateRule:
      rule.deprecateRule === undefined
        ? undefined
        : {
            Interval: rule.deprecateRule.interval,
            IntervalUnit: rule.deprecateRule.intervalUnit,
          },
  })),
  ShareRules: schedule.shareRules?.map((rule) => ({
    TargetAccounts: rule.targetAccounts,
    UnshareInterval: rule.unshareInterval,
    UnshareIntervalUnit: rule.unshareIntervalUnit,
  })),
  DeprecateRule:
    schedule.deprecateRule === undefined
      ? undefined
      : {
          Count: schedule.deprecateRule.count,
          Interval: schedule.deprecateRule.interval,
          IntervalUnit: schedule.deprecateRule.intervalUnit,
        },
  ArchiveRule:
    schedule.archiveRule === undefined
      ? undefined
      : {
          RetainRule: {
            RetentionArchiveTier: {
              Count: schedule.archiveRule.retainRule.retentionArchiveTier.count,
              Interval:
                schedule.archiveRule.retainRule.retentionArchiveTier.interval,
              IntervalUnit:
                schedule.archiveRule.retainRule.retentionArchiveTier
                  .intervalUnit,
            },
          },
        },
});

/** Map the camelCase policy details props to the DLM wire shape. */
const toWirePolicyDetails = (
  details: LifecyclePolicyDetails,
): dlm.PolicyDetails => ({
  PolicyType: details.policyType ?? "EBS_SNAPSHOT_MANAGEMENT",
  ResourceTypes: details.resourceTypes,
  ResourceLocations: details.resourceLocations,
  TargetTags: toWireTagList(details.targetTags),
  Schedules: details.schedules?.map(toWireSchedule),
  Parameters:
    details.parameters === undefined
      ? undefined
      : {
          ExcludeBootVolume: details.parameters.excludeBootVolume,
          NoReboot: details.parameters.noReboot,
          ExcludeDataVolumeTags: toWireTagList(
            details.parameters.excludeDataVolumeTags,
          ),
        },
});

/**
 * Canonicalize a wire value for drift comparison: drop `undefined` members,
 * sort object keys, and sort `{Key, Value}` tag lists by key so record-order
 * differences never register as drift.
 */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    const isTagList = items.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        Object.keys(item).every((k) => k === "Key" || k === "Value"),
    );
    return isTagList
      ? [...items].sort((a, b) => {
          const ak = (a as { Key?: string }).Key ?? "";
          const bk = (b as { Key?: string }).Key ?? "";
          return ak < bk ? -1 : ak > bk ? 1 : 0;
        })
      : items;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
};

/**
 * Project the observed value down to the keys present in the desired value,
 * recursively. DLM normalizes policies on read (adding defaults like
 * `PolicyLanguage`, `ResourceLocations`, or `CopyTags: false`), so comparing
 * the full observed document against our sparse desired document would flag
 * drift on every reconcile. Keys we do not manage are ignored.
 */
const projectToDesired = (desired: unknown, observed: unknown): unknown => {
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed)) return observed;
    if (desired.length !== observed.length) return observed;
    return desired.map((item, i) => projectToDesired(item, observed[i]));
  }
  if (
    desired !== null &&
    typeof desired === "object" &&
    observed !== null &&
    typeof observed === "object" &&
    !Array.isArray(observed)
  ) {
    return Object.fromEntries(
      Object.entries(desired as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [
          k,
          projectToDesired(v, (observed as Record<string, unknown>)[k]),
        ]),
    );
  }
  return observed;
};

/** Whether the observed wire document drifted from the desired one. */
const policyDetailsDrifted = (
  desired: dlm.PolicyDetails,
  observed: dlm.PolicyDetails | undefined,
): boolean =>
  JSON.stringify(canonicalize(desired)) !==
  JSON.stringify(canonicalize(projectToDesired(desired, observed ?? {})));

/**
 * DLM validates the execution role at create/update time; a freshly created
 * role can be transiently rejected with `InvalidRequestException` until IAM
 * propagation completes. Bounded retry, explicitly typed so declaration emit
 * never widens the provider layer (see PATTERNS §7).
 */
const retryWhileRolePropagates = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidRequestException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
  });

export const LifecyclePolicyProvider = () =>
  Provider.effect(
    LifecyclePolicy,
    Effect.gen(function* () {
      const createDescription = Effect.fn(function* (
        id: string,
        props: Pick<LifecyclePolicyProps, "description">,
      ) {
        return (
          props.description ??
          (yield* createPhysicalName({ id, maxLength: 500 }))
        );
      });

      const createRoleName = (id: string) =>
        createPhysicalName({ id, maxLength: 64 });

      const managedPolicyArnFor = (details: LifecyclePolicyDetails) =>
        (details.policyType ?? "EBS_SNAPSHOT_MANAGEMENT") === "IMAGE_MANAGEMENT"
          ? AMI_MANAGED_POLICY_ARN
          : SNAPSHOT_MANAGED_POLICY_ARN;

      const getOrUndefined = Effect.fn(function* (policyId: string) {
        return yield* dlm.getLifecyclePolicy({ PolicyId: policyId }).pipe(
          Effect.map((r) => r.Policy),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const buildAttrs = (
        policy: dlm.LifecyclePolicy,
        roleName: string | undefined,
      ) => ({
        policyId: policy.PolicyId!,
        policyArn: policy.PolicyArn!,
        state: (policy.State ?? "ENABLED") as LifecyclePolicyState,
        executionRoleArn: policy.ExecutionRoleArn!,
        roleName,
      });

      /**
       * Ensure the auto-created execution role exists with `dlm.amazonaws.com`
       * trust and the AWS managed policy matching the policy type. Idempotent:
       * tolerates the role already existing; attaching an already-attached
       * managed policy is a no-op.
       */
      const ensureExecutionRole = Effect.fn(function* ({
        id,
        roleName,
        managedPolicyArn,
      }: {
        id: string;
        roleName: string;
        managedPolicyArn: string;
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "dlm.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }),
            ),
          );
        yield* iam.attachRolePolicy({
          RoleName: roleName,
          PolicyArn: managedPolicyArn,
        });
        return role.Role.Arn;
      });

      return LifecyclePolicy.Provider.of({
        stables: ["policyId", "policyArn"],

        // Enumerate every lifecycle policy in the ambient account/region.
        // getLifecyclePolicies is unpaginated; hydrate each summary because
        // the full attributes (ARN, role) only appear on the detail call. A
        // policy can vanish between enumeration and hydration — drop it.
        list: () =>
          Effect.gen(function* () {
            const { Policies } = yield* dlm.getLifecyclePolicies({});
            const items = yield* Effect.forEach(
              Policies ?? [],
              (summary) =>
                summary.PolicyId === undefined
                  ? Effect.succeed(undefined)
                  : getOrUndefined(summary.PolicyId).pipe(
                      Effect.map((policy) =>
                        policy?.PolicyId !== undefined &&
                        policy.PolicyArn !== undefined &&
                        policy.ExecutionRoleArn !== undefined
                          ? buildAttrs(policy, undefined)
                          : undefined,
                      ),
                    ),
              { concurrency: 5 },
            );
            return items.filter(
              (item): item is LifecyclePolicy["Attributes"] =>
                item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, output }) {
          // Policy ids are server-assigned; without an output cache there is
          // no deterministic identity to look up. (A tag-based search would
          // mis-resolve the OLD instance during a replacement, since both
          // instances share the same logical-id tags.)
          if (output?.policyId === undefined) return undefined;
          const policy = yield* getOrUndefined(output.policyId);
          if (
            policy?.PolicyId === undefined ||
            policy.PolicyArn === undefined ||
            policy.ExecutionRoleArn === undefined
          ) {
            return undefined;
          }
          const attrs = buildAttrs(policy, output?.roleName);
          return (yield* hasAlchemyTags(id, fromWireTagMap(policy.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldType =
            olds?.policyDetails?.policyType ?? "EBS_SNAPSHOT_MANAGEMENT";
          const newType =
            news.policyDetails?.policyType ?? "EBS_SNAPSHOT_MANAGEMENT";
          if (oldType !== newType) {
            // The policy type of an existing policy cannot be changed.
            return { action: "replace" } as const;
          }
          // description/state/role/details/tags converge via update
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const description = yield* createDescription(id, news);
          const desiredState = news.state ?? "ENABLED";
          const desiredDetails = toWirePolicyDetails(news.policyDetails ?? {});
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Ensure the execution role first — the policy cannot exist
          // without one. Managed unless an explicit executionRoleArn is
          // provided.
          let executionRoleArn = news.executionRoleArn;
          let roleName: string | undefined;
          if (executionRoleArn === undefined) {
            roleName = yield* createRoleName(id);
            executionRoleArn = yield* ensureExecutionRole({
              id,
              roleName,
              managedPolicyArn: managedPolicyArnFor(news.policyDetails ?? {}),
            });
          }

          // 1. OBSERVE — cloud state is authoritative; `output` is only an
          //    id cache. Policy ids are server-assigned, so with no cached
          //    id the policy is (as far as we can know) missing.
          let policyId = output?.policyId;
          let observed =
            policyId === undefined
              ? undefined
              : yield* getOrUndefined(policyId);

          if (observed === undefined) {
            // 2. ENSURE — create. IAM propagation of a fresh role is
            //    eventually consistent; DLM rejects it with a transient
            //    InvalidRequestException, so retry briefly.
            const created = yield* retryWhileRolePropagates(
              dlm.createLifecyclePolicy({
                ExecutionRoleArn: executionRoleArn,
                Description: description,
                State: desiredState,
                PolicyDetails: desiredDetails,
                Tags: desiredTags,
              }),
            );
            policyId = created.PolicyId!;
            observed = yield* getOrUndefined(policyId);
          } else {
            // 3. SYNC — diff OBSERVED cloud state against desired and issue
            //    a single update only when something actually drifted. DLM
            //    normalizes documents on read (defaults like PolicyLanguage
            //    or ResourceLocations appear), so the comparison projects
            //    the observed document down to the keys we manage.
            const drifted =
              observed.Description !== description ||
              (observed.State ?? "ENABLED") !== desiredState ||
              observed.ExecutionRoleArn !== executionRoleArn ||
              policyDetailsDrifted(desiredDetails, observed.PolicyDetails);
            if (drifted) {
              yield* retryWhileRolePropagates(
                dlm.updateLifecyclePolicy({
                  PolicyId: policyId!,
                  ExecutionRoleArn: executionRoleArn,
                  Description: description,
                  State: desiredState,
                  PolicyDetails: desiredDetails,
                }),
              );
              observed = yield* getOrUndefined(policyId!);
            }
          }

          if (
            observed?.PolicyId === undefined ||
            observed.PolicyArn === undefined ||
            observed.ExecutionRoleArn === undefined
          ) {
            // The policy vanished between create/update and the final read —
            // surface as a typed not-found so the engine can retry the plan.
            return yield* Effect.fail(
              new dlm.ResourceNotFoundException({
                Message: `DLM lifecycle policy ${policyId} disappeared during reconcile`,
              }),
            );
          }

          // 3b. SYNC TAGS — against OBSERVED cloud tags so adoption
          //     converges (create-time tags only apply on first create).
          const observedTags = fromWireTagMap(observed.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* dlm.tagResource({
              ResourceArn: observed.PolicyArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* dlm.untagResource({
              ResourceArn: observed.PolicyArn,
              TagKeys: removed,
            });
          }

          yield* session.note(observed.PolicyId);
          return buildAttrs(observed, roleName);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* dlm
            .deleteLifecyclePolicy({ PolicyId: output.policyId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          // Tear down the managed execution role (absent when the user
          // supplied an explicit executionRoleArn). Every step tolerates
          // the role being partially or fully gone already.
          if (output.roleName !== undefined) {
            const roleName = output.roleName;
            yield* iam.listAttachedRolePolicies({ RoleName: roleName }).pipe(
              Effect.flatMap((r) =>
                Effect.forEach(r.AttachedPolicies ?? [], (policy) =>
                  policy.PolicyArn === undefined
                    ? Effect.void
                    : iam
                        .detachRolePolicy({
                          RoleName: roleName,
                          PolicyArn: policy.PolicyArn,
                        })
                        .pipe(
                          Effect.catchTag(
                            "NoSuchEntityException",
                            () => Effect.void,
                          ),
                        ),
                ),
              ),
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );
            yield* iam
              .deleteRole({ RoleName: roleName })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }),
      });
    }),
  );
