import * as sd from "@distilled.cloud/aws/servicediscovery";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  awaitOperation,
  deregisterAllInstances,
  fetchObservedTags,
  retryWhileResourceInUse,
  syncTags,
} from "./internal.ts";

export interface ServiceDnsRecord {
  /**
   * The DNS record type Cloud Map creates in the namespace's hosted zone
   * when an instance is registered. Changing the set of record types
   * replaces the service.
   */
  type: "A" | "AAAA" | "SRV" | "CNAME";
  /**
   * The TTL of the DNS record (e.g. `"10 seconds"` or
   * `Duration.seconds(10)`; a bare number is milliseconds). Mutable.
   */
  ttl: Duration.Input;
}

export interface ServiceProps {
  /**
   * Name of the service — for DNS namespaces this becomes the DNS label
   * (`{name}.{namespace}`). Changing the name replaces the service.
   * @default a generated DNS-compatible physical name
   */
  name?: string;
  /**
   * The ID of the namespace to register the service in. Changing the
   * namespace replaces the service.
   */
  namespaceId: string;
  /**
   * A description for the service.
   */
  description?: string;
  /**
   * DNS records Cloud Map creates when instances are registered. Omit for
   * API-only (HTTP namespace) services. TTLs are mutable; changing the set
   * of record types replaces the service.
   */
  dnsRecords?: ServiceDnsRecord[];
  /**
   * How Route 53 responds to DNS queries: `MULTIVALUE` returns up to eight
   * healthy records, `WEIGHTED` returns one. Create-only — changing it
   * replaces the service.
   * @default "MULTIVALUE"
   */
  routingPolicy?: "MULTIVALUE" | "WEIGHTED";
  /**
   * A Route 53 health check for instances (public DNS namespaces only).
   * Mutually exclusive with `healthCheckCustomConfig`.
   */
  healthCheckConfig?: {
    /** The endpoint protocol Route 53 health-checks: HTTP, HTTPS, or TCP. */
    type: "HTTP" | "HTTPS" | "TCP";
    /** The path Route 53 requests, e.g. `/health` (HTTP/HTTPS only). */
    resourcePath?: string;
    /** Consecutive failures before the instance is considered unhealthy. */
    failureThreshold?: number;
  };
  /**
   * Custom health checking — instance health is pushed via
   * `UpdateInstanceCustomHealthStatus` instead of probed by Route 53.
   * Create-only: it cannot be added, changed, or removed after creation, so
   * any change replaces the service.
   */
  healthCheckCustomConfig?: {
    /** Deprecated by AWS (always behaves as 1); retained for parity. */
    failureThreshold?: number;
  };
  /**
   * Set to `"HTTP"` to force API-only discovery even inside a DNS namespace.
   * Create-only — changing it replaces the service.
   */
  type?: "HTTP";
  /**
   * Custom service-level attributes (up to 30 key/value pairs) stored on the
   * service and readable at runtime via `GetServiceAttributes`. Mutable —
   * reconcile diffs the observed attributes against this map, upserting
   * changed keys and deleting keys no longer declared.
   */
  attributes?: Record<string, string>;
  /**
   * Tags to apply to the service. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Service extends Resource<
  "AWS.CloudMap.Service",
  ServiceProps,
  {
    /**
     * The unique identifier of the service.
     */
    serviceId: string;
    /**
     * The ARN of the service.
     */
    serviceArn: string;
    /**
     * Name of the service.
     */
    serviceName: string;
    /**
     * The namespace the service belongs to.
     */
    namespaceId: string;
    /**
     * Name of the namespace the service belongs to.
     */
    namespaceName: string;
  },
  {},
  Providers
> {}

