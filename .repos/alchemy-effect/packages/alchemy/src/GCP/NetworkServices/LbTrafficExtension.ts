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
import type {
  ExtensionChain,
  ExtensionChainExtension,
  ExtensionChainMatchCondition,
} from "./LbEdgeExtension.ts";
import {
  canonicalizeLink,
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

const COLLECTION = "lbTrafficExtensions";

export type LbTrafficExtensionLoadBalancingScheme =
  | networkservices.LbTrafficExtensionLoadBalancingSchemeEnum
  | (string & {});

export type ExtensionEvent =
  | networkservices.ExtensionChainExtensionSupportedEventsItemEnum
  | (string & {});

export type ExtensionBodySendMode =
  | networkservices.ExtensionChainExtensionRequestBodySendModeEnum
  | (string & {});

export type {
  ExtensionChain,
  ExtensionChainExtension,
  ExtensionChainMatchCondition,
};

export type LbTrafficExtensionProps = {
  /**
   * Extension id (the `{lbTrafficExtension}` segment of
   * `projects/{project}/locations/{location}/lbTrafficExtensions/{lbTrafficExtension}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the extension.
   */
  lbTrafficExtensionId?: string;
  /**
   * Location matching the forwarding rules (`global` or a region).
   * Immutable — changing it replaces the extension. `US-CENTRAL1` is
   * accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Forwarding-rule resource names this extension attaches to. At least
   * one is required. A forwarding rule may have only one traffic
   * extension.
   */
  forwardingRules: string[];
  /**
   * Ordered extension chains. The first matching chain runs. Limited to
   * 5 chains.
   */
  extensionChains: ExtensionChain[];
  /**
   * Load balancing scheme shared by every referenced backend and
   * forwarding rule (`INTERNAL_MANAGED` or `EXTERNAL_MANAGED`).
   * Immutable — changing it replaces the extension.
   */
  loadBalancingScheme: LbTrafficExtensionLoadBalancingScheme;
  /**
   * Resource-level metadata included in `ProcessingRequest`. Invalid
   * when any chain uses a plugin extension.
   */
  metadata?: Record<string, unknown>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type LbTrafficExtension = Resource<
  "GCP.NetworkServices.LbTrafficExtension",
  LbTrafficExtensionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/lbTrafficExtensions/{lbTrafficExtension}`. */
    name: string;
    /** Extension id (last path segment). */
    lbTrafficExtensionId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Attached forwarding-rule resource names. */
    forwardingRules: string[];
    /** Configured extension chains. */
    extensionChains: ExtensionChain[];
    /** Load balancing scheme. */
    loadBalancingScheme: string | undefined;
    /** Resource-level metadata. */
    metadata: Record<string, unknown> | undefined;
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
 * An LbTrafficExtension lets a Service Extension modify request and
 * response headers and payloads without changing backend selection.
 *
 * Changing `lbTrafficExtensionId`, `location`, or `loadBalancingScheme`
 * replaces the resource. Description, labels, forwarding rules, chains,
 * and metadata update in place.
 *
 * ### Creating an LbTrafficExtension
 * **Example:** Callout on an internal managed load balancer
 * ```typescript
 * const extension = yield* GCP.NetworkServices.LbTrafficExtension("Inspect", {
 *   location: "us-central1",
 *   loadBalancingScheme: "INTERNAL_MANAGED",
 *   forwardingRules: [rule.selfLink ?? rule.name],
 *   extensionChains: [
 *     {
 *       name: "all-traffic",
 *       matchCondition: { celExpression: "true" },
 *       extensions: [
 *         {
 *           name: "header-rewriter",
 *           service: callout.selfLink ?? callout.name,
 *           authority: "ext.example.com",
 *           timeout: "0.1s",
 *           failOpen: true,
 *           supportedEvents: ["REQUEST_HEADERS", "RESPONSE_HEADERS"],
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
export const LbTrafficExtension = Resource<LbTrafficExtension>(
  "GCP.NetworkServices.LbTrafficExtension",
);

const toExtension = (
  extension: ExtensionChainExtension | networkservices.ExtensionChainExtension,
): ExtensionChainExtension => ({
  name: extension.name,
  authority: extension.authority,
  service: extension.service ? canonicalizeLink(extension.service) : undefined,
  supportedEvents: [...(extension.supportedEvents ?? [])],
  timeout: extension.timeout,
  failOpen: extension.failOpen,
  forwardHeaders: [...(extension.forwardHeaders ?? [])],
  forwardAttributes: [...(extension.forwardAttributes ?? [])],
  metadata: extension.metadata
    ? { ...(extension.metadata as Record<string, unknown>) }
    : undefined,
  requestBodySendMode: extension.requestBodySendMode,
  responseBodySendMode: extension.responseBodySendMode,
  observabilityMode: extension.observabilityMode,
});

const toChain = (
  chain: ExtensionChain | networkservices.ExtensionChain,
): ExtensionChain => ({
  name: chain.name,
  matchCondition: chain.matchCondition
    ? { celExpression: chain.matchCondition.celExpression }
    : undefined,
  extensions: (chain.extensions ?? []).map(toExtension),
});

const toForwardingRules = (rules: readonly string[] | undefined) =>
  (rules ?? []).map((rule) => canonicalizeLink(rule)).filter(Boolean);

const toAttrs = (
  extension: networkservices.LbTrafficExtension,
  project: string,
  region: string,
) => {
  const name = extension.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    lbTrafficExtensionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    description: extension.description,
    forwardingRules: toForwardingRules(extension.forwardingRules),
    extensionChains: (extension.extensionChains ?? []).map(toChain),
    loadBalancingScheme: extension.loadBalancingScheme,
    metadata: extension.metadata
      ? { ...(extension.metadata as Record<string, unknown>) }
      : undefined,
    labels: userLabels(extension.labels),
    createTime: extension.createTime,
    updateTime: extension.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsLbTrafficExtensions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const LbTrafficExtensionProvider = () =>
  Provider.succeed(LbTrafficExtension, {
    stables: [
      "name",
      "lbTrafficExtensionId",
      "project",
      "location",
      "loadBalancingScheme",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.lbTrafficExtensionId ?? output?.lbTrafficExtensionId;
      const nextId = news.lbTrafficExtensionId
        ? rfc1035(news.lbTrafficExtensionId, "lb-traffic-extension")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousScheme = (
        olds?.loadBalancingScheme ??
        output?.loadBalancingScheme ??
        ""
      ).toUpperCase();
      const nextScheme = news.loadBalancingScheme.toUpperCase();
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousScheme.length > 0 && previousScheme !== nextScheme)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const lbTrafficExtensionId = yield* toPhysicalId(
        id,
        olds?.lbTrafficExtensionId,
        output?.lbTrafficExtensionId,
        "lb-traffic-extension",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, lbTrafficExtensionId);
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
          networkservices.listProjectsLocationsLbTrafficExtensions.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.lbTrafficExtensions,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const lbTrafficExtensionId = yield* toPhysicalId(
        id,
        news.lbTrafficExtensionId,
        output?.lbTrafficExtensionId,
        "lb-traffic-extension",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        lbTrafficExtensionId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredRules = toForwardingRules(news.forwardingRules);
      const desiredChains = news.extensionChains.map(toChain);
      const desiredMetadata = news.metadata ? { ...news.metadata } : undefined;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsLbTrafficExtensions({
            parent: parentOf(env.project, location),
            lbTrafficExtensionId,
            body: {
              description: news.description,
              labels: desiredLabels,
              forwardingRules: desiredRules,
              extensionChains: desiredChains,
              loadBalancingScheme: news.loadBalancingScheme,
              metadata: desiredMetadata,
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

      const observed = toAttrs(current, env.project, env.region);
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const updateMask = changedFields([
        ["labels", labelsChanged],
        [
          "description",
          (current.description ?? "") !== (news.description ?? ""),
        ],
        [
          "forwardingRules",
          !sameStringList(observed.forwardingRules, desiredRules),
        ],
        ["extensionChains", !sameJson(observed.extensionChains, desiredChains)],
        ["metadata", !sameJson(observed.metadata, desiredMetadata)],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsLbTrafficExtensions({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              forwardingRules: desiredRules,
              extensionChains: desiredChains,
              loadBalancingScheme: news.loadBalancingScheme,
              metadata: desiredMetadata,
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
        .deleteProjectsLocationsLbTrafficExtensions({ name: output.name })
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
