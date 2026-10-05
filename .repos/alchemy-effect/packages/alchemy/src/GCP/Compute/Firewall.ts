import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export interface FirewallRule {
  /**
   * IP protocol this rule matches. One of `tcp`, `udp`, `icmp`, `esp`,
   * `ah`, `ipip`, `sctp`, or an IP protocol number.
   */
  protocol: string;
  /**
   * Destination ports or ranges (e.g. `"22"`, `"80"`, `"8000-8080"`).
   * Only valid for `tcp` and `udp`. Omit to match every port.
   */
  ports?: string[];
}

export interface FirewallLogConfig {
  /**
   * Whether to export logs for this rule to Cloud Logging.
   * @default false
   */
  enable?: boolean;
  /**
   * Whether log entries include metadata. Only set when `enable` is true.
   */
  metadata?: "EXCLUDE_ALL_METADATA" | "INCLUDE_ALL_METADATA";
}

export type FirewallProps = {
  /**
   * Firewall name. If omitted, a unique RFC1035 name is generated from the
   * stack, stage, and logical id. Must be 1-63 characters and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Changing the name replaces the rule.
   */
  firewallName?: string;
  /**
   * VPC network the rule belongs to. Accepts a name (`default`), a partial
   * URL (`global/networks/default`), or a full URL. Immutable — changing it
   * replaces the rule.
   * @default "global/networks/default"
   */
  network?: string;
  /**
   * Human-readable description. Alchemy ownership markers are stored in
   * this field (Compute firewalls have no labels) and stripped from
   * attributes.
   */
  description?: string;
  /**
   * Priority in `[0, 65535]`. Lower values take precedence. DENY wins
   * over ALLOW at the same priority.
   * @default 1000
   */
  priority?: number;
  /**
   * Traffic direction. Immutable — changing it replaces the rule.
   * @default "INGRESS"
   */
  direction?: "INGRESS" | "EGRESS";
  /**
   * When true, the rule exists but is not enforced.
   * @default false
   */
  disabled?: boolean;
  /**
   * ALLOW match conditions. A rule must specify `allowed` or `denied`,
   * not both. Switching action replaces the rule.
   */
  allowed?: FirewallRule[];
  /**
   * DENY match conditions. A rule must specify `allowed` or `denied`,
   * not both. Switching action replaces the rule.
   */
  denied?: FirewallRule[];
  /**
   * Source CIDR ranges. For INGRESS, omit together with `sourceTags` and
   * `sourceServiceAccounts` to match `0.0.0.0/0`.
   */
  sourceRanges?: string[];
  /**
   * Destination CIDR ranges.
   */
  destinationRanges?: string[];
  /**
   * Source network tags (INGRESS). Cannot be combined with service-account
   * targeting.
   */
  sourceTags?: string[];
  /**
   * Target network tags. If omitted, the rule applies to every instance on
   * the network.
   */
  targetTags?: string[];
  /**
   * Source service accounts (INGRESS). Cannot be combined with network tags.
   */
  sourceServiceAccounts?: string[];
  /**
   * Target service accounts. Cannot be combined with network tags.
   */
  targetServiceAccounts?: string[];
  /**
   * Firewall Rules Logging options.
   */
  logConfig?: FirewallLogConfig;
};

