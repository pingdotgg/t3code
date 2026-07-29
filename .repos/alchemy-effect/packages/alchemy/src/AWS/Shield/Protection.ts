import * as shield from "@distilled.cloud/aws/shield";
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

/** Route 53 health check ARNs look like `arn:aws:route53:::healthcheck/{id}`. */
const healthCheckIdFromArn = (arn: string) => arn.split("/").pop() ?? arn;
const healthCheckArnFromId = (id: string) =>
  `arn:aws:route53:::healthcheck/${id}`;

/**
 * How Shield Advanced responds automatically to application-layer (layer 7)
 * DDoS attacks against the protected resource: `BLOCK` the attacking traffic
 * with the associated AWS WAF web ACL, or `COUNT` it for visibility only.
 */
export type ApplicationLayerAutomaticResponseAction = "BLOCK" | "COUNT";

export interface ProtectionProps {
  /**
   * Friendly name for the protection. Immutable — changing it replaces the
   * protection. If omitted, a unique name is generated.
   */
  name?: string;
  /**
   * ARN of the resource to protect (CloudFront distribution, Route 53 hosted
   * zone, Global Accelerator, ALB, CLB, or Elastic IP allocation). Immutable —
   * changing it replaces the protection.
   */
  resourceArn: string;
  /**
   * Route 53 health check ARNs to associate with the protection for
   * health-based DDoS detection. Mutable.
   */
  healthCheckArns?: string[];
  /**
   * Shield Advanced automatic application-layer DDoS mitigation: `BLOCK`
   * attacking traffic with the associated AWS WAF web ACL, or `COUNT` it for
   * visibility only. Omit to leave the feature disabled. Only supported for
   * CloudFront distributions and Application Load Balancers that have an
   * associated web ACL. Mutable.
   */
  applicationLayerAutomaticResponse?: ApplicationLayerAutomaticResponseAction;
  /**
   * User-defined tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Protection extends Resource<
  "AWS.Shield.Protection",
  ProtectionProps,
  {
    /** Unique identifier of the protection. */
    protectionId: string;
    /** ARN of the protection. */
    protectionArn: string;
    /** Name of the protection. */
    name: string;
    /** ARN of the protected resource. */
    resourceArn: string;
    /** IDs of the associated Route 53 health checks. */
    healthCheckIds: string[];
    /**
     * The automatic application-layer DDoS mitigation action, or `undefined`
     * when the feature is disabled.
     */
    applicationLayerAutomaticResponse:
      | ApplicationLayerAutomaticResponseAction
      | undefined;
    /** Tags on the protection (including Alchemy ownership tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Shield Advanced Protection for a single resource (CloudFront
 * distribution, Route 53 hosted zone, Global Accelerator, Application/Classic
 * Load Balancer, or Elastic IP).
 *
 * Requires an active Shield Advanced subscription ($3,000/month with a 1-year
 * commitment); without one every call fails with the typed
 * `SubscriptionNotFound` error.
 *
 * @section Protecting Resources
 * @example Protect a CloudFront Distribution
 * ```typescript
 * const protection = yield* Shield.Protection("SiteProtection", {
 *   resourceArn: distribution.distributionArn,
 * });
 * ```
 *
 * @example Protection with Health-Based Detection
 * ```typescript
 * const protection = yield* Shield.Protection("ApiProtection", {
 *   name: "api-protection",
 *   resourceArn: loadBalancer.loadBalancerArn,
 *   healthCheckArns: ["arn:aws:route53:::healthcheck/11111111-2222-3333-4444-555555555555"],
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @section Automatic Application-Layer Mitigation
 * @example Block Layer-7 Attacks Automatically
 * ```typescript
 * // Requires an AWS WAF web ACL associated with the CloudFront distribution
 * // or Application Load Balancer.
 * const protection = yield* Shield.Protection("SiteProtection", {
 *   resourceArn: distribution.distributionArn,
 *   applicationLayerAutomaticResponse: "BLOCK",
 * });
 * ```
 */
export const Protection = Resource<Protection>("AWS.Shield.Protection");

const observeByResourceArn = (resourceArn: string) =>
  shield.describeProtection({ ResourceArn: resourceArn }).pipe(
    Effect.map((r) => r.Protection),
    Effect.catchTag(["ResourceNotFoundException", "SubscriptionNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const toTagRecord = (tags: shield.Tag[] | undefined): Record<string, string> =>
  tagRecord(
    (tags ?? []).flatMap((t) =>
      t.Key !== undefined && t.Value !== undefined
        ? [{ Key: t.Key, Value: t.Value }]
        : [],
    ),
  );

const readProtectionTags = (protectionArn: string) =>
  shield.listTagsForResource({ ResourceARN: protectionArn }).pipe(
    Effect.map((r) => toTagRecord(r.Tags)),
    Effect.catch(() => Effect.succeed<Record<string, string>>({})),
  );

/**
 * Collapse the observed ALAR configuration to the prop shape: the action when
 * enabled, `undefined` when disabled or never configured.
 */
const observedAlarAction = (
  protection: shield.Protection,
): ApplicationLayerAutomaticResponseAction | undefined => {
  const config = protection.ApplicationLayerAutomaticResponseConfiguration;
  if (config?.Status !== "ENABLED") return undefined;
  return config.Action.Block !== undefined ? "BLOCK" : "COUNT";
};

const buildAttrs = (
  protection: shield.Protection,
  tags: Record<string, string>,
) => ({
  protectionId: protection.Id!,
  protectionArn: protection.ProtectionArn!,
  name: protection.Name!,
  resourceArn: protection.ResourceArn!,
  healthCheckIds: [...(protection.HealthCheckIds ?? [])],
  applicationLayerAutomaticResponse: observedAlarAction(protection),
  tags,
});

export const ProtectionProvider = () =>
  Provider.effect(
    Protection,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string }) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 128 });

