import type {
  ConnectionRouteKind,
  EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import { linkBackOffer } from "@t3tools/client-runtime/link-batch";
import { peerLinkHealth, type PeerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  AuthMcpClientAccess,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

export const FLEET_CLIENT_NODE_ID = "client";

/** What this client knows of the links an environment holds to others. */
export type FleetOutgoingLinks =
  | { readonly state: "loaded"; readonly links: ReadonlyArray<PeerLinkSummary> }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  /** Connected, but linked environments is off or unsupported there. */
  | { readonly state: "off" }
  /** Not connected, or not allowed to read: it may hold links this client cannot see. */
  | { readonly state: "unknown" };

export interface FleetRouteInput {
  readonly id: string;
  readonly kind: ConnectionRouteKind;
  /** The route's own label when it says more than its kind, such as "Tailscale HTTPS". */
  readonly label?: string;
}

export interface FleetEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind | null;
  readonly phase: EnvironmentConnectionPhase;
  /** Switched on in this client. A switched-off environment is saved but never dialled. */
  readonly enabled: boolean;
  /** Saved routes, preferred first. */
  readonly routes: ReadonlyArray<FleetRouteInput>;
  /** The route carrying the connection, when the client is connected and knows it. */
  readonly activeRouteId: string | null;
  readonly refusedRouteIds: ReadonlyArray<string>;
  readonly outgoing: FleetOutgoingLinks;
  /** Linked environments is supported and switched on there. */
  readonly offersLinks: boolean;
  /** This client's session there may create links from it and pairing codes on it. */
  readonly canWriteAccess: boolean;
  /** An address another machine can reach it at, so a link to it needs no typed address. */
  readonly hasLinkAddress: boolean;
}

/** A machine on the user's T3 Connect account that this client has not saved. */
export interface FleetConnectMachineInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind | null;
  readonly availability: "checking" | "online" | "offline" | "error";
}

/**
 * How a route is doing, from what the client knows: which one carries the connection, which the
 * host refused, and the environment's phase. It never probes a route to find out.
 */
export type FleetRouteState =
  | "in-use"
  | "standby"
  | "trying"
  /** The environment cannot be reached right now, over any route. */
  | "down"
  /** Not dialled: the environment is switched off, or needs an update first. */
  | "idle"
  | "refused"
  /** A T3 Connect machine this client could add; no route is saved yet. */
  | "offered";

/** Why an environment can or cannot be the source of a new link. */
export type FleetLinking = "ready" | "disconnected" | "off" | "forbidden";

export type FleetNode =
  | { readonly id: string; readonly kind: "client"; readonly label: string }
  | {
      readonly id: string;
      readonly kind: "environment";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly machine: EnvironmentMachineKind | null;
      readonly phase: EnvironmentConnectionPhase;
      readonly enabled: boolean;
      readonly routeCount: number;
      readonly outgoing: FleetOutgoingLinks["state"];
      readonly outgoingError: string | null;
      readonly linking: FleetLinking;
      /** The client can mint a pairing code there itself, so linking to it asks for none. */
      readonly mintable: boolean;
      readonly canWriteAccess: boolean;
      readonly hasLinkAddress: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "connect";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly machine: EnvironmentMachineKind | null;
      readonly availability: FleetConnectMachineInput["availability"];
    }
  /** Seen only as another environment's link target; the client is not connected to it. */
  | {
      readonly id: string;
      readonly kind: "target";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      /** Where the first environment linking to it reaches it. */
      readonly address: string | null;
    };

export type FleetEnvironmentNode = Extract<FleetNode, { kind: "environment" }>;

export type FleetEdge =
  | {
      readonly id: string;
      readonly kind: "route";
      readonly from: string;
      readonly to: string;
      readonly routeId: string;
      readonly routeKind: ConnectionRouteKind;
      readonly routeLabel?: string;
      readonly state: FleetRouteState;
    }
  | {
      readonly id: string;
      readonly kind: "link";
      readonly from: string;
      readonly to: string;
      readonly sourceEnvironmentId: EnvironmentId;
      readonly link: PeerLinkSummary;
      readonly health: PeerLinkHealth;
    };

export type FleetRouteEdge = Extract<FleetEdge, { kind: "route" }>;
export type FleetLinkEdge = Extract<FleetEdge, { kind: "link" }>;

export interface FleetGraph {
  readonly nodes: ReadonlyArray<FleetNode>;
  readonly edges: ReadonlyArray<FleetEdge>;
}

export const fleetEnvironmentNodeId = (environmentId: EnvironmentId) => `env:${environmentId}`;

function routeState(environment: FleetEnvironmentInput, routeId: string): FleetRouteState {
  if (environment.refusedRouteIds.includes(routeId)) return "refused";
  if (!environment.enabled) return "idle";
  switch (environment.phase) {
    case "connected":
      return routeId === environment.activeRouteId ? "in-use" : "standby";
    case "connecting":
      return "trying";
    case "unsupported":
    case "available":
      return "idle";
    case "reconnecting":
    case "error":
    case "offline":
      return "down";
  }
}

function linking(environment: FleetEnvironmentInput): FleetLinking {
  if (environment.phase !== "connected") return "disconnected";
  if (!environment.offersLinks) return "off";
  return environment.canWriteAccess ? "ready" : "forbidden";
}

/**
 * One node per machine however often it is named: an environment listed twice, a link repeated
 * in a list, a T3 Connect machine the client also saved, and a link to a machine the client
 * knows all land on the same node. Each saved route is its own edge from the client.
 */
