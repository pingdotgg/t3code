import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { toChain, type ExtensionChain } from "./LbEdgeExtension.ts";
import {
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "lbRouteExtensions";
const DEFAULT_SCHEME = "INTERNAL_MANAGED";

export type LbRouteExtensionLoadBalancingScheme =
  | networkservices.LbRouteExtensionLoadBalancingSchemeEnum
  | (string & {});

export type { ExtensionChain };

export type LbRouteExtensionProps = {
  /**
   * LbRouteExtension id (the `{lbRouteExtension}` segment of
   * `projects/{project}/locations/{location}/lbRouteExtensions/{lbRouteExtension}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the extension.
   */
  lbRouteExtensionId?: string;
  /**
   * Location (`us-central1`, `global`, …). Immutable — changing it
   * replaces the extension. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Forwarding rule resource names this extension attaches to. At least
   * one is required. Only one LbRouteExtension may attach to a given
   * forwarding rule.
   */
  forwardingRules: string[];
  /**
   * Ordered extension chains. The first matching chain runs. Limited to
   * 5 chains; each chain is limited to 1 extension.
   */
  extensionChains: ExtensionChain[];
  /**
   * Load balancing scheme shared by referenced backend services and
   * forwarding rules. Immutable — changing it replaces the extension.
   * @default "INTERNAL_MANAGED"
   */
  loadBalancingScheme?: LbRouteExtensionLoadBalancingScheme;
  /**
   * Metadata included under `com.google.lb_route_extension.` in the
   * `ProcessingRequest`. Must not be set when any chain contains a
   * plugin extension.
   */
  metadata?: Record<string, unknown>;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type LbRouteExtension = Resource<
  "GCP.NetworkServices.LbRouteExtension",
  LbRouteExtensionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/lbRouteExtensions/{lbRouteExtension}`. */
    name: string;
    /** LbRouteExtension id (last path segment). */
    lbRouteExtensionId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `global`, …). */
    location: string;
    /** Attached forwarding rule resource names. */
    forwardingRules: string[];
    /** Extension chains. */
    extensionChains: ExtensionChain[];
    /** Load balancing scheme. */
    loadBalancingScheme: string | undefined;
    /** Resource-level callout metadata. */
    metadata: Record<string, unknown> | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Services LbRouteExtension — a Service Extension that
 * controls where an Application Load Balancer routes a given request.
 *
 * Changing `lbRouteExtensionId`, `location`, or `loadBalancingScheme`
 * replaces the extension. Description, labels, forwarding rules,
 * extension chains, and metadata update in place.
 *
 * ### Creating an LbRouteExtension
 * **Example:** Attach to a regional forwarding rule
 * ```typescript
 * const ext = yield* GCP.NetworkServices.LbRouteExtension("Route", {
 *   location: "us-central1",
 *   loadBalancingScheme: "INTERNAL_MANAGED",
 *   forwardingRules: [rule.selfLink],
 *   extensionChains: [
 *     {
 *       name: "chain1",
 *       matchCondition: { celExpression: "true" },
 *       extensions: [
 *         {
 *           name: "ext1",
 *           authority: "ext1.example.com",
 *           service: backend.selfLink,
 *           timeout: "0.1s",
 *           supportedEvents: ["REQUEST_HEADERS"],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const LbRouteExtension = Resource<LbRouteExtension>(
  "GCP.NetworkServices.LbRouteExtension",
);

const toAttrs = (
  extension: networkservices.LbRouteExtension,
  project: string,
  region: string,
) => {
  const name = extension.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    lbRouteExtensionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    forwardingRules: extension.forwardingRules ?? [],
    extensionChains: (extension.extensionChains ?? []).map(toChain),
    loadBalancingScheme: extension.loadBalancingScheme,
    metadata: extension.metadata,
    description: extension.description,
    labels: userLabels(extension.labels),
    createTime: extension.createTime,
    updateTime: extension.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsLbRouteExtensions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const LbRouteExtensionProvider = () =>
  Provider.succeed(LbRouteExtension, {
    stables: [
      "name",
      "lbRouteExtensionId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.lbRouteExtensionId ?? output?.lbRouteExtensionId;
      const nextId = news.lbRouteExtensionId
        ? rfc1035(news.lbRouteExtensionId, "lb-route-extension")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousScheme =
        olds?.loadBalancingScheme ??
        output?.loadBalancingScheme ??
        DEFAULT_SCHEME;
      const nextScheme = news.loadBalancingScheme ?? previousScheme;
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousScheme !== nextScheme
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const lbRouteExtensionId = yield* toPhysicalId(
        id,
        olds?.lbRouteExtensionId,
        output?.lbRouteExtensionId,
        "lb-route-extension",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, lbRouteExtensionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkservices.listProjectsLocationsLbRouteExtensions.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.lbRouteExtensions,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const lbRouteExtensionId = yield* toPhysicalId(
        id,
        news.lbRouteExtensionId,
        output?.lbRouteExtensionId,
        "lb-route-extension",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        lbRouteExtensionId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const loadBalancingScheme = news.loadBalancingScheme ?? DEFAULT_SCHEME;
      const desiredRules = news.forwardingRules;
      const desiredChains = news.extensionChains.map(toChain);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsLbRouteExtensions({
            parent: parentOf(env.project, location),
            lbRouteExtensionId,
            body: {
              labels: desiredLabels,
              description: news.description,
              forwardingRules: desiredRules,
              extensionChains: desiredChains,
              loadBalancingScheme,
              metadata: news.metadata,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const rulesChanged = !sameStringList(
        current.forwardingRules,
        desiredRules,
      );
      const chainsChanged = !sameJson(
        (current.extensionChains ?? []).map(toChain),
        desiredChains,
      );
      const metadataChanged = !sameJson(current.metadata, news.metadata);

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["forwardingRules", rulesChanged],
        ["extensionChains", chainsChanged],
        ["metadata", metadataChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsLbRouteExtensions({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              forwardingRules: desiredRules,
              extensionChains: desiredChains,
              loadBalancingScheme,
              metadata: news.metadata,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsLbRouteExtensions({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
