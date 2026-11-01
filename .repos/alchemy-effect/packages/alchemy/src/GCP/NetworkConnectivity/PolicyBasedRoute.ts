import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./internal.ts";

const DEFAULT_LOCATION = "global";
const DEFAULT_PRIORITY = 1000;
const DEFAULT_IP_PROTOCOL = "ALL";
const MAX_NAME_LENGTH = 63;
const COMPUTE_SELF_LINK_PREFIX = /^https?:\/\/[^/]+\/compute\/v1\//;

export type PolicyBasedRouteProtocolVersion =
  | networkconnectivity.FilterProtocolVersionEnum
  | (string & {});

export type PolicyBasedRouteNextHopOtherRoutes =
  | networkconnectivity.PolicyBasedRouteNextHopOtherRoutesEnum
  | (string & {});

export type PolicyBasedRouteFilter = {
  /**
   * Internet protocol version this route matches (`IPV4` or `IPV6`).
   */
  protocolVersion: PolicyBasedRouteProtocolVersion;
  /**
   * L4 protocol this route matches (`TCP`, `UDP`, or `ALL`).
   * @default "ALL"
   */
  ipProtocol?: string;
  /**
   * Source CIDR of matching packets. Defaults to `0.0.0.0/0` for IPv4
   * and `::/0` for IPv6.
   */
  srcRange?: string;
  /**
   * Destination CIDR of matching packets. Defaults to `0.0.0.0/0` for
   * IPv4 and `::/0` for IPv6.
   */
  destRange?: string;
};

export type PolicyBasedRouteVirtualMachine = {
  /**
   * VM network tags this route installs on. A VM matching ANY tag
   * receives the route.
   */
  tags: string[];
};

export type PolicyBasedRouteInterconnectAttachment = {
  /**
   * Region of interconnect attachments this route applies to. Use
   * `"all"` to install it on every attachment.
   */
  region: string;
};

export type PolicyBasedRouteWarning = {
  /** Server warning code (`RESOURCE_NOT_ACTIVE`, …). */
  code: string | undefined;
  /** Human-readable warning. */
  warningMessage: string | undefined;
};

export type PolicyBasedRouteProps = {
  /**
   * Policy-based route id (the `{policyBasedRoute}` segment of
   * `projects/{project}/locations/global/policyBasedRoutes/{policyBasedRoute}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters and match
   * `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces the
   * route.
   */
  policyBasedRouteId?: string;
  /**
   * VPC network this route applies to. Accepts a name (`default`), a
   * resource path (`projects/{project}/global/networks/{network}`), or a
   * Compute self-link. Immutable — changing it replaces the route.
   */
  network: string;
  /**
   * L4 match filter. Immutable — changing it replaces the route.
   */
  filter: PolicyBasedRouteFilter;
  /**
   * IP address of a global-access-enabled internal L4 load balancer used
   * as the next hop. Exactly one of `nextHopIlbIp` or
   * `nextHopOtherRoutes` must be set. Immutable — changing it replaces
   * the route.
   */
  nextHopIlbIp?: string;
  /**
   * Other routes consulted for the next hop. `DEFAULT_ROUTING` skips
   * remaining policy-based routes and uses the VPC routing tables.
   * Exactly one of `nextHopIlbIp` or `nextHopOtherRoutes` must be set.
   * Immutable — changing it replaces the route.
   */
  nextHopOtherRoutes?: PolicyBasedRouteNextHopOtherRoutes;
  /**
   * VM instances this route applies to, selected by network tags. Omit
   * together with `interconnectAttachment` to install on every endpoint
   * in the VPC. Immutable — changing it replaces the route.
   */
  virtualMachine?: PolicyBasedRouteVirtualMachine;
  /**
   * Interconnect attachments this route applies to. Mutually exclusive
   * with `virtualMachine`. Immutable — changing it replaces the route.
   */
  interconnectAttachment?: PolicyBasedRouteInterconnectAttachment;
  /**
   * Priority used to break ties among matching policy-based routes.
   * Lower wins. Range `1`–`65535`.
   * @default 1000
   */
  priority?: number;
  /**
   * Human-readable description. Immutable — changing it replaces the
   * route (the API has no update method).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Immutable — changing them replaces the route (the API has no update
   * method).
   */
  labels?: Record<string, string>;
};