export function buildFleetGraph(input: {
  readonly clientLabel: string;
  readonly environments: ReadonlyArray<FleetEnvironmentInput>;
  readonly connectMachines?: ReadonlyArray<FleetConnectMachineInput>;
  readonly now: DateTime.Utc;
}): FleetGraph {
  const nodes = new Map<string, FleetNode>([
    [FLEET_CLIENT_NODE_ID, { id: FLEET_CLIENT_NODE_ID, kind: "client", label: input.clientLabel }],
  ]);
  const edges = new Map<string, FleetEdge>();
  const environments = input.environments.filter(
    (environment, index, all) =>
      all.findIndex((other) => other.environmentId === environment.environmentId) === index,
  );
  for (const environment of environments) {
    const id = fleetEnvironmentNodeId(environment.environmentId);
    nodes.set(id, {
      id,
      kind: "environment",
      environmentId: environment.environmentId,
      label: environment.label,
      machine: environment.machine,
      phase: environment.phase,
      enabled: environment.enabled,
      routeCount: environment.routes.length,
      outgoing: environment.outgoing.state,
      outgoingError: environment.outgoing.state === "error" ? environment.outgoing.message : null,
      linking: linking(environment),
      mintable:
        environment.phase === "connected" &&
        environment.canWriteAccess &&
        environment.hasLinkAddress,
      canWriteAccess: environment.canWriteAccess,
      hasLinkAddress: environment.hasLinkAddress,
    });
    for (const route of environment.routes) {
      const edgeId = `route:${id}:${route.id}`;
      if (edges.has(edgeId)) continue;
      edges.set(edgeId, {
        id: edgeId,
        kind: "route",
        from: FLEET_CLIENT_NODE_ID,
        to: id,
        routeId: route.id,
        routeKind: route.kind,
        ...(route.label === undefined ? {} : { routeLabel: route.label }),
        state: routeState(environment, route.id),
      });
    }
  }
  for (const machine of input.connectMachines ?? []) {
    const id = fleetEnvironmentNodeId(machine.environmentId);
    if (nodes.has(id)) continue;
    nodes.set(id, {
      id,
      kind: "connect",
      environmentId: machine.environmentId,
      label: machine.label,
      machine: machine.machine,
      availability: machine.availability,
    });
    edges.set(`route:${id}:offer`, {
      id: `route:${id}:offer`,
      kind: "route",
      from: FLEET_CLIENT_NODE_ID,
      to: id,
      routeId: "offer",
      routeKind: "relay",
      state: "offered",
    });
  }
  for (const environment of environments) {
    if (environment.outgoing.state !== "loaded") continue;
    const from = fleetEnvironmentNodeId(environment.environmentId);
    for (const link of environment.outgoing.links) {
      const to = fleetEnvironmentNodeId(link.environmentId);
      const id = `link:${from}>${to}`;
      if (to === from || edges.has(id)) continue;
      if (!nodes.has(to)) {
        nodes.set(to, {
          id: to,
          kind: "target",
          environmentId: link.environmentId,
          label: link.label,
          address: link.urls[0] ?? null,
        });
      }
      edges.set(id, {
        id,
        kind: "link",
        from,
        to,
        sourceEnvironmentId: environment.environmentId,
        link,
        health: peerLinkHealth(link, input.now),
      });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export const isLinkEdge = (edge: FleetEdge): edge is FleetLinkEdge => edge.kind === "link";
export const isRouteEdge = (edge: FleetEdge): edge is FleetRouteEdge => edge.kind === "route";

/** Two machines linked to each other at the same access: two links the map draws as one line. */
export interface FleetTwoWayLink {
  /** The one the line is drawn and selected as: from the machine listed first. */
  readonly forward: FleetLinkEdge;
  readonly back: FleetLinkEdge;
}

/**
 * Every two-way link, under the id of each of its two links. Links at different access levels
 * say different things, so they stay two lines.
 */
export function fleetTwoWayLinks(graph: FleetGraph): ReadonlyMap<string, FleetTwoWayLink> {
  const links = new Map(graph.edges.filter(isLinkEdge).map((edge) => [edge.id, edge]));
  const pairs = new Map<string, FleetTwoWayLink>();
  for (const forward of links.values()) {
    const back = links.get(`link:${forward.to}>${forward.from}`);
    if (back === undefined || back.link.access !== forward.link.access || pairs.has(forward.id)) {
      continue;
    }
    const pair = { forward, back };
    pairs.set(forward.id, pair).set(back.id, pair);
  }
  return pairs;
}

/** The link whose line stands for `edge`: itself, or the other half of its two-way link. */
export const fleetDrawnLinkId = (pairs: ReadonlyMap<string, FleetTwoWayLink>, edgeId: string) =>
  pairs.get(edgeId)?.forward.id ?? edgeId;

/** Worst first: expired, failing, not answering, expiring soon, fine. */
export const linkTroubleRank = (health: PeerLinkHealth) =>
  health.kind === "expired"
    ? 0
    : health.kind === "failing"
      ? 1
      : health.kind === "unreachable"
        ? 2
        : health.expiresInDays === null
          ? 4
          : 3;

/** The health a two-way link's one label wears: that of the direction in more trouble. */
export const worseLinkHealth = (left: PeerLinkHealth, right: PeerLinkHealth) =>
  linkTroubleRank(right) < linkTroubleRank(left) ? right : left;

/**
 * Whether the map offers to link a one-way link's target back to its source: the same rule
 * the link dialogs use, read from what the map knows of the two machines.
 */
export function fleetLinkBackOffered(graph: FleetGraph, edge: FleetLinkEdge): boolean {
  const source = graph.nodes.find((node) => node.id === edge.from);
  const target = graph.nodes.find((node) => node.id === edge.to);
  if (source?.kind !== "environment" || target?.kind !== "environment") return false;
  const offer = linkBackOffer({
    source: {
      environmentId: source.environmentId,
      connected: source.phase === "connected",
      writable: source.canWriteAccess,
      urls: source.hasLinkAddress ? [""] : [],
    },
    target: {
      connected: target.phase === "connected",
      offersLinks: target.linking !== "off",
      writable: target.canWriteAccess,
      links:
        target.outgoing === "loaded"
          ? graph.edges
              .filter(isLinkEdge)
              .filter((other) => other.from === target.id)
              .map((other) => other.link)
          : null,
    },
  });
  return offer.kind === "offered";
}

/**
 * The setup in two numbers. `links` is null when the total is not known: a list still loading,
 * none read, or one failed among several. A failed or unread list is not "no links".
 */
export function fleetSummary(graph: FleetGraph): {
  readonly machines: number;
  readonly links: number | null;
  readonly loading: boolean;
} {
  const connected = graph.nodes.filter(
    (node) => node.kind === "environment" && node.phase === "connected",
  ) as FleetEnvironmentNode[];
  const loading = connected.some((node) => node.outgoing === "loading");
  const known =
    !loading &&
    connected.some((node) => node.outgoing === "loaded") &&
    !connected.some((node) => node.outgoing === "error");
  return {
    machines: graph.nodes.length - 1,
    links: known ? graph.edges.filter(isLinkEdge).length : null,
    loading,
  };
}

/** Whether a link wants the user's attention: anything but reachable with time left. */
export const linkNeedsAttention = (health: PeerLinkHealth) =>
  health.kind !== "reachable" || health.expiresInDays !== null;

const ACCESS_ORDER = AuthMcpClientAccess.literals;
/**
 * How far apart two links enter one card while it has the room: an arrowhead plus the heaviest
 * line. A card with more links than that fits keeps its size and they close up.
 */
export const FLEET_LANE_PITCH = 12;
const labelOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Why an environment with no links is folded away: what the client knows of it, never a probe. */
export type FleetFoldGroup = "offline" | "off" | "update" | "not-added";

/**
 * Machines drawn as a single node, each still listed in the details. `targets` are machines
 * known only through links, all linked from the same environments at the same access levels:
 * a thousand VMs under two hosts cost one node and two lines. `environments` are ones this app
 * is not connected to and that take part in no link, grouped by why.
 */
export interface FleetStack {
  readonly id: string;
  readonly kind: "targets" | "environments";
  /** The environments linking to every member, uppermost first. Empty for `environments`. */
  readonly sources: ReadonlyArray<{
    readonly sourceId: string;
    readonly access: AuthMcpClientAccess;
  }>;
  readonly group: FleetFoldGroup | null;
  /** In name order, so the first and last name the range. */
  readonly memberIds: ReadonlyArray<string>;
  readonly edgeIds: ReadonlyArray<string>;
  /** Members every one of whose links answers. */
  readonly reachable: number;
  readonly firstLabel: string;
  readonly lastLabel: string;
  readonly expanded: boolean;
  /** The members an open stack draws on the map; the rest are in the details only. */
  readonly shownIds: ReadonlyArray<string>;
}

/** Below this many machines a group of link targets is clearer drawn one by one. */
const FLEET_STACK_MIN = 5;
/** Environments fold only once the client knows more than this many. */
export const FLEET_FOLD_ENVIRONMENTS_OVER = 12;
/** A folded group of environments needs at least this many; fewer stay as cards. */
const FLEET_FOLD_MIN = 3;
/** An open stack draws this many machines at most, then one card for the rest. */
export const FLEET_STACK_SHOWN_MAX = 24;

export const fleetMoreNodeId = (stackId: string) => `more:${stackId}`;

function foldGroup(node: FleetNode): FleetFoldGroup | null {
  if (node.kind === "connect") return "not-added";
  if (node.kind !== "environment") return null;
  if (node.phase === "unsupported") return "update";
  if (!node.enabled) return "off";
  // One still dialling stays a card: it is about to change, and the user is watching it.
  return node.phase === "offline" || node.phase === "error" || node.phase === "available"
    ? "offline"
    : null;
}

const FOLD_ORDER: ReadonlyArray<FleetFoldGroup> = ["offline", "off", "update", "not-added"];

export function fleetStacks(graph: FleetGraph, expanded: ReadonlySet<string>): FleetStack[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const label = (id: string) => byId.get(id)?.label ?? "";
  const byLabel = (left: string, right: string) =>
    labelOrder.compare(label(left), label(right)) || (left < right ? -1 : 1);
  const links = graph.edges.filter(isLinkEdge);
  const incoming = new Map<string, FleetLinkEdge[]>();
  for (const link of links) {
    if (byId.get(link.to)?.kind !== "target") continue;
    const into = incoming.get(link.to);
    if (into === undefined) incoming.set(link.to, [link]);
    else into.push(link);
  }
  // Keyed by the exact set of (host, access) links in, so every member is drawn by the same lines.
  const groups = new Map<string, Array<{ id: string; links: FleetLinkEdge[] }>>();
  for (const [id, unsorted] of incoming) {
    const into = unsorted.toSorted((a, b) => order.get(a.from)! - order.get(b.from)!);
    const key = `stack:${into.map((link) => `${link.from}:${link.link.access}`).join("|")}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [{ id, links: into }]);
    else group.push({ id, links: into });
  }
  const make = (
    id: string,
    kind: FleetStack["kind"],
    memberIds: ReadonlyArray<string>,
    rest: Pick<FleetStack, "sources" | "group" | "edgeIds" | "reachable">,
  ): FleetStack => ({
    id,
    kind,
    ...rest,
    memberIds,
    firstLabel: label(memberIds[0]!),
    lastLabel: label(memberIds.at(-1)!),
    expanded: expanded.has(id),
    shownIds:
      memberIds.length > FLEET_STACK_SHOWN_MAX
        ? memberIds.slice(0, FLEET_STACK_SHOWN_MAX)
        : memberIds,
  });
  const stacks: FleetStack[] = [];
  for (const [id, unsorted] of groups) {
    if (unsorted.length < FLEET_STACK_MIN) continue;
    const members = unsorted.toSorted((left, right) => byLabel(left.id, right.id));
    stacks.push(
      make(
        id,
        "targets",
        members.map((member) => member.id),
        {
          sources: members[0]!.links.map((link) => ({
            sourceId: link.from,
            access: link.link.access,
          })),
          group: null,
          edgeIds: members.flatMap((member) => member.links.map((link) => link.id)),
          reachable: members.filter((member) =>
            member.links.every((link) => link.health.kind === "reachable"),
          ).length,
        },
      ),
    );
  }
  const hosts = graph.nodes.filter(
    (node) => node.kind === "environment" || node.kind === "connect",
  );
  if (hosts.length <= FLEET_FOLD_ENVIRONMENTS_OVER) return stacks;
  const linked = new Set(links.flatMap((link) => [link.from, link.to]));
  const routesOf = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "route") continue;
    const routes = routesOf.get(edge.to);
    if (routes === undefined) routesOf.set(edge.to, [edge.id]);
    else routes.push(edge.id);
  }
  for (const group of FOLD_ORDER) {
    const memberIds = hosts
      .filter((host) => !linked.has(host.id) && foldGroup(host) === group)
      .map((host) => host.id)
      .toSorted(byLabel);
    if (memberIds.length < FLEET_FOLD_MIN) continue;
    stacks.push(
      make(`fold:${group}`, "environments", memberIds, {
        sources: [],
        group,
        edgeIds: memberIds.flatMap((id) => routesOf.get(id) ?? []),
        reachable: 0,
      }),
    );
  }
  return stacks;
}

export type FleetFocus =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "edge"; readonly id: string }
  | { readonly kind: "stack"; readonly id: string };

export interface FleetNeighborhood {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

/**
 * What a node reaches and what reaches it, one hop only, plus how this client gets there. A link
 * does not chain: A linked to B and B linked to C gives A's agents nothing on C, so following
 * links further would lie.
 */
export function fleetNeighborhood(
  graph: FleetGraph,
  stacks: ReadonlyArray<FleetStack>,
  focus: FleetFocus,
): FleetNeighborhood {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const sources = new Set<string>();
  const stack = focus.kind === "stack" ? stacks.find((entry) => entry.id === focus.id) : undefined;
  const stackEdges = new Set(stack?.edgeIds);
  // A two-way link is one line: either of its links brings the other with it.
  const pair = focus.kind === "edge" ? fleetTwoWayLinks(graph).get(focus.id) : undefined;
  for (const edge of graph.edges) {
    const touches =
      focus.kind === "stack"
        ? stackEdges.has(edge.id)
        : focus.kind === "edge"
          ? edge.id === focus.id || edge.id === pair?.forward.id || edge.id === pair?.back.id
          : edge.from === focus.id || edge.to === focus.id;
    if (!touches) continue;
    edges.add(edge.id);
    nodes.add(edge.from).add(edge.to);
    if (edge.kind === "link" && (focus.kind !== "node" || edge.to === focus.id)) {
      sources.add(edge.from);
    }
  }
  // The client reaches the focus through whichever environment holds the link to it.
  for (const edge of graph.edges) {
    if (edge.kind !== "route" || !sources.has(edge.to)) continue;
    edges.add(edge.id);
    nodes.add(edge.from);
  }
  if (focus.kind === "node" && graph.nodes.some((node) => node.id === focus.id)) {
    nodes.add(focus.id);
  }
  return { nodes, edges };
}

/** What linking `sourceId` to `targetId` would take, or why the map does not offer it. */
export type FleetLinkOffer =
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "not-an-environment"
        | "same-machine"
        | "source-disconnected"
        | "source-off"
        | "source-forbidden";
    }
  | {
      readonly kind: "link";
      readonly sourceEnvironmentId: EnvironmentId;
      /**
       * `code-less`: the client mints the pairing code on the target with its own session there.
       * `pairing-code`: the user brings one from the target.
       * `through-link`: a machine that links to the target at full access gets the code there.
       */
      readonly path: "code-less" | "pairing-code" | "through-link";
      /** The pair is already linked, so linking again renews it. */
      readonly renews: boolean;
      readonly target:
        | { readonly kind: "machine"; readonly environmentId: EnvironmentId }
        /** A machine the client has no entry for: only an address another host uses. */
        | {
            readonly kind: "address";
            readonly address: string | null;
            /** The linked machine itself, and the one that can get a pairing code from it. */
            readonly through?: {
              readonly viaEnvironmentId: EnvironmentId;
              readonly environmentId: EnvironmentId;
              readonly label: string;
            };
          };
    };

export function fleetLinkOffer(
  graph: FleetGraph,
  sourceId: string,
  targetId: string,
): FleetLinkOffer {
  const source = graph.nodes.find((node) => node.id === sourceId);
  const target = graph.nodes.find((node) => node.id === targetId);
  if (source?.kind !== "environment" || target === undefined || target.kind === "client") {
    return { kind: "unavailable", reason: "not-an-environment" };
  }
  if (source.id === target.id) return { kind: "unavailable", reason: "same-machine" };
  if (source.linking !== "ready") {
    return { kind: "unavailable", reason: `source-${source.linking}` as const };
  }
  const renews = graph.edges.some(
    (edge) =>
      edge.kind === "link" &&
      edge.from === source.id &&
      edge.to === target.id &&
      edge.health.kind !== "expired",
  );
  const base = { kind: "link", sourceEnvironmentId: source.environmentId, renews } as const;
  if (target.kind === "target") {
    // Only a full-access link may mint a code there, and only a session that manages access on
    // the machine holding that link may ask it to.
    const via = graph.edges.find(
      (edge): edge is FleetLinkEdge =>
        edge.kind === "link" &&
        edge.to === target.id &&
        edge.from !== source.id &&
        edge.link.access === "full-access" &&
        edge.health.kind === "reachable" &&
        graph.nodes.some(
          (node) =>
            node.id === edge.from &&
            node.kind === "environment" &&
            node.phase === "connected" &&
            node.canWriteAccess,
        ),
    );
    return {
      ...base,
      path: via === undefined ? "pairing-code" : "through-link",
      target: {
        kind: "address",
        address: target.address,
        ...(via === undefined
          ? {}
          : {
              through: {
                viaEnvironmentId: via.sourceEnvironmentId,
                environmentId: target.environmentId,
                label: target.label,
              },
            }),
      },
    };
  }
  return {
    ...base,
    path: target.kind === "environment" && target.mintable ? "code-less" : "pairing-code",
    target: { kind: "machine", environmentId: target.environmentId },
  };
}

/** Some of a stack's linked machines do not answer: its card grows a line to say how many do. */
export const fleetStackPartial = (stack: FleetStack) =>
  stack.kind === "targets" && stack.reachable < stack.memberIds.length;

/** Changes exactly when the layout would: membership, labels, routes, wiring and open stacks. */
export function fleetShapeKey(graph: FleetGraph, stacks: ReadonlyArray<FleetStack>): string {
  return [
    ...graph.nodes.map((node) => `${node.kind}\u0000${node.id}\u0000${node.label}`),
    ...graph.edges.map((edge) =>
      edge.kind === "link" ? `${edge.id}\u0000${edge.link.access}` : edge.id,
    ),
    // Which environments fold follows their state, which nothing above carries.
    ...stacks.map(
      (stack) =>
        `${stack.id}\u0000${stack.expanded}\u0000${fleetStackPartial(stack)}\u0000${stack.kind === "environments" ? stack.memberIds.join() : ""}`,
    ),
  ].join("\n");
}

export interface FleetRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FleetPoint {
  readonly x: number;
  readonly y: number;
}

export interface FleetRouteGeometry {
  readonly d: string;
  /** Where the route's kind is named, on the wire just before the environment. */
  readonly pill: FleetRect;
}

/**
 * Room for a link's access in words. `side` is the way it grows from the lane it sits on.
 * `onDemand` names one with no clear place: shown only while its link is in focus.
 */
export type FleetLinkBadge = FleetRect & { readonly side: 1 | -1; readonly onDemand: boolean };

export interface FleetArrow {
  readonly x: number;
  readonly y: number;
  readonly dir: 1 | -1;
}

export interface FleetLinkGeometry {
  readonly d: string;
  /** Arrowhead tip and the horizontal direction it points. */
  readonly arrow: FleetArrow;
  /**
   * Set for a two-way link, which is one line with an arrowhead at each end. `arrow` and
   * `forward` are the half leading into the machine the drawn link reaches; `backArrow` and
   * `back` the half leading into the one it leaves, which is the other link's.
   */
  readonly twoWay: {
    readonly backArrow: FleetArrow;
    readonly forward: string;
    readonly back: string;
  } | null;
  /** Where a link between two environments names its access; a target's card shows its own. */
  readonly badge: FleetLinkBadge | null;
}

/** A line a stack draws for all its machines: one environment's links, or the client's routes. */
export interface FleetStackLine {
  readonly sourceId: string | null;
  readonly access: AuthMcpClientAccess | null;
  readonly d: string;
  readonly arrow: FleetPoint | null;
}

export interface FleetStackGeometry {
  /** The whole footprint: the sheets of a closed stack, or an open one's card and its tray. */
  readonly rect: FleetRect;
  /** The stack's card. Opening the stack leaves it where it is, and the tray grows out below. */
  readonly face: FleetRect;
  readonly lines: ReadonlyArray<FleetStackLine>;
  /** The panel an open stack draws its machines in, below its card. */
  readonly tray: FleetRect | null;
  /** In an open stack, the card standing for the machines it does not draw. */
  readonly more: FleetRect | null;
}

export type FleetColumn = "client" | "environments" | "targets";

export interface FleetLayout {
  /** Every machine drawn on its own. Members of a closed stack are not here. */
  readonly nodes: ReadonlyMap<string, FleetRect>;
  readonly stacks: ReadonlyMap<string, FleetStackGeometry>;
  readonly routes: ReadonlyMap<string, FleetRouteGeometry>;
  /** Links drawn one by one. A stack's links are drawn by the stack. */
  readonly links: ReadonlyMap<string, FleetLinkGeometry>;
  /** Where an environment's links leave it and its link handle sits, on its right edge. */
  readonly handles: ReadonlyMap<string, FleetPoint>;
  readonly columns: ReadonlyArray<{ readonly id: FleetColumn; readonly x: number }>;
  readonly width: number;
  readonly height: number;
}

const HEADER = 28;
const CLIENT = { height: 44 };
const PILL = { height: 18 };
/** How far apart route names sit in their column beside a card. */
export const FLEET_ROUTE_PITCH = 22;
/** How far that column may reach into the gap above and below its card's place. */
const PILL_OVERHANG = 9;
/** `nameLine` is the most characters of a name the narrowest card sets on one line. */
const CARD = { height: 56, twoLines: 68, nameLine: 13 };
/** Routes enter a card as one bundle: this far apart, and never wider than `spread`. */
const ROUTE_ENTRY = { pitch: 4, spread: 10 };
const OFFER = { height: 44 };
const TARGET = { height: 44 };
/** `partial` is the room a closed stack adds to say how many of its machines answer. */
const STACK = { height: 50, partial: 20, lift: 8 };

/**
 * Every horizontal measure the map can give up or take. Heights never change with the width, so
 * what is drawn where, lane by lane, is the same at every width and only the columns move.
 */
interface FleetMetrics {
  /** The card for this app, where every route starts. */
  readonly app: number;
  /** The run from it to the route names. */
  readonly wire: number;
  readonly pill: number;
  /** The run in which a machine's routes close up from their names to its card. */
  readonly pillGap: number;
  readonly card: number;
  readonly target: number;
  /** The run from the environments, past their lanes, to the machines they link to. */
  readonly linkRun: number;
  readonly laneFirst: number;
  readonly betweenFirst: number;
  readonly betweenLast: number;
}

const REGULAR: FleetMetrics = {
  app: 136,
  wire: 72,
  pill: 82,
  pillGap: 20,
  card: 164,
  target: 188,
  linkRun: 92,
  laneFirst: 24,
  betweenFirst: 16,
  betweenLast: 6,
};
/** The least each measure can be with its text still whole: a narrow settings column. */
const COMPACT: FleetMetrics = {
  app: 124,
  wire: 28,
  pill: 72,
  pillGap: 14,
  card: 148,
  target: 146,
  linkRun: 36,
  laneFirst: 18,
  betweenFirst: 14,
  betweenLast: 4,
};
/** Past this the map is enlarged instead: longer wires would only pull the columns apart. */
const ROOMY: FleetMetrics = {
  app: 148,
  wire: 112,
  pill: 88,
  pillGap: 26,
  card: 180,
  target: 220,
  linkRun: 132,
  laneFirst: 24,
  betweenFirst: 16,
  betweenLast: 6,
};

const mixMetrics = (from: FleetMetrics, to: FleetMetrics, t: number): FleetMetrics => {
  const at = (key: keyof FleetMetrics) => Math.floor(from[key] + (to[key] - from[key]) * t);
  return {
    app: at("app"),
    wire: at("wire"),
    pill: at("pill"),
    pillGap: at("pillGap"),
    card: at("card"),
    target: at("target"),
    linkRun: at("linkRun"),
    laneFirst: at("laneFirst"),
    betweenFirst: at("betweenFirst"),
    betweenLast: at("betweenLast"),
  };
};
const CHIP = { width: 124, height: 26 };
const CHIP_GAP = 6;
const FRAME_PAD = 8;
/** Between a stack's card and the tray it opens. */
const TRAY_GAP = 4;
/** Narrower than this a machine's name no longer reads, so a tray gives up a column instead. */
const CHIP_MIN_WIDTH = 60;
const GROUP_GAP = 28;
const BAY_GAP = 12;
const LANE_STEP = 14;
const LANE_CLEARANCE = 10;
const ARROW_LENGTH = 6;
/** The least run a link keeps from the last lane to a machine: its turn and its arrowhead. */
const LINK_RUN_MIN = 20;
/** How far apart two hosts' links enter one machine, so each keeps its own last stretch. */
const ENTRY_PITCH = 14;
/** The channel left of the cards that links between environments keep to themselves. */
const BETWEEN = { step: 14 };
/**
 * Where those links meet a card's left edge: past its routes, the outermost lane innermost,
 * `margin` short of the corner. The card never grows for them: the pitch gives way instead.
 */
const LINK_PORT = { first: 10, pitch: FLEET_LANE_PITCH, margin: 4 };
const CORNER = 8;
const BADGE = { width: 120, height: 20, overhang: 5, gap: 4 };

/** Horizontal, a vertical run at `viaX`, then horizontal again, with rounded turns. */
function elbowPath(x0: number, y0: number, viaX: number, x1: number, y1: number): string {
  const dy = y1 - y0;
  if (Math.abs(dy) < 1) return `M${x0} ${y0}H${x1}`;
  const r = Math.min(CORNER, Math.abs(dy) / 2, Math.abs(viaX - x0), Math.abs(x1 - viaX));
  const sy = Math.sign(dy);
  const inX = Math.sign(viaX - x0);
  const outX = Math.sign(x1 - viaX);
  return [
    `M${x0} ${y0}`,
    `H${viaX - inX * r}`,
    `Q${viaX} ${y0} ${viaX} ${y0 + sy * r}`,
    `V${y1 - sy * r}`,
    `Q${viaX} ${y1} ${viaX + outX * r} ${y1}`,
    `H${x1}`,
  ].join("");
}

/** `elbowPath` cut halfway along its vertical run: the half it starts with, then the other. */
function elbowHalves(x0: number, y0: number, viaX: number, x1: number, y1: number) {
  const dy = y1 - y0;
  const mid = (y0 + y1) / 2;
  const r = Math.min(CORNER, Math.abs(dy) / 2, Math.abs(viaX - x0), Math.abs(x1 - viaX));
  const sy = Math.sign(dy);
  const inX = Math.sign(viaX - x0);
  const outX = Math.sign(x1 - viaX);
  return [
    `M${x0} ${y0}H${viaX - inX * r}Q${viaX} ${y0} ${viaX} ${y0 + sy * r}V${mid}`,
    `M${viaX} ${mid}V${y1 - sy * r}Q${viaX} ${y1} ${viaX + outX * r} ${y1}H${x1}`,
  ] as const;
}

/** Straight to `fanX`, across any lanes so they only ever meet it square, then a curve. */
const sCurve = (x0: number, y0: number, x1: number, y1: number, fanX = x0) => {
  // A short run bends within itself, so it still arrives level instead of doubling back.
  const reach = Math.max(Math.min(24, (x1 - fanX) * 0.6), (x1 - fanX) / 2);
  const lead = fanX > x0 ? `H${fanX}` : "";
  return `M${x0} ${y0}${lead}C${fanX + reach} ${y0} ${x1 - reach} ${y1} ${x1} ${y1}`;
};

const frameColumns = (count: number) => Math.max(2, Math.min(4, Math.ceil(Math.sqrt(count / 2.2))));

/** What an open stack draws: its shown machines, and one more card when some are left out. */
const frameCells = (stack: FleetStack) =>
  stack.shownIds.length + Number(stack.memberIds.length > stack.shownIds.length);

const trayWidth = (columns: number) => FRAME_PAD * 2 + columns * (CHIP.width + CHIP_GAP) - CHIP_GAP;

/** What an open stack adds below its card. */
const trayHeight = (stack: FleetStack, columns: number) =>
  TRAY_GAP +
  FRAME_PAD * 2 +
  Math.ceil(frameCells(stack) / columns) * (CHIP.height + CHIP_GAP) -
  CHIP_GAP;

/**
 * What an open stack of link targets has to stay within, both read off the map with every stack
 * closed: the width its tray can take without the view shrinking to show it, and where its
 * column stood, so opening one neither rescales the map nor moves a column.
 */
interface FleetTrayRoom {
  readonly width: number;
  readonly bayX: number | null;
}

const closedStacks = (stacks: ReadonlyArray<FleetStack>) =>
  stacks.some((stack) => stack.expanded)
    ? stacks.map((stack) => (stack.expanded ? { ...stack, expanded: false } : stack))
    : stacks;

/** One line into a machine or a stack, from the environment holding the link. */
interface BayEntry {
  readonly key: string;
  readonly from: string;
}

type BayItem =
  | {
      readonly kind: "target";
      readonly targetId: string;
      readonly label: string;
      readonly access: AuthMcpClientAccess;
      readonly entries: ReadonlyArray<BayEntry>;
    }
  | {
      readonly kind: "stack";
      readonly stack: FleetStack;
      readonly label: string;
      readonly access: AuthMcpClientAccess;
      readonly entries: ReadonlyArray<BayEntry>;
    };

type ColumnEntry =
  | { readonly kind: "host"; readonly id: string; readonly host: FleetNode }
  | { readonly kind: "fold"; readonly id: string; readonly stack: FleetStack };

interface FleetRow {
  readonly entries: ColumnEntry[];
  readonly items: ReadonlyArray<BayItem>;
}

/** One host's vertical run to a row of shared machines, kept to itself for its whole span. */
interface FleetLane {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  /** Where its links turn off towards their machines. */
  readonly branches: ReadonlyArray<number>;
  index: number;
}

const stackLineKey = (stackId: string, sourceId: string) => `${stackId}<${sourceId}`;

const pushTo = <K, V>(into: Map<K, V[]>, key: K, value: V) => {
  const list = into.get(key);
  if (list === undefined) into.set(key, [value]);
  else list.push(value);
};

/**
 * The map at the width it is given. It gives up gutters, wire runs and card width before the fit
 * has to shrink it, and takes more of each on a wide canvas, up to a point. With no width it is
 * laid out at its regular measures.
 */
export function layoutFleetGraph(
  graph: FleetGraph,
  stacks: ReadonlyArray<FleetStack> = [],
  canvasWidth?: number,
): FleetLayout {
  // The measures follow the map with every stack closed, so opening one moves no column.
  const closed = closedStacks(stacks);
  const { metrics, layout } = fitFleetMetrics(graph, closed, canvasWidth);
  if (closed === stacks) return layout;
  if (canvasWidth === undefined) {
    const bayX = layout.columns.find((column) => column.id === "targets")?.x ?? null;
    return layoutFleetGraphAt(graph, stacks, metrics, { width: Infinity, bayX });
  }
  const bayX = layout.columns.find((column) => column.id === "targets")?.x ?? null;
  // How much of the map the closed fit shows across: the room a tray has at that same scale.
  const room = canvasWidth - fleetFitPadding(canvasWidth) * 2;
  const shown = room / Math.min(FLEET_FIT_MAX_SCALE, room / layout.width);
  return layoutFleetGraphAt(graph, stacks, metrics, { width: shown - (bayX ?? 0), bayX });
}

function fitFleetMetrics(
  graph: FleetGraph,
  stacks: ReadonlyArray<FleetStack>,
  canvasWidth: number | undefined,
): { readonly metrics: FleetMetrics; readonly layout: FleetLayout } {
  const regular = layoutFleetGraphAt(graph, stacks, REGULAR);
  if (canvasWidth === undefined) return { metrics: REGULAR, layout: regular };
  const room = canvasWidth - fleetFitPadding(canvasWidth) * 2;
  const narrow = room < regular.width;
  // Narrower than regular, the map fits at full size. Wider, it is enlarged first.
  const wanted = narrow ? room : room / FLEET_FIT_MAX_SCALE;
  if (!narrow && wanted <= regular.width) return { metrics: REGULAR, layout: regular };
  const limit = narrow ? COMPACT : ROOMY;
  const end = layoutFleetGraphAt(graph, stacks, limit);
  if (narrow ? end.width >= wanted : end.width <= wanted) return { metrics: limit, layout: end };
  // Width is a maximum of sums of the measures, so it never exceeds this straight-line estimate.
  const t = (wanted - regular.width) / (end.width - regular.width);
  const metrics = mixMetrics(REGULAR, limit, t);
  return { metrics, layout: layoutFleetGraphAt(graph, stacks, metrics) };
}

/**
 * Links to machines seen only through a link run right of the environments, links between two
 * environments left of them, each on its own lane with its own entry. A stack takes one place
 * whatever it holds, so the cost follows what is drawn. Deterministic.
 */
function layoutFleetGraphAt(
  graph: FleetGraph,
  stacks: ReadonlyArray<FleetStack>,
  metrics: FleetMetrics,
  room: FleetTrayRoom = { width: Infinity, bayX: null },
): FleetLayout {
  const CLIENT_SIZE = { width: metrics.app, height: CLIENT.height };
  const PILL_SIZE = { width: metrics.pill, height: PILL.height };
  const nodes = new Map<string, FleetRect>();
  const stackGeometry = new Map<string, FleetStackGeometry>();
  const routes = new Map<string, FleetRouteGeometry>();
  const linkGeometry = new Map<string, FleetLinkGeometry>();
  const handles = new Map<string, FleetPoint>();
  const links = graph.edges.filter(isLinkEdge);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const folds = stacks.filter((stack) => stack.kind === "environments");
  const folded = new Set(folds.flatMap((stack) => stack.memberIds));
  const hosts = graph.nodes.filter(
    (node) => (node.kind === "environment" || node.kind === "connect") && !folded.has(node.id),
  );
  const hostIndex = new Map(hosts.map((host, index) => [host.id, index]));
  const indexOf = (hostId: string) => hostIndex.get(hostId) ?? 0;
  const routesOf = new Map<string, FleetRouteEdge[]>();
  for (const edge of graph.edges) if (edge.kind === "route") pushTo(routesOf, edge.to, edge);
  const accessRank = (access: AuthMcpClientAccess) => -ACCESS_ORDER.indexOf(access);
  const labelOf = (id: string) => byId.get(id)?.label ?? "";

  const stacked = new Set(stacks.flatMap((stack) => stack.edgeIds));
  const incomingOf = new Map<string, FleetLinkEdge[]>();
  for (const link of links) {
    if (byId.get(link.to)?.kind !== "target" || stacked.has(link.id)) continue;
    pushTo(incomingOf, link.to, link);
  }
  const items: BayItem[] = [];
  for (const stack of stacks) {
    if (stack.kind !== "targets") continue;
    items.push({
      kind: "stack",
      stack,
      label: stack.firstLabel,
      access: stack.sources[0]!.access,
      entries: stack.sources.map((source) => ({
        key: stackLineKey(stack.id, source.sourceId),
        from: source.sourceId,
      })),
    });
  }
  for (const [targetId, unsorted] of incomingOf) {
    // Top to bottom in the order of the hosts, so the upper line is the upper host's.
    const incoming = unsorted.toSorted((left, right) => indexOf(left.from) - indexOf(right.from));
    items.push({
      kind: "target",
      targetId,
      label: labelOf(targetId),
      access: incoming[0]!.link.access,
      entries: incoming.map((link) => ({ key: link.id, from: link.from })),
    });
  }
  const itemId = (item: BayItem) => (item.kind === "stack" ? item.stack.id : item.targetId);
  const byName = (left: BayItem, right: BayItem) =>
    labelOrder.compare(left.label, right.label) || (itemId(left) < itemId(right) ? -1 : 1);
  const bayOf = new Map<string, BayItem[]>();
  const bandOf = new Map<string, BayItem[]>();
  for (const item of items
    .filter((entry) => entry.entries.length === 1)
    .toSorted(
      (left, right) =>
        Number(right.kind === "stack") - Number(left.kind === "stack") ||
        accessRank(left.access) - accessRank(right.access) ||
        byName(left, right),
    )) {
    pushTo(bayOf, item.entries[0]!.from, item);
  }
  // Below the middle host of those linking to it: the shortest total reach, with ties going up.
  const meanSource = (item: BayItem) =>
    item.entries.reduce((sum, entry) => sum + indexOf(entry.from), 0) / item.entries.length;
  for (const item of items
    .filter((entry) => entry.entries.length > 1)
    .toSorted((left, right) => meanSource(left) - meanSource(right) || byName(left, right))) {
    pushTo(bandOf, item.entries[Math.floor((item.entries.length - 1) / 2)]!.from, item);
  }

  // A machine with no links rides beside a shared row instead of pushing the hosts further apart.
  const linked = new Set(links.flatMap((link) => [link.from, link.to]));
  const rows: FleetRow[] = [];
  let shared: FleetRow | null = null;
  for (const host of hosts) {
    const entry: ColumnEntry = { kind: "host", id: host.id, host };
    if (shared !== null && !linked.has(host.id)) {
      shared.entries.push(entry);
      continue;
    }
    rows.push({ entries: [entry], items: bayOf.get(host.id) ?? [] });
    const band = bandOf.get(host.id);
    shared = band === undefined ? null : { entries: [], items: band };
    if (shared !== null) rows.push(shared);
  }
  for (const stack of folds) {
    const entry: ColumnEntry = { kind: "fold", id: stack.id, stack };
    if (shared !== null) shared.entries.push(entry);
    else rows.push({ entries: [entry], items: [] });
  }

  // Links between environments: shorter ones take the lanes nearer the cards, and two share a
  // lane when no host lies between both pairs, so a chain of links reads as one line.
  const reach = (link: FleetLinkEdge) => Math.abs(indexOf(link.to) - indexOf(link.from));
  const low = (link: FleetLinkEdge) => Math.min(indexOf(link.from), indexOf(link.to));
  const high = (link: FleetLinkEdge) => Math.max(indexOf(link.from), indexOf(link.to));
  // A two-way link is drawn once, as the link from the machine listed first.
  const pairs = fleetTwoWayLinks(graph);
  const twoWay = (link: FleetLinkEdge) => pairs.has(link.id);
  const between = links
    .filter(
      (link) =>
        hostIndex.has(link.from) &&
        hostIndex.has(link.to) &&
        fleetDrawnLinkId(pairs, link.id) === link.id,
    )
    .toSorted((left, right) => reach(left) - reach(right) || (left.id < right.id ? -1 : 1));
  const betweenLanes: FleetLinkEdge[][] = [];
  const betweenLane = new Map<string, number>();
  for (const link of between) {
    let index = 0;
    while (
      betweenLanes[index]?.some(
        (other) => Math.max(low(other), low(link)) < Math.min(high(other), high(link)),
      )
    ) {
      index += 1;
    }
    betweenLane.set(link.id, index);
    (betweenLanes[index] ??= []).push(link);
  }
  // Such a link meets a card's left edge above its routes when the other machine is above,
  // below them when it is below. Each arrowhead has its own port, the outer lane's nearer the
  // middle so two never cross. Links out on a side share one port; a two-way link arrives at
  // both its cards.
  const leaves = new Set<string>();
  const arrivalsOf = new Map<string, FleetLinkEdge[]>();
  for (const link of between) {
    const down = Math.sign(indexOf(link.to) - indexOf(link.from));
    if (twoWay(link)) pushTo(arrivalsOf, `${link.from}:${down}`, link);
    else leaves.add(`${link.from}:${down}`);
    pushTo(arrivalsOf, `${link.to}:${-down}`, link);
  }
  for (const ports of arrivalsOf.values()) {
    ports.sort((left, right) => betweenLane.get(right.id)! - betweenLane.get(left.id)!);
  }
  const routesInto = (hostId: string) => routesOf.get(hostId)?.length ?? 0;
  // A card's size follows its name alone, so what attaches to it never stretches it. The name
  // is measured in characters against the narrowest card, so no height changes with the width.
  const cardHeight = (host: FleetNode) =>
    host.kind === "connect"
      ? OFFER.height
      : host.label.length > CARD.nameLine
        ? CARD.twoLines
        : CARD.height;
  const routeEntryPitch = (hostId: string) =>
    routesInto(hostId) < 2
      ? 0
      : Math.min(ROUTE_ENTRY.pitch, ROUTE_ENTRY.spread / (routesInto(hostId) - 1));
  const routesExtent = (hostId: string) =>
    (Math.max(1, routesInto(hostId)) - 1) * routeEntryPitch(hostId) * 0.5;
  const linkPortPitch = (host: FleetNode, side: number) => {
    const key = `${host.id}:${side}`;
    const ports = Number(leaves.has(key)) + (arrivalsOf.get(key)?.length ?? 0);
    const room = cardHeight(host) / 2 - LINK_PORT.margin - routesExtent(host.id) - LINK_PORT.first;
    return ports < 2 ? 0 : Math.min(LINK_PORT.pitch, room / (ports - 1));
  };
  const pillsHeight = (hostId: string) =>
    (Math.max(1, routesInto(hostId)) - 1) * FLEET_ROUTE_PITCH + PILL.height;
  const foldFace = { width: metrics.card - STACK.lift, height: STACK.height };
  const closedWidth = metrics.target + STACK.lift;
  /**
   * A group of environments opens one machine wide, under its card. Link targets take the
   * columns there is room for, and with no room to spare two narrow ones under the closed stack.
   */
  const trayShape = (stack: FleetStack) => {
    if (stack.kind === "environments") return { columns: 1, width: metrics.card };
    const wanted = frameColumns(frameCells(stack));
    const fitting = Math.floor((room.width - FRAME_PAD * 2 + CHIP_GAP) / (CHIP.width + CHIP_GAP));
    if (fitting >= 2) {
      const columns = Math.min(wanted, fitting);
      return { columns, width: Math.max(closedWidth, trayWidth(columns)) };
    }
    const width = Math.max(closedWidth, Math.min(room.width, trayWidth(2)));
    return {
      columns: (width - FRAME_PAD * 2 - CHIP_GAP) / 2 < CHIP_MIN_WIDTH ? 1 : 2,
      width,
    };
  };
  /** `open` false is the place an entry takes with its stack closed, which is where it starts. */
  const entryHeight = (entry: ColumnEntry, open: boolean) =>
    entry.kind === "host"
      ? // The place a card takes in the column: its own height, or what its route names need.
        Math.max(cardHeight(entry.host), pillsHeight(entry.id) - PILL_OVERHANG * 2)
      : STACK.height +
        STACK.lift +
        (open && entry.stack.expanded
          ? trayHeight(entry.stack, trayShape(entry.stack).columns)
          : 0);
  /** Tall enough that each line in keeps its own entry. */
  const faceHeight = (item: BayItem, least: number) =>
    Math.max(least, 20 + (item.entries.length - 1) * ENTRY_PITCH);
  const itemSize = (item: BayItem, open: boolean) => {
    if (item.kind === "target") {
      return { width: metrics.target, height: faceHeight(item, TARGET.height) };
    }
    const closed = {
      width: closedWidth,
      height:
        faceHeight(item, STACK.height + (fleetStackPartial(item.stack) ? STACK.partial : 0)) +
        STACK.lift,
    };
    if (!open || !item.stack.expanded) return closed;
    const shape = trayShape(item.stack);
    return {
      width: shape.width,
      height: closed.height + trayHeight(item.stack, shape.columns),
    };
  };
  /** Places an open stack's machines in the tray below its card, and returns the card for the rest. */
  const fillTray = (stack: FleetStack, face: FleetRect): FleetRect | null => {
    const { columns, width } = trayShape(stack);
    const chipWidth = (width - FRAME_PAD * 2 - (columns - 1) * CHIP_GAP) / columns;
    const cell = (index: number): FleetRect => ({
      x: face.x + FRAME_PAD + (index % columns) * (chipWidth + CHIP_GAP),
      y:
        face.y +
        face.height +
        TRAY_GAP +
        FRAME_PAD +
        Math.floor(index / columns) * (CHIP.height + CHIP_GAP),
      width: chipWidth,
      height: CHIP.height,
    });
    stack.shownIds.forEach((memberId, index) => nodes.set(memberId, cell(index)));
    return stack.memberIds.length > stack.shownIds.length ? cell(stack.shownIds.length) : null;
  };
  /** An open stack's footprint, its card and tray, and the tray alone. */
  const openRects = (stack: FleetStack, face: FleetRect) => {
    const { columns, width } = trayShape(stack);
    const height = trayHeight(stack, columns);
    return {
      rect: { x: face.x, y: face.y, width, height: face.height + height },
      tray: {
        x: face.x,
        y: face.y + face.height + TRAY_GAP,
        width,
        height: height - TRAY_GAP,
      },
    };
  };

  const pillX = metrics.app + metrics.wire;
  const cardX =
    pillX +
    metrics.pill +
    metrics.pillGap +
    (betweenLanes.length === 0
      ? 0
      : metrics.betweenLast + (betweenLanes.length - 1) * BETWEEN.step + metrics.betweenFirst);
  const cardRight = cardX + metrics.card;

  // Heights first: which lanes the channel needs, and so how wide it is, follows from them.
  // Rows are spaced as if every stack were closed, so an open one grows down from where its
  // card was and moves only what its tray would otherwise cover.
  const placed: Array<{
    readonly item: BayItem;
    readonly y: number;
    readonly size: { readonly width: number; readonly height: number };
    /** The item's height with its stack closed: where its card ends. */
    readonly closedHeight: number;
  }> = [];
  const column: Array<{ readonly entry: ColumnEntry; readonly center: number }> = [];
  /** Where each entry's middle is with every stack closed: this app's card is set by these. */
  const restCenters: number[] = [];
  /** Where a card's routes arrive and its links leave: its middle. */
  const anchors = new Map<string, number>();
  let y = HEADER;
  let cardFloor = -Infinity;
  let bayFloor = -Infinity;
  for (const row of rows) {
    const heights = row.entries.map((entry) => entryHeight(entry, false));
    const cardsHeight = heights.reduce((sum, height) => sum + height + GROUP_GAP, -GROUP_GAP);
    const sizes = row.items.map((item) => itemSize(item, false));
    const bayHeight = sizes.reduce((sum, size) => sum + size.height + BAY_GAP, -BAY_GAP);
    const rowHeight = Math.max(cardsHeight, bayHeight);
    let restY = y + (rowHeight - cardsHeight) / 2;
    row.entries.forEach((entry, index) => {
      const rest = heights[index]!;
      const cardY = Math.max(restY, cardFloor);
      if (entry.kind === "host") {
        const anchor = cardY + rest / 2;
        const own = cardHeight(entry.host);
        nodes.set(entry.id, { x: cardX, y: anchor - own / 2, width: metrics.card, height: own });
        anchors.set(entry.id, anchor);
        if (entry.host.kind === "environment") handles.set(entry.id, { x: cardRight, y: anchor });
        column.push({ entry, center: anchor });
        restCenters.push(restY + rest / 2);
      } else {
        const face = { x: cardX, y: cardY + STACK.lift, ...foldFace };
        stackGeometry.set(entry.id, {
          ...(entry.stack.expanded
            ? openRects(entry.stack, face)
            : { rect: { x: cardX, y: cardY, width: metrics.card, height: rest }, tray: null }),
          face,
          lines: [],
          more: entry.stack.expanded ? fillTray(entry.stack, face) : null,
        });
        column.push({ entry, center: face.y + face.height / 2 });
        restCenters.push(restY + STACK.lift + face.height / 2);
      }
      cardFloor = cardY + entryHeight(entry, true) + GROUP_GAP;
      restY += rest + GROUP_GAP;
    });
    let restItemY = y + (rowHeight - bayHeight) / 2;
    row.items.forEach((item, index) => {
      const itemY = Math.max(restItemY, bayFloor);
      const size = itemSize(item, true);
      placed.push({ item, y: itemY, size, closedHeight: sizes[index]!.height });
      bayFloor = itemY + size.height + BAY_GAP;
      restItemY += sizes[index]!.height + BAY_GAP;
    });
    y += rowHeight + GROUP_GAP;
  }
  let height = Math.max(
    HEADER + CLIENT.height,
    y - GROUP_GAP,
    cardFloor - GROUP_GAP,
    bayFloor - BAY_GAP,
  );

  const centerOf = (id: string) => anchors.get(id)!;

  /** What a line into the item points at: the machine, or the stack's card, open or closed. */
  const faceOf = (item: BayItem, itemY: number, closedHeight: number) =>
    item.kind === "target"
      ? { top: itemY, height: closedHeight }
      : { top: itemY + STACK.lift, height: closedHeight - STACK.lift };
  /** Where each line into the item arrives. */
  const entryY = new Map<string, number>();
  for (const { item, y: itemY, closedHeight } of placed) {
    const face = faceOf(item, itemY, closedHeight);
    item.entries.forEach((entry, index) => {
      entryY.set(
        entry.key,
        face.top + face.height / 2 + (index - (item.entries.length - 1) / 2) * ENTRY_PITCH,
      );
    });
  }
  const portY = (link: FleetLinkEdge, hostId: string) => {
    const side = Math.sign(indexOf(link.from === hostId ? link.to : link.from) - indexOf(hostId));
    const key = `${hostId}:${side}`;
    const port =
      link.from === hostId && !twoWay(link)
        ? 0
        : Number(leaves.has(key)) + arrivalsOf.get(key)!.indexOf(link);
    return (
      centerOf(hostId) +
      side *
        (routesExtent(hostId) + LINK_PORT.first + port * linkPortPitch(byId.get(hostId)!, side))
    );
  };

  // One lane per host for each shared row it reaches.
  const trunkOf = new Map<string, FleetLane>();
  const lanes: FleetLane[] = [];
  for (const [anchor, band] of bandOf) {
    const byHost = new Map<string, BayEntry[]>();
    for (const item of band) for (const entry of item.entries) pushTo(byHost, entry.from, entry);
    for (const [hostId, mine] of byHost) {
      const from = centerOf(hostId);
      const branches = mine.map((entry) => entryY.get(entry.key)!);
      const lane: FleetLane = {
        id: `${hostId}>${anchor}`,
        from,
        to: branches.reduce((far, at) => (Math.abs(at - from) > Math.abs(far - from) ? at : far)),
        branches,
        index: 0,
      };
      for (const entry of mine) trunkOf.set(entry.key, lane);
      lanes.push(lane);
    }
  }
  const span = (lane: FleetLane) => Math.abs(lane.to - lane.from);
  const passes = (lane: FleetLane, at: number) =>
    at > Math.min(lane.from, lane.to) && at < Math.max(lane.from, lane.to);
  // What `inner` nearer the cards costs: each of its turn-offs that has to cross `outer`, and
  // `outer` leaving its host across it. Of two lanes the one that costs less goes inside.
  const crossings = (inner: FleetLane, outer: FleetLane) =>
    inner.branches.filter((at) => passes(outer, at)).length + Number(passes(inner, outer.from));
  const taken: FleetLane[][] = [];
  for (const lane of lanes
    .toSorted((left, right) => (left.id < right.id ? -1 : 1))
    .toSorted(
      (left, right) => crossings(left, right) - crossings(right, left) || span(left) - span(right),
    )) {
    const top = Math.min(lane.from, lane.to) - LANE_CLEARANCE;
    const bottom = Math.max(lane.from, lane.to) + LANE_CLEARANCE;
    let index = 0;
    while (
      taken[index]?.some(
        (other) => Math.min(other.from, other.to) < bottom && top < Math.max(other.from, other.to),
      )
    ) {
      index += 1;
    }
    lane.index = index;
    (taken[index] ??= []).push(lane);
  }
  const laneX = (lane: FleetLane) => cardRight + metrics.laneFirst + lane.index * LANE_STEP;
  const fanX =
    taken.length === 0 ? cardRight : cardRight + metrics.laneFirst + taken.length * LANE_STEP;
  // Machines an open stack pushed down can need a lane more. It comes out of the run to their
  // column while that has any to give, so the column stays where it stood.
  const bayX =
    room.bayX === null
      ? fanX + metrics.linkRun
      : Math.max(room.bayX, fanX + Math.min(metrics.linkRun, LINK_RUN_MIN));
  const endX = bayX - ARROW_LENGTH;
  const lineInto = (entry: BayEntry) => {
    const trunk = trunkOf.get(entry.key);
    const targetY = entryY.get(entry.key)!;
    return {
      d:
        trunk === undefined
          ? sCurve(cardRight, centerOf(entry.from), endX, targetY, fanX)
          : elbowPath(cardRight, trunk.from, laneX(trunk), endX, targetY),
      arrow: { x: bayX, y: targetY },
    };
  };

  let width = fanX;
  for (const { item, y: itemY, size, closedHeight } of placed) {
    width = Math.max(width, bayX + size.width);
    if (item.kind === "target") {
      nodes.set(item.targetId, { x: bayX, y: itemY, ...size });
      for (const entry of item.entries) {
        const line = lineInto(entry);
        linkGeometry.set(entry.key, {
          d: line.d,
          arrow: { ...line.arrow, dir: 1 },
          twoWay: null,
          badge: null,
        });
      }
      continue;
    }
    const { stack } = item;
    const { top, height: faceHeight } = faceOf(item, itemY, closedHeight);
    const face = { x: bayX, y: top, width: metrics.target, height: faceHeight };
    stackGeometry.set(stack.id, {
      ...(stack.expanded
        ? openRects(stack, face)
        : { rect: { x: bayX, y: itemY, ...size }, tray: null }),
      face,
      lines: item.entries.map((entry, index) => ({
        sourceId: entry.from,
        access: stack.sources[index]!.access,
        ...lineInto(entry),
      })),
      more: stack.expanded ? fillTray(stack, face) : null,
    });
  }

  const clientCenterY =
    restCenters.length === 0
      ? HEADER + CLIENT.height / 2
      : (restCenters[0]! + restCenters.at(-1)!) / 2;
  nodes.set(FLEET_CLIENT_NODE_ID, {
    x: 0,
    y: clientCenterY - CLIENT.height / 2,
    ...CLIENT_SIZE,
  });

  // Wires leave the client a little apart, in the order they arrive, so they never cross. A
  // folded group of environments gets one wire, whatever its machines' routes are.
  // Each route is named in a column beside its card, then closes up into the card's edge.
  const wires = column.flatMap(
    ({
      entry,
      center,
    }): Array<{
      entry: ColumnEntry;
      edge: FleetRouteEdge | null;
      portY: number;
      entryY: number;
    }> => {
      if (entry.kind === "fold") return [{ entry, edge: null, portY: center, entryY: center }];
      const hostRoutes = routesOf.get(entry.id) ?? [];
      return hostRoutes.map((edge, index) => {
        const offset = index - (hostRoutes.length - 1) / 2;
        return {
          entry,
          edge,
          portY: center + offset * FLEET_ROUTE_PITCH,
          entryY: center + offset * routeEntryPitch(entry.id),
        };
      });
    },
  );
  const pillRight = pillX + metrics.pill;
  const closeX = pillRight + metrics.pillGap;
  const pillColumns: FleetRect[] = [];
  const fan = Math.min(CLIENT.height - 20, (wires.length - 1) * 4);
  wires.forEach((wire, index) => {
    const startY =
      clientCenterY + (wires.length < 2 ? 0 : (index / (wires.length - 1) - 0.5) * fan);
    const close =
      wire.entryY === wire.portY
        ? ""
        : `H${pillRight}C${pillRight + metrics.pillGap / 2} ${wire.portY} ${closeX - metrics.pillGap / 2} ${wire.entryY} ${closeX} ${wire.entryY}`;
    const d = `${sCurve(metrics.app, startY, pillX, wire.portY)}${close}H${cardX}`;
    if (wire.edge === null) {
      const geometry = stackGeometry.get(wire.entry.id)!;
      stackGeometry.set(wire.entry.id, {
        ...geometry,
        lines: [{ sourceId: null, access: null, d, arrow: null }],
      });
      return;
    }
    const pill = { x: pillX, y: wire.portY - PILL.height / 2, ...PILL_SIZE };
    routes.set(wire.edge.id, { d, pill });
    pillColumns.push(pill);
    height = Math.max(height, pill.y + pill.height);
  });

  // A link between environments names its access on its own lane, in a gap between two cards:
  // the one just past the environment it leaves, or the next one free. It grows away from the
  // other lanes passing there. Where no place is clear of every lane and every other name, the
  // name is shown only while its link is in focus, so it never covers a line that is being read.
  const runs = between.map((link) => ({
    link,
    x: cardX - metrics.betweenFirst - betweenLane.get(link.id)! * BETWEEN.step,
    from: portY(link, link.from),
    to: portY(link, link.to),
  }));
  const badges: FleetLinkBadge[] = [];
  for (const run of runs) {
    const { link, x } = run;
    const down = indexOf(link.to) > indexOf(link.from);
    const gaps: number[] = [];
    for (let index = low(link); index < high(link); index += 1) {
      const above = nodes.get(hosts[index]!.id)!;
      const below = nodes.get(hosts[index + 1]!.id)!;
      gaps.push(above.y + above.height + GROUP_GAP / 2, below.y - GROUP_GAP / 2);
    }
    if (!down) gaps.reverse();
    const place = (at: number, side: 1 | -1): FleetLinkBadge => ({
      x: side === 1 ? x - BADGE.overhang : x + BADGE.overhang - BADGE.width,
      y: at - BADGE.height / 2,
      width: BADGE.width,
      height: BADGE.height,
      side,
      onDemand: false,
    });
    const clearOfLanes = (badge: FleetLinkBadge) =>
      !runs.some(
        (other) =>
          other !== run &&
          other.x > badge.x &&
          other.x < badge.x + badge.width &&
          Math.min(other.from, other.to) < badge.y + badge.height &&
          Math.max(other.from, other.to) > badge.y,
      );
    const clearOfNames = (badge: FleetLinkBadge) =>
      !badges.some(
        (other) =>
          other.x < badge.x + badge.width + BADGE.gap &&
          badge.x < other.x + other.width + BADGE.gap &&
          other.y < badge.y + badge.height + BADGE.gap &&
          badge.y < other.y + other.height + BADGE.gap,
      );
    // Route names reach past their card into the gaps a name would take on that side.
    const clearOfRoutes = (badge: FleetLinkBadge) =>
      !pillColumns.some(
        (pill) =>
          pill.x < badge.x + badge.width &&
          badge.x < pill.x + pill.width &&
          pill.y < badge.y + badge.height &&
          badge.y < pill.y + pill.height,
      );
    const options = gaps.flatMap((at) => [place(at, 1), place(at, -1)]);
    const clear = options.find(
      (option) => clearOfNames(option) && clearOfLanes(option) && clearOfRoutes(option),
    );
    if (clear !== undefined) badges.push(clear);
    const startX = twoWay(link) ? cardX - ARROW_LENGTH : cardX;
    const [back, forward] = elbowHalves(startX, run.from, x, cardX - ARROW_LENGTH, run.to);
    linkGeometry.set(link.id, {
      d: elbowPath(startX, run.from, x, cardX - ARROW_LENGTH, run.to),
      arrow: { x: cardX, y: run.to, dir: 1 },
      twoWay: twoWay(link) ? { backArrow: { x: cardX, y: run.from, dir: 1 }, forward, back } : null,
      badge: clear ?? { ...options[0]!, onDemand: true },
    });
  }

  return {
    nodes,
    stacks: stackGeometry,
    routes,
    links: linkGeometry,
    handles,
    columns: [
      { id: "client", x: 0 },
      ...(column.length > 0 ? [{ id: "environments" as const, x: cardX }] : []),
      ...(placed.length > 0 ? [{ id: "targets" as const, x: bayX }] : []),
    ],
    width,
    height,
  };
}

/** What the arrow keys move between: every machine drawn, and each stack's controls. */
export function fleetFocusRects(layout: FleetLayout): ReadonlyMap<string, FleetRect> {
  const rects = new Map(layout.nodes);
  for (const [id, geometry] of layout.stacks) {
    rects.set(id, geometry.face);
    if (geometry.more !== null) rects.set(fleetMoreNodeId(id), geometry.more);
  }
  return rects;
}

/** The machines drawn on their own that a selection box touches. */
export function fleetNodesInBox(layout: FleetLayout, box: FleetRect): string[] {
  const inside: string[] = [];
  for (const [id, rect] of layout.nodes) {
    if (
      id !== FLEET_CLIENT_NODE_ID &&
      rect.x < box.x + box.width &&
      box.x < rect.x + rect.width &&
      rect.y < box.y + box.height &&
      box.y < rect.y + rect.height
    ) {
      inside.push(id);
    }
  }
  return inside;
}

/** What pressing or dropping an environment's link handle starts. */
export type FleetLinkAction =
  /** The batch flow, opened on these machines. Which of them it can link is its own to say. */
  | {
      readonly kind: "batch";
      readonly sourceEnvironmentId: EnvironmentId;
      readonly environmentIds: ReadonlyArray<EnvironmentId>;
    }
  /**
   * None of the machines dropped on can be linked from here in one go: this client has no
   * session on any of them, so each needs a pairing code. `machineIds` are the map's nodes.
   */
  | {
      readonly kind: "code-only";
      readonly sourceId: string;
      readonly sourceEnvironmentId: EnvironmentId;
      readonly machineIds: ReadonlyArray<string>;
    }
  /** The single link flow; `offer` is null when no machine was named. */
  | {
      readonly kind: "single";
      readonly sourceEnvironmentId: EnvironmentId;
      readonly offer: Extract<FleetLinkOffer, { kind: "link" }> | null;
    };

/**
 * A drop on a stack links to its machines; a drop on a selected machine, or a press of the
 * handle while others are selected, links to the selection. Anything else is one link.
 */
export function fleetLinkAction(
  graph: FleetGraph,
  stacks: ReadonlyArray<FleetStack>,
  selected: ReadonlySet<string>,
  sourceId: string,
  targetId: string | null,
): FleetLinkAction | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const source = byId.get(sourceId);
  if (source?.kind !== "environment" || source.linking !== "ready") return null;
  const sourceEnvironmentId = source.environmentId;
  const batch = (picked: Iterable<string>): FleetLinkAction | null => {
    const environmentIds = new Set<EnvironmentId>();
    const machineIds: string[] = [];
    let known = false;
    for (const id of picked) {
      const node = byId.get(id);
      if (node === undefined || node.kind === "client" || node.id === source.id) continue;
      if (!environmentIds.has(node.environmentId)) machineIds.push(node.id);
      environmentIds.add(node.environmentId);
      known ||= node.kind !== "target";
    }
    if (environmentIds.size === 0) return null;
    if (known) return { kind: "batch", sourceEnvironmentId, environmentIds: [...environmentIds] };
    const [only, ...rest] = machineIds;
    if (rest.length > 0 || only === undefined) {
      return { kind: "code-only", sourceId: source.id, sourceEnvironmentId, machineIds };
    }
    // One such machine is the single flow's, which asks for its code.
    const offer = fleetLinkOffer(graph, sourceId, only);
    return offer.kind === "link" ? { kind: "single", sourceEnvironmentId, offer } : null;
  };
  const stack = targetId === null ? undefined : stacks.find((entry) => entry.id === targetId);
  if (stack !== undefined) return batch(stack.memberIds);
  if (targetId === null || selected.has(targetId)) {
    const picked = batch(selected);
    if (picked !== null) return picked;
  }
  if (targetId === null) return { kind: "single", sourceEnvironmentId, offer: null };
  const offer = fleetLinkOffer(graph, sourceId, targetId);
  return offer.kind === "link" ? { kind: "single", sourceEnvironmentId, offer } : null;
}

/** Machines whose name holds the query, drawn or folded, in name order. */
export function fleetSearch(graph: FleetGraph, query: string): string[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [];
  return graph.nodes
    .filter((node) => node.kind !== "client" && node.label.toLocaleLowerCase().includes(needle))
    .toSorted((left, right) => labelOrder.compare(left.label, right.label))
    .map((node) => node.id);
}

export type FleetDirection = "up" | "down" | "left" | "right";

/** The nearest item in that direction, for arrow keys. Sideways distance counts double. */
export function nextFleetNode(
  rects: ReadonlyMap<string, FleetRect>,
  fromId: string,
  direction: FleetDirection,
): string | null {
  const from = rects.get(fromId);
  if (!from) return null;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const center = (rect: FleetRect) => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  const origin = center(from);
  let best: { readonly id: string; readonly score: number } | null = null;
  for (const [id, rect] of rects) {
    if (id === fromId) continue;
    const point = center(rect);
    const along = sign * (horizontal ? point.x - origin.x : point.y - origin.y);
    const across = Math.abs(horizontal ? point.y - origin.y : point.x - origin.x);
    if (along < 1) continue;
    const score = along + across * 2;
    if (best === null || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

export interface FleetViewTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

const FLEET_MIN_SCALE = 0.3;
const FLEET_MAX_SCALE = 2;
/** A small setup is enlarged to fill the canvas, but not until two machines look like a poster. */
const FLEET_FIT_MAX_SCALE = 1.15;
/** The fit never has to go below this on a map with its stacks closed, down to a 560px canvas. */
export const FLEET_FIT_LEGIBLE_SCALE = 0.85;

/** The canvas width a layout is made for: steps, so dragging a window edge relays it rarely. */
export const fleetLayoutWidth = (canvasWidth: number) => Math.floor(canvasWidth / 16) * 16;

/** The margin the fit leaves around the map: a narrow canvas spends less of itself on it. */
const fleetFitPadding = (canvasWidth: number) => (canvasWidth < 720 ? 16 : 28);

const fitScale = (available: number, extent: number, padding: number) =>
  Math.max(0.01, (available - padding * 2) / Math.max(1, extent));

/** Centers the whole map in the viewport at the largest scale that shows all of it. */
export function fitFleetLayout(
  layout: Pick<FleetLayout, "width" | "height">,
  viewport: { readonly width: number; readonly height: number },
): FleetViewTransform {
  const padding = fleetFitPadding(viewport.width);
  const scale = Math.min(
    FLEET_FIT_MAX_SCALE,
    fitScale(viewport.width, layout.width, padding),
    fitScale(viewport.height, layout.height, padding),
  );
  return {
    scale,
    x: (viewport.width - layout.width * scale) / 2,
    y: (viewport.height - layout.height * scale) / 2,
  };
}

/** How tall the canvas wants to be at this width: the fitted map plus padding, within bounds. */
export function fleetCanvasHeight(
  layout: Pick<FleetLayout, "width" | "height">,
  width: number,
  bounds: { readonly min: number; readonly max: number },
): number {
  const padding = fleetFitPadding(width);
  const scale = Math.min(FLEET_FIT_MAX_SCALE, fitScale(width, layout.width, padding));
  const wanted = Math.ceil(layout.height * scale + padding * 2);
  return Math.max(bounds.min, Math.min(bounds.max, wanted));
}

/** Zooms by `factor`, keeping the map point under `anchor` where it is. */
export function zoomFleetView(
  view: FleetViewTransform,
  factor: number,
  anchor: FleetPoint,
  fitScale = view.scale,
): FleetViewTransform {
  // A fit of a very large setup sits below the manual minimum: zooming out stops at the fit
  // instead of jumping up, and can return to it after zooming in.
  const floor = Math.min(FLEET_MIN_SCALE, fitScale, view.scale);
  const scale = Math.max(floor, Math.min(FLEET_MAX_SCALE, view.scale * factor));
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

/** A view that is not the fit: set by hand, or kept in place while a stack opened or closed. */
export interface FleetHeldView {
  /** The shape it was set on. It holds while the map keeps that shape. */
  readonly key: string;
  readonly view: FleetViewTransform;
  readonly height: number;
  /** Eased into; a drag or pinch tracks the hand instead. */
  readonly glide: boolean;
  /** What closing the stack again returns to, while nothing else has moved the view since. */
  readonly undo: { readonly key: string; readonly held: FleetHeldView | null } | null;
}

/**
 * The view after a stack opened or closed. Its card stays where it was on screen and the scale
 * holds, so nothing is fitted again. The canvas grows to show what the stack added, up to its
 * bound; past that the user pans. Only a stack wider than the canvas at this scale shrinks the
 * view, and then just to its width. Toggling it back returns the view it had before.
 */
export function anchorFleetView(input: {
  readonly key: string;
  /** The shape, the view held on it and the canvas before the change. */
  readonly from: {
    readonly key: string;
    readonly held: FleetHeldView | null;
    readonly view: FleetViewTransform;
    readonly size: { readonly width: number; readonly height: number };
    readonly face: FleetPoint;
  };
  /** The stack and the map after it. */
  readonly stack: Pick<FleetStackGeometry, "rect" | "face" | "tray">;
  readonly layout: Pick<FleetLayout, "width" | "height">;
  readonly bounds: { readonly min: number; readonly max: number };
}): FleetHeldView {
  const { from, stack, layout, bounds } = input;
  const { size } = from;
  if (from.held?.undo?.key === input.key) {
    const { held } = from.held.undo;
    // With no view held before, a stale entry eases the scene back to the fit.
    return held === null
      ? { key: "", view: from.view, height: size.height, glide: true, undo: null }
      : { ...held, glide: true };
  }
  const padding = fleetFitPadding(size.width);
  const top = from.face.y * from.view.scale + from.view.y;
  const scale = Math.min(from.view.scale, fitScale(size.width, stack.rect.width, padding));
  const view =
    scale < from.view.scale
      ? { scale, x: padding - stack.face.x * scale, y: top - stack.face.y * scale }
      : {
          scale,
          x: from.view.x + (from.face.x - stack.face.x) * scale,
          y: from.view.y + (from.face.y - stack.face.y) * scale,
        };
  const wanted = Math.ceil(view.y + layout.height * scale + padding);
  const opened = stack.tray !== null;
  return {
    key: input.key,
    view,
    height: Math.max(
      bounds.min,
      Math.min(bounds.max, opened ? Math.max(size.height, wanted) : Math.min(size.height, wanted)),
    ),
    glide: true,
    undo: { key: from.key, held: from.held },
  };
}
