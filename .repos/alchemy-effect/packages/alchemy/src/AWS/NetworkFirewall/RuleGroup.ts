import type * as NFW from "@distilled.cloud/aws/network-firewall";
import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  nfwTagsToRecord,
  recordToNfwTags,
  retryWhileNfwInUse,
  retryWhileNfwNotFound,
} from "./internal.ts";

export interface RuleGroupProps {
  /**
   * Name of the rule group. Must be 1-128 alphanumeric characters or
   * hyphens. If omitted, a deterministic physical name is generated.
   * Changing the name replaces the rule group.
   */
  ruleGroupName?: string;
  /**
   * Whether the rule group inspects packets on their own (`STATELESS`) or
   * in the context of their traffic flow (`STATEFUL`). Changing the type
   * replaces the rule group.
   */
  type: "STATELESS" | "STATEFUL";
  /**
   * Maximum operating capacity the rule group can consume when applied.
   * Capacity cannot be changed after creation — changing it replaces the
   * rule group.
   */
  capacity: number;
  /**
   * The rule group definition (rule variables, reference sets, and the
   * rules source). Provide either `ruleGroup` or `rules`, not both.
   * Uses raw Network Firewall API structures.
   */
  ruleGroup?: NFW.RuleGroup;
  /**
   * A string containing stateful rules in Suricata format. Provide either
   * `rules` or `ruleGroup`, not both. Only valid for `STATEFUL` groups.
   */
  rules?: string;
  /**
   * Which rule attributes (`SID`, `MSG`, `METADATA`) DescribeRuleGroupSummary
   * includes in per-rule summaries. Only valid for `STATEFUL` groups; when
   * omitted, summaries are not generated.
   */
  summaryConfiguration?: NFW.SummaryConfiguration;
  /**
   * Human-readable description of the rule group.
   */
  description?: string;
  /**
   * Tags to apply to the rule group. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface RuleGroup extends Resource<
  "AWS.NetworkFirewall.RuleGroup",
  RuleGroupProps,
  {
    /** Name of the rule group. */
    ruleGroupName: string;
    /** ARN of the rule group. */
    ruleGroupArn: string;
    /** Server-assigned unique id of the rule group. */
    ruleGroupId: string;
    /** Rule group type (`STATELESS` or `STATEFUL`). */
    type: string;
    /** Reserved rule capacity of the group. */
    capacity: number;
  },
  never,
  Providers
> {}

/**
 * An AWS Network Firewall rule group — a reusable collection of stateless
 * or stateful network traffic inspection rules referenced by
 * {@link FirewallPolicy | firewall policies}.
 * @resource
 * @section Creating Rule Groups
 * @example Stateless Rule Group
 * ```typescript
 * import * as NetworkFirewall from "alchemy/AWS/NetworkFirewall";
 *
 * const stateless = yield* NetworkFirewall.RuleGroup("AllowHttp", {
 *   type: "STATELESS",
 *   capacity: 10,
 *   ruleGroup: {
 *     RulesSource: {
 *       StatelessRulesAndCustomActions: {
 *         StatelessRules: [
 *           {
 *             Priority: 1,
 *             RuleDefinition: {
 *               Actions: ["aws:pass"],
 *               MatchAttributes: {
 *                 Protocols: [6],
 *                 DestinationPorts: [{ FromPort: 80, ToPort: 80 }],
 *               },
 *             },
 *           },
 *         ],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @example Stateful Rule Group (Suricata rules)
 * ```typescript
 * const stateful = yield* NetworkFirewall.RuleGroup("BlockDomains", {
 *   type: "STATEFUL",
 *   capacity: 100,
 *   rules: 'drop tcp any any -> any any (msg:"drop all tcp"; sid:1; rev:1;)',
 * });
 * ```
 *
 * @example Stateful Domain List
 * ```typescript
 * const domains = yield* NetworkFirewall.RuleGroup("DenyList", {
 *   type: "STATEFUL",
 *   capacity: 100,
 *   ruleGroup: {
 *     RulesSource: {
 *       RulesSourceList: {
 *         Targets: [".example.com"],
 *         TargetTypes: ["TLS_SNI", "HTTP_HOST"],
 *         GeneratedRulesType: "DENYLIST",
 *       },
 *     },
 *   },
 * });
 * ```
 */
export const RuleGroup = Resource<RuleGroup>("AWS.NetworkFirewall.RuleGroup");

