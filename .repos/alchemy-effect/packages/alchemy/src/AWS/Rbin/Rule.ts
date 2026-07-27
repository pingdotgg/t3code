import * as rbin from "@distilled.cloud/aws/rbin";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * A resource tag used to identify (or exclude) resources covered by a
 * retention rule.
 */
export interface RuleResourceTag {
  /**
   * The tag key.
   */
  key: string;
  /**
   * The tag value. Omit to match any resource that has the tag key,
   * regardless of value.
   */
  value?: string;
}

/**
 * Lock configuration for a Region-level retention rule. A locked rule
 * cannot be modified or deleted until it is unlocked and the unlock delay
 * period expires.
 */
export interface RuleLockConfiguration {
  /**
   * The unlock delay that must expire after the rule is unlocked before it
   * can be modified or deleted (e.g. `"7 days"`; valid range 7-30 days).
   * Sent to the API in whole days.
   */
  unlockDelay: Duration.Input;
}

export interface RuleProps {
  /**
   * The resource type to be retained by the retention rule:
   * `EBS_SNAPSHOT` for Amazon EBS snapshots, `EC2_IMAGE` for EBS-backed
   * AMIs, or `EBS_VOLUME` for Amazon EBS volumes.
   * Changing the resource type replaces the rule.
   */
  resourceType: "EBS_SNAPSHOT" | "EC2_IMAGE" | "EBS_VOLUME";

  /**
   * The period for which the retention rule retains resources after they
   * are deleted (e.g. `"7 days"` or `Duration.days(7)`; valid range
   * 1-365 days). Sent to the API in whole days.
   */
  retentionPeriod: Duration.Input;

  /**
   * A brief description of the retention rule.
   */
  description?: string;

  /**
   * Resource tags that identify the resources to retain (a **tag-level**
   * retention rule). Resources of the specified type that have at least one
   * of these tag key/value pairs are retained in the Recycle Bin upon
   * deletion. Omit (along with `excludeResourceTags`) to create a
   * **Region-level** rule that retains all resources of the type in the
   * Region.
   */
  resourceTags?: RuleResourceTag[];

  /**
   * Exclusion tags for a Region-level retention rule. Resources that have
   * any of these tag key/value pairs are NOT retained by the rule. Cannot
   * be combined with `resourceTags` or `lockConfiguration`.
   */
  excludeResourceTags?: RuleResourceTag[];

  /**
   * Lock configuration for the rule. Only Region-level rules without
   * exclusion tags can be locked. A locked rule cannot be modified or
   * deleted; removing this prop unlocks the rule, which then remains in
   * `pending_unlock` until the unlock delay (7-30 days) expires.
   */
  lockConfiguration?: RuleLockConfiguration;

  /**
   * Tags to apply to the retention rule itself. Merged with internal
   * Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Rule extends Resource<
  "AWS.Rbin.Rule",
  RuleProps,
  {
    /** The unique ID of the retention rule (e.g. `1a2b3c4d-5e6f-...`). */
    identifier: string;
    /** The Amazon Resource Name (ARN) of the retention rule. */
    ruleArn: string;
    /** The resource type retained by the retention rule. */
    resourceType: rbin.ResourceType;
    /** The state of the retention rule (`pending` or `available`). */
    status: rbin.RuleStatus;
    /** The lock state of the retention rule, if lockable. */
    lockState?: rbin.LockState;
  },
  never,
  Providers
> {}

