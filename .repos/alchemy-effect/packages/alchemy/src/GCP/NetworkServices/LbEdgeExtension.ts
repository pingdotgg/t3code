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
import {
  DEFAULT_GLOBAL,
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

const COLLECTION = "lbEdgeExtensions";
const DEFAULT_SCHEME = "EXTERNAL_MANAGED";

export type LbEdgeExtensionLoadBalancingScheme =
  | networkservices.LbEdgeExtensionLoadBalancingSchemeEnum
  | (string & {});

export type ExtensionChainMatchCondition = {
  /**
   * CEL expression used to select requests. See the Service Extensions
   * CEL matcher language reference.
   */
  celExpression?: string;
};

export type ExtensionChainExtension = {
  /**
   * Extension name logged in HTTP request logs. RFC1034, 1-63
   * characters. Required except on AuthzExtension.
   */
  name?: string;
  /**
   * `:authority` header sent from Envoy to the callout. Required for
   * callout extensions; forbidden for plugin extensions.
   */
  authority?: string;
  /**
   * Backend service URL (callout) or WasmPlugin resource name (plugin).
   */
  service?: string;
  /**
   * Events that invoke this extension. `LbEdgeExtension` must list only
   * `REQUEST_HEADERS`.
   */
  supportedEvents?: string[];
  /**
   * Per-message timeout between 10ms and 10000ms. Required for callouts.
   */
  timeout?: string;
  /**
   * Continue request processing if the callout fails or times out.
   * @default false
   */
  failOpen?: boolean;
  /** HTTP headers forwarded to the extension. Omitted sends every header. */
  forwardHeaders?: string[];
  /** Envoy attributes forwarded to the extension. Omitted sends none. */
  forwardAttributes?: string[];
  /**
   * Metadata included in `ProcessingRequest.metadata_context`. Must not
   * be set for plugin extensions.
   */
  metadata?: Record<string, unknown>;
  /** Request body send mode (`STREAMED` or `FULL_DUPLEX_STREAMED`). */
  requestBodySendMode?: string;
  /** Response body send mode. */
  responseBodySendMode?: string;
  /**
   * Run the callout asynchronously without pausing the request.
   * @default false
   */
  observabilityMode?: boolean;
};

export type ExtensionChain = {
  /** Chain name logged in HTTP request logs. RFC1034, 1-63 characters. */
  name?: string;
  /** Conditions under which this chain runs. */
  matchCondition?: ExtensionChainMatchCondition;
  /**
   * Extensions executed for a matching request. `LbEdgeExtension` and
   * `LbRouteExtension` allow one extension per chain.
   */
  extensions?: ExtensionChainExtension[];
};

export type LbEdgeExtensionProps = {
  /**
   * LbEdgeExtension id (the `{lbEdgeExtension}` segment of
   * `projects/{project}/locations/{location}/lbEdgeExtensions/{lbEdgeExtension}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the extension.
   */
  lbEdgeExtensionId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the extension. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Forwarding rule resource names this extension attaches to. At least
   * one is required. Only one LbEdgeExtension may attach to a given
   * forwarding rule.
   */
  forwardingRules: string[];
  /**
   * Ordered extension chains. The first matching chain runs. Limited to
   * 5 chains.
   */
  extensionChains: ExtensionChain[];
  /**
   * Load balancing scheme shared by referenced forwarding rules.
   * Immutable — changing it replaces the extension.
   * @default "EXTERNAL_MANAGED"
   */
  loadBalancingScheme?: LbEdgeExtensionLoadBalancingScheme;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type LbEdgeExtension = Resource<
  "GCP.NetworkServices.LbEdgeExtension",
  LbEdgeExtensionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/lbEdgeExtensions/{lbEdgeExtension}`. */
    name: string;
    /** LbEdgeExtension id (last path segment). */
    lbEdgeExtensionId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** Attached forwarding rule resource names. */
    forwardingRules: string[];
    /** Extension chains. */
    extensionChains: ExtensionChain[];
    /** Load balancing scheme. */
    loadBalancingScheme: string | undefined;
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
 * A Network Services LbEdgeExtension — a Service Extension that
 * rewrites request headers so an Application Load Balancer can change
 * backend selection and Cloud CDN cache keys.
 *
 * Changing `lbEdgeExtensionId`, `location`, or `loadBalancingScheme`
 * replaces the extension. Description, labels, forwarding rules, and
 * extension chains update in place.
 *
 * ### Creating an LbEdgeExtension
 * **Example:** Attach to a global forwarding rule
 * ```typescript
 * const ext = yield* GCP.NetworkServices.LbEdgeExtension("Edge", {
 *   loadBalancingScheme: "EXTERNAL_MANAGED",
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
export const LbEdgeExtension = Resource<LbEdgeExtension>(
  "GCP.NetworkServices.LbEdgeExtension",
);

export const toExtension = (
  value: ExtensionChainExtension | networkservices.ExtensionChainExtension,
): ExtensionChainExtension => ({
  name: value.name,
  authority: value.authority,
  service: value.service,
  supportedEvents: value.supportedEvents ?? [],
  timeout: value.timeout,
  failOpen: value.failOpen,
  forwardHeaders: value.forwardHeaders ?? [],
  forwardAttributes: value.forwardAttributes ?? [],
  metadata: value.metadata,
  requestBodySendMode: value.requestBodySendMode,
  responseBodySendMode: value.responseBodySendMode,
  observabilityMode: value.observabilityMode,
});

export const toChain = (
  value: ExtensionChain | networkservices.ExtensionChain,
): ExtensionChain => ({
  name: value.name,
  matchCondition: value.matchCondition
    ? { celExpression: value.matchCondition.celExpression }
    : undefined,
  extensions: (value.extensions ?? []).map(toExtension),
});

const toAttrs = (
  extension: networkservices.LbEdgeExtension,
  project: string,
) => {
  const name = extension.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    lbEdgeExtensionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    forwardingRules: extension.forwardingRules ?? [],
    extensionChains: (extension.extensionChains ?? []).map(toChain),
    loadBalancingScheme: extension.loadBalancingScheme,
    description: extension.description,
    labels: userLabels(extension.labels),
    createTime: extension.createTime,
    updateTime: extension.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsLbEdgeExtensions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const LbEdgeExtensionProvider = () =>
  Provider.succeed(LbEdgeExtension, {
    stables: ["name", "lbEdgeExtensionId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.lbEdgeExtensionId ?? output?.lbEdgeExtensionId;
      const nextId = news.lbEdgeExtensionId
        ? rfc1035(news.lbEdgeExtensionId, "lb-edge-extension")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
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
      const lbEdgeExtensionId = yield* toPhysicalId(
        id,
        olds?.lbEdgeExtensionId,
        output?.lbEdgeExtensionId,
        "lb-edge-extension",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, lbEdgeExtensionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkservices.listProjectsLocationsLbEdgeExtensions.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.lbEdgeExtensions,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const lbEdgeExtensionId = yield* toPhysicalId(
        id,
        news.lbEdgeExtensionId,
        output?.lbEdgeExtensionId,
        "lb-edge-extension",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        lbEdgeExtensionId,
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
          .createProjectsLocationsLbEdgeExtensions({
            parent: parentOf(env.project, location),
            lbEdgeExtensionId,
            body: {
              labels: desiredLabels,
              description: news.description,
              forwardingRules: desiredRules,
              extensionChains: desiredChains,
              loadBalancingScheme,
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

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["forwardingRules", rulesChanged],
        ["extensionChains", chainsChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsLbEdgeExtensions({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              forwardingRules: desiredRules,
              extensionChains: desiredChains,
              loadBalancingScheme,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsLbEdgeExtensions({ name: output.name })
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