export const RuleGroupProvider = () =>
  Provider.effect(
    RuleGroup,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { ruleGroupName?: string },
      ) {
        return (
          props.ruleGroupName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const toAttrs = (
        response: NFW.RuleGroupResponse,
      ): RuleGroup["Attributes"] => ({
        ruleGroupName: response.RuleGroupName,
        ruleGroupArn: response.RuleGroupArn,
        ruleGroupId: response.RuleGroupId,
        type: response.Type ?? "STATEFUL",
        capacity: response.Capacity ?? 0,
      });

      return RuleGroup.Provider.of({
        stables: ["ruleGroupName", "ruleGroupArn", "ruleGroupId", "type"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* nfw.listRuleGroups
              .pages({ Scope: "ACCOUNT" })
              .pipe(Stream.runCollect);
            const metas = Array.from(pages).flatMap(
              (page) => page.RuleGroups ?? [],
            );
            const items = yield* Effect.forEach(
              metas,
              (meta) =>
                nfw.describeRuleGroup({ RuleGroupArn: meta.Arn }).pipe(
                  Effect.map((r) => toAttrs(r.RuleGroupResponse)),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
              { concurrency: 5 },
            );
            return items.filter(
              (item): item is RuleGroup["Attributes"] => item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const found =
            output?.ruleGroupArn !== undefined
              ? yield* nfw
                  .describeRuleGroup({ RuleGroupArn: output.ruleGroupArn })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  )
              : yield* nfw
                  .describeRuleGroup({
                    RuleGroupName: yield* createName(id, olds ?? {}),
                    Type: olds?.type,
                  })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  );
          if (found === undefined) return undefined;
          const attrs = toAttrs(found.RuleGroupResponse);
          const tags = nfwTagsToRecord(found.RuleGroupResponse.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            olds.type !== news.type ||
            olds.capacity !== news.capacity
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.ruleGroupName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...news.tags,
            ...internalTags,
          };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* nfw
            .describeRuleGroup({ RuleGroupName: name, Type: news.type })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // 2. Ensure — create if missing.
          if (observed === undefined) {
            yield* nfw.createRuleGroup({
              RuleGroupName: name,
              Type: news.type,
              Capacity: news.capacity,
              RuleGroup: news.ruleGroup,
              Rules: news.rules,
              Description: news.description,
              SummaryConfiguration: news.summaryConfiguration,
              Tags: recordToNfwTags(desiredTags),
            });
            observed = yield* nfw
              .describeRuleGroup({ RuleGroupName: name, Type: news.type })
              .pipe(retryWhileNfwNotFound);
          }

          // 3. Sync definition — compare desired against OBSERVED state and
          // apply only when it differs.
          const observedDescription = observed.RuleGroupResponse.Description;
          const definitionDiffers =
            (news.rules !== undefined &&
              news.rules !== observed.RuleGroup?.RulesSource?.RulesString) ||
            (news.ruleGroup !== undefined &&
              !deepEqual(news.ruleGroup, observed.RuleGroup)) ||
            (news.summaryConfiguration !== undefined &&
              !deepEqual(
                news.summaryConfiguration,
                observed.RuleGroupResponse.SummaryConfiguration,
              )) ||
            (news.description ?? undefined) !== observedDescription;
          if (definitionDiffers) {
            yield* nfw.updateRuleGroup({
              UpdateToken: observed.UpdateToken,
              RuleGroupArn: observed.RuleGroupResponse.RuleGroupArn,
              RuleGroup: news.ruleGroup,
              Rules: news.rules,
              Type: news.type,
              Description: news.description,
              SummaryConfiguration: news.summaryConfiguration,
            });
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = nfwTagsToRecord(observed.RuleGroupResponse.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          const arn = observed.RuleGroupResponse.RuleGroupArn;
          if (upsert.length > 0) {
            yield* nfw.tagResource({ ResourceArn: arn, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* nfw.untagResource({ ResourceArn: arn, TagKeys: removed });
          }

          yield* session.note(name);
          return toAttrs(observed.RuleGroupResponse);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A rule group still referenced by a firewall policy (deleted
          // moments ago by the engine) rejects deletion with
          // InvalidOperationException — retry through the release window.
          yield* nfw
            .deleteRuleGroup({ RuleGroupArn: output.ruleGroupArn })
            .pipe(
              retryWhileNfwInUse,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