/**
 * A Recycle Bin retention rule. Recycle Bin retains deleted EBS snapshots,
 * EBS-backed AMIs, and EBS volumes for a configurable period so they can be
 * recovered after accidental deletion.
 *
 * Rules are either **tag-level** (retain only resources carrying specific
 * resource tags) or **Region-level** (retain every resource of the type in
 * the Region, optionally minus exclusion tags). Changing `resourceType`
 * replaces the rule; every other property updates in place.
 *
 * @resource
 * @section Creating Retention Rules
 * @example Tag-level rule for EBS snapshots
 * ```typescript
 * import * as Rbin from "alchemy/AWS/Rbin";
 *
 * const rule = yield* Rbin.Rule("SnapshotRetention", {
 *   resourceType: "EBS_SNAPSHOT",
 *   retentionPeriod: "7 days",
 *   description: "Retain tagged snapshots for 7 days",
 *   resourceTags: [{ key: "team", value: "data" }],
 * });
 * ```
 *
 * @example Region-level rule for AMIs
 * ```typescript
 * const rule = yield* Rbin.Rule("AmiRetention", {
 *   resourceType: "EC2_IMAGE",
 *   retentionPeriod: "14 days",
 *   description: "Retain all deregistered AMIs in this Region",
 * });
 * ```
 *
 * @example Region-level rule with exclusion tags
 * ```typescript
 * const rule = yield* Rbin.Rule("SnapshotRetention", {
 *   resourceType: "EBS_SNAPSHOT",
 *   retentionPeriod: "30 days",
 *   excludeResourceTags: [{ key: "ephemeral", value: "true" }],
 * });
 * ```
 *
 * @section Locking
 * A Region-level rule (without exclusion tags) can be locked so it cannot
 * be modified or deleted. Removing `lockConfiguration` unlocks the rule,
 * which stays protected in `pending_unlock` until the unlock delay expires.
 *
 * @example Locked Region-level rule
 * ```typescript
 * const rule = yield* Rbin.Rule("LockedRetention", {
 *   resourceType: "EBS_SNAPSHOT",
 *   retentionPeriod: "30 days",
 *   lockConfiguration: { unlockDelay: "7 days" },
 * });
 * ```
 *
 * @section Tagging
 * @example Tag the rule itself
 * ```typescript
 * const rule = yield* Rbin.Rule("SnapshotRetention", {
 *   resourceType: "EBS_SNAPSHOT",
 *   retentionPeriod: "7 days",
 *   resourceTags: [{ key: "team", value: "data" }],
 *   tags: { CostCenter: "storage" },
 * });
 * ```
 */
export const Rule = Resource<Rule>("AWS.Rbin.Rule");

/**
 * Raised when a `Rule` combines `lockConfiguration` with `resourceTags` or
 * `excludeResourceTags`. Recycle Bin only supports locking Region-level
 * retention rules that have no exclusion tags.
 */
export class RbinLockUnsupported extends Data.TaggedError(
  "RbinLockUnsupported",
)<{ message: string }> {}

const validateLock = (props: RuleProps) =>
  props.lockConfiguration !== undefined &&
  ((props.resourceTags?.length ?? 0) > 0 ||
    (props.excludeResourceTags?.length ?? 0) > 0)
    ? Effect.fail(
        new RbinLockUnsupported({
          message:
            "lockConfiguration is only supported on Region-level retention rules without excludeResourceTags — remove resourceTags/excludeResourceTags or the lock.",
        }),
      )
    : Effect.void;

/** All resource types a retention rule can cover — used to enumerate rules. */
const RULE_RESOURCE_TYPES = [
  "EBS_SNAPSHOT",
  "EC2_IMAGE",
  "EBS_VOLUME",
] as const;

const toRetentionPeriod = (p: Duration.Input): rbin.RetentionPeriod => ({
  // The wire unit is whole days (`DAYS` is the only supported unit).
  RetentionPeriodValue: toWireDays(p)!,
  RetentionPeriodUnit: "DAYS",
});

const toResourceTags = (
  tags: RuleResourceTag[] | undefined,
): rbin.ResourceTag[] =>
  (tags ?? []).map((t) => ({
    ResourceTagKey: t.key,
    ...(t.value !== undefined ? { ResourceTagValue: t.value } : {}),
  }));

const toLockConfiguration = (
  lock: RuleLockConfiguration,
): rbin.LockConfiguration => ({
  UnlockDelay: {
    // The wire unit is whole days (`DAYS` is the only supported unit).
    UnlockDelayValue: toWireDays(lock.unlockDelay)!,
    UnlockDelayUnit: "DAYS",
  },
});

/** Order-insensitive fingerprint of a resource-tag set for delta detection. */
const resourceTagsKey = (tags: readonly rbin.ResourceTag[] | undefined) =>
  JSON.stringify(
    (tags ?? [])
      .map((t) => [t.ResourceTagKey, t.ResourceTagValue ?? ""])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
  );

const toAttributes = (live: rbin.GetRuleResponse): Rule["Attributes"] => ({
  identifier: live.Identifier!,
  ruleArn: live.RuleArn!,
  resourceType: live.ResourceType!,
  status: live.Status ?? "available",
  lockState: live.LockState,
});

/** Read a rule; a typed RULE_NOT_FOUND becomes `undefined`. */
const readRule = (identifier: string) =>
  rbin
    .getRule({ Identifier: identifier })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

/** Observed tags on the rule itself (empty on a NotFound race). */
const readRuleTags = (ruleArn: string) =>
  rbin.listTagsForResource({ ResourceArn: ruleArn }).pipe(
    Effect.map((r) => tagRecord(r.Tags ?? [])),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed({} as Record<string, string>),
    ),
  );

