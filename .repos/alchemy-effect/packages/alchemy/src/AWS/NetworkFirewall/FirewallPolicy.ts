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

export interface FirewallPolicyProps {
  /**
   * Name of the firewall policy. Must be 1-128 alphanumeric characters or
   * hyphens. If omitted, a deterministic physical name is generated.
   * Changing the name replaces the policy.
   */
  firewallPolicyName?: string;
  /**
   * The policy definition: stateless/stateful rule group references,
   * default actions, and engine options. Uses raw Network Firewall API
   * structures. `StatelessDefaultActions` and
   * `StatelessFragmentDefaultActions` are required.
   */
  firewallPolicy: NFW.FirewallPolicy;
  /**
   * Human-readable description of the firewall policy.
   */
  description?: string;
  /**
   * Tags to apply to the policy. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface FirewallPolicy extends Resource<
  "AWS.NetworkFirewall.FirewallPolicy",
  FirewallPolicyProps,
  {
    /** Name of the firewall policy. */
    firewallPolicyName: string;
    /** ARN of the firewall policy. */
    firewallPolicyArn: string;
    /** Server-assigned unique id of the firewall policy. */
    firewallPolicyId: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Network Firewall policy — defines a firewall's traffic inspection
 * behavior as a collection of stateless and stateful
 * {@link RuleGroup | rule group} references plus default actions. One policy
 * can be shared by multiple {@link Firewall | firewalls}.
 * @resource
 * @section Creating Policies
 * @example Pass-everything Policy
 * ```typescript
 * import * as NetworkFirewall from "alchemy/AWS/NetworkFirewall";
 *
 * const policy = yield* NetworkFirewall.FirewallPolicy("Policy", {
 *   firewallPolicy: {
 *     StatelessDefaultActions: ["aws:pass"],
 *     StatelessFragmentDefaultActions: ["aws:pass"],
 *   },
 * });
 * ```
 *
 * @example Policy referencing Rule Groups
 * ```typescript
 * const stateless = yield* NetworkFirewall.RuleGroup("Stateless", {
 *   type: "STATELESS",
 *   capacity: 10,
 *   ruleGroup: { ... },
 * });
 *
 * const policy = yield* NetworkFirewall.FirewallPolicy("Policy", {
 *   firewallPolicy: {
 *     StatelessDefaultActions: ["aws:forward_to_sfe"],
 *     StatelessFragmentDefaultActions: ["aws:forward_to_sfe"],
 *     StatelessRuleGroupReferences: [
 *       { ResourceArn: stateless.ruleGroupArn, Priority: 1 },
 *     ],
 *   },
 * });
 * ```
 */
export const FirewallPolicy = Resource<FirewallPolicy>(
  "AWS.NetworkFirewall.FirewallPolicy",
);

export const FirewallPolicyProvider = () =>
  Provider.effect(
    FirewallPolicy,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { firewallPolicyName?: string },
      ) {
        return (
          props.firewallPolicyName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const toAttrs = (
        response: NFW.FirewallPolicyResponse,
      ): FirewallPolicy["Attributes"] => ({
        firewallPolicyName: response.FirewallPolicyName,
        firewallPolicyArn: response.FirewallPolicyArn,
        firewallPolicyId: response.FirewallPolicyId,
      });

      return FirewallPolicy.Provider.of({
        stables: [
          "firewallPolicyName",
          "firewallPolicyArn",
          "firewallPolicyId",
        ],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* nfw.listFirewallPolicies
              .pages({})
              .pipe(Stream.runCollect);
            const metas = Array.from(pages).flatMap(
              (page) => page.FirewallPolicies ?? [],
            );
            const items = yield* Effect.forEach(
              metas,
              (meta) =>
                nfw
                  .describeFirewallPolicy({ FirewallPolicyArn: meta.Arn })
                  .pipe(
                    Effect.map((r) => toAttrs(r.FirewallPolicyResponse)),
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              { concurrency: 5 },
            );
            return items.filter(
              (item): item is FirewallPolicy["Attributes"] =>
                item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.firewallPolicyName ?? (yield* createName(id, olds ?? {}));
          const found = yield* nfw
            .describeFirewallPolicy({ FirewallPolicyName: name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (found === undefined) return undefined;
          const attrs = toAttrs(found.FirewallPolicyResponse);
          const tags = nfwTagsToRecord(found.FirewallPolicyResponse.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.firewallPolicyName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...news.tags,
            ...internalTags,
          };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* nfw
            .describeFirewallPolicy({ FirewallPolicyName: name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // 2. Ensure — create if missing.
          if (observed === undefined) {
            yield* nfw.createFirewallPolicy({
              FirewallPolicyName: name,
              FirewallPolicy: news.firewallPolicy,
              Description: news.description,
              Tags: recordToNfwTags(desiredTags),
            });
            observed = yield* nfw
              .describeFirewallPolicy({ FirewallPolicyName: name })
              .pipe(retryWhileNfwNotFound);
          }

          // 3. Sync definition — compare desired against OBSERVED state.
          const observedDescription =
            observed.FirewallPolicyResponse.Description;
          const definitionDiffers =
            !deepEqual(news.firewallPolicy, observed.FirewallPolicy) ||
            (news.description ?? undefined) !== observedDescription;
          if (definitionDiffers) {
            yield* nfw.updateFirewallPolicy({
              UpdateToken: observed.UpdateToken,
              FirewallPolicyArn:
                observed.FirewallPolicyResponse.FirewallPolicyArn,
              FirewallPolicy: news.firewallPolicy,
              Description: news.description,
            });
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = nfwTagsToRecord(
            observed.FirewallPolicyResponse.Tags,
          );
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          const arn = observed.FirewallPolicyResponse.FirewallPolicyArn;
          if (upsert.length > 0) {
            yield* nfw.tagResource({ ResourceArn: arn, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* nfw.untagResource({ ResourceArn: arn, TagKeys: removed });
          }

          yield* session.note(name);
          return toAttrs(observed.FirewallPolicyResponse);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A policy still associated to a firewall (deleted moments ago by
          // the engine) rejects deletion with InvalidOperationException —
          // retry through the release window.
          yield* nfw
            .deleteFirewallPolicy({
              FirewallPolicyArn: output.firewallPolicyArn,
            })
            .pipe(
              retryWhileNfwInUse,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
