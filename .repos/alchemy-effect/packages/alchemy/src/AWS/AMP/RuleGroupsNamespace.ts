import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  decodeDefinition,
  encodeDefinition,
  syncAmpTags,
  toTagRecord,
} from "./internal.ts";

export interface RuleGroupsNamespaceProps {
  /**
   * Id of the AMP workspace this rule groups namespace belongs to. Changing
   * the workspace replaces the namespace.
   */
  workspaceId: string;
  /**
   * Name of the rule groups namespace. Changing the name replaces the
   * namespace.
   */
  name: string;
  /**
   * The rules definition as a Prometheus-format YAML document (the same
   * shape as a `prometheus.yml` `groups:` file). Updated in place.
   */
  definition: string;
  /**
   * User-defined tags for the namespace.
   */
  tags?: Record<string, string>;
}

export interface RuleGroupsNamespace extends Resource<
  "AWS.AMP.RuleGroupsNamespace",
  RuleGroupsNamespaceProps,
  {
    workspaceId: string;
    name: string;
    ruleGroupsNamespaceArn: string;
    status: string;
  },
  never,
  Providers
> {}

/**
 * A rule groups namespace inside an Amazon Managed Service for Prometheus
 * workspace — a container of Prometheus recording and alerting rules,
 * supplied as a YAML definition.
 *
 * @resource
 * @section Creating a Rule Groups Namespace
 * @example Basic Recording Rule
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {});
 * const rules = yield* AMP.RuleGroupsNamespace("Rules", {
 *   workspaceId: workspace.workspaceId,
 *   name: "default",
 *   definition: `groups:
 *   - name: example
 *     rules:
 *       - record: metric:requests:rate5m
 *         expr: rate(http_requests_total[5m])`,
 * });
 * ```
 */
export const RuleGroupsNamespace = Resource<RuleGroupsNamespace>(
  "AWS.AMP.RuleGroupsNamespace",
);

export const RuleGroupsNamespaceProvider = () =>
  Provider.effect(
    RuleGroupsNamespace,
    Effect.gen(function* () {
      const toAttrs = (ns: amp.RuleGroupsNamespaceDescription) => ({
        workspaceId: "",
        name: ns.name,
        ruleGroupsNamespaceArn: ns.arn,
        status: ns.status.statusCode,
      });

      /** Describe the namespace; typed not-found → undefined. */
      const describe = Effect.fn(function* (workspaceId: string, name: string) {
        const response = yield* amp
          .describeRuleGroupsNamespace({ workspaceId, name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ruleGroupsNamespace;
      });

      /**
       * Poll until the namespace reaches ACTIVE. A namespace in CREATING /
       * UPDATING omits its `data` blob from the description, so callers that
       * need the definition must wait for ACTIVE first. Activation is
       * usually seconds but has been observed to remain CREATING beyond 90s
       * under account load. Poll less frequently for a bounded ~2 minute
       * window so deployments tolerate that documented asynchronous
       * lifecycle without creating an unbounded wait.
       */
      const waitActive = Effect.fn(function* (
        workspaceId: string,
        name: string,
      ) {
        const ns = yield* amp
          .describeRuleGroupsNamespace({ workspaceId, name })
          .pipe(
            Effect.map((r) => r.ruleGroupsNamespace),
            Effect.repeat({
              schedule: Schedule.max([
                Schedule.fixed("12 seconds"),
                Schedule.recurs(10),
              ]),
              until: (n) => n.status.statusCode === "ACTIVE",
            }),
          );
        if (ns.status.statusCode !== "ACTIVE") {
          return yield* Effect.fail(
            new Error(
              `AMP rule groups namespace ${name} did not become ACTIVE (status: ${ns.status.statusCode})`,
            ),
          );
        }
        return ns;
      });

      return {
        stables: ["workspaceId", "name", "ruleGroupsNamespaceArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds?.workspaceId !== news.workspaceId ||
            olds?.name !== news.name
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const workspaceId = output?.workspaceId ?? olds?.workspaceId;
          const name = output?.name ?? olds?.name;
          if (!workspaceId || !name) return undefined;
          const ns = yield* describe(workspaceId, name);
          if (ns === undefined) return undefined;
          const attrs = { ...toAttrs(ns), workspaceId };
          const tags = toTagRecord(ns.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const workspaceId = news!.workspaceId;
          const name = news!.name;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news!.tags };
          const desiredData = yield* encodeDefinition(news!.definition);

          // 1. Observe — the live namespace is authoritative.
          const ns = yield* describe(workspaceId, name);

          // 2. Ensure — create if missing.
          if (ns === undefined) {
            yield* amp.createRuleGroupsNamespace({
              workspaceId,
              name,
              data: desiredData,
              tags: desiredTags,
            });
          } else {
            // 3. Sync definition — put only when the YAML drifts. `data` is
            // present once the namespace is ACTIVE (omitted while CREATING).
            const currentDefinition =
              ns.data !== undefined
                ? yield* decodeDefinition(ns.data)
                : undefined;
            if (currentDefinition !== news!.definition) {
              yield* amp.putRuleGroupsNamespace({
                workspaceId,
                name,
                data: desiredData,
              });
            }
          }

          // Wait for ACTIVE so the ARN, status, and data blob are settled.
          const fresh = yield* waitActive(workspaceId, name);

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncAmpTags(fresh.arn, desiredTags);

          yield* session.note(`${workspaceId}/${name}`);
          return { ...toAttrs(fresh), workspaceId };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* amp
            .deleteRuleGroupsNamespace({
              workspaceId: output.workspaceId,
              name: output.name,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(20),
                ]),
              }),
            );
        }),

        // Sub-resource keyed by its parent workspace — not independently
        // enumerable across the account.
        list: () => Effect.succeed([]),
      };
    }),
  );
