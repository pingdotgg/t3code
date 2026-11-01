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

const COLLECTION = "endpointPolicies";
const DEFAULT_TYPE = "SIDECAR_PROXY";

export type EndpointPolicyType =
  | networkservices.EndpointPolicyTypeEnum
  | (string & {});

export type EndpointPolicyMetadataLabel = {
  /** Label name presented as a key in xDS node metadata. */
  labelName?: string;
  /** Label value presented as the matching value. */
  labelValue?: string;
};

export type EndpointPolicyMetadataLabelMatcher = {
  /**
   * How labels are combined. `MATCH_ANY` matches if any listed label is
   * present; `MATCH_ALL` requires every listed label.
   */
  metadataLabelMatchCriteria?: string;
  /**
   * Label pairs that must match xDS node metadata. At most 64 entries.
   * Empty with `MATCH_ANY` is a wildcard.
   */
  metadataLabels?: EndpointPolicyMetadataLabel[];
};

export type EndpointPolicyEndpointMatcher = {
  /** Matcher based on xDS client node metadata. */
  metadataLabelMatcher?: EndpointPolicyMetadataLabelMatcher;
};

export type EndpointPolicyTrafficPortSelector = {
  /**
   * Ports, ranges (`80-90`), named ports, or `*` for all ports. Empty
   * selects every port.
   */
  ports?: string[];
};

