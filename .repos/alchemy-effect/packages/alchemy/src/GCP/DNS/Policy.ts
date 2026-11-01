import * as dns from "@distilled.cloud/gcp/dns_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;

export type PolicyAlternativeNameServer = {
  /**
   * IPv4 address of the target name server.
   */
  ipv4Address?: string;
  /**
   * IPv6 address of the target name server. Mutually exclusive with
   * `ipv4Address`.
   */
  ipv6Address?: string;
  /**
   * Forwarding path. `default` uses address ranges (RFC1918 via the VPC,
   * public via the internet). `private` always sends queries through the
   * VPC.
   */
  forwardingPath?:
    | dns.PolicyAlternativeNameServerConfigTargetNameServerForwardingPathEnum
    | (string & {});
};

export type PolicyProps = {
  /**
   * User-assigned policy name, unique within the project. If omitted, a
   * unique RFC1035 name is generated from the stack, stage, and logical
   * id. Must be 1-63 characters, begin with a letter, end with a letter
   * or digit, and contain only lowercase letters, digits, or dashes.
   * Immutable — changing it replaces the policy.
   */
  policyName?: string;
  /**
   * Human-readable description (max 1024 characters). DNS policies have
   * no labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Allow on-premises resolvers to query Cloud DNS using inbound
   * forwarding VIPs allocated from each bound subnet.
   * @default false
   */
  enableInboundForwarding?: boolean;
  /**
   * Enable Cloud DNS query logging for bound networks.
   * @default false
   */
  enableLogging?: boolean;
  /**
   * VPC networks this policy applies to. Each value may be a network
   * name, a `projects/.../global/networks/...` path, or a full compute
   * URL. A network may belong to at most one DNS server policy. Updates
   * in place.
   */
  networks?: string[];
  /**
   * Outbound forwarding targets. When set, all DNS queries from bound
   * networks are forwarded to these name servers (Cloud DNS private
   * zones such as `.internal` are not consulted).
   */
  alternativeNameServers?: PolicyAlternativeNameServer[];
  /**
   * Enable DNS64 (`dns64Config.scope.allQueries`) for bound networks.
   * @default false
   */
  enableDns64?: boolean;
};