/**
 * An AWS Cloud Map service — a named entry in a namespace that instances
 * register against. For DNS namespaces, Cloud Map creates the configured DNS
 * records per registered instance; every service is also queryable via the
 * `DiscoverInstances` API. This is what ECS `serviceRegistries[].registryArn`
 * consumes.
 * @resource
 * @section Creating Services
 * @example DNS Service with A Records
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const namespace = yield* AWS.CloudMap.PrivateDnsNamespace("AppNamespace", {
 *   name: "internal.example.com",
 *   vpc: vpc.vpcId,
 * });
 *
 * const service = yield* AWS.CloudMap.Service("Backend", {
 *   namespaceId: namespace.namespaceId,
 *   dnsRecords: [{ type: "A", ttl: "10 seconds" }],
 *   routingPolicy: "MULTIVALUE",
 * });
 * ```
 *
 * @example API-only Service in an HTTP Namespace
 * ```typescript
 * const namespace = yield* AWS.CloudMap.HttpNamespace("AppNamespace");
 * const service = yield* AWS.CloudMap.Service("Backend", {
 *   namespaceId: namespace.namespaceId,
 * });
 * ```
 *
 * @example Service with Custom Health Checks
 * ```typescript
 * const service = yield* AWS.CloudMap.Service("Backend", {
 *   namespaceId: namespace.namespaceId,
 *   dnsRecords: [{ type: "SRV", ttl: "10 seconds" }],
 *   healthCheckCustomConfig: {},
 * });
 * ```
 *
 * @example Service with Custom Attributes
 * ```typescript
 * const service = yield* AWS.CloudMap.Service("Backend", {
 *   namespaceId: namespace.namespaceId,
 *   attributes: { tier: "backend", version: "2" },
 * });
 * ```
 *
 * @section Discovering Instances
 * @example Discover Healthy Instances from a Lambda
 * ```typescript
 * // init
 * const discover = yield* AWS.CloudMap.DiscoverInstances(service);
 *
 * // runtime
 * const { Instances } = yield* discover({ HealthStatus: "HEALTHY" });
 * ```
 */
