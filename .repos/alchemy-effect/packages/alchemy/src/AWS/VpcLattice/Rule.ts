import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { retryOnConflict, waitUntilAbsent } from "./internal.ts";

/**
 * The match conditions of a listener rule (HTTP method, path, and header
 * matches).
 */
export type RuleMatch = vpclattice.RuleMatch;

/**
 * The action a rule applies to matched traffic: forward to weighted target
 * groups or answer with a fixed HTTP status.
 */
export type RuleAction = vpclattice.RuleAction;

export interface RuleProps {
  /**
   * ID or ARN of the lattice service the rule's listener belongs to.
   * Immutable — changing it replaces the rule.
   */
  serviceIdentifier: string;
  /**
   * ID or ARN of the listener the rule belongs to. Immutable — changing it
   * replaces the rule.
   */
  listenerIdentifier: string;
  /**
   * Name of the rule. If omitted, a unique name is generated. Immutable —
   * changing it replaces the rule.
   */
  name?: string;
  /**
   * Match conditions for the rule, e.g.
   * `{ httpMatch: { pathMatch: { match: { prefix: "/api" } } } }`.
   */
  match: RuleMatch;
  /**
   * Rule priority (1–100). Lower numbers are evaluated first; each rule on a
   * listener must have a unique priority.
   */
  priority: number;
  /**
   * Action applied to matched requests: forward to weighted target groups or
   * return a fixed response status.
   */
  action: RuleAction;
  /**
   * User-defined tags to apply to the rule.
   */
  tags?: Record<string, string>;
}