export type Firewall = Resource<
  "GCP.Compute.Firewall",
  FirewallProps,
  {
    /** Firewall name. */
    firewallName: string;
    /** Project id. */
    project: string;
    /** Network URL. */
    network: string;
    /** User description (ownership marker stripped). */
    description: string | undefined;
    /** Priority. */
    priority: number;
    /** `INGRESS` or `EGRESS`. */
    direction: string;
    /** Whether the rule is not enforced. */
    disabled: boolean;
    /** ALLOW match conditions. */
    allowed: FirewallRule[];
    /** DENY match conditions. */
    denied: FirewallRule[];
    /** Source CIDR ranges. */
    sourceRanges: string[];
    /** Destination CIDR ranges. */
    destinationRanges: string[];
    /** Source network tags. */
    sourceTags: string[];
    /** Target network tags. */
    targetTags: string[];
    /** Source service accounts. */
    sourceServiceAccounts: string[];
    /** Target service accounts. */
    targetServiceAccounts: string[];
    /** Logging options, if enabled. */
    logConfig: FirewallLogConfig | undefined;
    /** Server-assigned numeric id. */
    id: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VPC firewall rule that allows or denies ingress/egress traffic for
 * instances on a network.
 *
 * Compute Engine firewalls have no resource labels. Alchemy stamps
 * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) into the
 * description so `read` and `list` (and `pnpm nuke:gcp`) can find them.
 *
 * Name, network, direction, and allow-vs-deny are immutable — changing any
 * of them replaces the rule.
 *
 * ### Creating a Firewall
 * **Example:** Generated name, HTTP from a private range
 * ```typescript
 * const http = yield* GCP.Compute.Firewall("AllowHttp", {
 *   allowed: [{ protocol: "tcp", ports: ["80"] }],
 *   sourceRanges: ["10.0.0.0/8"],
 *   targetTags: ["web"],
 * });
 * ```
 *
 * **Example:** Explicit name, HTTPS deny, logging
 * ```typescript
 * const deny = yield* GCP.Compute.Firewall("DenyHttps", {
 *   firewallName: "deny-https-egress",
 *   direction: "EGRESS",
 *   denied: [{ protocol: "tcp", ports: ["443"] }],
 *   destinationRanges: ["0.0.0.0/0"],
 *   priority: 800,
 *   logConfig: { enable: true, metadata: "INCLUDE_ALL_METADATA" },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Firewall = Resource<Firewall>("GCP.Compute.Firewall");

export class FirewallNotResolved extends Data.TaggedError(
  "GCP.Compute.FirewallNotResolved",
)<{
  firewallName: string;
}> {}

const DEFAULT_NETWORK = "global/networks/default";
const DEFAULT_DIRECTION = "INGRESS";
const DEFAULT_PRIORITY = 1000;
const OWNERSHIP_KEYS = [
  "alchemy-stack",
  "alchemy-stage",
  "alchemy-id",
] as const;

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(300), 1.5),
  Schedule.spaced(Duration.seconds(2)),
]);

const networkId = (network: string | undefined) => {
  if (network === undefined || network.length === 0) return undefined;
  const parts = network.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1];
};

const toNetworkUrl = (network: string | undefined, project: string) => {
  if (network === undefined || network.length === 0) {
    return `projects/${project}/global/networks/default`;
  }
  if (network.includes("/")) return network;
  return `projects/${project}/global/networks/${network}`;
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    const rfc = generated.replace(/^[^a-z]+/, "f").replace(/-+$/g, "");
    return rfc.slice(0, 63);
  });

const encodeDescription = (
  user: string | undefined,
  labels: Record<string, string>,
) => {
  const marker = OWNERSHIP_KEYS.map(
    (key) => `${key}=${labels[key] ?? ""}`,
  ).join(" ");
  const trimmed = user?.trim() ?? "";
  return trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

const parseDescription = (description: string | undefined) => {
  if (description === undefined || description.length === 0) {
    return { labels: {} as Record<string, string>, description: undefined };
  }
  const newline = description.indexOf("\n");
  const first = newline === -1 ? description : description.slice(0, newline);
  const rest = newline === -1 ? undefined : description.slice(newline + 1);
  if (!first.includes("alchemy-id=") || !first.includes("alchemy-stack=")) {
    return { labels: {} as Record<string, string>, description };
  }
  const labels: Record<string, string> = {};
  for (const part of first.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return {
    labels,
    description: rest && rest.length > 0 ? rest : undefined,
  };
};

const hasAlchemyMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toApiRules = (
  rules: FirewallRule[] | undefined,
): compute.FirewallAllowedItemList | undefined => {
  if (rules === undefined || rules.length === 0) return undefined;
  return rules.map((rule) => ({
    IPProtocol: rule.protocol,
    ports:
      rule.ports !== undefined && rule.ports.length > 0
        ? rule.ports
        : undefined,
  }));
};

const fromApiRules = (
  rules: compute.FirewallAllowedItemList | undefined,
): FirewallRule[] =>
  (rules ?? []).flatMap((rule) =>
    rule.IPProtocol
      ? [
          {
            protocol: rule.IPProtocol,
            ports: rule.ports,
          },
        ]
      : [],
  );

const toApiLogConfig = (
  log: FirewallLogConfig | undefined,
): compute.FirewallLogConfig | undefined => {
  if (log === undefined || log.enable !== true) return undefined;
  return {
    enable: true,
    metadata: log.metadata,
  };
};

const fromApiLogConfig = (
  log: compute.FirewallLogConfig | undefined,
): FirewallLogConfig | undefined =>
  log?.enable === true
    ? {
        enable: true,
        metadata: log.metadata as FirewallLogConfig["metadata"],
      }
    : undefined;

const listsEqual = (left?: string[], right?: string[]) => {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
};

const rulesEqual = (left?: FirewallRule[], right?: FirewallRule[]) => {
  const canon = (rules?: FirewallRule[]) =>
    JSON.stringify(
      (rules ?? [])
        .map((rule) => ({
          protocol: rule.protocol.toLowerCase(),
          ports: [...(rule.ports ?? [])].sort(),
        }))
        .sort(
          (a, b) =>
            a.protocol.localeCompare(b.protocol) ||
            JSON.stringify(a.ports).localeCompare(JSON.stringify(b.ports)),
        ),
    );
  return canon(left) === canon(right);
};

const logConfigEqual = (
  left: FirewallLogConfig | undefined,
  right: FirewallLogConfig | undefined,
) =>
  (left?.enable === true) === (right?.enable === true) &&
  (left?.enable === true ? left.metadata : undefined) ===
    (right?.enable === true ? right.metadata : undefined);

type FirewallAction = "allow" | "deny";

const actionOf = (
  props:
    | {
        allowed?: unknown[];
        denied?: unknown[];
      }
    | undefined,
): FirewallAction | undefined => {
  if (props === undefined) return undefined;
  if (props.denied !== undefined && props.denied.length > 0) return "deny";
  if (props.allowed !== undefined && props.allowed.length > 0) return "allow";
  return undefined;
};

const toAttrs = (firewall: compute.Firewall, project: string) => ({
  firewallName: firewall.name ?? firewall.id ?? "",
  project,
  network: firewall.network ?? "",
  description: parseDescription(firewall.description).description,
  priority: firewall.priority ?? DEFAULT_PRIORITY,
  direction: (firewall.direction ?? DEFAULT_DIRECTION).toUpperCase(),
  disabled: firewall.disabled === true,
  allowed: fromApiRules(firewall.allowed),
  denied: fromApiRules(firewall.denied),
  sourceRanges: firewall.sourceRanges ?? [],
  destinationRanges: firewall.destinationRanges ?? [],
  sourceTags: firewall.sourceTags ?? [],
  targetTags: firewall.targetTags ?? [],
  sourceServiceAccounts: firewall.sourceServiceAccounts ?? [],
  targetServiceAccounts: firewall.targetServiceAccounts ?? [],
  logConfig: fromApiLogConfig(firewall.logConfig),
  id: firewall.id,
  selfLink: firewall.selfLink,
  creationTimestamp: firewall.creationTimestamp,
});

const getByName = (project: string, firewall: string) =>
  compute
    .getFirewalls({ project, firewall })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const insertBody = (
  firewallName: string,
  project: string,
  news: FirewallProps,
  description: string,
): compute.Firewall => ({
  name: firewallName,
  network: toNetworkUrl(news.network, project),
  description,
  priority: news.priority ?? DEFAULT_PRIORITY,
  direction: (news.direction ?? DEFAULT_DIRECTION).toUpperCase(),
  disabled: news.disabled === true,
  allowed: toApiRules(news.allowed),
  denied: toApiRules(news.denied),
  sourceRanges: news.sourceRanges,
  destinationRanges: news.destinationRanges,
  sourceTags: news.sourceTags,
  targetTags: news.targetTags,
  sourceServiceAccounts: news.sourceServiceAccounts,
  targetServiceAccounts: news.targetServiceAccounts,
  logConfig: toApiLogConfig(news.logConfig),
});

export const FirewallProvider = () =>
  Provider.succeed(Firewall, {
    stables: [
      "firewallName",
      "project",
      "network",
      "direction",
      "id",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const prevName = olds?.firewallName ?? output?.firewallName;
      const nextName = news.firewallName ?? prevName;
      const nameChanged =
        prevName !== undefined &&
        nextName !== undefined &&
        prevName !== nextName;

      const prevNetwork = networkId(olds?.network ?? output?.network);
      const nextNetwork = networkId(
        news.network ?? prevNetwork ?? DEFAULT_NETWORK,
      );
      const networkChanged =
        prevNetwork !== undefined &&
        nextNetwork !== undefined &&
        prevNetwork !== nextNetwork;

      const prevDir = (olds?.direction ?? output?.direction)?.toUpperCase();
      const nextDir = (
        news.direction ??
        prevDir ??
        DEFAULT_DIRECTION
      ).toUpperCase();
      const directionChanged = prevDir !== undefined && prevDir !== nextDir;

      const prevAction = actionOf(olds) ?? actionOf(output);
      const nextAction = actionOf(news);
      const actionChanged =
        prevAction !== undefined &&
        nextAction !== undefined &&
        prevAction !== nextAction;

      if (nameChanged || networkChanged || directionChanged || actionChanged) {
        return {
          action: "replace" as const,
          deleteFirst: !nameChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const firewallName = yield* toName(
        id,
        olds?.firewallName,
        output?.firewallName,
      );
      const existing = yield* getByName(env.project, firewallName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        parseDescription(existing.description).labels,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listFirewalls
          .items({ project: env.project })
          .pipe(
            Stream.filter((firewall) => hasAlchemyMarker(firewall.description)),
            Stream.map((firewall) => toAttrs(firewall, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const firewallName = yield* toName(
        id,
        news.firewallName,
        output?.firewallName,
      );
      const desiredLabels = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(
        news.description,
        desiredLabels,
      );
      const desiredPriority = news.priority ?? DEFAULT_PRIORITY;
      const desiredDisabled = news.disabled === true;
      const desiredAllowed = news.allowed ?? [];
      const desiredDenied = news.denied ?? [];
      const desiredSourceRanges = news.sourceRanges ?? [];
      const desiredDestinationRanges = news.destinationRanges ?? [];
      const desiredSourceTags = news.sourceTags ?? [];
      const desiredTargetTags = news.targetTags ?? [];
      const desiredSourceServiceAccounts = news.sourceServiceAccounts ?? [];
      const desiredTargetServiceAccounts = news.targetServiceAccounts ?? [];
      const desiredLogConfig = toApiLogConfig(news.logConfig);

      let current = yield* getByName(env.project, firewallName);

      if (current === undefined) {
        yield* compute
          .insertFirewalls({
            project: env.project,
            body: insertBody(
              firewallName,
              env.project,
              news,
              desiredDescription,
            ),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* getByName(env.project, firewallName).pipe(
          Effect.flatMap((firewall) =>
            firewall !== undefined
              ? Effect.succeed(firewall)
              : Effect.fail(new FirewallNotResolved({ firewallName })),
          ),
          Effect.retry({
            while: (error) => error._tag === "GCP.Compute.FirewallNotResolved",
            times: 8,
            schedule: backoff,
          }),
          Effect.catchTag("GCP.Compute.FirewallNotResolved", () =>
            Effect.succeed(undefined),
          ),
        );
      }

      if (current === undefined) {
        return yield* new FirewallNotResolved({ firewallName });
      }

      const observed = toAttrs(current, env.project);
      const patch: compute.Firewall = {};

      if ((current.description ?? "") !== desiredDescription) {
        patch.description = desiredDescription;
      }
      if (observed.priority !== desiredPriority) {
        patch.priority = desiredPriority;
      }
      if (observed.disabled !== desiredDisabled) {
        patch.disabled = desiredDisabled;
      }
      if (!rulesEqual(observed.allowed, desiredAllowed)) {
        patch.allowed = toApiRules(desiredAllowed) ?? [];
      }
      if (!rulesEqual(observed.denied, desiredDenied)) {
        patch.denied = toApiRules(desiredDenied) ?? [];
      }
      if (!listsEqual(observed.sourceRanges, desiredSourceRanges)) {
        patch.sourceRanges = desiredSourceRanges;
      }
      if (!listsEqual(observed.destinationRanges, desiredDestinationRanges)) {
        patch.destinationRanges = desiredDestinationRanges;
      }
      if (!listsEqual(observed.sourceTags, desiredSourceTags)) {
        patch.sourceTags = desiredSourceTags;
      }
      if (!listsEqual(observed.targetTags, desiredTargetTags)) {
        patch.targetTags = desiredTargetTags;
      }
      if (
        !listsEqual(
          observed.sourceServiceAccounts,
          desiredSourceServiceAccounts,
        )
      ) {
        patch.sourceServiceAccounts = desiredSourceServiceAccounts;
      }
      if (
        !listsEqual(
          observed.targetServiceAccounts,
          desiredTargetServiceAccounts,
        )
      ) {
        patch.targetServiceAccounts = desiredTargetServiceAccounts;
      }
      if (
        !logConfigEqual(observed.logConfig, fromApiLogConfig(desiredLogConfig))
      ) {
        patch.logConfig = desiredLogConfig ?? { enable: false };
      }

      if (Object.keys(patch).length > 0) {
        yield* compute
          .patchFirewalls({
            project: env.project,
            firewall: firewallName,
            body: patch,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: backoff,
            }),
          );
        current = (yield* getByName(env.project, firewallName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      yield* compute
        .deleteFirewalls({
          project: env.project,
          firewall: output.firewallName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitGlobalOperation(env.project, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
