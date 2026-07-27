import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import {
  type ListenerAction,
  type ListenerRuleCondition,
  serializeActions,
  serializeConditions,
} from "./common.ts";
import type { Listener, ListenerArn } from "./Listener.ts";

export type RuleArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:listener-rule/${string}`;

/**
 * The requested rule priority is already taken by another rule on the same
 * listener. Surfaced instead of the raw `PriorityInUseException` so the
 * failure names the conflicting priority and the fix: rules composed with an
 * auto-derived priority (e.g. `AWS.ECS.Service` shared load balancer rules)
 * should set an explicit `priority` to resolve the collision. The engine
 * never probes for a free slot — priorities stay deterministic.
 */
export class ListenerRulePriorityInUse extends Data.TaggedError(
  "ListenerRulePriorityInUse",
)<{
  readonly listenerArn: string;
  readonly priority: number;
  readonly message: string;
}> {}

const priorityInUse = (listenerArn: string, priority: number) =>
  new ListenerRulePriorityInUse({
    listenerArn,
    priority,
    message: `Listener rule priority ${priority} is already in use on ${listenerArn}. Set an explicit \`priority\` on the rule to resolve the conflict.`,
  });

export interface ListenerRuleProps {
  /** The listener this rule attaches to. Changing it replaces the rule. */
  listenerArn: Input<ListenerArn> | Listener;
  /**
   * The rule priority (1-50000). Lower numbers are evaluated first. Updated in
   * place via `setRulePriorities`.
   */
  priority: number;
  /** The conditions under which the rule matches a request (AND-ed). */
  conditions: ListenerRuleCondition[];
  /** The actions to take when the rule matches. */
  actions: ListenerAction[];
  /** Tags to apply to the rule. */
  tags?: Record<string, string>;
}

export interface ListenerRule extends Resource<
  "AWS.ELBv2.ListenerRule",
  ListenerRuleProps,
  {
    /** The ARN of the rule. */
    ruleArn: RuleArn;
    /** The ARN of the listener the rule is attached to. */
    listenerArn: ListenerArn;
    /** The rule's evaluation priority (lower numbers evaluate first). */
    priority: number;
    /** Whether this is the listener's default rule. */
    isDefault: boolean;
  },
  never,
  Providers
> {}

/**
 * An ELBv2 listener rule. Rules attach to an Application Load Balancer listener
 * and route requests to target groups (or other actions) based on conditions
 * such as host header, path pattern, HTTP header, query string, request method,
 * and source IP.
 * @resource
 * @section Creating a Rule
 * @example Path-based routing
 * ```typescript
 * const rule = yield* ListenerRule("api", {
 *   listenerArn: listener.listenerArn,
 *   priority: 10,
 *   conditions: [{ pathPattern: { values: ["/api/*"] } }],
 *   actions: [
 *     { type: "forward", targetGroups: [{ targetGroupArn: apiTg.targetGroupArn }] },
 *   ],
 * });
 * ```
 *
 * @example Host-header routing
 * ```typescript
 * const rule = yield* ListenerRule("admin", {
 *   listenerArn: listener.listenerArn,
 *   priority: 20,
 *   conditions: [{ hostHeader: { values: ["admin.example.com"] } }],
 *   actions: [
 *     { type: "forward", targetGroups: [{ targetGroupArn: adminTg.targetGroupArn }] },
 *   ],
 * });
 * ```
 *
 * @section Conditions
 * @example Combining query-string and HTTP-header conditions
 * ```typescript
 * const rule = yield* ListenerRule("beta", {
 *   listenerArn: listener.listenerArn,
 *   priority: 30,
 *   conditions: [
 *     { queryString: { values: [{ key: "version", value: "beta" }] } },
 *     { httpHeader: { name: "X-Channel", values: ["internal"] } },
 *   ],
 *   actions: [{ type: "fixedResponse", statusCode: "200", messageBody: "beta" }],
 * });
 * ```
 */
export const ListenerRule = Resource<ListenerRule>("AWS.ELBv2.ListenerRule");

