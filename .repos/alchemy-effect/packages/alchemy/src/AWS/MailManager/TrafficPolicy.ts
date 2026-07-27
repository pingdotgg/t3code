import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readMailManagerTags,
  retryWhileMailManagerConflict,
  sameShape,
  syncMailManagerTags,
} from "./internal.ts";

export interface TrafficPolicyProps {
  /**
   * Name of the traffic policy. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Renames apply in place.
   */
  trafficPolicyName?: string;
  /**
   * Conditional statements evaluated against incoming SMTP connections and
   * message metadata (sender IP, recipient, TLS protocol, analyzer verdicts,
   * address-list membership). Each statement ALLOWs or DENYs matching
   * traffic. Updates apply in place.
   * @default []
   */
  policyStatements?: mm.PolicyStatement[];
  /**
   * Action applied to traffic that matches no policy statement.
   */
  defaultAction: mm.AcceptAction;
  /**
   * Maximum message size in bytes; larger messages are rejected.
   */
  maxMessageSizeBytes?: number;
  /**
   * Tags applied to the traffic policy. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface TrafficPolicy extends Resource<
  "AWS.MailManager.TrafficPolicy",
  TrafficPolicyProps,
  {
    /** Server-assigned ID of the traffic policy. */
    trafficPolicyId: string;
    /** ARN of the traffic policy. */
    trafficPolicyArn: string;
    /** Name of the traffic policy. */
    trafficPolicyName: string;
  },
  never,
  Providers
> {}

/**
 * An SES Mail Manager traffic policy — connection-level ALLOW/DENY rules an
 * ingress point applies before email reaches the rule set (sender CIDRs,
 * recipient patterns, TLS floor, message size cap).
 *
 * All aspects (name, statements, default action, size cap, tags) update in
 * place.
 * @resource
 * @section Creating Traffic Policies
 * @example Deny-by-Default with an Allowed CIDR
 * ```typescript
 * import * as MailManager from "alchemy/AWS/MailManager";
 *
 * const policy = yield* MailManager.TrafficPolicy("Edge", {
 *   defaultAction: "DENY",
 *   policyStatements: [
 *     {
 *       Action: "ALLOW",
 *       Conditions: [
 *         {
 *           IpExpression: {
 *             Evaluate: { Attribute: "SENDER_IP" },
 *             Operator: "CIDR_MATCHES",
 *             Values: ["10.0.0.0/8"],
 *           },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @example Allow All with a Size Cap
 * ```typescript
 * const policy = yield* MailManager.TrafficPolicy("Edge", {
 *   defaultAction: "ALLOW",
 *   maxMessageSizeBytes: 10 * 1024 * 1024,
 * });
 * ```
 */
export const TrafficPolicy = Resource<TrafficPolicy>(
  "AWS.MailManager.TrafficPolicy",
);

export const TrafficPolicyProvider = () =>
  Provider.effect(
    TrafficPolicy,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { trafficPolicyName?: string },
      ) {
        return (
          props.trafficPolicyName ??
          (yield* createPhysicalName({ id, maxLength: 63 }))
        );
      });

      const getById = (trafficPolicyId: string) =>
        mm
          .getTrafficPolicy({ TrafficPolicyId: trafficPolicyId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const findByName = (name: string) =>
        mm.listTrafficPolicies.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.TrafficPolicies ?? [])
              .find((p) => p.TrafficPolicyName === name),
          ),
        );

      const observe = Effect.fn(function* (
        output: TrafficPolicy["Attributes"] | undefined,
        name: string,
      ) {
        if (output?.trafficPolicyId !== undefined) {
          const found = yield* getById(output.trafficPolicyId);
          if (found !== undefined) return found;
        }
        const summary = yield* findByName(name);
        if (summary?.TrafficPolicyId === undefined) return undefined;
        return yield* getById(summary.TrafficPolicyId);
      });

      const toAttrs = Effect.fn(function* (
        policy: mm.GetTrafficPolicyResponse,
      ) {
        if (policy.TrafficPolicyArn === undefined) {
          return yield* Effect.fail(
            new Error(
              `Mail Manager traffic policy '${policy.TrafficPolicyId}' returned without an ARN`,
            ),
          );
        }
        return {
          trafficPolicyId: policy.TrafficPolicyId,
          trafficPolicyArn: policy.TrafficPolicyArn,
          trafficPolicyName: policy.TrafficPolicyName,
        };
      });

      return TrafficPolicy.Provider.of({
        stables: ["trafficPolicyId", "trafficPolicyArn"],

        list: () =>
          mm.listTrafficPolicies.pages({}).pipe(
            Stream.runCollect,
            Effect.flatMap((chunk) =>
              Effect.forEach(
                Array.from(chunk)
                  .flatMap((page) => page.TrafficPolicies ?? [])
                  .flatMap((p) =>
                    p.TrafficPolicyId !== undefined ? [p.TrafficPolicyId] : [],
                  ),
                (trafficPolicyId) => getById(trafficPolicyId),
              ),
            ),
            Effect.flatMap((results) =>
              Effect.forEach(
                results.flatMap((p) => (p === undefined ? [] : [p])),
                (p) => toAttrs(p),
              ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.trafficPolicyName ?? (yield* createName(id, olds ?? {}));
          const policy = yield* observe(output, name);
          if (policy === undefined) return undefined;
          const attrs = yield* toAttrs(policy);
          const tags = yield* readMailManagerTags(attrs.trafficPolicyArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // Every prop updates in place — no replacement triggers, so the
        // engine's default update path applies (no diff needed).

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredStatements = news.policyStatements ?? [];

          // 1. OBSERVE.
          let policy = yield* observe(output, name);

          // 2. ENSURE — create if missing; a Conflict race re-observes.
          if (policy === undefined) {
            yield* session.note(`creating traffic policy ${name}`);
            const created = yield* mm
              .createTrafficPolicy({
                TrafficPolicyName: name,
                PolicyStatements: desiredStatements,
                DefaultAction: news.defaultAction,
                MaxMessageSizeBytes: news.maxMessageSizeBytes,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            policy =
              created !== undefined
                ? yield* getById(created.TrafficPolicyId)
                : yield* observe(undefined, name);
          }
          if (policy === undefined) {
            return yield* Effect.fail(
              new Error(
                `Mail Manager traffic policy '${name}' not found after create`,
              ),
            );
          }

          // 3. SYNC — diff OBSERVED state against desired; apply only the
          //    delta.
          if (
            policy.TrafficPolicyName !== name ||
            policy.DefaultAction !== news.defaultAction ||
            policy.MaxMessageSizeBytes !== news.maxMessageSizeBytes ||
            !sameShape(policy.PolicyStatements ?? [], desiredStatements)
          ) {
            yield* mm.updateTrafficPolicy({
              TrafficPolicyId: policy.TrafficPolicyId,
              TrafficPolicyName: name,
              PolicyStatements: desiredStatements,
              DefaultAction: news.defaultAction,
              MaxMessageSizeBytes: news.maxMessageSizeBytes,
            });
          }

          // 3b. SYNC TAGS.
          const attrs = yield* toAttrs(policy);
          yield* syncMailManagerTags(attrs.trafficPolicyArn, desiredTags);

          yield* session.note(attrs.trafficPolicyId);
          return { ...attrs, trafficPolicyName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          // A traffic policy stays "in use" while a deleted ingress point
          // finishes deprovisioning — retry through the Conflict window.
          yield* retryWhileMailManagerConflict(
            mm.deleteTrafficPolicy({
              TrafficPolicyId: output.trafficPolicyId,
            }),
          ).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