export type EndpointPolicyProps = {
  /**
   * EndpointPolicy id (the `{endpointPolicy}` segment of
   * `projects/{project}/locations/{location}/endpointPolicies/{endpointPolicy}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the policy.
   */
  endpointPolicyId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Endpoint policy type. Used to validate configuration.
   * @default "SIDECAR_PROXY"
   */
  type?: EndpointPolicyType;
  /**
   * Matcher that selects endpoints this policy applies to.
   */
  endpointMatcher?: EndpointPolicyEndpointMatcher;
  /**
   * Port selector for matched endpoints. Omitted applies to every port.
   */
  trafficPortSelector?: EndpointPolicyTrafficPortSelector;
  /**
   * AuthorizationPolicy resource URL applied to inbound traffic. Empty
   * disables authorization.
   */
  authorizationPolicy?: string;
  /**
   * ServerTlsPolicy URL used to terminate inbound TLS. Empty leaves the
   * endpoint open.
   */
  serverTlsPolicy?: string;
  /**
   * ClientTlsPolicy URL applied to traffic from the sidecar proxy to the
   * backend. Applicable only when `type` is `SIDECAR_PROXY`.
   */
  clientTlsPolicy?: string;
  /**
   * Human-readable description. Max length 1024 characters.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type EndpointPolicy = Resource<
  "GCP.NetworkServices.EndpointPolicy",
  EndpointPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/endpointPolicies/{endpointPolicy}`. */
    name: string;
    /** EndpointPolicy id (last path segment). */
    endpointPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** Endpoint policy type. */
    type: string;
    /** Matcher currently configured. */
    endpointMatcher: EndpointPolicyEndpointMatcher | undefined;
    /** Port selector currently configured. */
    trafficPortSelector: EndpointPolicyTrafficPortSelector | undefined;
    /** AuthorizationPolicy URL, if set. */
    authorizationPolicy: string | undefined;
    /** ServerTlsPolicy URL, if set. */
    serverTlsPolicy: string | undefined;
    /** ClientTlsPolicy URL, if set. */
    clientTlsPolicy: string | undefined;
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
 * A Network Services EndpointPolicy — applies TLS and authorization
 * configuration to Traffic Director endpoints that match a metadata
 * selector.
 *
 * Changing `endpointPolicyId`, `location`, or `type` replaces the
 * policy. Description, labels, matcher, port selector, and policy URLs
 * update in place.
 *
 * ### Creating an EndpointPolicy
 * **Example:** Sidecar proxy with a metadata matcher
 * ```typescript
 * const policy = yield* GCP.NetworkServices.EndpointPolicy("Sidecar", {
 *   type: "SIDECAR_PROXY",
 *   endpointMatcher: {
 *     metadataLabelMatcher: {
 *       metadataLabelMatchCriteria: "MATCH_ANY",
 *       metadataLabels: [{ labelName: "app", labelValue: "web" }],
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Named policy with a port selector
 * ```typescript
 * const policy = yield* GCP.NetworkServices.EndpointPolicy("Sidecar", {
 *   endpointPolicyId: "app-sidecar",
 *   description: "prod sidecars",
 *   labels: { env: "prod" },
 *   type: "SIDECAR_PROXY",
 *   trafficPortSelector: { ports: ["8080"] },
 *   endpointMatcher: {
 *     metadataLabelMatcher: {
 *       metadataLabelMatchCriteria: "MATCH_ANY",
 *       metadataLabels: [{ labelName: "app", labelValue: "web" }],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const EndpointPolicy = Resource<EndpointPolicy>(
  "GCP.NetworkServices.EndpointPolicy",
);

const toLabel = (
  label:
    | EndpointPolicyMetadataLabel
    | networkservices.EndpointMatcherMetadataLabelMatcherMetadataLabels,
): EndpointPolicyMetadataLabel => ({
  labelName: label.labelName,
  labelValue: label.labelValue,
});

const toMatcher = (
  matcher:
    | EndpointPolicyEndpointMatcher
    | networkservices.EndpointMatcher
    | undefined,
): EndpointPolicyEndpointMatcher | undefined => {
  const metadata = matcher?.metadataLabelMatcher;
  if (metadata === undefined) return undefined;
  return {
    metadataLabelMatcher: {
      metadataLabelMatchCriteria: metadata.metadataLabelMatchCriteria,
      metadataLabels: (metadata.metadataLabels ?? []).map(toLabel),
    },
  };
};

const toPortSelector = (
  selector:
    | EndpointPolicyTrafficPortSelector
    | networkservices.TrafficPortSelector
    | undefined,
): EndpointPolicyTrafficPortSelector | undefined => {
  if (selector === undefined) return undefined;
  return { ports: selector.ports ?? [] };
};

const toAttrs = (policy: networkservices.EndpointPolicy, project: string) => {
  const name = policy.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    endpointPolicyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    type: policy.type ?? DEFAULT_TYPE,
    endpointMatcher: toMatcher(policy.endpointMatcher),
    trafficPortSelector: toPortSelector(policy.trafficPortSelector),
    authorizationPolicy: policy.authorizationPolicy,
    serverTlsPolicy: policy.serverTlsPolicy,
    clientTlsPolicy: policy.clientTlsPolicy,
    description: policy.description,
    labels: userLabels(policy.labels),
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsEndpointPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const EndpointPolicyProvider = () =>
  Provider.succeed(EndpointPolicy, {
    stables: ["name", "endpointPolicyId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.endpointPolicyId ?? output?.endpointPolicyId;
      const nextId = news.endpointPolicyId
        ? rfc1035(news.endpointPolicyId, "endpoint-policy")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const previousType = olds?.type ?? output?.type ?? DEFAULT_TYPE;
      const nextType = news.type ?? previousType;
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousType !== nextType
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const endpointPolicyId = yield* toPhysicalId(
        id,
        olds?.endpointPolicyId,
        output?.endpointPolicyId,
        "endpoint-policy",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, endpointPolicyId);
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
          networkservices.listProjectsLocationsEndpointPolicies.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
            returnPartialSuccess: true,
          }),
          (page) => page.endpointPolicies,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const endpointPolicyId = yield* toPhysicalId(
        id,
        news.endpointPolicyId,
        output?.endpointPolicyId,
        "endpoint-policy",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        endpointPolicyId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const type = news.type ?? DEFAULT_TYPE;
      const desiredMatcher = toMatcher(news.endpointMatcher);
      const desiredPorts = toPortSelector(news.trafficPortSelector);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsEndpointPolicies({
            parent: parentOf(env.project, location),
            endpointPolicyId,
            body: {
              type,
              labels: desiredLabels,
              description: news.description,
              endpointMatcher: desiredMatcher,
              trafficPortSelector: desiredPorts,
              authorizationPolicy: news.authorizationPolicy,
              serverTlsPolicy: news.serverTlsPolicy,
              clientTlsPolicy: news.clientTlsPolicy,
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
      const matcherChanged = !sameJson(
        toMatcher(current.endpointMatcher),
        desiredMatcher,
      );
      const portsChanged = !sameStringList(
        current.trafficPortSelector?.ports,
        desiredPorts?.ports,
      );
      const authzChanged =
        (current.authorizationPolicy ?? "") !==
        (news.authorizationPolicy ?? "");
      const serverTlsChanged =
        (current.serverTlsPolicy ?? "") !== (news.serverTlsPolicy ?? "");
      const clientTlsChanged =
        (current.clientTlsPolicy ?? "") !== (news.clientTlsPolicy ?? "");

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["endpointMatcher", matcherChanged],
        ["trafficPortSelector", portsChanged],
        ["authorizationPolicy", authzChanged],
        ["serverTlsPolicy", serverTlsChanged],
        ["clientTlsPolicy", clientTlsChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsEndpointPolicies({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              type,
              labels: desiredLabels,
              description: news.description,
              endpointMatcher: desiredMatcher,
              trafficPortSelector: desiredPorts,
              authorizationPolicy: news.authorizationPolicy,
              serverTlsPolicy: news.serverTlsPolicy,
              clientTlsPolicy: news.clientTlsPolicy,
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
        .deleteProjectsLocationsEndpointPolicies({ name: output.name })
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
