import * as route53 from "@distilled.cloud/aws/route-53";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, diffTags } from "alchemy/Tags";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { durationToSeconds } from "../IAM/common.ts";
import { plainJson } from "../internal/Observe.ts";
import type { Providers } from "../Providers.ts";

export interface HealthCheckProps {
  /**
   * Health check protocol/type (e.g. `"HTTP"`, `"HTTPS"`, `"TCP"`,
   * `"CALCULATED"`, `"CLOUDWATCH_METRIC"`). Immutable — changing it forces
   * replacement.
   */
  type: route53.HealthCheckType;
  /**
   * IP address of the endpoint to check.
   */
  ipAddress?: string;
  /**
   * Port of the endpoint to check.
   */
  port?: number;
  /**
   * Path requested for HTTP/HTTPS checks (e.g. `"/health"`).
   */
  resourcePath?: string;
  /**
   * Fully qualified domain name of the endpoint.
   */
  fullyQualifiedDomainName?: string;
  /**
   * String the response body must contain for the check to pass.
   */
  searchString?: string;
  /**
   * Time between checks, e.g. `"30 seconds"` or `Duration.seconds(10)` (a
   * bare number is milliseconds). Rounded to whole seconds on the wire
   * (10 or 30). Immutable — changing it forces replacement.
   * @default 30 seconds
   */
  requestInterval?: Duration.Input;
  /**
   * Number of consecutive failures before the endpoint is considered unhealthy.
   * @default 3
   */
  failureThreshold?: number;
  /**
   * Whether Route 53 measures latency. Immutable — changing it forces
   * replacement.
   */
  measureLatency?: boolean;
  /**
   * Invert the health check result.
   */
  inverted?: boolean;
  /**
   * Disable the health check (treated as healthy).
   */
  disabled?: boolean;
  /**
   * For CALCULATED checks, the number of child checks that must be healthy.
   */
  healthThreshold?: number;
  /**
   * For CALCULATED checks, the child health check IDs.
   */
  childHealthChecks?: string[];
  /**
   * Send SNI to the endpoint for HTTPS checks.
   */
  enableSNI?: boolean;
  /**
   * Regions from which Route 53 checks the endpoint.
   */
  regions?: route53.HealthCheckRegion[];
  /**
   * Tags applied to the health check.
   */
  tags?: Record<string, string>;
}

export interface HealthCheck extends Resource<
  "AWS.Route53.HealthCheck",
  HealthCheckProps,
  {
    /**
     * Health check ID.
     */
    id: string;
    /**
     * Alias of `id`.
     */
    healthCheckId: string;
    /**
     * Health check type.
     */
    type: route53.HealthCheckType;
    /**
     * Endpoint, path, port, thresholds, disabled/inverted state, SNI and
     * tags, as observed. Lets `alchemy drift` detect out-of-band changes.
     */
    configuration?: {
      ipAddress?: string;
      port?: number;
      resourcePath?: string;
      fullyQualifiedDomainName?: string;
      searchString?: string;
      failureThreshold?: number;
      inverted?: boolean;
      disabled?: boolean;
      healthThreshold?: number;
      enableSNI?: boolean;
      tags: Record<string, string>;
    };
  },
  never,
  Providers
> {}

/**
 * A Route 53 health check.
 *
 * `HealthCheck` monitors the health of an endpoint and can gate failover and
 * other routing policies on a `Record` via `record.healthCheckId`.
 * ### Creating a Health Check
 * **Example:** HTTP Health Check
 * ```typescript
 * const check = yield* HealthCheck("ApiHealth", {
 *   type: "HTTP",
 *   fullyQualifiedDomainName: "api.example.com",
 *   resourcePath: "/health",
 *   port: 80,
 *   requestInterval: "30 seconds",
 *   failureThreshold: 3,
 * });
 * ```
 *
 * ### Gating DNS Failover
 * **Example:** Fail Over a Record When the Check Fails
 * ```typescript
 * const check = yield* HealthCheck("PrimaryHealth", {
 *   type: "HTTPS",
 *   fullyQualifiedDomainName: "primary.example.com",
 *   resourcePath: "/health",
 *   port: 443,
 * });
 * // Route 53 answers with the PRIMARY record only while the check passes;
 * // see `Record` for the matching SECONDARY record.
 * const primary = yield* Record("Primary", {
 *   hostedZoneId: zone.id,
 *   name: "app.example.com",
 *   type: "A",
 *   ttl: "60 seconds",
 *   records: ["1.2.3.4"],
 *   setIdentifier: "primary",
 *   failover: "PRIMARY",
 *   healthCheckId: check.id,
 * });
 * ```
 *
 * @resource
 */
