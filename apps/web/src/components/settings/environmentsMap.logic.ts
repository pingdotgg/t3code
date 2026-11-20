import type {
  ConnectionRouteKind,
  EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
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
const labelOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Machines only one environment links to, at one access level, drawn as a single node. Forty
 * VMs under one host cost one node and one line, and each link stays listed in the details.
 */
export interface FleetStack {
  readonly id: string;
  readonly sourceId: string;
  readonly access: AuthMcpClientAccess;
  /** In name order, so the first and last name the range. */
  readonly memberIds: ReadonlyArray<string>;
  readonly edgeIds: ReadonlyArray<string>;
  readonly reachable: number;
  readonly firstLabel: string;
  readonly lastLabel: string;
  readonly expanded: boolean;
}

/** Below this many machines a group is clearer drawn one by one. */
const FLEET_STACK_MIN = 5;

export function fleetStacks(graph: FleetGraph, expanded: ReadonlySet<string>): FleetStack[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const links = graph.edges.filter(isLinkEdge);
  const incoming = new Map<string, number>();
  for (const link of links) incoming.set(link.to, (incoming.get(link.to) ?? 0) + 1);
  const groups = new Map<string, FleetLinkEdge[]>();
  for (const link of links) {
    if (byId.get(link.to)?.kind !== "target" || incoming.get(link.to) !== 1) continue;
    const id = `stack:${link.from}:${link.link.access}`;
    groups.set(id, [...(groups.get(id) ?? []), link]);
  }
  const label = (link: FleetLinkEdge) => byId.get(link.to)?.label ?? "";
  return [...groups]
    .filter(([, members]) => members.length >= FLEET_STACK_MIN)
    .map(([id, unsorted]) => {
      const members = unsorted.toSorted(
        (left, right) =>
          labelOrder.compare(label(left), label(right)) || (left.to < right.to ? -1 : 1),
      );
      return {
        id,
        sourceId: members[0]!.from,
        access: members[0]!.link.access,
        memberIds: members.map((link) => link.to),
        edgeIds: members.map((link) => link.id),
        reachable: members.filter((link) => link.health.kind === "reachable").length,
        firstLabel: label(members[0]!),
        lastLabel: label(members.at(-1)!),
        expanded: expanded.has(id),
      };
    });
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
  for (const edge of graph.edges) {
    const touches =
      focus.kind === "stack"
        ? stackEdges.has(edge.id)
        : focus.kind === "edge"
          ? edge.id === focus.id
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
       */
      readonly path: "code-less" | "pairing-code";
      /** The pair is already linked, so linking again renews it. */
      readonly renews: boolean;
      readonly target:
        | { readonly kind: "machine"; readonly environmentId: EnvironmentId }
        /** A machine the client has no entry for: only an address another host uses. */
        | { readonly kind: "address"; readonly address: string | null };
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
    return {
      ...base,
      path: "pairing-code",
      target: { kind: "address", address: target.address },
    };
  }
  return {
    ...base,
    path: target.kind === "environment" && target.mintable ? "code-less" : "pairing-code",
    target: { kind: "machine", environmentId: target.environmentId },
  };
}

/** Changes exactly when the layout would: membership, labels, routes, wiring and open stacks. */
export function fleetShapeKey(graph: FleetGraph, stacks: ReadonlyArray<FleetStack>): string {
  return [
    ...graph.nodes.map((node) => `${node.kind}\u0000${node.id}\u0000${node.label}`),
    ...graph.edges.map((edge) =>
      edge.kind === "link" ? `${edge.id}\u0000${edge.link.access}` : edge.id,
    ),
    ...stacks.map((stack) => `${stack.id}\u0000${stack.expanded}`),
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

/** Room for a link's access in words. `side` is the way it grows from the lane it sits on. */
export type FleetLinkBadge = FleetRect & { readonly side: 1 | -1 };

export interface FleetLinkGeometry {
  readonly d: string;
  /** Arrowhead tip and the horizontal direction it points. */
  readonly arrow: { readonly x: number; readonly y: number; readonly dir: 1 | -1 };
  /**
   * Where a link between two environments names its access; a target's card shows its own.
   * Null too where so many links pass that a name would sit on another's.
   */
  readonly badge: FleetLinkBadge | null;
}

export interface FleetStackGeometry {
  /** The whole footprint: the sheets of a closed stack, or the frame of an open one. */
  readonly rect: FleetRect;
  /** The part that is the stack's control: the front sheet, or an open stack's header. */
  readonly face: FleetRect;
  readonly d: string;
  readonly arrow: FleetPoint;
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
const CLIENT = { width: 136, height: 44 };
const WIRE = 72;
const PILL = { width: 82, height: 18 };
const PILL_GAP = 10;
const PORT_PITCH = 22;
const CARD = { width: 204, height: 60 };
const OFFER = { height: 44 };
const TARGET = { width: 188, height: 44 };
const STACK = { height: 50, lift: 8 };
const CHIP = { width: 124, height: 26 };
const CHIP_GAP = 6;
const FRAME_PAD = 8;
const FRAME_HEADER = 30;
const GROUP_GAP = 28;
const BAY_GAP = 12;
const LANE_FIRST = 24;
const LANE_STEP = 14;
const LANE_CLEARANCE = 10;
const LINK_RUN = 92;
const ARROW_LENGTH = 6;
/** How far apart two hosts' links enter one machine, so each keeps its own last stretch. */
const ENTRY_PITCH = 14;
/** The channel left of the cards that links between environments keep to themselves. */
const BETWEEN = { first: 16, step: 14, last: 10 };
/** Where those links meet a card's left edge: past its routes, the outermost lane innermost. */
const LINK_PORT = { first: 4, pitch: 8, margin: 8 };
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

/** Straight to `fanX`, across any lanes so they only ever meet it square, then a curve. */
const sCurve = (x0: number, y0: number, x1: number, y1: number, fanX = x0) => {
  const reach = Math.max(24, (x1 - fanX) / 2);
  const lead = fanX > x0 ? `H${fanX}` : "";
  return `M${x0} ${y0}${lead}C${fanX + reach} ${y0} ${x1 - reach} ${y1} ${x1} ${y1}`;
};

const frameColumns = (count: number) => Math.max(2, Math.min(4, Math.ceil(Math.sqrt(count / 2.2))));

type BayItem =
  | { readonly kind: "target"; readonly targetId: string; readonly incoming: FleetLinkEdge[] }
  | { readonly kind: "stack"; readonly stack: FleetStack };

interface FleetRow {
  /** The host whose own machines these are; a row of shared machines has none. */
  readonly hostId: string | null;
  readonly hosts: FleetNode[];
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

/**
 * This client, the machines it knows, and those seen only through a link: beside the one host
 * linking to them, or in a row between the several that do. Links to those run right of the
 * environments and links between two environments run left of them, each on its own lane with
 * its own entry, so two hosts' links never share a stretch. Deterministic.
 */
export function layoutFleetGraph(
  graph: FleetGraph,
  stacks: ReadonlyArray<FleetStack> = [],
): FleetLayout {
  const nodes = new Map<string, FleetRect>();
  const stackGeometry = new Map<string, FleetStackGeometry>();
  const routes = new Map<string, FleetRouteGeometry>();
  const linkGeometry = new Map<string, FleetLinkGeometry>();
  const handles = new Map<string, FleetPoint>();
  const links = graph.edges.filter(isLinkEdge);
  const routeEdges = graph.edges.filter(isRouteEdge);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const hosts = graph.nodes.filter(
    (node) => node.kind === "environment" || node.kind === "connect",
  );
  const hostIndex = new Map(hosts.map((host, index) => [host.id, index]));
  const indexOf = (hostId: string) => hostIndex.get(hostId) ?? 0;
  const accessRank = (access: AuthMcpClientAccess) => -ACCESS_ORDER.indexOf(access);
  const labelOf = (id: string) => byId.get(id)?.label ?? "";
  const byLabel = (left: string, right: string) =>
    labelOrder.compare(labelOf(left), labelOf(right)) || (left < right ? -1 : 1);

  const stacked = new Set(stacks.flatMap((stack) => stack.edgeIds));
  const incomingOf = new Map<string, FleetLinkEdge[]>();
  for (const link of links) {
    if (byId.get(link.to)?.kind !== "target" || stacked.has(link.id)) continue;
    incomingOf.set(link.to, [...(incomingOf.get(link.to) ?? []), link]);
  }
  const bayOf = new Map<string, BayItem[]>();
  const bandOf = new Map<string, BayItem[]>();
  const push = (into: Map<string, BayItem[]>, hostId: string, item: BayItem) =>
    into.set(hostId, [...(into.get(hostId) ?? []), item]);
  for (const stack of stacks.toSorted((a, b) => accessRank(a.access) - accessRank(b.access))) {
    push(bayOf, stack.sourceId, { kind: "stack", stack });
  }
  const targets = [...incomingOf].map(([targetId, unsorted]) => ({
    targetId,
    // Top to bottom in the order of the hosts, so the upper line is the upper host's.
    incoming: unsorted.toSorted((left, right) => indexOf(left.from) - indexOf(right.from)),
  }));
  for (const { targetId, incoming } of targets
    .filter((target) => target.incoming.length === 1)
    .toSorted(
      (left, right) =>
        accessRank(left.incoming[0]!.link.access) - accessRank(right.incoming[0]!.link.access) ||
        byLabel(left.targetId, right.targetId),
    )) {
    push(bayOf, incoming[0]!.from, { kind: "target", targetId, incoming });
  }
  // Below the middle host of those linking to it: the shortest total reach, with ties going up.
  const meanSource = (incoming: ReadonlyArray<FleetLinkEdge>) =>
    incoming.reduce((sum, link) => sum + indexOf(link.from), 0) / incoming.length;
  for (const { targetId, incoming } of targets
    .filter((target) => target.incoming.length > 1)
    .toSorted(
      (left, right) =>
        meanSource(left.incoming) - meanSource(right.incoming) ||
        byLabel(left.targetId, right.targetId),
    )) {
    const anchor = incoming[Math.floor((incoming.length - 1) / 2)]!.from;
    push(bandOf, anchor, { kind: "target", targetId, incoming });
  }

  // A machine with no links rides beside a shared row instead of pushing the hosts further apart.
  const linked = new Set(links.flatMap((link) => [link.from, link.to]));
  const rows: FleetRow[] = [];
  let shared: FleetRow | null = null;
  for (const host of hosts) {
    if (shared !== null && !linked.has(host.id)) {
      shared.hosts.push(host);
      continue;
    }
    rows.push({ hostId: host.id, hosts: [host], items: bayOf.get(host.id) ?? [] });
    const band = bandOf.get(host.id);
    shared = band === undefined ? null : { hostId: null, hosts: [], items: band };
    if (shared !== null) rows.push(shared);
  }

  // Links between environments: shorter ones take the lanes nearer the cards, and two share a
  // lane when no host lies between both pairs, so a chain of links reads as one line.
  const reach = (link: FleetLinkEdge) => Math.abs(indexOf(link.to) - indexOf(link.from));
  const low = (link: FleetLinkEdge) => Math.min(indexOf(link.from), indexOf(link.to));
  const high = (link: FleetLinkEdge) => Math.max(indexOf(link.from), indexOf(link.to));
  const between = links
    .filter((link) => hostIndex.has(link.from) && hostIndex.has(link.to))
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
  // Each end of such a link has its own port on the card's left edge, above the routes when the
  // other machine is above and below them when it is below. The outer lane's port is nearer the
  // middle, so two links turning at one card never cross.
  const portsOf = new Map<string, FleetLinkEdge[]>();
  for (const link of between) {
    const down = Math.sign(indexOf(link.to) - indexOf(link.from));
    for (const key of [`${link.from}:${down}`, `${link.to}:${-down}`]) {
      portsOf.set(key, [...(portsOf.get(key) ?? []), link]);
    }
  }
  for (const ports of portsOf.values()) {
    ports.sort((left, right) => betweenLane.get(right.id)! - betweenLane.get(left.id)!);
  }
  const routesInto = (hostId: string) => routeEdges.filter((edge) => edge.to === hostId).length;
  const routesExtent = (hostId: string) =>
    ((Math.max(1, routesInto(hostId)) - 1) * PORT_PITCH + PILL.height) / 2;
  const cardHeight = (host: FleetNode) => {
    const ports = Math.max(
      portsOf.get(`${host.id}:-1`)?.length ?? 0,
      portsOf.get(`${host.id}:1`)?.length ?? 0,
    );
    const plain =
      host.kind === "connect"
        ? OFFER.height
        : Math.max(CARD.height, (routesInto(host.id) - 1) * PORT_PITCH + PILL.height + 20);
    return ports === 0
      ? plain
      : Math.max(
          plain,
          2 *
            (routesExtent(host.id) +
              LINK_PORT.first +
              (ports - 1) * LINK_PORT.pitch +
              LINK_PORT.margin),
        );
  };
  const itemSize = (item: BayItem) => {
    if (item.kind === "target") {
      return {
        width: TARGET.width,
        height: Math.max(TARGET.height, 20 + (item.incoming.length - 1) * ENTRY_PITCH),
      };
    }
    if (!item.stack.expanded) {
      return { width: TARGET.width + STACK.lift, height: STACK.height + STACK.lift };
    }
    const columns = frameColumns(item.stack.memberIds.length);
    const stackRows = Math.ceil(item.stack.memberIds.length / columns);
    return {
      width: FRAME_PAD * 2 + columns * (CHIP.width + CHIP_GAP) - CHIP_GAP,
      height: FRAME_HEADER + stackRows * (CHIP.height + CHIP_GAP) - CHIP_GAP + FRAME_PAD,
    };
  };

  const pillX = CLIENT.width + WIRE;
  const cardX =
    pillX +
    PILL.width +
    (betweenLanes.length === 0
      ? PILL_GAP
      : BETWEEN.last + (betweenLanes.length - 1) * BETWEEN.step + BETWEEN.first);
  const cardRight = cardX + CARD.width;

  // Heights first: which lanes the channel needs, and so how wide it is, follows from them.
  const placed: Array<{
    readonly item: BayItem;
    readonly y: number;
    readonly size: { readonly width: number; readonly height: number };
    readonly hostId: string | null;
  }> = [];
  let y = HEADER;
  for (const row of rows) {
    const heights = row.hosts.map(cardHeight);
    const cardsHeight = heights.reduce((sum, height) => sum + height + GROUP_GAP, -GROUP_GAP);
    const sizes = row.items.map(itemSize);
    const bayHeight = sizes.reduce((sum, size) => sum + size.height + BAY_GAP, -BAY_GAP);
    const rowHeight = Math.max(cardsHeight, bayHeight);
    let cardY = y + (rowHeight - cardsHeight) / 2;
    row.hosts.forEach((host, index) => {
      const height = heights[index]!;
      nodes.set(host.id, { x: cardX, y: cardY, width: CARD.width, height });
      if (host.kind === "environment") {
        handles.set(host.id, { x: cardRight, y: cardY + height / 2 });
      }
      cardY += height + GROUP_GAP;
    });
    let itemY = y + (rowHeight - bayHeight) / 2;
    row.items.forEach((item, index) => {
      const size = sizes[index]!;
      placed.push({ item, y: itemY, size, hostId: row.hostId });
      itemY += size.height + BAY_GAP;
    });
    y += rowHeight + GROUP_GAP;
  }
  const height = Math.max(HEADER + CLIENT.height, y - GROUP_GAP);

  const centerOf = (id: string) => {
    const rect = nodes.get(id)!;
    return rect.y + rect.height / 2;
  };

  /** Where each link into a machine several hosts link to arrives. */
  const entryY = new Map<string, number>();
  for (const { item, y: itemY, size, hostId } of placed) {
    if (item.kind !== "target" || hostId !== null) continue;
    item.incoming.forEach((link, index) => {
      entryY.set(
        link.id,
        itemY + size.height / 2 + (index - (item.incoming.length - 1) / 2) * ENTRY_PITCH,
      );
    });
  }
  const portY = (link: FleetLinkEdge, hostId: string) => {
    const side = Math.sign(indexOf(link.from === hostId ? link.to : link.from) - indexOf(hostId));
    const port = portsOf.get(`${hostId}:${side}`)!.indexOf(link);
    return (
      centerOf(hostId) + side * (routesExtent(hostId) + LINK_PORT.first + port * LINK_PORT.pitch)
    );
  };

  // One lane per host for each shared row it reaches.
  const trunkOf = new Map<string, FleetLane>();
  const lanes: FleetLane[] = [];
  for (const [anchor, band] of bandOf) {
    const incoming = band.flatMap((item) => (item.kind === "target" ? item.incoming : []));
    for (const hostId of new Set(incoming.map((link) => link.from))) {
      const from = centerOf(hostId);
      const mine = incoming.filter((link) => link.from === hostId);
      const branches = mine.map((link) => entryY.get(link.id)!);
      const lane: FleetLane = {
        id: `${hostId}>${anchor}`,
        from,
        to: branches.reduce((far, y) => (Math.abs(y - from) > Math.abs(far - from) ? y : far)),
        branches,
        index: 0,
      };
      for (const link of mine) trunkOf.set(link.id, lane);
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
  const laneX = (lane: FleetLane) => cardRight + LANE_FIRST + lane.index * LANE_STEP;
  const fanX = taken.length === 0 ? cardRight : cardRight + LANE_FIRST + taken.length * LANE_STEP;
  const bayX = fanX + LINK_RUN;
  const endX = bayX - ARROW_LENGTH;

  let width = fanX;
  for (const { item, y: itemY, size, hostId } of placed) {
    width = Math.max(width, bayX + size.width);
    if (item.kind === "target") {
      nodes.set(item.targetId, { x: bayX, y: itemY, ...size });
      for (const link of item.incoming) {
        const trunk = trunkOf.get(link.id);
        const targetY = entryY.get(link.id) ?? itemY + size.height / 2;
        linkGeometry.set(link.id, {
          d:
            trunk === undefined
              ? sCurve(cardRight, centerOf(link.from), endX, targetY, fanX)
              : elbowPath(cardRight, trunk.from, laneX(trunk), endX, targetY),
          arrow: { x: bayX, y: targetY, dir: 1 },
          badge: null,
        });
      }
      continue;
    }
    const originY = centerOf(hostId ?? item.stack.sourceId);
    if (!item.stack.expanded) {
      const face = { x: bayX, y: itemY + STACK.lift, width: TARGET.width, height: STACK.height };
      const faceY = face.y + face.height / 2;
      stackGeometry.set(item.stack.id, {
        rect: { x: bayX, y: itemY, ...size },
        face,
        d: sCurve(cardRight, originY, endX, faceY, fanX),
        arrow: { x: bayX, y: faceY },
      });
      continue;
    }
    const columns = frameColumns(item.stack.memberIds.length);
    item.stack.memberIds.forEach((memberId, member) => {
      nodes.set(memberId, {
        x: bayX + FRAME_PAD + (member % columns) * (CHIP.width + CHIP_GAP),
        y: itemY + FRAME_HEADER + Math.floor(member / columns) * (CHIP.height + CHIP_GAP),
        ...CHIP,
      });
    });
    const headerY = itemY + FRAME_HEADER / 2;
    stackGeometry.set(item.stack.id, {
      rect: { x: bayX, y: itemY, ...size },
      face: { x: bayX, y: itemY, width: size.width, height: FRAME_HEADER },
      d: sCurve(cardRight, originY, endX, headerY, fanX),
      arrow: { x: bayX, y: headerY },
    });
  }

  const hostCenters = hosts.map((host) => centerOf(host.id));
  const clientCenterY =
    hostCenters.length === 0
      ? HEADER + CLIENT.height / 2
      : (hostCenters[0]! + hostCenters.at(-1)!) / 2;
  nodes.set(FLEET_CLIENT_NODE_ID, {
    x: 0,
    y: clientCenterY - CLIENT.height / 2,
    ...CLIENT,
  });

  // Wires leave the client a little apart, in the order they arrive, so they never cross.
  const fan = Math.min(CLIENT.height - 20, (routeEdges.length - 1) * 4);
  let wire = 0;
  for (const host of hosts) {
    const hostRoutes = routeEdges.filter((edge) => edge.to === host.id);
    hostRoutes.forEach((edge, index) => {
      const portY = centerOf(host.id) + (index - (hostRoutes.length - 1) / 2) * PORT_PITCH;
      const startY =
        clientCenterY + (routeEdges.length < 2 ? 0 : (wire / (routeEdges.length - 1) - 0.5) * fan);
      wire += 1;
      routes.set(edge.id, {
        d: `${sCurve(CLIENT.width, startY, pillX, portY)}H${cardX}`,
        pill: { x: pillX, y: portY - PILL.height / 2, ...PILL },
      });
    });
  }

  // A link between environments names its access on its own lane, in a gap between two cards:
  // the one just past the environment it leaves, or the next one free. It grows away from the
  // other lanes passing there; where it cannot, it may cover one, but never another name.
  const runs = between.map((link) => ({
    link,
    x: cardX - BETWEEN.first - betweenLane.get(link.id)! * BETWEEN.step,
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
    const place = (y: number, side: 1 | -1): FleetLinkBadge => ({
      x: side === 1 ? x - BADGE.overhang : x + BADGE.overhang - BADGE.width,
      y: y - BADGE.height / 2,
      width: BADGE.width,
      height: BADGE.height,
      side,
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
    const options = gaps.flatMap((y) => [place(y, 1), place(y, -1)]).filter(clearOfNames);
    const badge = options.find(clearOfLanes) ?? options[0] ?? null;
    if (badge !== null) badges.push(badge);
    linkGeometry.set(link.id, {
      d: elbowPath(cardX, run.from, x, cardX - ARROW_LENGTH, run.to),
      arrow: { x: cardX, y: run.to, dir: 1 },
      badge,
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
      ...(hosts.length > 0 ? [{ id: "environments" as const, x: cardX }] : []),
      ...(placed.length > 0 ? [{ id: "targets" as const, x: bayX }] : []),
    ],
    width,
    height,
  };
}

/** What the arrow keys move between: every machine drawn, and each stack's control. */
export function fleetFocusRects(layout: FleetLayout): ReadonlyMap<string, FleetRect> {
  return new Map([
    ...layout.nodes,
    ...[...layout.stacks].map(([id, geometry]) => [id, geometry.face] as const),
  ]);
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
const FLEET_FIT_PADDING = 28;

const fitScale = (available: number, extent: number) =>
  Math.max(0.01, (available - FLEET_FIT_PADDING * 2) / Math.max(1, extent));

/** Centers the whole map in the viewport at the largest scale that shows all of it. */
export function fitFleetLayout(
  layout: Pick<FleetLayout, "width" | "height">,
  viewport: { readonly width: number; readonly height: number },
): FleetViewTransform {
  const scale = Math.min(
    FLEET_FIT_MAX_SCALE,
    fitScale(viewport.width, layout.width),
    fitScale(viewport.height, layout.height),
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
  const scale = Math.min(FLEET_FIT_MAX_SCALE, fitScale(width, layout.width));
  const wanted = Math.ceil(layout.height * scale + FLEET_FIT_PADDING * 2);
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