export const Service = Resource<Service>("AWS.CloudMap.Service");

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        // 63 = the Route 53 per-label limit; the service name becomes the
        // DNS label `{name}.{namespace}` for DNS namespaces
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }))
        );
      });

      /** Observe by cached id, falling back to name lookup in the namespace. */
      const observeService = Effect.fn(function* (
        namespaceId: string,
        name: string,
        serviceId: string | undefined,
      ) {
        if (serviceId !== undefined) {
          const byId = yield* sd.getService({ Id: serviceId }).pipe(
            Effect.map((r) => r.Service),
            Effect.catchTag("ServiceNotFound", () => Effect.succeed(undefined)),
          );
          if (byId !== undefined) {
            return byId;
          }
        }
        const summary = yield* sd.listServices
          .pages({
            Filters: [
              { Name: "NAMESPACE_ID", Values: [namespaceId], Condition: "EQ" },
            ],
          })
          .pipe(
            Stream.map((page) => page.Services ?? []),
            Stream.flattenIterable,
            Stream.filter((s) => s.Name === name),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
        if (summary?.Id === undefined) {
          return undefined;
        }
        return yield* sd.getService({ Id: summary.Id }).pipe(
          Effect.map((r) => r.Service),
          Effect.catchTag("ServiceNotFound", () => Effect.succeed(undefined)),
        );
      });

      const resolveNamespaceName = Effect.fn(function* (namespaceId: string) {
        const namespace = yield* sd.getNamespace({ Id: namespaceId });
        return namespace.Namespace?.Name ?? "";
      });

      const toDesiredDnsConfig = (props: ServiceProps) =>
        props.dnsRecords !== undefined
          ? {
              DnsRecords: props.dnsRecords.map((record) => ({
                Type: record.type,
                TTL: toWireSeconds(record.ttl)!,
              })),
              RoutingPolicy: props.routingPolicy,
            }
          : undefined;

      const toDesiredHealthCheckConfig = (props: ServiceProps) =>
        props.healthCheckConfig !== undefined
          ? {
              Type: props.healthCheckConfig.type,
              ResourcePath: props.healthCheckConfig.resourcePath,
              FailureThreshold: props.healthCheckConfig.failureThreshold,
            }
          : undefined;

      const recordKey = (records: { Type: string; TTL: number }[]) =>
        records
          .map((r) => `${r.Type}:${r.TTL}`)
          .sort()
          .join(",");

      const recordTypeKey = (records: { type: string }[] | undefined) =>
        (records ?? [])
          .map((r) => r.type)
          .sort()
          .join(",");

      return Service.Provider.of({
        stables: [
          "serviceId",
          "serviceArn",
          "serviceName",
          "namespaceId",
          "namespaceName",
        ],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* sd.listServices
              .pages({})
              .pipe(Stream.runCollect);
            const summaries = Array.from(pages).flatMap(
              (page) => page.Services ?? [],
            );
            const items = yield* Effect.forEach(
              summaries,
              (summary) =>
                Effect.gen(function* () {
                  if (summary.Id === undefined) return undefined;
                  const service = yield* sd.getService({ Id: summary.Id }).pipe(
                    Effect.map((r) => r.Service),
                    Effect.catchTag("ServiceNotFound", () =>
                      Effect.succeed(undefined),
                    ),
                  );
                  if (
                    service?.Id === undefined ||
                    service.Arn === undefined ||
                    service.Name === undefined ||
                    service.NamespaceId === undefined
                  ) {
                    return undefined;
                  }
                  const namespaceName = yield* resolveNamespaceName(
                    service.NamespaceId,
                  ).pipe(
                    Effect.catchTag("NamespaceNotFound", () =>
                      Effect.succeed(""),
                    ),
                  );
                  return {
                    serviceId: service.Id,
                    serviceArn: service.Arn,
                    serviceName: service.Name,
                    namespaceId: service.NamespaceId,
                    namespaceName,
                  };
                }),
              { concurrency: 10 },
            );
            return items.filter(
              (item): item is Service["Attributes"] => item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const namespaceId = output?.namespaceId ?? olds?.namespaceId;
          if (namespaceId === undefined) return undefined;
          const name =
            output?.serviceName ?? (yield* createName(id, olds ?? {}));
          const service = yield* observeService(
            namespaceId,
            name,
            output?.serviceId,
          );
          if (
            service?.Id === undefined ||
            service.Arn === undefined ||
            service.NamespaceId === undefined
          ) {
            return undefined;
          }
          const namespaceName = yield* resolveNamespaceName(
            service.NamespaceId,
          ).pipe(
            Effect.catchTag("NamespaceNotFound", () => Effect.succeed("")),
          );
          const attrs = {
            serviceId: service.Id,
            serviceArn: service.Arn,
            serviceName: service.Name ?? name,
            namespaceId: service.NamespaceId,
            namespaceName,
          };
          const tags = yield* fetchObservedTags(attrs.serviceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (olds.namespaceId !== news.namespaceId) {
            return { action: "replace" } as const;
          }
          if (olds.routingPolicy !== news.routingPolicy) {
            return { action: "replace" } as const;
          }
          if (
            recordTypeKey(olds.dnsRecords) !== recordTypeKey(news.dnsRecords)
          ) {
            return { action: "replace" } as const;
          }
          // healthCheckCustomConfig cannot be added, changed, or removed
          if (
            (olds.healthCheckCustomConfig === undefined) !==
            (news.healthCheckCustomConfig === undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (olds.type !== news.type) {
            return { action: "replace" } as const;
          }
          // description / record TTLs / healthCheckConfig / tags → update
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.serviceName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative
          let service = yield* observeService(
            news.namespaceId,
            name,
            output?.serviceId,
          );

          // 2. ENSURE — createService is synchronous
          if (service === undefined) {
            service = yield* sd
              .createService({
                Name: name,
                NamespaceId: news.namespaceId,
                Description: news.description,
                DnsConfig: toDesiredDnsConfig(news),
                HealthCheckConfig: toDesiredHealthCheckConfig(news),
                HealthCheckCustomConfig: news.healthCheckCustomConfig
                  ? {
                      FailureThreshold:
                        news.healthCheckCustomConfig.failureThreshold,
                    }
                  : undefined,
                Type: news.type,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.map((r) => r.Service),
                // a concurrent reconciler created it — observe instead
                Effect.catchTag("ServiceAlreadyExists", (e) =>
                  e.ServiceId !== undefined
                    ? sd
                        .getService({ Id: e.ServiceId })
                        .pipe(Effect.map((r) => r.Service))
                    : observeService(news.namespaceId, name, undefined),
                ),
              );
          }
          if (service?.Id === undefined || service.Arn === undefined) {
            return yield* Effect.fail(
              new sd.ServiceNotFound({
                Message: `service ${name} not visible after create`,
              }),
            );
          }

          // 3. SYNC — description / DNS record TTLs / health check config.
          // UpdateService deletes DnsRecords/HealthCheckConfig omitted from
          // the change, so we always send the FULL desired configuration and
          // only skip the call when observed already matches desired.
          const desiredDns = toDesiredDnsConfig(news);
          const desiredHealth = toDesiredHealthCheckConfig(news);
          const observedRecords = service.DnsConfig?.DnsRecords ?? [];
          const desiredRecords = desiredDns?.DnsRecords ?? [];
          const dnsDelta =
            recordKey([...observedRecords]) !== recordKey(desiredRecords);
          const descriptionDelta =
            (news.description ?? undefined) !==
            (service.Description ?? undefined);
          const observedHealth = service.HealthCheckConfig;
          const healthDelta =
            (desiredHealth === undefined) !== (observedHealth === undefined) ||
            (desiredHealth !== undefined &&
              (desiredHealth.Type !== observedHealth?.Type ||
                (desiredHealth.ResourcePath ?? undefined) !==
                  (observedHealth?.ResourcePath ?? undefined) ||
                (desiredHealth.FailureThreshold ?? undefined) !==
                  (observedHealth?.FailureThreshold ?? undefined)));
          if (dnsDelta || descriptionDelta || healthDelta) {
            const update = yield* sd.updateService({
              Id: service.Id,
              Service: {
                Description: news.description,
                DnsConfig:
                  desiredDns !== undefined
                    ? { DnsRecords: desiredDns.DnsRecords }
                    : undefined,
                HealthCheckConfig: desiredHealth,
              },
            });
            if (update.OperationId !== undefined) {
              yield* awaitOperation(update.OperationId);
            }
          }

          // 3b. SYNC SERVICE ATTRIBUTES — diff OBSERVED custom attributes
          // against the desired map; upsert changed keys, delete undeclared
          const observedAttributes: { [key: string]: string | undefined } =
            yield* sd.getServiceAttributes({ ServiceId: service.Id }).pipe(
              Effect.map((r) => r.ServiceAttributes?.Attributes ?? {}),
              Effect.catchTag("ServiceNotFound", () => Effect.succeed({})),
            );
          const desiredAttributes = news.attributes ?? {};
          const attributeUpserts = Object.entries(desiredAttributes).filter(
            ([key, value]) => observedAttributes[key] !== value,
          );
          const attributeRemovals = Object.keys(observedAttributes).filter(
            (key) => !(key in desiredAttributes),
          );
          if (attributeUpserts.length > 0) {
            yield* sd.updateServiceAttributes({
              ServiceId: service.Id,
              Attributes: Object.fromEntries(attributeUpserts),
            });
          }
          if (attributeRemovals.length > 0) {
            yield* sd.deleteServiceAttributes({
              ServiceId: service.Id,
              Attributes: attributeRemovals,
            });
          }

          // 3c. SYNC TAGS — diff against OBSERVED cloud tags
          const observedTags = yield* fetchObservedTags(service.Arn);
          yield* syncTags(service.Arn, observedTags, desiredTags);

          const namespaceId = service.NamespaceId ?? news.namespaceId;
          const namespaceName = yield* resolveNamespaceName(namespaceId);

          yield* session.note(service.Id);
          return {
            serviceId: service.Id,
            serviceArn: service.Arn,
            serviceName: service.Name ?? name,
            namespaceId,
            namespaceName,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // OBSERVE — instances registered at runtime (RegisterInstance
          // binding) block DeleteService; deregister any that remain and
          // await the async operations before deleting.
          yield* deregisterAllInstances(output.serviceId).pipe(
            Effect.catchTag("ServiceNotFound", () => Effect.void),
          );
          // deregistrations still propagating surface as ResourceInUse —
          // retry through the visibility window (bounded)
          yield* retryWhileResourceInUse(
            sd.deleteService({ Id: output.serviceId }),
          ).pipe(Effect.catchTag("ServiceNotFound", () => Effect.void));
        }),
      });
    }),
  );
