import * as sd from "@distilled.cloud/aws/servicediscovery";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  awaitOperation,
  ensureNamespace,
  fetchObservedTags,
  observeNamespace,
  retryWhileResourceInUse,
  syncTags,
} from "./internal.ts";

export interface PrivateDnsNamespaceProps {
  /**
   * Name of the namespace — services are discoverable in DNS as
   * `{service}.{name}` inside the associated VPC (e.g. `internal.example.com`
   * yields `backend.internal.example.com`). Changing the name replaces the
   * namespace.
   * @default a generated DNS-compatible physical name
   */
  name?: string;
  /**
   * The ID of the Amazon VPC that the private DNS namespace is associated
   * with (a Route 53 private hosted zone is created and associated with it).
   * Changing the VPC replaces the namespace.
   */
  vpc: string;
  /**
   * A description for the namespace.
   */
  description?: string;
  /**
   * The TTL of the SOA record for the namespace's Route 53 private hosted
   * zone (e.g. `"60 seconds"` or `Duration.seconds(60)`; a bare number is
   * milliseconds).
   */
  ttl?: Duration.Input;
  /**
   * Tags to apply to the namespace. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface PrivateDnsNamespace extends Resource<
  "AWS.CloudMap.PrivateDnsNamespace",
  PrivateDnsNamespaceProps,
  {
    /**
     * The unique identifier of the namespace.
     */
    namespaceId: string;
    /**
     * The ARN of the namespace.
     */
    namespaceArn: string;
    /**
     * Name of the namespace (the private DNS domain, e.g. `internal.example`).
     */
    namespaceName: string;
    /**
     * The private Route 53 hosted zone Cloud Map created for the namespace.
     */
    hostedZoneId: string | undefined;
  },
  {},
  Providers
> {}

/**
 * An AWS Cloud Map private DNS namespace — the DNS-based service registry
 * that ECS Service Connect and `serviceRegistries` point at. Services
 * registered in the namespace are discoverable inside the associated VPC via
 * DNS (`{service}.{namespace}`) and from anywhere via the
 * `DiscoverInstances` API.
 *
 * Namespace creation and deletion are asynchronous — the provider polls the
 * Cloud Map operations API (bounded) until they complete, which typically
 * takes 30-60 seconds.
 * @resource
 * @section Creating Namespaces
 * @example Private DNS Namespace in a VPC
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const vpc = yield* AWS.EC2.Vpc("AppVpc", { cidrBlock: "10.0.0.0/16" });
 * const namespace = yield* AWS.CloudMap.PrivateDnsNamespace("AppNamespace", {
 *   name: "internal.example.com",
 *   vpc: vpc.vpcId,
 * });
 * ```
 *
 * @example Namespace with SOA TTL and Description
 * ```typescript
 * const namespace = yield* AWS.CloudMap.PrivateDnsNamespace("AppNamespace", {
 *   name: "internal.example.com",
 *   vpc: vpc.vpcId,
 *   description: "service discovery for the app tier",
 *   ttl: "60 seconds",
 * });
 * ```
 *
 * @section Registering Services
 * @example Service with A Records
 * ```typescript
 * const service = yield* AWS.CloudMap.Service("Backend", {
 *   namespaceId: namespace.namespaceId,
 *   dnsRecords: [{ type: "A", ttl: "10 seconds" }],
 *   routingPolicy: "MULTIVALUE",
 * });
 * ```
 */
export const PrivateDnsNamespace = Resource<PrivateDnsNamespace>(
  "AWS.CloudMap.PrivateDnsNamespace",
);