/** Collect all rule summaries for one resource type (exhaustive pages). */
const listRuleSummaries = (resourceType: rbin.ResourceType) =>
  rbin.listRules.items({ ResourceType: resourceType }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    // Tolerate a resource type the Region/partition doesn't support yet.
    Effect.catchTag("ValidationException", () =>
      Effect.succeed([] as rbin.RuleSummary[]),
    ),
  );

class RuleStillPending extends Data.TaggedError("RuleStillPending")<{
  identifier: string;
}> {}

class RuleStillExists extends Data.TaggedError("RuleStillExists")<{
  identifier: string;
}> {}

/**
 * Bounded retry while a freshly created/updated rule reports `pending`.
 * Extracted to module scope with an explicit signature so the conditional
 * `Retry.Return` type never leaks into the provider layer's declaration.
 */
const retryWhileRulePending = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E | RuleStillPending, R>,
): Effect.Effect<A, E | RuleStillPending, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "RuleStillPending",
    schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(30)]),
  });

/** Poll a rule until it leaves the transient `pending` status. */
const waitForRuleAvailable = (identifier: string) =>
  retryWhileRulePending(
    Effect.gen(function* () {
      const live = yield* rbin.getRule({ Identifier: identifier });
      if (live.Status === "pending") {
        return yield* new RuleStillPending({ identifier });
      }
      return live;
    }),
  );

/** Bounded retry while the rule is still observable after deletion. */
const retryWhileRuleExists = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E | RuleStillExists, R>,
): Effect.Effect<A, E | RuleStillExists, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "RuleStillExists",
    schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(15)]),
  });