export interface Rule extends Resource<
  "AWS.VpcLattice.Rule",
  RuleProps,
  {
    /**
     * Service-assigned unique ID of the rule.
     */
    ruleId: string;
    /**
     * ARN of the rule.
     */
    ruleArn: string;
    /**
     * Physical name of the rule.
     */
    name: string;
    /**
     * Current rule priority.
     */
    priority: number;
    /**
     * ID or ARN of the owning lattice service (as configured).
     */
    serviceIdentifier: string;
    /**
     * ID or ARN of the owning listener (as configured).
     */
    listenerIdentifier: string;
    /**
     * Current tags reported for the rule.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon VPC Lattice listener rule — matches HTTP requests by method,
 * path, or headers and forwards them to target groups (or answers with a
 * fixed response), evaluated in priority order before the listener's default
 * action.
 *
 * @resource
 * @section Creating Rules
 * @example Path-Prefix Rule Forwarding to a Target Group
 * ```typescript
 * const rule = yield* Rule("ApiRule", {
 *   serviceIdentifier: service.serviceId,
 *   listenerIdentifier: listener.listenerId,
 *   priority: 10,
 *   match: { httpMatch: { pathMatch: { match: { prefix: "/api" } } } },
 *   action: {
 *     forward: {
 *       targetGroups: [
 *         { targetGroupIdentifier: targets.targetGroupId, weight: 100 },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * @example Method Match with a Fixed Response
 * ```typescript
 * const rule = yield* Rule("BlockDeletes", {
 *   serviceIdentifier: service.serviceId,
 *   listenerIdentifier: listener.listenerId,
 *   priority: 1,
 *   match: { httpMatch: { method: "DELETE" } },
 *   action: { fixedResponse: { statusCode: 403 } },
 * });
 * ```
 */
export const Rule = Resource<Rule>("AWS.VpcLattice.Rule");

export const RuleProvider = () =>
  Provider.effect(
    Rule,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 63, lowercase: true });

      const observe = (
        serviceIdentifier: string,
        listenerIdentifier: string,
        ruleIdentifier: string,
      ) =>
        vpclattice
          .getRule({ serviceIdentifier, listenerIdentifier, ruleIdentifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const findByName = (
        serviceIdentifier: string,
        listenerIdentifier: string,
        name: string,
      ) =>
        vpclattice.listRules
          .pages({ serviceIdentifier, listenerIdentifier })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.items ?? [])
                .find((r) => r.name === name),
            ),
            Effect.flatMap((summary) =>
              summary?.id
                ? observe(serviceIdentifier, listenerIdentifier, summary.id)
                : Effect.succeed(undefined),
            ),
          )
          .pipe(
            // The owning listener/service may already be gone during
            // teardown races.
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const listed = yield* vpclattice.listTagsForResource({
          resourceArn: arn,
        });
        const { removed, upsert } = diffTags(
          tagRecord(listed.tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* vpclattice.tagResource({
            resourceArn: arn,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* vpclattice.untagResource({
            resourceArn: arn,
            tagKeys: removed,
          });
        }
      });

      return {
        stables: [
          "ruleId",
          "ruleArn",
          "name",
          "serviceIdentifier",
          "listenerIdentifier",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds?.serviceIdentifier !== news.serviceIdentifier ||
            olds?.listenerIdentifier !== news.listenerIdentifier
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const serviceIdentifier =
            output?.serviceIdentifier ?? olds?.serviceIdentifier;
          const listenerIdentifier =
            output?.listenerIdentifier ?? olds?.listenerIdentifier;
          if (!serviceIdentifier || !listenerIdentifier) return undefined;
          const rule = output?.ruleId
            ? yield* observe(
                serviceIdentifier,
                listenerIdentifier,
                output.ruleId,
              )
            : yield* findByName(
                serviceIdentifier,
                listenerIdentifier,
                yield* toName(id, olds ?? {}),
              );
          if (!rule?.arn || !rule.id) return undefined;
          const listed = yield* vpclattice.listTagsForResource({
            resourceArn: rule.arn,
          });
          const attrs = {
            ruleId: rule.id,
            ruleArn: rule.arn,
            name: rule.name!,
            priority: rule.priority ?? 0,
            serviceIdentifier,
            listenerIdentifier,
            tags: tagRecord(listed.tags),
          };
          return (yield* hasAlchemyTags(id, listed.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the stable id cache, fall back to name lookup.
          let rule = output?.ruleId
            ? yield* observe(
                news.serviceIdentifier,
                news.listenerIdentifier,
                output.ruleId,
              )
            : yield* findByName(
                news.serviceIdentifier,
                news.listenerIdentifier,
                name,
              );

          // Ensure — create if missing.
          if (!rule?.arn || !rule.id) {
            rule = yield* retryOnConflict(
              vpclattice.createRule({
                serviceIdentifier: news.serviceIdentifier,
                listenerIdentifier: news.listenerIdentifier,
                name,
                match: news.match,
                priority: news.priority,
                action: news.action,
              }),
            ).pipe(
              Effect.catchTag("ConflictException", () =>
                findByName(
                  news.serviceIdentifier,
                  news.listenerIdentifier,
                  name,
                ),
              ),
            );
            if (!rule?.arn || !rule.id) {
              return yield* Effect.fail(
                new Error(`Failed to create rule ${name}`),
              );
            }
          } else if (
            JSON.stringify(rule.match) !== JSON.stringify(news.match) ||
            rule.priority !== news.priority ||
            JSON.stringify(rule.action) !== JSON.stringify(news.action)
          ) {
            // Sync match/priority/action — all mutable in place.
            yield* retryOnConflict(
              vpclattice.updateRule({
                serviceIdentifier: news.serviceIdentifier,
                listenerIdentifier: news.listenerIdentifier,
                ruleIdentifier: rule.id,
                match: news.match,
                priority: news.priority,
                action: news.action,
              }),
            );
          }

          yield* syncTags(rule.arn, desiredTags);

          yield* session.note(rule.arn);
          return {
            ruleId: rule.id,
            ruleArn: rule.arn,
            name,
            priority: news.priority,
            serviceIdentifier: news.serviceIdentifier,
            listenerIdentifier: news.listenerIdentifier,
            tags: desiredTags,
          };
        }),
        // Sub-resource: rules are keyed by their owning service/listener and
        // are removed with them, so nuke has nothing to enumerate.
        list: () => Effect.succeed([] as Rule["Attributes"][]),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOnConflict(
            vpclattice.deleteRule({
              serviceIdentifier: output.serviceIdentifier,
              listenerIdentifier: output.listenerIdentifier,
              ruleIdentifier: output.ruleId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          yield* waitUntilAbsent(
            observe(
              output.serviceIdentifier,
              output.listenerIdentifier,
              output.ruleId,
            ),
          );
        }),
      };
    }),
  );