export const PrivateDnsNamespaceProvider = () =>
  Provider.effect(
    PrivateDnsNamespace,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 253, lowercase: true }))
        );
      });

      const toAttributes = (namespace: sd.Namespace) => ({
        namespaceId: namespace.Id!,
        namespaceArn: namespace.Arn!,
        namespaceName: namespace.Name!,
        hostedZoneId: namespace.Properties?.DnsProperties?.HostedZoneId,
      });

      return PrivateDnsNamespace.Provider.of({
        stables: ["namespaceId", "namespaceArn", "namespaceName"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* sd.listNamespaces
              .pages({
                Filters: [
                  { Name: "TYPE", Values: ["DNS_PRIVATE"], Condition: "EQ" },
                ],
              })
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.Namespaces ?? [])
              .filter(
                (n) =>
                  n.Id !== undefined &&
                  n.Arn !== undefined &&
                  n.Name !== undefined,
              )
              .map((n) => ({
                namespaceId: n.Id!,
                namespaceArn: n.Arn!,
                namespaceName: n.Name!,
                hostedZoneId: n.Properties?.DnsProperties?.HostedZoneId,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.namespaceName ?? (yield* createName(id, olds ?? {}));
          const namespace = yield* observeNamespace(
            "DNS_PRIVATE",
            name,
            output?.namespaceId,
          );
          if (namespace?.Id === undefined) {
            return undefined;
          }
          const attrs = toAttributes(namespace);
          const tags = yield* fetchObservedTags(attrs.namespaceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (olds.vpc !== news.vpc) {
            return { action: "replace" } as const;
          }
          // description/ttl/tags fall through to the default update path
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.namespaceName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredTtl = toWireSeconds(news.ttl);

          // 1. OBSERVE — cloud state is authoritative; output is an id cache
          let namespace = yield* observeNamespace(
            "DNS_PRIVATE",
            name,
            output?.namespaceId,
          );

          // 2. ENSURE — create if missing; namespace creation is async. The
          // created namespace is observed by the operation's target id,
          // riding out a same-name predecessor still deleting
          if (namespace === undefined) {
            yield* session.note(
              `creating private DNS namespace ${name} (async)...`,
            );
            namespace = yield* ensureNamespace(
              "DNS_PRIVATE",
              name,
              sd.createPrivateDnsNamespace({
                Name: name,
                Vpc: news.vpc,
                Description: news.description,
                Properties:
                  desiredTtl !== undefined
                    ? { DnsProperties: { SOA: { TTL: desiredTtl } } }
                    : undefined,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            );
          }
          if (namespace?.Id === undefined) {
            return yield* Effect.fail(
              new sd.NamespaceNotFound({
                Message: `namespace ${name} not visible after create`,
              }),
            );
          }

          // 3. SYNC — description + SOA TTL, observed vs desired
          const observedTtl = namespace.Properties?.DnsProperties?.SOA?.TTL;
          const descriptionDelta =
            news.description !== undefined &&
            news.description !== namespace.Description;
          const ttlDelta =
            desiredTtl !== undefined && desiredTtl !== observedTtl;
          if (descriptionDelta || ttlDelta) {
            const update = yield* sd.updatePrivateDnsNamespace({
              Id: namespace.Id,
              Namespace: {
                Description: descriptionDelta ? news.description : undefined,
                Properties: ttlDelta
                  ? { DnsProperties: { SOA: { TTL: desiredTtl! } } }
                  : undefined,
              },
            });
            if (update.OperationId !== undefined) {
              yield* awaitOperation(update.OperationId);
            }
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags
          const observedTags = yield* fetchObservedTags(namespace.Arn!);
          yield* syncTags(namespace.Arn!, observedTags, desiredTags);

          yield* session.note(namespace.Id);
          return toAttributes(namespace);
        }),

        delete: Effect.fn(function* ({ output }) {
          const deleted = yield* retryWhileResourceInUse(
            sd.deleteNamespace({ Id: output.namespaceId }),
          ).pipe(
            Effect.catchTag("NamespaceNotFound", () =>
              Effect.succeed({ OperationId: undefined }),
            ),
            // an identical delete is already in flight — await THAT operation
            // instead of silently skipping the deletion
            Effect.catchTag("DuplicateRequest", (e) =>
              Effect.succeed({ OperationId: e.DuplicateOperationId }),
            ),
          );
          if (deleted.OperationId !== undefined) {
            yield* awaitOperation(deleted.OperationId);
          }
        }),
      });
    }),
  );