export const RuleProvider = () =>
  Provider.effect(
    Rule,
    Effect.gen(function* () {
      return Rule.Provider.of({
        stables: ["identifier", "ruleArn", "resourceType"],

        // Enumerate every retention rule in the ambient account/region across
        // all supported resource types, hydrating each summary to the full
        // Attributes shape. A rule can vanish between enumeration and
        // hydration, so tolerate the typed NotFound per item and drop it.
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* Effect.forEach(
              RULE_RESOURCE_TYPES,
              (resourceType) => listRuleSummaries(resourceType),
              { concurrency: 3 },
            ).pipe(Effect.map((groups) => groups.flat()));
            const items = yield* Effect.forEach(
              summaries.filter((s) => s.Identifier !== undefined),
              (summary) =>
                readRule(summary.Identifier!).pipe(
                  Effect.map((live) =>
                    live === undefined ? undefined : toAttributes(live),
                  ),
                ),
              { concurrency: 5 },
            );
            return items.filter(
              (item): item is Rule["Attributes"] => item !== undefined,
            );
          }),

        // Rule identifiers are server-generated, so without a cached output
        // we search for a rule branded with our alchemy ownership tags.
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.identifier) {
            const live = yield* readRule(output.identifier);
            if (!live) return undefined;
            const attrs = toAttributes(live);
            const tags = yield* readRuleTags(attrs.ruleArn);
            return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
          }
          const resourceTypes = olds?.resourceType
            ? [olds.resourceType]
            : RULE_RESOURCE_TYPES;
          for (const resourceType of resourceTypes) {
            const summaries = yield* listRuleSummaries(resourceType);
            for (const summary of summaries) {
              if (!summary.Identifier || !summary.RuleArn) continue;
              const tags = yield* readRuleTags(summary.RuleArn);
              if (yield* hasAlchemyTags(id, tags)) {
                const live = yield* readRule(summary.Identifier);
                if (live) return toAttributes(live);
              }
            }
          }
          return undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          yield* validateLock(news);
          // The resource type of a retention rule cannot be changed after
          // creation — a change requires replacement.
          if (news.resourceType !== olds.resourceType) {
            return { action: "replace" } as const;
          }
          // Everything else (retention period, description, resource tags,
          // exclusion tags, lock, tags) updates in place.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          yield* validateLock(news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // OBSERVE — `output.identifier` is only a cache; a rule deleted
          // out-of-band falls through to create.
          let live = output?.identifier
            ? yield* readRule(output.identifier)
            : undefined;

          // ENSURE — create if missing, then wait out the transient
          // `pending` status so downstream sync reads settled state.
          if (live === undefined) {
            const created = yield* rbin.createRule({
              ResourceType: news.resourceType,
              RetentionPeriod: toRetentionPeriod(news.retentionPeriod),
              Description: news.description,
              ...(news.resourceTags
                ? { ResourceTags: toResourceTags(news.resourceTags) }
                : {}),
              ...(news.excludeResourceTags
                ? {
                    ExcludeResourceTags: toResourceTags(
                      news.excludeResourceTags,
                    ),
                  }
                : {}),
              ...(news.lockConfiguration
                ? {
                    LockConfiguration: toLockConfiguration(
                      news.lockConfiguration,
                    ),
                  }
                : {}),
              Tags: createTagsList(desiredTags),
            });
            yield* session.note(`Created retention rule ${created.Identifier}`);
            live = yield* waitForRuleAvailable(created.Identifier!);
          }
          const identifier = live.Identifier!;
          const ruleArn = live.RuleArn!;

          // SYNC mutable settings — diff OBSERVED cloud state against the
          // desired props and apply only the delta. A no-op skips the API
          // call entirely (a fresh create always lands here as a no-op).
          const desiredRetention = toRetentionPeriod(news.retentionPeriod);
          const desiredResourceTags = toResourceTags(news.resourceTags);
          const desiredExcludeTags = toResourceTags(news.excludeResourceTags);
          const retentionChanged =
            live.RetentionPeriod?.RetentionPeriodValue !==
              desiredRetention.RetentionPeriodValue ||
            live.RetentionPeriod?.RetentionPeriodUnit !==
              desiredRetention.RetentionPeriodUnit;
          const descriptionChanged =
            (live.Description ?? "") !== (news.description ?? "");
          const resourceTagsChanged =
            resourceTagsKey(live.ResourceTags) !==
            resourceTagsKey(desiredResourceTags);
          const excludeTagsChanged =
            resourceTagsKey(live.ExcludeResourceTags) !==
            resourceTagsKey(desiredExcludeTags);
          if (
            retentionChanged ||
            descriptionChanged ||
            resourceTagsChanged ||
            excludeTagsChanged
          ) {
            yield* rbin.updateRule({
              Identifier: identifier,
              ...(retentionChanged
                ? { RetentionPeriod: desiredRetention }
                : {}),
              ...(descriptionChanged
                ? { Description: news.description ?? "" }
                : {}),
              ...(resourceTagsChanged
                ? { ResourceTags: desiredResourceTags }
                : {}),
              ...(excludeTagsChanged
                ? { ExcludeResourceTags: desiredExcludeTags }
                : {}),
            });
            live = yield* waitForRuleAvailable(identifier);
          }

          // SYNC lock state — observed lock state vs desired. Unlocking
          // starts the unlock delay (`pending_unlock`); re-locking during
          // that window is allowed and converges back to `locked`.
          if (news.lockConfiguration !== undefined) {
            const desiredLock = toLockConfiguration(news.lockConfiguration);
            const lockDelta =
              live.LockState !== "locked" ||
              live.LockConfiguration?.UnlockDelay.UnlockDelayValue !==
                desiredLock.UnlockDelay.UnlockDelayValue ||
              live.LockConfiguration?.UnlockDelay.UnlockDelayUnit !==
                desiredLock.UnlockDelay.UnlockDelayUnit;
            if (lockDelta) {
              yield* rbin.lockRule({
                Identifier: identifier,
                LockConfiguration: desiredLock,
              });
              yield* session.note(`Locked retention rule ${identifier}`);
            }
          } else if (live.LockState === "locked") {
            yield* rbin.unlockRule({ Identifier: identifier });
            yield* session.note(
              `Unlock initiated for ${identifier}; rule stays protected (pending_unlock) until the unlock delay expires`,
            );
          }

          // SYNC tags — diff against OBSERVED cloud tags (never olds/output)
          // so adoption converges.
          const currentTags = yield* readRuleTags(ruleArn);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* rbin.tagResource({ ResourceArn: ruleArn, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* rbin.untagResource({
              ResourceArn: ruleArn,
              TagKeys: removed,
            });
          }

          // RETURN fresh attributes reflecting all sync steps.
          const final = yield* rbin.getRule({ Identifier: identifier });
          yield* session.note(identifier);
          return toAttributes(final);
        }),

        // Idempotent: a rule already gone is success. A locked rule fails
        // with the typed ConflictException (INVALID_RULE_STATE) — it must be
        // unlocked and its unlock delay must expire before deletion.
        delete: Effect.fn(function* ({ output }) {
          yield* rbin
            .deleteRule({ Identifier: output.identifier })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          // Deletion is near-immediate, but confirm the rule is gone so
          // dependents (and re-creates of the same logical id) never observe
          // a half-deleted rule.
          yield* retryWhileRuleExists(
            Effect.gen(function* () {
              const live = yield* readRule(output.identifier);
              if (live !== undefined) {
                return yield* new RuleStillExists({
                  identifier: output.identifier,
                });
              }
            }),
          );
        }),
      });
    }),
  );