export type PolicyBasedRoute = Resource<
  "GCP.NetworkConnectivity.PolicyBasedRoute",
  PolicyBasedRouteProps,
  {
    /**
     * Full resource name
     * `projects/{project}/locations/global/policyBasedRoutes/{policyBasedRoute}`.
     */
    name: string;
    /** Policy-based route id (last path segment). */
    policyBasedRouteId: string;
    /** Project id. */
    project: string;
    /** Location id. Policy-based routes are global — always `"global"`. */
    location: string;
    /** Fully-qualified VPC network path. */
    network: string;
    /** L4 match filter as stored by the API. */
    filter: PolicyBasedRouteFilter;
    /** Next-hop ILB IP, if set. */
    nextHopIlbIp: string | undefined;
    /** Next-hop other-routes enum, if set. */
    nextHopOtherRoutes: string | undefined;
    /** VM tag target, if set. */
    virtualMachine: PolicyBasedRouteVirtualMachine | undefined;
    /** Interconnect attachment target, if set. */
    interconnectAttachment: PolicyBasedRouteInterconnectAttachment | undefined;
    /** Route priority. */
    priority: number;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported configuration warnings. */
    warnings: PolicyBasedRouteWarning[];
    /** Server-defined fully-qualified URL. */
    selfLink: string | undefined;
    /** Resource kind (`networkconnectivity#policyBasedRoute`). */
    kind: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VPC policy-based route.
 *
 * Policy-based routes match L4 traffic by source, destination, and
 * protocol — not just destination IP — and always take precedence over
 * other route types. They live at `locations/global`. The API has create,
 * get, list, and delete only, so every user-facing field is immutable and
 * changing it replaces the resource.
 *
 * ### Creating a Policy-Based Route
 * **Example:** Skip other policy-based routes
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const route = yield* GCP.NetworkConnectivity.PolicyBasedRoute("Skip", {
 *   network: network.networkName,
 *   filter: { protocolVersion: "IPV4" },
 *   nextHopOtherRoutes: "DEFAULT_ROUTING",
 * });
 * ```
 *
 * **Example:** Named route with VM tags and an ILB next hop
 * ```typescript
 * const route = yield* GCP.NetworkConnectivity.PolicyBasedRoute("Inspect", {
 *   policyBasedRouteId: "app-inspect",
 *   network: network.networkName,
 *   filter: {
 *     protocolVersion: "IPV4",
 *     ipProtocol: "TCP",
 *     srcRange: "10.0.0.0/8",
 *     destRange: "0.0.0.0/0",
 *   },
 *   nextHopIlbIp: "10.10.10.20",
 *   virtualMachine: { tags: ["client"] },
 *   priority: 500,
 *   description: "send tagged VMs to the inspection ILB",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Interconnect attachments
 * **Example:** Apply to every VLAN attachment
 * ```typescript
 * const route = yield* GCP.NetworkConnectivity.PolicyBasedRoute("Vlan", {
 *   network: network.networkName,
 *   filter: { protocolVersion: "IPV4" },
 *   nextHopOtherRoutes: "DEFAULT_ROUTING",
 *   interconnectAttachment: { region: "all" },
 * });
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const PolicyBasedRoute = Resource<PolicyBasedRoute>(
  "GCP.NetworkConnectivity.PolicyBasedRoute",
);

export class PolicyBasedRouteNotResolved extends Data.TaggedError(
  "GCP.NetworkConnectivity.PolicyBasedRouteNotResolved",
)<{
  name: string;
}> {}

export class PolicyBasedRouteStillExists extends Data.TaggedError(
  "GCP.NetworkConnectivity.PolicyBasedRouteStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `p${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "policy-based-route";
};

const resourceName = (project: string, policyBasedRouteId: string) =>
  `projects/${project}/locations/${DEFAULT_LOCATION}/policyBasedRoutes/${policyBasedRouteId}`;

const parentOf = (project: string) =>
  `projects/${project}/locations/${DEFAULT_LOCATION}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const routesAt = parts.lastIndexOf("policyBasedRoutes");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    policyBasedRouteId:
      routesAt >= 0 && parts[routesAt + 1]
        ? parts[routesAt + 1]!
        : lastSegment(name),
  };
};

const toNetworkUrl = (project: string, network: string) => {
  const stripped = network
    .replace(COMPUTE_SELF_LINK_PREFIX, "")
    .replace(/^\/+/, "");
  const parts = stripped.split("/").filter((part) => part.length > 0);
  const name = parts[parts.length - 1] ?? stripped;
  const projectsAt = parts.lastIndexOf("projects");
  const owner =
    projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : project;
  return `projects/${owner}/global/networks/${name}`;
};

const sameRef = (left: string | undefined, right: string | undefined) =>
  lastSegment(left ?? "").toLowerCase() ===
  lastSegment(right ?? "").toLowerCase();

const protocolVersionOf = (filter: PolicyBasedRouteFilter | undefined) =>
  (filter?.protocolVersion ?? "IPV4").toUpperCase();

const defaultRangeOf = (filter: PolicyBasedRouteFilter | undefined) =>
  protocolVersionOf(filter) === "IPV6" ? "::/0" : "0.0.0.0/0";

const normalizeFilter = (filter: PolicyBasedRouteFilter | undefined) => {
  const fallback = defaultRangeOf(filter);
  return {
    protocolVersion: protocolVersionOf(filter),
    ipProtocol: (filter?.ipProtocol ?? DEFAULT_IP_PROTOCOL).toUpperCase(),
    srcRange: filter?.srcRange ?? fallback,
    destRange: filter?.destRange ?? fallback,
  };
};

const sameFilter = (
  left: PolicyBasedRouteFilter | undefined,
  right: PolicyBasedRouteFilter | undefined,
) => {
  const a = normalizeFilter(left);
  const b = normalizeFilter(right);
  return (
    a.protocolVersion === b.protocolVersion &&
    a.ipProtocol === b.ipProtocol &&
    a.srcRange === b.srcRange &&
    a.destRange === b.destRange
  );
};

const tagsKey = (tags: readonly string[] | undefined) =>
  [...(tags ?? [])]
    .map((tag) => tag.toLowerCase())
    .sort()
    .join("\0");

const sameVirtualMachine = (
  left: PolicyBasedRouteVirtualMachine | undefined,
  right: PolicyBasedRouteVirtualMachine | undefined,
) => tagsKey(left?.tags) === tagsKey(right?.tags);

const sameInterconnectAttachment = (
  left: PolicyBasedRouteInterconnectAttachment | undefined,
  right: PolicyBasedRouteInterconnectAttachment | undefined,
) => (left?.region ?? "").toLowerCase() === (right?.region ?? "").toLowerCase();

const labelsKey = (labels: Record<string, string> | undefined) =>
  Object.entries(toLabels(labels))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const labelsCovered = (
  observed: Record<string, string | undefined> | null | undefined,
  desired: Record<string, string>,
) => {
  const current = tagRecord(observed);
  return Object.entries(desired).every(
    ([key, value]) => current[key] === value,
  );
};

const toId = (
  id: string,
  policyBasedRouteId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (policyBasedRouteId !== undefined) return policyBasedRouteId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const toFilterAttr = (
  filter: networkconnectivity.Filter | undefined,
): PolicyBasedRouteFilter => ({
  protocolVersion: filter?.protocolVersion ?? "IPV4",
  ipProtocol: filter?.ipProtocol,
  srcRange: filter?.srcRange,
  destRange: filter?.destRange,
});

const toVirtualMachine = (
  virtualMachine: networkconnectivity.VirtualMachine | undefined,
): PolicyBasedRouteVirtualMachine | undefined => {
  if (virtualMachine === undefined) return undefined;
  return { tags: virtualMachine.tags ?? [] };
};

const toInterconnectAttachment = (
  interconnectAttachment:
    | networkconnectivity.InterconnectAttachment
    | undefined,
): PolicyBasedRouteInterconnectAttachment | undefined => {
  if (interconnectAttachment?.region === undefined) return undefined;
  return { region: interconnectAttachment.region };
};

const toWarnings = (
  warnings: networkconnectivity.WarningsList | undefined,
): PolicyBasedRouteWarning[] =>
  (warnings ?? []).map((warning) => ({
    code: warning.code,
    warningMessage: warning.warningMessage,
  }));

const toAttrs = (
  route: networkconnectivity.PolicyBasedRoute,
  project: string,
) => {
  const name = route.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    policyBasedRouteId: parsed.policyBasedRouteId,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    network: route.network ?? "",
    filter: toFilterAttr(route.filter),
    nextHopIlbIp: route.nextHopIlbIp,
    nextHopOtherRoutes: route.nextHopOtherRoutes,
    virtualMachine: toVirtualMachine(route.virtualMachine),
    interconnectAttachment: toInterconnectAttachment(
      route.interconnectAttachment,
    ),
    priority: route.priority ?? DEFAULT_PRIORITY,
    description: route.description,
    labels: userLabels(route.labels),
    warnings: toWarnings(route.warnings),
    selfLink: route.selfLink,
    kind: route.kind,
    createTime: route.createTime,
    updateTime: route.updateTime,
  };
};

const toBody = (
  project: string,
  news: PolicyBasedRouteProps,
  labels: Record<string, string>,
): networkconnectivity.PolicyBasedRoute => {
  const body: networkconnectivity.PolicyBasedRoute = {
    network: toNetworkUrl(project, news.network),
    filter: {
      protocolVersion: news.filter.protocolVersion,
      ipProtocol: news.filter.ipProtocol,
      srcRange: news.filter.srcRange,
      destRange: news.filter.destRange,
    },
    priority: news.priority ?? DEFAULT_PRIORITY,
    description: news.description,
    labels,
  };
  if (news.nextHopIlbIp !== undefined) {
    body.nextHopIlbIp = news.nextHopIlbIp;
  }
  if (news.nextHopOtherRoutes !== undefined) {
    body.nextHopOtherRoutes = news.nextHopOtherRoutes;
  }
  if (news.virtualMachine !== undefined) {
    body.virtualMachine = { tags: news.virtualMachine.tags };
  }
  if (news.interconnectAttachment !== undefined) {
    body.interconnectAttachment = {
      region: news.interconnectAttachment.region,
    };
  }
  return body;
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsGlobalPolicyBasedRoutes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((route) =>
      route
        ? Effect.succeed(route)
        : Effect.fail(new PolicyBasedRouteNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkConnectivity.PolicyBasedRouteNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((route) =>
      route === undefined
        ? Effect.void
        : Effect.fail(new PolicyBasedRouteStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkConnectivity.PolicyBasedRouteStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const removeRoute = (name: string) =>
  Effect.gen(function* () {
    const operation = yield* networkconnectivity
      .deleteProjectsLocationsGlobalPolicyBasedRoutes({ name })
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
    yield* waitUntilGone(name);
  });

const listOwnedRoutes = (project: string) =>
  networkconnectivity.listProjectsLocationsGlobalPolicyBasedRoutes
    .pages({
      parent: parentOf(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.policyBasedRoutes ?? []),
      ),
      Stream.filter((route) =>
        Object.keys(route.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((route) => toAttrs(route, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const matchesDesired = (
  route: networkconnectivity.PolicyBasedRoute,
  project: string,
  news: PolicyBasedRouteProps,
  desiredLabels: Record<string, string>,
) => {
  if (!sameRef(route.network, toNetworkUrl(project, news.network))) {
    return false;
  }
  if (!sameFilter(toFilterAttr(route.filter), news.filter)) {
    return false;
  }
  if ((route.nextHopIlbIp ?? "") !== (news.nextHopIlbIp ?? "")) {
    return false;
  }
  if ((route.nextHopOtherRoutes ?? "") !== (news.nextHopOtherRoutes ?? "")) {
    return false;
  }
  if (
    !sameVirtualMachine(
      toVirtualMachine(route.virtualMachine),
      news.virtualMachine,
    )
  ) {
    return false;
  }
  if (
    !sameInterconnectAttachment(
      toInterconnectAttachment(route.interconnectAttachment),
      news.interconnectAttachment,
    )
  ) {
    return false;
  }
  if (
    (route.priority ?? DEFAULT_PRIORITY) !== (news.priority ?? DEFAULT_PRIORITY)
  ) {
    return false;
  }
  if ((route.description ?? "") !== (news.description ?? "")) {
    return false;
  }
  return labelsCovered(route.labels, desiredLabels);
};

const immutableChanged = (
  news: PolicyBasedRouteProps,
  olds: Partial<PolicyBasedRouteProps> | undefined,
  output: PolicyBasedRoute["Attributes"] | undefined,
) => {
  const previousNetwork = olds?.network ?? output?.network;
  if (
    previousNetwork !== undefined &&
    !sameRef(news.network, previousNetwork)
  ) {
    return true;
  }
  const previousFilter = olds?.filter ?? output?.filter;
  if (
    previousFilter !== undefined &&
    !sameFilter(news.filter, previousFilter)
  ) {
    return true;
  }
  const previousIlb = olds?.nextHopIlbIp ?? output?.nextHopIlbIp ?? "";
  if ((news.nextHopIlbIp ?? "") !== previousIlb) {
    return true;
  }
  const previousOther =
    olds?.nextHopOtherRoutes ?? output?.nextHopOtherRoutes ?? "";
  if ((news.nextHopOtherRoutes ?? "") !== previousOther) {
    return true;
  }
  if (
    !sameVirtualMachine(
      news.virtualMachine,
      olds?.virtualMachine ?? output?.virtualMachine,
    )
  ) {
    return true;
  }
  if (
    !sameInterconnectAttachment(
      news.interconnectAttachment,
      olds?.interconnectAttachment ?? output?.interconnectAttachment,
    )
  ) {
    return true;
  }
  const previousPriority =
    olds?.priority ?? output?.priority ?? DEFAULT_PRIORITY;
  if ((news.priority ?? DEFAULT_PRIORITY) !== previousPriority) {
    return true;
  }
  const previousDescription = olds?.description ?? output?.description ?? "";
  if ((news.description ?? "") !== previousDescription) {
    return true;
  }
  if (labelsKey(news.labels) !== labelsKey(olds?.labels ?? output?.labels)) {
    return true;
  }
  return false;
};

export const PolicyBasedRouteProvider = () =>
  Provider.succeed(PolicyBasedRoute, {
    stables: [
      "name",
      "policyBasedRouteId",
      "project",
      "location",
      "createTime",
      "selfLink",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.policyBasedRouteId ?? output?.policyBasedRouteId;
      const nextId = news.policyBasedRouteId ?? previousId;
      if (previousId === undefined && output === undefined) {
        return undefined;
      }
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;
      if (idChanged || immutableChanged(news, olds, output)) {
        return {
          action: "replace" as const,
          deleteFirst: nextId !== undefined && nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const policyBasedRouteId = yield* toId(
        id,
        olds?.policyBasedRouteId,
        output?.policyBasedRouteId,
      );
      const name =
        output?.name ?? resourceName(env.project, policyBasedRouteId);
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
        return yield* listOwnedRoutes(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const policyBasedRouteId = yield* toId(
        id,
        news.policyBasedRouteId,
        output?.policyBasedRouteId,
      );
      const name =
        output?.name ?? resourceName(env.project, policyBasedRouteId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (
        current !== undefined &&
        !matchesDesired(current, env.project, news, desiredLabels)
      ) {
        yield* removeRoute(current.name ?? name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsGlobalPolicyBasedRoutes({
            parent: parentOf(env.project),
            policyBasedRouteId,
            body: toBody(env.project, news, desiredLabels),
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
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new PolicyBasedRouteNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* removeRoute(output.name);
    }),
  });