export const HealthCheck = Resource<HealthCheck>("AWS.Route53.HealthCheck");

/**
 * Whether a Route 53 health check can be managed directly through Route 53.
 *
 * Health checks with `LinkedService` are owned by another AWS service (for
 * example, Cloud Map). Route 53 refuses direct deletion of those checks, and
 * the owning service may retain them as tombstones after its resource is
 * deleted. They therefore must not be returned to account-wide nuke inventory.
 */
export const isNukeableHealthCheck = (check: { LinkedService?: route53.LinkedService }): boolean =>
  check.LinkedService === undefined;

const toConfig = (props: HealthCheckProps): route53.HealthCheckConfig => ({
  Type: props.type,
  IPAddress: props.ipAddress,
  Port: props.port,
  ResourcePath: props.resourcePath,
  FullyQualifiedDomainName: props.fullyQualifiedDomainName,
  SearchString: props.searchString,
  RequestInterval: durationToSeconds(props.requestInterval),
  FailureThreshold: props.failureThreshold,
  MeasureLatency: props.measureLatency,
  Inverted: props.inverted,
  Disabled: props.disabled,
  HealthThreshold: props.healthThreshold,
  ChildHealthChecks: props.childHealthChecks,
  EnableSNI: props.enableSNI,
  Regions: props.regions,
});

// Fields settable via UpdateHealthCheck (i.e. everything except the immutable
// Type / RequestInterval / MeasureLatency).
const mutableFields = (props: HealthCheckProps) => ({
  IPAddress: props.ipAddress,
  Port: props.port,
  ResourcePath: props.resourcePath,
  FullyQualifiedDomainName: props.fullyQualifiedDomainName,
  SearchString: props.searchString,
  FailureThreshold: props.failureThreshold,
  // Omitted means AWS's default (false), so a check disabled or inverted
  // out of band converges back.
  Inverted: props.inverted ?? false,
  Disabled: props.disabled ?? false,
  HealthThreshold: props.healthThreshold,
  ChildHealthChecks: props.childHealthChecks,
  EnableSNI: props.enableSNI,
  Regions: props.regions,
});

const mutableDiffers = (
  observed: route53.HealthCheckConfig,
  desired: HealthCheckProps,
): boolean => {
  const d = mutableFields(desired);
  return (
    observed.IPAddress !== d.IPAddress ||
    observed.Port !== d.Port ||
    observed.ResourcePath !== d.ResourcePath ||
    observed.FullyQualifiedDomainName !== d.FullyQualifiedDomainName ||
    observed.SearchString !== d.SearchString ||
    (observed.FailureThreshold ?? undefined) !== d.FailureThreshold ||
    (observed.Inverted ?? false) !== d.Inverted ||
    (observed.Disabled ?? false) !== d.Disabled ||
    (observed.HealthThreshold ?? undefined) !== d.HealthThreshold ||
    (observed.EnableSNI ?? undefined) !== d.EnableSNI
  );
};

/**
 * The settings reconcile converges, as observed. `read` and `reconcile`
 * share it so a converged health check reads unchanged.
 */
const observeHealthCheckConfiguration = (
  observed: route53.HealthCheckConfig,
  tags: Record<string, string>,
) =>
  plainJson({
    ipAddress: observed.IPAddress,
    port: observed.Port,
    resourcePath: observed.ResourcePath,
    fullyQualifiedDomainName: observed.FullyQualifiedDomainName,
    searchString: observed.SearchString,
    failureThreshold: observed.FailureThreshold,
    inverted: observed.Inverted ?? false,
    disabled: observed.Disabled ?? false,
    healthThreshold: observed.HealthThreshold,
    enableSNI: observed.EnableSNI,
    tags,
  });