      const syncTags = Effect.fn(function* (
        protectionArn: string,
        desiredTags: Record<string, string>,
      ) {
        const observedTags = yield* readProtectionTags(protectionArn);
        const { upsert, removed } = diffTags(observedTags, desiredTags);
        if (upsert.length > 0) {
          yield* shield.tagResource({
            ResourceARN: protectionArn,
            Tags: upsert,
          });
        }
        if (removed.length > 0) {
          yield* shield.untagResource({
            ResourceARN: protectionArn,
            TagKeys: removed,
          });
        }
      });

      // Automatic application-layer DDoS mitigation: enable, update, or
      // disable based on the delta between OBSERVED and desired state.
      const syncApplicationLayerAutomaticResponse = Effect.fn(function* (
        resourceArn: string,
        observed: ApplicationLayerAutomaticResponseAction | undefined,
        desired: ApplicationLayerAutomaticResponseAction | undefined,
      ) {
        if (observed === desired) return;
        if (desired === undefined) {
          yield* shield.disableApplicationLayerAutomaticResponse({
            ResourceArn: resourceArn,
          });
          return;
        }
        const Action = desired === "BLOCK" ? { Block: {} } : { Count: {} };
        if (observed === undefined) {
          yield* shield.enableApplicationLayerAutomaticResponse({
            ResourceArn: resourceArn,
            Action,
          });
        } else {
          yield* shield.updateApplicationLayerAutomaticResponse({
            ResourceArn: resourceArn,
            Action,
          });
        }
      });

      const syncHealthChecks = Effect.fn(function* (
        protectionId: string,
        observedIds: readonly string[],
        desiredArns: readonly string[],
      ) {
        const desiredIds = desiredArns.map(healthCheckIdFromArn);
        for (const arn of desiredArns) {
          if (!observedIds.includes(healthCheckIdFromArn(arn))) {
            yield* shield.associateHealthCheck({
              ProtectionId: protectionId,
              HealthCheckArn: arn,
            });
          }
        }
        for (const observedId of observedIds) {
          if (!desiredIds.includes(observedId)) {
            yield* shield.disassociateHealthCheck({
              ProtectionId: protectionId,
              HealthCheckArn: healthCheckArnFromId(observedId),
            });
          }
        }
      });

      return {
        stables: ["protectionId", "protectionArn", "name", "resourceArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          if (olds.resourceArn !== news.resourceArn) {
            return { action: "replace" } as const;
          }
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const resourceArn = output?.resourceArn ?? olds?.resourceArn;
          if (resourceArn === undefined) return undefined;
          const protection = yield* observeByResourceArn(resourceArn);
          if (!protection?.Id || !protection.ProtectionArn) return undefined;
          const tags = yield* readProtectionTags(protection.ProtectionArn);
          const attrs = buildAttrs(protection, tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; a protection is keyed
          //    by the resource it protects.
          let protection = yield* observeByResourceArn(news.resourceArn);

          // 2. ENSURE — create if missing; tolerate the AlreadyExists race.
          if (!protection?.Id) {
            yield* shield
              .createProtection({
                Name: name,
                ResourceArn: news.resourceArn,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            protection = yield* observeByResourceArn(news.resourceArn);
            if (!protection?.Id || !protection.ProtectionArn) {
              return yield* Effect.fail(
                new Error(
                  `Failed to create or read Shield protection for ${news.resourceArn}`,
                ),
              );
            }
          }

          // 3. SYNC health check associations — diff observed against desired.
          yield* syncHealthChecks(
            protection.Id,
            protection.HealthCheckIds ?? [],
            news.healthCheckArns ?? [],
          );

          // 3b. SYNC automatic application-layer DDoS mitigation.
          yield* syncApplicationLayerAutomaticResponse(
            news.resourceArn,
            observedAlarAction(protection),
            news.applicationLayerAutomaticResponse,
          );

          // 3c. SYNC tags — diff against OBSERVED cloud tags.
          yield* syncTags(protection.ProtectionArn!, desiredTags);

          // 4. RETURN fresh attributes.
          const final = yield* observeByResourceArn(news.resourceArn);
          yield* session.note(protection.ProtectionArn!);
          return buildAttrs(final ?? protection, desiredTags);
        }),

        // Enumerate every protection in the account. Without a Shield Advanced
        // subscription the account cannot have any protections.
        list: () =>
          Effect.gen(function* () {
            const protections = yield* shield.listProtections.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Protections ?? []),
              ),
              Effect.catchTag("SubscriptionNotFound", () => Effect.succeed([])),
            );
            return yield* Effect.forEach(
              protections.filter(
                (p) => p.Id != null && p.ProtectionArn != null,
              ),
              (protection) =>
                Effect.gen(function* () {
                  const tags = yield* readProtectionTags(
                    protection.ProtectionArn!,
                  );
                  return buildAttrs(protection, tags);
                }),
              { concurrency: 5 },
            );
          }),

        delete: Effect.fn(function* ({ output }) {
          yield* shield
            .deleteProtection({ ProtectionId: output.protectionId })
            .pipe(
              Effect.catchTag(
                ["ResourceNotFoundException", "SubscriptionNotFound"],
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