export const ListenerRuleProvider = () =>
  Provider.succeed(ListenerRule, {
    stables: ["ruleArn", "listenerArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      // priority is mutable in place via setRulePriorities; only the listener
      // forces replacement.
      if (olds.listenerArn !== news.listenerArn) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const described = yield* elbv2
        .describeRules({ RuleArns: [output.ruleArn] })
        .pipe(
          Effect.catchTag("RuleNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      const rule = described?.Rules?.[0];
      if (!rule?.RuleArn) {
        return undefined;
      }
      return {
        ruleArn: rule.RuleArn as RuleArn,
        listenerArn: output.listenerArn,
        priority: Number(rule.Priority ?? output.priority),
        isDefault: rule.IsDefault ?? false,
      };
    }),
    // Rules belong to a listener, which belongs to a load balancer. Enumerate
    // every load balancer, then every listener, then every rule.
    list: Effect.fn(function* () {
      const loadBalancerArns = yield* elbv2.describeLoadBalancers
        .pages({})
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.LoadBalancers ?? []).flatMap((lb) =>
                lb.LoadBalancerArn ? [lb.LoadBalancerArn] : [],
              ),
            ),
          ),
        );
      const listenerArns = yield* Effect.forEach(
        loadBalancerArns,
        (loadBalancerArn) =>
          elbv2.describeListeners
            .pages({ LoadBalancerArn: loadBalancerArn })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Listeners ?? []).flatMap((l) =>
                    l.ListenerArn ? [l.ListenerArn as ListenerArn] : [],
                  ),
                ),
              ),
              Effect.catchTag("LoadBalancerNotFoundException", () =>
                Effect.succeed([]),
              ),
              Effect.catchTag("ListenerNotFoundException", () =>
                Effect.succeed([]),
              ),
            ),
        { concurrency: 10 },
      );
      const rows = yield* Effect.forEach(
        listenerArns.flat(),
        (listenerArn) =>
          elbv2.describeRules.items({ ListenerArn: listenerArn }).pipe(
            Stream.filter(
              (r): r is typeof r & { RuleArn: string } =>
                r.RuleArn != null && !r.IsDefault,
            ),
            Stream.map((rule) => ({
              ruleArn: rule.RuleArn as RuleArn,
              listenerArn,
              priority: Number(rule.Priority ?? 0),
              isDefault: rule.IsDefault ?? false,
            })),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("ListenerNotFoundException", () =>
              Effect.succeed([]),
            ),
            Effect.catchTag("RuleNotFoundException", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      const result: ListenerRule["Attributes"][] = rows.flat();
      return result;
    }),
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const listenerArn = news.listenerArn as ListenerArn;
      const desiredTags = {
        ...(yield* createInternalTags(id)),
        ...news.tags,
      };
      const conditions = serializeConditions(news.conditions);
      const actions = serializeActions(news.actions);

      // Observe — look up the rule by our prior ARN.
      let rule: elbv2.Rule | undefined;
      if (output?.ruleArn) {
        const described = yield* elbv2
          .describeRules({ RuleArns: [output.ruleArn] })
          .pipe(
            Effect.catchTag("RuleNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        rule = described?.Rules?.[0];
      }

      // Ensure — create if missing.
      if (!rule?.RuleArn) {
        const created = yield* elbv2
          .createRule({
            ListenerArn: listenerArn,
            Priority: news.priority,
            Conditions: conditions,
            Actions: actions,
            Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          })
          .pipe(
            Effect.catchTag("PriorityInUseException", () =>
              Effect.fail(priorityInUse(listenerArn, news.priority)),
            ),
          );
        rule = created.Rules?.[0];
        if (!rule?.RuleArn) {
          return yield* Effect.die(new Error("createRule returned no rule"));
        }
      } else {
        // Sync conditions + actions — modifyRule fully replaces these lists.
        const modified = yield* elbv2.modifyRule({
          RuleArn: rule.RuleArn,
          Conditions: conditions,
          Actions: actions,
        });
        rule = modified.Rules?.[0] ?? rule;

        // Sync priority — not mutable via modifyRule.
        if (Number(rule.Priority) !== news.priority) {
          yield* elbv2
            .setRulePriorities({
              RulePriorities: [
                { RuleArn: rule.RuleArn, Priority: news.priority },
              ],
            })
            .pipe(
              Effect.catchTag("PriorityInUseException", () =>
                Effect.fail(priorityInUse(listenerArn, news.priority)),
              ),
            );
        }
      }

      const ruleArn = rule.RuleArn!;

      // Sync tags — diff observed cloud tags against desired.
      const tagDescriptions = yield* elbv2.describeTags({
        ResourceArns: [ruleArn],
      });
      const observedTags = Object.fromEntries(
        (tagDescriptions.TagDescriptions?.[0]?.Tags ?? [])
          .filter(
            (t): t is { Key: string; Value: string } =>
              typeof t.Key === "string" && typeof t.Value === "string",
          )
          .map((t) => [t.Key, t.Value]),
      );
      const { removed, upsert } = diffTags(observedTags, desiredTags);
      if (upsert.length > 0) {
        yield* elbv2.addTags({ ResourceArns: [ruleArn], Tags: upsert });
      }
      if (removed.length > 0) {
        yield* elbv2.removeTags({ ResourceArns: [ruleArn], TagKeys: removed });
      }

      yield* session.note(ruleArn);
      return {
        ruleArn: ruleArn as RuleArn,
        listenerArn,
        priority: news.priority,
        isDefault: rule.IsDefault ?? false,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* elbv2
        .deleteRule({ RuleArn: output.ruleArn })
        .pipe(Effect.catchTag("RuleNotFoundException", () => Effect.void));
    }),
  });