export const HealthCheckProvider = () =>
  Provider.effect(
    HealthCheck,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (id: string) {
        return yield* route53.getHealthCheck({ HealthCheckId: id }).pipe(
          Effect.map((r) => r.HealthCheck),
          Effect.catchTag("NoSuchHealthCheck", () => Effect.undefined),
        );
      });

      const observedTags = Effect.fn(function* (id: string) {
        const response = yield* route53.listTagsForResource({
          ResourceType: "healthcheck",
          ResourceId: id,
        });
        const record: Record<string, string> = {};
        for (const tag of response.ResourceTagSet.Tags ?? []) {
          if (tag.Key !== undefined && tag.Value !== undefined) {
            record[tag.Key] = tag.Value;
          }
        }
        return record;
      });

      const syncTags = Effect.fn(function* (
        id: string,
        logicalId: string,
        userTags: Record<string, string> | undefined,
      ) {
        const internalTags = yield* createInternalTags(logicalId);
        const newTags = { ...userTags, ...internalTags };
        const oldTags = yield* observedTags(id);
        const { upsert, removed } = diffTags(oldTags, newTags);
        if (upsert.length === 0 && removed.length === 0) {
          return newTags;
        }
        yield* route53.changeTagsForResource({
          ResourceType: "healthcheck",
          ResourceId: id,
          AddTags: upsert.length > 0 ? upsert : undefined,
          RemoveTagKeys: removed.length > 0 ? removed : undefined,
        });
        return newTags;
      });

      return {
        stables: ["id", "healthCheckId"],
        list: () =>
          route53.listHealthChecks.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.HealthChecks ?? []).filter(isNukeableHealthCheck).map((check) => ({
                  id: check.Id,
                  healthCheckId: check.Id,
                  type: check.HealthCheckConfig.Type,
                })),
              ),
            ),
          ),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.type !== news.type ||
            (durationToSeconds(olds.requestInterval) ?? 30) !==
              (durationToSeconds(news.requestInterval) ?? 30) ||
            (olds.measureLatency ?? false) !== (news.measureLatency ?? false)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) {
            return undefined;
          }
          const check = yield* observe(output.id);
          if (!check) {
            return undefined;
          }
          return {
            id: check.Id,
            healthCheckId: check.Id,
            type: check.HealthCheckConfig.Type,
            configuration: observeHealthCheckConfiguration(
              check.HealthCheckConfig,
              yield* observedTags(check.Id),
            ),
          };
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          // Observe.
          let check = output?.id ? yield* observe(output.id) : undefined;

          // Ensure — CallerReference makes create idempotent.
          if (!check) {
            check = yield* route53
              .createHealthCheck({
                CallerReference: instanceId,
                HealthCheckConfig: toConfig(news),
              })
              .pipe(
                Effect.map((r) => r.HealthCheck),
                Effect.catchTag("HealthCheckAlreadyExists", () =>
                  // Same CallerReference already created it; the engine stores
                  // output, so on a true re-run output.id observes above. A bare
                  // race here means we must re-read — but the API gives us no id,
                  // so fall back to the stored output if present.
                  output?.id
                    ? observe(output.id).pipe(
                        Effect.flatMap((existing) =>
                          existing
                            ? Effect.succeed(existing)
                            : Effect.die(
                                new Error("health check exists but could not be observed"),
                              ),
                        ),
                      )
                    : Effect.die(new Error("health check already exists for caller reference")),
                ),
              );
          }

          // Sync config — diff observed mutable fields against desired.
          if (mutableDiffers(check.HealthCheckConfig, news)) {
            const updated = yield* route53
              .updateHealthCheck({
                HealthCheckId: check.Id,
                HealthCheckVersion: check.HealthCheckVersion,
                ...mutableFields(news),
              })
              .pipe(
                Effect.map((r) => r.HealthCheck),
                // Optimistic-lock retry: re-read for the latest version.
                Effect.retry({
                  while: (e) => e._tag === "HealthCheckVersionMismatch",
                  schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(5)]),
                }),
              );
            check = updated;
          }

          // Sync tags.
          const tags = yield* syncTags(check.Id, id, news.tags);

          return {
            id: check.Id,
            healthCheckId: check.Id,
            type: check.HealthCheckConfig.Type,
            configuration: observeHealthCheckConfiguration(check.HealthCheckConfig, tags),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* route53.deleteHealthCheck({ HealthCheckId: output.id }).pipe(
            Effect.asVoid,
            Effect.catchTag("NoSuchHealthCheck", () => Effect.void),
            // Still referenced by a record whose delete is propagating.
            Effect.retry({
              while: (e) => e._tag === "HealthCheckInUse",
              schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
            }),
            Effect.catchTag("HealthCheckInUse", () => Effect.void),
          );
        }),
      };
    }),
  );