export type Policy = Resource<
  "GCP.DNS.Policy",
  PolicyProps,
  {
    /** User-assigned policy name. */
    policyName: string;
    /** Project id. */
    project: string;
    /** Server-assigned numeric id. */
    id: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Whether inbound forwarding is enabled. */
    enableInboundForwarding: boolean;
    /** Whether query logging is enabled. */
    enableLogging: boolean;
    /** VPC network URLs bound to this policy. */
    networks: ReadonlyArray<string>;
    /** Outbound forwarding targets. */
    alternativeNameServers: ReadonlyArray<PolicyAlternativeNameServer>;
    /** Whether DNS64 is enabled for all queries. */
    enableDns64: boolean;
    /** Server-reported kind (`dns#policy`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud DNS server policy applied to one or more VPC networks.
 *
 * A policy controls inbound DNS forwarding, outbound forwarding to
 * alternative name servers, query logging, and DNS64. Name is identity
 * — changing it replaces the policy. A VPC network can belong to at
 * most one server policy.
 *
 * DNS policies have no labels. Alchemy stamps
 * `alchemy-stack` / `alchemy-stage` / `alchemy-id` into the description
 * so `list` and `pnpm nuke:gcp` can identify owned policies.
 *
 * ### Creating a Policy
 * **Example:** Generated name, logging enabled
 * ```typescript
 * const vpc = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const policy = yield* GCP.DNS.Policy("CorpDns", {
 *   enableLogging: true,
 *   networks: [vpc.networkName],
 * });
 * ```
 *
 * **Example:** Explicit name, inbound forwarding, and description
 * ```typescript
 * const policy = yield* GCP.DNS.Policy("CorpDns", {
 *   policyName: "corp-dns",
 *   description: "inbound resolver for on-prem",
 *   enableInboundForwarding: true,
 *   enableLogging: true,
 *   networks: ["app-vpc"],
 * });
 * ```
 *
 * ### Outbound Forwarding
 * **Example:** Forward all queries to on-prem name servers
 * ```typescript
 * const policy = yield* GCP.DNS.Policy("Forward", {
 *   networks: ["app-vpc"],
 *   alternativeNameServers: [{ ipv4Address: "192.0.2.53" }],
 * });
 * ```
 *
 * @resource
 * @category DNS
 */
export const Policy = Resource<Policy>("GCP.DNS.Policy");

export class PolicyNotResolved extends Data.TaggedError(
  "GCP.DNS.PolicyNotResolved",
)<{
  policyName: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const toNetworkUrl = (project: string, network: string) => {
  if (network.startsWith("https://") || network.startsWith("http://")) {
    return network;
  }
  if (network.includes("/")) {
    const path = network.replace(/^\//, "");
    return path.startsWith("compute/")
      ? `https://www.googleapis.com/${path}`
      : `https://www.googleapis.com/compute/v1/${path}`;
  }
  return `https://www.googleapis.com/compute/v1/projects/${project}/global/networks/${network}`;
};

const desiredNetworks = (project: string, networks: string[] | undefined) =>
  [
    ...new Set(
      (networks ?? []).map((network) => toNetworkUrl(project, network)),
    ),
  ].sort((left, right) => lastSegment(left).localeCompare(lastSegment(right)));

const observedNetworks = (policy: dns.Policy) =>
  (policy.networks ?? [])
    .map((network) => network.networkUrl ?? "")
    .filter((url) => url.length > 0)
    .sort((left, right) => lastSegment(left).localeCompare(lastSegment(right)));

const sameNetworks = (left: string[], right: string[]) =>
  left.length === right.length &&
  left.every(
    (url, index) => lastSegment(url) === lastSegment(right[index] ?? ""),
  );

const desiredNameServers = (
  servers: PolicyAlternativeNameServer[] | undefined,
): PolicyAlternativeNameServer[] =>
  (servers ?? []).map((server) => ({
    ipv4Address: server.ipv4Address,
    ipv6Address: server.ipv6Address,
    forwardingPath: server.forwardingPath,
  }));

const observedNameServers = (
  policy: dns.Policy,
): PolicyAlternativeNameServer[] =>
  (policy.alternativeNameServerConfig?.targetNameServers ?? []).map(
    (server) => ({
      ipv4Address: server.ipv4Address,
      ipv6Address: server.ipv6Address,
      forwardingPath: server.forwardingPath,
    }),
  );

const sameNameServers = (
  left: PolicyAlternativeNameServer[],
  right: PolicyAlternativeNameServer[],
) => JSON.stringify(left) === JSON.stringify(right);

const encodeDescription = (
  internal: Record<string, string>,
  user?: string,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${internal[alchemyLabelKeys.stack] ?? ""} ${alchemyLabelKeys.stage}=${internal[alchemyLabelKeys.stage] ?? ""} ${alchemyLabelKeys.id}=${internal[alchemyLabelKeys.id] ?? ""}]`;
  return user && user.length > 0 ? `${marker}\n${user}` : marker;
};

const parseDescription = (description: string | undefined) => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {} as Record<string, string>, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {} as Record<string, string>, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return {
    labels,
    description: rest.length > 0 ? rest : undefined,
  };
};

const hasAlchemyMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toPolicyName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    const rfc = generated
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^[^a-z]+/, "p")
      .slice(0, MAX_NAME_LENGTH)
      .replace(/-+$/g, "");
    return rfc.length > 0 ? rfc : "p";
  });

const toAttrs = (policy: dns.Policy, project: string) => ({
  policyName: policy.name ?? "",
  project,
  id: policy.id,
  description: parseDescription(policy.description).description,
  enableInboundForwarding: policy.enableInboundForwarding === true,
  enableLogging: policy.enableLogging === true,
  networks: observedNetworks(policy),
  alternativeNameServers: observedNameServers(policy),
  enableDns64: policy.dns64Config?.scope?.allQueries === true,
  kind: policy.kind,
});

const getByName = (project: string, policyName: string) =>
  dns
    .getPolicies({ project, policy: policyName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const alternativeNameServerConfig = (
  servers: PolicyAlternativeNameServer[],
): dns.PolicyAlternativeNameServerConfig | undefined =>
  servers.length === 0
    ? undefined
    : {
        targetNameServers: servers.map((server) => ({
          ipv4Address: server.ipv4Address,
          ipv6Address: server.ipv6Address,
          forwardingPath: server.forwardingPath,
        })),
      };

const dns64Config = (enable: boolean): dns.PolicyDns64Config | undefined =>
  enable ? { scope: { allQueries: true } } : undefined;

export const PolicyProvider = () =>
  Provider.succeed(Policy, {
    stables: ["policyName", "project", "id"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.policyName ?? output?.policyName;
      const nextName = news.policyName ?? previousName;
      if (
        previousName === undefined ||
        nextName === undefined ||
        nextName === previousName
      ) {
        return undefined;
      }
      // A VPC may belong to only one server policy, so the old policy
      // must be deleted (and its networks unbound) before the new one
      // can attach to the same network.
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const policyName = yield* toPolicyName(
        id,
        olds?.policyName,
        output?.policyName,
      );
      const existing = yield* getByName(env.project, policyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, parsed.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: ReturnType<typeof toAttrs>[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* dns.listPolicies({
            project: env.project,
            maxResults: 1000,
            pageToken,
          });
          for (const policy of response.policies ?? []) {
            if (hasAlchemyMarker(policy.description)) {
              found.push(toAttrs(policy, env.project));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const policyName = yield* toPolicyName(
        id,
        news.policyName,
        output?.policyName,
      );
      const enableInboundForwarding = news.enableInboundForwarding === true;
      const enableLogging = news.enableLogging === true;
      const enableDns64 = news.enableDns64 === true;
      const networks = desiredNetworks(env.project, news.networks);
      const nameServers = desiredNameServers(news.alternativeNameServers);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(env.project, policyName);

      if (current === undefined) {
        const created = yield* dns
          .createPolicies({
            project: env.project,
            body: {
              name: policyName,
              description: desiredDescription,
              enableInboundForwarding,
              enableLogging,
              networks: networks.map((networkUrl) => ({ networkUrl })),
              alternativeNameServerConfig:
                alternativeNameServerConfig(nameServers),
              dns64Config: dns64Config(enableDns64),
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(env.project, policyName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PolicyNotResolved({ policyName });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const inboundChanged =
        (current.enableInboundForwarding === true) !== enableInboundForwarding;
      const loggingChanged = (current.enableLogging === true) !== enableLogging;
      const dns64Changed =
        (current.dns64Config?.scope?.allQueries === true) !== enableDns64;
      const networksChanged = !sameNetworks(
        observedNetworks(current),
        networks,
      );
      const nameServersChanged = !sameNameServers(
        observedNameServers(current),
        nameServers,
      );

      if (
        descriptionChanged ||
        inboundChanged ||
        loggingChanged ||
        dns64Changed ||
        networksChanged ||
        nameServersChanged
      ) {
        const body: dns.Policy = {};
        if (descriptionChanged) body.description = desiredDescription;
        if (inboundChanged) {
          body.enableInboundForwarding = enableInboundForwarding;
        }
        if (loggingChanged) body.enableLogging = enableLogging;
        if (dns64Changed) {
          body.dns64Config = enableDns64
            ? { scope: { allQueries: true } }
            : { scope: { allQueries: false } };
        }
        if (networksChanged) {
          body.networks = networks.map((networkUrl) => ({ networkUrl }));
        }
        if (nameServersChanged) {
          body.alternativeNameServerConfig = {
            targetNameServers: nameServers.map((server) => ({
              ipv4Address: server.ipv4Address,
              ipv6Address: server.ipv6Address,
              forwardingPath: server.forwardingPath,
            })),
          };
        }
        const patched = yield* dns.patchPolicies({
          project: env.project,
          policy: policyName,
          body,
        });
        current =
          patched.policy ??
          (yield* getByName(env.project, policyName)) ??
          current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const project = output.project;
      const policyName = output.policyName;
      const detach = dns
        .patchPolicies({
          project,
          policy: policyName,
          body: {
            enableInboundForwarding: false,
            networks: [],
          },
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      const attempt = dns
        .deletePolicies({ project, policy: policyName })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* detach.pipe(Effect.andThen(attempt)).pipe(
        Effect.catchIf(
          (error) => error._tag === "Conflict" || error._tag === "BadRequest",
          () => detach.pipe(Effect.andThen(attempt)),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "Conflict" || error._tag === "BadRequest",
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
      );
    }),
  });
