import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  anchorFleetView,
  buildFleetGraph,
  FLEET_FIT_LEGIBLE_SCALE,
  fitFleetLayout,
  fleetCanvasHeight,
  fleetStackPartial,
  FLEET_CLIENT_NODE_ID,
  fleetEnvironmentNodeId,
  FLEET_FOLD_ENVIRONMENTS_OVER,
  FLEET_LANE_PITCH,
  FLEET_ROUTE_PITCH,
  FLEET_STACK_SHOWN_MAX,
  fleetFocusRects,
  fleetDrawnLinkId,
  fleetLinkAction,
  fleetLinkBackOffered,
  fleetLinkOffer,
  fleetMoreNodeId,
  fleetNeighborhood,
  fleetNodesInBox,
  fleetSearch,
  fleetShapeKey,
  fleetStacks,
  fleetSummary,
  fleetTwoWayLinks,
  isLinkEdge,
  isRouteEdge,
  layoutFleetGraph,
  nextFleetNode,
  zoomFleetView,
  type FleetConnectMachineInput,
  type FleetEnvironmentInput,
  type FleetLayout,
  type FleetRect,
} from "./environmentsMap.logic";

const now = DateTime.makeUnsafe("2026-11-19T12:00:00.000Z");
const id = (value: string) => EnvironmentId.make(value);
const node = (value: string) => fleetEnvironmentNodeId(id(value));

const link = (target: string, overrides: Partial<PeerLinkSummary> = {}): PeerLinkSummary => ({
  environmentId: id(target),
  label: target,
  urls: [`https://${target}.example.ts.net`],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
  ...overrides,
});

const environment = (
  name: string,
  links: ReadonlyArray<PeerLinkSummary> | FleetEnvironmentInput["outgoing"]["state"] = [],
  overrides: Partial<FleetEnvironmentInput> = {},
): FleetEnvironmentInput => ({
  environmentId: id(name),
  label: name,
  machine: "server",
  phase: "connected",
  enabled: true,
  routes: [{ id: "tailnet", kind: "tailnet" }],
  activeRouteId: "tailnet",
  refusedRouteIds: [],
  offersLinks: true,
  canWriteAccess: true,
  hasLinkAddress: true,
  outgoing:
    typeof links !== "string"
      ? { state: "loaded", links }
      : links === "error"
        ? { state: "error", message: "boom" }
        : links === "loaded"
          ? { state: "loaded", links: [] }
          : { state: links },
  ...overrides,
});

const connectMachine = (name: string): FleetConnectMachineInput => ({
  environmentId: id(name),
  label: name,
  machine: "server",
  availability: "online",
});

const build = (
  environments: ReadonlyArray<FleetEnvironmentInput>,
  connectMachines: ReadonlyArray<FleetConnectMachineInput> = [],
) => buildFleetGraph({ clientLabel: "This browser", environments, connectMachines, now });

const vms = (count: number, prefix = "vm", overrides: Partial<PeerLinkSummary> = {}) =>
  Array.from({ length: count }, (_, index) => link(`${prefix}-${index + 1}`, overrides));

const routeStates = (graph: ReturnType<typeof build>, name: string) =>
  Object.fromEntries(
    graph.edges
      .filter(isRouteEdge)
      .filter((edge) => edge.to === node(name))
      .map((edge) => [edge.routeId, edge.state]),
  );

/** Six environments in every state, 45 link targets, 40 of them under one host. */
const largeSetup = () =>
  build(
    [
      environment(
        "nucbox",
        [...vms(40, "fs", { access: "full-access" }), link("ci"), link("cups", { access: "auto" })],
        {
          routes: [
            { id: "tailnet", kind: "tailnet" },
            { id: "lan", kind: "lan" },
            { id: "relay", kind: "relay" },
          ],
        },
      ),
      environment("cups", [link("nucbox"), link("staging", { access: "read-only" }), link("ci")]),
      environment("mbp", "unknown", { phase: "offline" }),
      environment("win", "unknown", { phase: "error" }),
      environment("vps", [
        link("db-1"),
        link("db-2"),
        link("db-3"),
        link("ci", { access: "read-only" }),
        link("staging", { access: "auto" }),
        link("cups", { access: "full-access" }),
      ]),
      environment("old", "unknown", { enabled: false, phase: "available" }),
    ],
    [connectMachine("gpu")],
  );

/** The brief's setup: two hosts share three machines, one has three more and links to the other. */
const sharedSetup = () =>
  build([
    environment("nucbox", [
      link("fs-1", { access: "full-access" }),
      link("fs-2", { access: "auto" }),
      link("fs-3", { access: "read-only" }),
    ]),
    environment("mbp", "unknown", { phase: "reconnecting" }),
    environment("cups", [
      link("fs-1", { access: "full-access" }),
      link("fs-2", { access: "full-access" }),
      link("fs-3", { access: "auto" }),
      link("fs-4", { access: "auto-accept-edits" }),
      link("fs-5"),
      link("fs-6", { access: "read-only" }),
      link("nucbox", { access: "auto" }),
    ]),
  ]);

/** Twenty environments, five of them folding by state, and 1000 machines two hosts both link to. */
const hugeSetup = () =>
  build([
    environment("nucbox", [...vms(1000, "vm", { access: "full-access" }), link("cups")]),
    environment("cups", vms(1000, "vm", { access: "full-access" })),
    environment("mbp", [link("nucbox", { access: "auto" })]),
    ...Array.from({ length: 5 }, (_, index) => environment(`gpu-${index + 1}`)),
    ...Array.from({ length: 6 }, (_, index) =>
      environment(`lab-${index + 1}`, "unknown", { phase: "offline" }),
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      environment(`old-${index + 1}`, "unknown", { enabled: false, phase: "available" }),
    ),
    ...Array.from({ length: 2 }, (_, index) =>
      environment(`legacy-${index + 1}`, "unknown", { phase: "unsupported" }),
    ),
  ]);

/** Points along a path the layout wrote: absolute M, H, V, Q and C only. */
function samplePath(d: string): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  let x = 0;
  let y = 0;
  const curve = (controls: ReadonlyArray<number>) => {
    const xs = [x, ...controls.filter((_, index) => index % 2 === 0)];
    const ys = [y, ...controls.filter((_, index) => index % 2 === 1)];
    const at = (values: ReadonlyArray<number>, t: number): number =>
      values.length === 1
        ? values[0]!
        : at(
            values.slice(1).map((value, index) => values[index]! * (1 - t) + value * t),
            t,
          );
    for (let step = 1; step <= 24; step += 1) {
      points.push({ x: at(xs, step / 24), y: at(ys, step / 24) });
    }
    x = xs.at(-1)!;
    y = ys.at(-1)!;
  };
  for (const [, command, rest] of d.matchAll(/([MHVQC])([^MHVQC]*)/g)) {
    const values = rest!.trim().split(/[ ,]+/).map(Number);
    if (command === "M") points.push({ x: (x = values[0]!), y: (y = values[1]!) });
    else if (command === "H") curve([values[0]!, y]);
    else if (command === "V") curve([x, values[0]!]);
    else curve(values);
  }
  return points;
}

const overlaps = (a: FleetRect, b: FleetRect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every box the layout draws that must not sit on another. */
const solidRects = (layout: FleetLayout) => [
  ...[...layout.nodes].map(([key, rect]) => ({ key, rect, within: null as string | null })),
  ...[...layout.routes].map(([key, geometry]) => ({ key, rect: geometry.pill, within: null })),
  ...[...layout.stacks].map(([key, geometry]) => ({ key, rect: geometry.rect, within: key })),
];

function expectNoOverlap(layout: FleetLayout, members: ReadonlyMap<string, string>) {
  const rects = solidRects(layout);
  for (const [index, left] of rects.entries()) {
    for (const right of rects.slice(index + 1)) {
      // An open stack's frame holds its own machines.
      if (members.get(left.key) === right.within || members.get(right.key) === left.within) {
        if (left.within !== null || right.within !== null) continue;
      }
      expect(overlaps(left.rect, right.rect), `${left.key} overlaps ${right.key}`).toBe(false);
    }
    expect(left.rect.x).toBeGreaterThanOrEqual(0);
    expect(left.rect.y).toBeGreaterThanOrEqual(0);
    expect(left.rect.x + left.rect.width).toBeLessThanOrEqual(layout.width);
    expect(left.rect.y + left.rect.height).toBeLessThanOrEqual(layout.height);
  }
}

describe("buildFleetGraph", () => {
  it("draws each saved route as its own edge and reads its state from what the client knows", () => {
    const routes = [
      { id: "tailnet", kind: "tailnet" as const },
      { id: "lan", kind: "lan" as const },
      { id: "relay", kind: "relay" as const },
    ];
    const graph = build([
      environment("up", [], { routes, activeRouteId: "lan", refusedRouteIds: ["relay"] }),
      environment("dialling", "unknown", { routes, phase: "connecting", activeRouteId: null }),
      environment("gone", "unknown", { routes, phase: "error", activeRouteId: null }),
      environment("off", "unknown", { routes, enabled: false, phase: "available" }),
      environment("old", "unknown", { routes, phase: "unsupported" }),
    ]);
    expect(routeStates(graph, "up")).toEqual({
      tailnet: "standby",
      lan: "in-use",
      relay: "refused",
    });
    expect(routeStates(graph, "dialling")).toEqual({
      tailnet: "trying",
      lan: "trying",
      relay: "trying",
    });
    expect(routeStates(graph, "gone")).toEqual({ tailnet: "down", lan: "down", relay: "down" });
    expect(routeStates(graph, "off")).toEqual({ tailnet: "idle", lan: "idle", relay: "idle" });
    expect(routeStates(graph, "old")).toEqual({ tailnet: "idle", lan: "idle", relay: "idle" });
  });

  it("adds T3 Connect machines the client has not saved, and only those", () => {
    const graph = build([environment("cups")], [connectMachine("cups"), connectMachine("gpu")]);
    expect(graph.nodes.map((entry) => `${entry.kind}:${entry.label}`)).toEqual([
      "client:This browser",
      "environment:cups",
      "connect:gpu",
    ]);
    expect(routeStates(graph, "gpu")).toEqual({ offer: "offered" });
  });

  it("keeps one node per machine and one edge per link, whatever names it twice", () => {
    const graph = build(
      [
        environment("cups", [link("vps"), link("vps"), link("cups"), link("gpu"), link("nucbox")]),
        environment("cups", [link("other")]),
        environment("nucbox"),
      ],
      [connectMachine("gpu")],
    );
    expect(graph.nodes.map((entry) => `${entry.kind}:${entry.label}`)).toEqual([
      "client:This browser",
      "environment:cups",
      "environment:nucbox",
      "connect:gpu",
      "target:vps",
    ]);
    expect(graph.edges.filter((edge) => edge.kind === "link").map((edge) => edge.id)).toEqual([
      `link:${node("cups")}>${node("vps")}`,
      `link:${node("cups")}>${node("gpu")}`,
      `link:${node("cups")}>${node("nucbox")}`,
    ]);
  });

  it("keeps unknown, off, loading and failed link lists apart from an empty one", () => {
    const graph = build([
      environment("a", "loaded"),
      environment("b", "loading"),
      environment("c", "error"),
      environment("d", "off", { offersLinks: false }),
      environment("e", "unknown", { phase: "offline" }),
      environment("f", [], { canWriteAccess: false }),
    ]);
    const states = graph.nodes.flatMap((entry) =>
      entry.kind === "environment"
        ? [[entry.label, entry.outgoing, entry.linking, entry.outgoingError]]
        : [],
    );
    expect(states).toEqual([
      ["a", "loaded", "ready", null],
      ["b", "loading", "ready", null],
      ["c", "error", "ready", "boom"],
      ["d", "off", "off", null],
      ["e", "unknown", "disconnected", null],
      ["f", "loaded", "forbidden", null],
    ]);
  });

  it("reads a link's health at the given time", () => {
    const graph = build([
      environment("cups", [
        link("soon", { expiresAt: DateTime.makeUnsafe("2026-11-21T12:00:00.000Z") }),
        link("gone", { status: "expired" }),
      ]),
    ]);
    expect(graph.edges.flatMap((edge) => (edge.kind === "link" ? [edge.health] : []))).toEqual([
      { kind: "reachable", expiresInDays: 2 },
      { kind: "expired" },
    ]);
  });
});

describe("fleetSummary", () => {
  it("counts links only when every connected environment's list was read", () => {
    const summary = (...environments: FleetEnvironmentInput[]) => fleetSummary(build(environments));
    expect(summary(environment("a", [link("x")]), environment("b"))).toEqual({
      machines: 3,
      links: 1,
      loading: false,
    });
    expect(summary(environment("a"), environment("b"))).toMatchObject({ links: 0 });
    // One failed list among several leaves the total unknown, not zero.
    expect(summary(environment("a"), environment("b", "error"))).toMatchObject({ links: null });
    expect(summary(environment("a", "unknown"))).toMatchObject({ links: null });
    expect(summary(environment("a"), environment("b", "loading"))).toMatchObject({
      links: null,
      loading: true,
    });
    // A machine that is not connected says nothing either way.
    expect(
      summary(environment("a", [link("x")]), environment("b", "unknown", { phase: "offline" })),
    ).toMatchObject({ links: 1 });
  });
});

describe("fleetStacks", () => {
  it("collapses many machines under one host and one access level, and nothing smaller", () => {
    const graph = build([
      environment("nucbox", [
        ...vms(40, "fs", { access: "full-access" }),
        ...vms(4, "few"),
        link("fs-41", { access: "full-access", status: "unreachable" }),
      ]),
    ]);
    const stacks = fleetStacks(graph, new Set());
    expect(
      stacks.map((stack) => [
        stack.id,
        stack.memberIds.length,
        stack.reachable,
        stack.firstLabel,
        stack.lastLabel,
        stack.expanded,
      ]),
    ).toEqual([[`stack:${node("nucbox")}:full-access`, 41, 40, "fs-1", "fs-41", false]]);
    const [open] = fleetStacks(graph, new Set([stacks[0]!.id]));
    expect(open!.expanded).toBe(true);
    // An open stack draws its first machines; the rest stay in the details.
    expect(open!.shownIds).toEqual(open!.memberIds.slice(0, FLEET_STACK_SHOWN_MAX));
  });

  it("folds machines that share the exact set of links in, and keeps other sets apart", () => {
    const graph = build([
      environment("nucbox", [
        ...vms(8, "vm", { access: "full-access" }),
        ...vms(6, "ro", { access: "read-only" }),
        ...vms(5, "solo"),
      ]),
      environment("cups", [
        link("vm-1", { access: "full-access", status: "unreachable" }),
        ...vms(8, "vm", { access: "full-access" }).slice(1),
        // The same two hosts, but one at another access level: a set of its own.
        ...vms(6, "ro", { access: "full-access" }),
      ]),
    ]);
    const stacks = fleetStacks(graph, new Set());
    expect(
      stacks.map((stack) => [
        stack.sources.map((source) => `${source.sourceId}:${source.access}`),
        stack.memberIds.length,
        stack.edgeIds.length,
        stack.reachable,
      ]),
    ).toEqual([
      [[`${node("nucbox")}:full-access`, `${node("cups")}:full-access`], 8, 16, 7],
      [[`${node("nucbox")}:read-only`, `${node("cups")}:full-access`], 6, 12, 6],
      [[`${node("nucbox")}:approval-required`], 5, 5, 5],
    ]);
  });

  it("folds unlinked environments by state once there are many, and never a linked or connected one", () => {
    const few = build(
      Array.from({ length: FLEET_FOLD_ENVIRONMENTS_OVER }, (_, index) =>
        environment(`lab-${index}`, "unknown", { phase: "offline" }),
      ),
    );
    expect(fleetStacks(few, new Set())).toEqual([]);
    const graph = build(
      [
        environment("nucbox", [link("linked-offline")]),
        environment("linked-offline", "unknown", { phase: "offline" }),
        environment("idle"),
        environment("dialling", "unknown", { phase: "connecting" }),
        ...Array.from({ length: 4 }, (_, index) =>
          environment(`lab-${index + 1}`, "unknown", { phase: index === 0 ? "error" : "offline" }),
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          environment(`old-${index + 1}`, "unknown", { enabled: false, phase: "available" }),
        ),
        // Two is too few to be worth a stack.
        environment("legacy-1", "unknown", { phase: "unsupported" }),
        environment("legacy-2", "unknown", { phase: "unsupported" }),
      ],
      ["gpu-1", "gpu-2", "gpu-3"].map(connectMachine),
    );
    expect(
      fleetStacks(graph, new Set()).map((stack) => [stack.kind, stack.group, stack.memberIds]),
    ).toEqual([
      ["environments", "offline", ["lab-1", "lab-2", "lab-3", "lab-4"].map(node)],
      ["environments", "off", ["old-1", "old-2", "old-3"].map(node)],
      ["environments", "not-added", ["gpu-1", "gpu-2", "gpu-3"].map(node)],
    ]);
  });

  it("leaves out a machine a second host links to, and a machine the client knows", () => {
    const graph = build([
      environment("nucbox", [...vms(6, "fs"), link("cups")]),
      environment("cups", [link("fs-1")]),
    ]);
    const [stack] = fleetStacks(graph, new Set());
    expect(stack!.memberIds).toEqual(["fs-2", "fs-3", "fs-4", "fs-5", "fs-6"].map(node));
  });
});

describe("fleetLinkOffer", () => {
  const graph = build(
    [
      environment("cups", [link("vm"), link("old", { status: "expired" }), link("nucbox")]),
      environment("nucbox"),
      environment("guest", [], { canWriteAccess: false }),
      environment("nolabs", "off", { offersLinks: false }),
      environment("ssh-only", [], { hasLinkAddress: false }),
      environment("asleep", "unknown", { phase: "offline" }),
    ],
    [connectMachine("gpu")],
  );
  const offer = (source: string, target: string) =>
    fleetLinkOffer(graph, node(source), target === "client" ? FLEET_CLIENT_NODE_ID : node(target));

  it("links without a code only where the client can mint one on the target", () => {
    expect(offer("nucbox", "cups")).toEqual({
      kind: "link",
      sourceEnvironmentId: id("nucbox"),
      path: "code-less",
      renews: false,
      target: { kind: "machine", environmentId: id("cups") },
    });
    expect(offer("cups", "nucbox")).toMatchObject({ path: "code-less", renews: true });
    for (const target of ["guest", "ssh-only", "asleep", "gpu"]) {
      expect(offer("cups", target), target).toMatchObject({
        path: "pairing-code",
        target: { kind: "machine", environmentId: id(target) },
      });
    }
  });

  it("links to a machine known only through a link by its address, with a code", () => {
    expect(offer("nucbox", "vm")).toMatchObject({
      path: "pairing-code",
      renews: false,
      target: { kind: "address", address: "https://vm.example.ts.net" },
    });
    expect(offer("cups", "vm")).toMatchObject({ renews: true });
    expect(offer("cups", "old")).toMatchObject({ renews: false });
  });

  it("offers nothing from a machine that cannot link, or to itself or the client", () => {
    const reason = (source: string, target: string) => {
      const result = offer(source, target);
      return result.kind === "unavailable" ? result.reason : result.kind;
    };
    expect(reason("cups", "cups")).toBe("same-machine");
    expect(reason("cups", "client")).toBe("not-an-environment");
    expect(reason("gpu", "cups")).toBe("not-an-environment");
    expect(reason("vm", "cups")).toBe("not-an-environment");
    expect(reason("asleep", "cups")).toBe("source-disconnected");
    expect(reason("nolabs", "cups")).toBe("source-off");
    expect(reason("guest", "cups")).toBe("source-forbidden");
  });
});

describe("fleetLinkAction", () => {
  const graph = build([
    environment("nucbox", [...vms(6, "fs")]),
    environment("cups"),
    environment("mbp", "unknown", { phase: "offline" }),
    environment("vps", [], { canWriteAccess: false }),
  ]);
  const stacks = fleetStacks(graph, new Set());
  const batch = (environmentIds: ReadonlyArray<string>) => ({
    kind: "batch",
    sourceEnvironmentId: id("nucbox"),
    environmentIds: environmentIds.map(id),
  });

  it("links to the selection when the drop lands on it, or the handle is pressed with one", () => {
    const selected = new Set([node("cups"), node("mbp"), node("nucbox"), FLEET_CLIENT_NODE_ID]);
    // The source and the client are never among the machines to link.
    expect(fleetLinkAction(graph, stacks, selected, node("nucbox"), node("cups"))).toEqual(
      batch(["cups", "mbp"]),
    );
    expect(fleetLinkAction(graph, stacks, selected, node("nucbox"), null)).toEqual(
      batch(["cups", "mbp"]),
    );
  });

  it("links one machine when the drop lands outside the selection, or nothing is selected", () => {
    const selected = new Set([node("mbp")]);
    expect(fleetLinkAction(graph, stacks, selected, node("nucbox"), node("cups"))).toMatchObject({
      kind: "single",
      offer: { path: "code-less", target: { environmentId: id("cups") } },
    });
    expect(fleetLinkAction(graph, stacks, new Set(), node("nucbox"), null)).toEqual({
      kind: "single",
      sourceEnvironmentId: id("nucbox"),
      offer: null,
    });
    // A selection of only the source is no batch.
    expect(
      fleetLinkAction(graph, stacks, new Set([node("nucbox")]), node("nucbox"), null),
    ).toMatchObject({ kind: "single" });
  });

  it("opens no batch for machines the client has no session on, and offers nothing from a host that cannot link", () => {
    const members = ["fs-1", "fs-2", "fs-3", "fs-4", "fs-5", "fs-6"].map(node);
    // A stack of machines known only through links: each needs a code, so no batch can link one.
    expect(fleetLinkAction(graph, stacks, new Set(), node("cups"), stacks[0]!.id)).toEqual({
      kind: "code-only",
      sourceId: node("cups"),
      sourceEnvironmentId: id("cups"),
      machineIds: members,
    });
    // One such machine alone, ticked and dropped on, is asked for its code like any other.
    expect(
      fleetLinkAction(graph, stacks, new Set([node("fs-1")]), node("cups"), node("fs-1")),
    ).toMatchObject({
      kind: "single",
      sourceEnvironmentId: id("cups"),
      offer: { path: "pairing-code", target: { kind: "address" } },
    });
    // One the client is connected to among them makes it a batch, which says why for the rest.
    const mixed = new Set([node("fs-1"), node("fs-2"), node("mbp")]);
    expect(fleetLinkAction(graph, stacks, mixed, node("cups"), node("mbp"))).toEqual({
      ...batch(["fs-1", "fs-2", "mbp"]),
      sourceEnvironmentId: id("cups"),
    });
    for (const source of ["mbp", "vps"]) {
      expect(fleetLinkAction(graph, stacks, new Set(), node(source), stacks[0]!.id)).toBeNull();
      expect(fleetLinkAction(graph, stacks, new Set(), node(source), null)).toBeNull();
    }
    expect(fleetLinkAction(graph, stacks, new Set(), node("nucbox"), node("nucbox"))).toBeNull();
  });
});

describe("fleetTwoWayLinks", () => {
  const graph = build([
    environment("a", [link("b"), link("c", { access: "full-access" }), link("d")]),
    environment("b", [link("a", { status: "unreachable" })]),
    environment("c", [link("a", { access: "auto" })]),
    environment("d"),
  ]);
  const pairs = fleetTwoWayLinks(graph);
  const edge = (from: string, to: string) => `link:${node(from)}>${node(to)}`;

  it("merges two links between the same machines only at the same access", () => {
    expect([...pairs.keys()].toSorted()).toEqual([edge("a", "b"), edge("b", "a")]);
    // Both links select the one line, drawn as the link from the machine listed first.
    expect(fleetDrawnLinkId(pairs, edge("b", "a"))).toBe(edge("a", "b"));
    expect(fleetDrawnLinkId(pairs, edge("a", "b"))).toBe(edge("a", "b"));
    // Different access says two different things, and a one-way link has no other half.
    expect(fleetDrawnLinkId(pairs, edge("c", "a"))).toBe(edge("c", "a"));
    expect(fleetDrawnLinkId(pairs, edge("a", "d"))).toBe(edge("a", "d"));
  });

  it("keeps each direction's own health, and counts both links", () => {
    const pair = pairs.get(edge("a", "b"))!;
    expect(pair.forward.health.kind).toBe("reachable");
    expect(pair.back.health.kind).toBe("unreachable");
    expect(fleetSummary(graph).links).toBe(5);
  });

  it("lights both links and both machines' routes from either one", () => {
    const lit = fleetNeighborhood(graph, [], { kind: "edge", id: edge("a", "b") });
    expect(lit.edges.has(edge("a", "b")) && lit.edges.has(edge("b", "a"))).toBe(true);
    expect(lit.edges.has(`route:${node("a")}:tailnet`)).toBe(true);
    expect(lit.edges.has(`route:${node("b")}:tailnet`)).toBe(true);
    expect(lit.edges.has(edge("a", "d"))).toBe(false);
  });

  it("offers the link back on a one-way link only where the client can make it", () => {
    const linkEdge = (from: ReturnType<typeof build>, source: string, target: string) =>
      from.edges.filter(isLinkEdge).find((entry) => entry.id === edge(source, target))!;
    expect(fleetLinkBackOffered(graph, linkEdge(graph, "a", "d"))).toBe(true);
    // Already linked back, at whatever access.
    expect(fleetLinkBackOffered(graph, linkEdge(graph, "a", "c"))).toBe(false);
    for (const target of [
      environment("d", "unknown", { phase: "offline" }),
      environment("d", "off", { offersLinks: false }),
      environment("d", [], { canWriteAccess: false }),
      environment("d", "loading"),
    ]) {
      const other = build([environment("a", [link("d")]), target]);
      expect(fleetLinkBackOffered(other, linkEdge(other, "a", "d"))).toBe(false);
    }
    for (const source of [{ canWriteAccess: false }, { hasLinkAddress: false }]) {
      const other = build([environment("a", [link("d")], source), environment("d")]);
      expect(fleetLinkBackOffered(other, linkEdge(other, "a", "d"))).toBe(false);
    }
    // A machine known only through the link is not one the client can link from.
    const unknown = build([environment("a", [link("x")])]);
    expect(fleetLinkBackOffered(unknown, linkEdge(unknown, "a", "x"))).toBe(false);
  });
});

describe("selecting and finding machines", () => {
  it("selects the machines a box touches, and never the client or a stack", () => {
    const graph = largeSetup();
    const layout = layoutFleetGraph(graph, fleetStacks(graph, new Set()));
    const everything = { x: 0, y: 0, width: layout.width, height: layout.height };
    expect(fleetNodesInBox(layout, everything).toSorted()).toEqual(
      [...layout.nodes.keys()].filter((key) => key !== FLEET_CLIENT_NODE_ID).toSorted(),
    );
    const cups = layout.nodes.get(node("cups"))!;
    expect(fleetNodesInBox(layout, { x: cups.x + 4, y: cups.y + 4, width: 2, height: 2 })).toEqual([
      node("cups"),
    ]);
  });

  it("finds machines by name wherever they are drawn, in name order", () => {
    const graph = largeSetup();
    expect(fleetSearch(graph, " FS-1 ").slice(0, 3)).toEqual(["fs-1", "fs-10", "fs-11"].map(node));
    expect(fleetSearch(graph, "")).toEqual([]);
    expect(fleetSearch(graph, "this browser")).toEqual([]);
  });
});

describe("fleetNeighborhood", () => {
  const graph = build([
    environment("a", [link("b"), ...vms(5)]),
    environment("b", [link("c")]),
    environment("c"),
  ]);
  const stacks = fleetStacks(graph, new Set());

  it("lights one hop from a machine and its routes, and does not follow a link through", () => {
    const lit = fleetNeighborhood(graph, stacks, { kind: "node", id: node("b") });
    expect([...lit.nodes].toSorted()).toEqual(
      [FLEET_CLIENT_NODE_ID, node("a"), node("b"), node("c")].toSorted(),
    );
    expect(lit.edges.has(`link:${node("a")}>${node("vm-1")}`)).toBe(false);
    expect(lit.edges.has(`route:${node("b")}:tailnet`)).toBe(true);
    expect(lit.edges.has(`route:${node("a")}:tailnet`)).toBe(true);
    expect(lit.edges.has(`route:${node("c")}:tailnet`)).toBe(false);
  });

  it("lights a stack's machines, their host and the route to it", () => {
    const lit = fleetNeighborhood(graph, stacks, { kind: "stack", id: stacks[0]!.id });
    expect(lit.nodes.has(node("vm-3"))).toBe(true);
    expect(lit.nodes.has(node("b"))).toBe(false);
    expect(lit.edges.has(`route:${node("a")}:tailnet`)).toBe(true);
  });
});

describe("layoutFleetGraph", () => {
  const membersOf = (stacks: ReturnType<typeof fleetStacks>) =>
    new Map(stacks.flatMap((stack) => stack.memberIds.map((member) => [member, stack.id])));

  it("places one environment, and a large setup, with nothing overlapping or out of bounds", () => {
    const one = build([environment("cups")]);
    expectNoOverlap(layoutFleetGraph(one), new Map());
    const large = largeSetup();
    const closed = fleetStacks(large, new Set());
    const layout = layoutFleetGraph(large, closed);
    expectNoOverlap(layout, membersOf(closed));
    // Forty machines cost one node: 6 environments, the client, the Connect machine, 5 targets.
    expect(layout.nodes.size).toBe(13);
    expect(layout.stacks.size).toBe(1);
    expect(layout.routes.size).toBe(9);
    expect(layout.columns.map((column) => column.id)).toEqual([
      "client",
      "environments",
      "targets",
    ]);
  });

  it("opens a stack where its card is, each machine in the tray below it", () => {
    const large = largeSetup();
    const closed = fleetStacks(large, new Set());
    const stackId = closed[0]!.id;
    const open = fleetStacks(large, new Set([stackId]));
    for (const width of [undefined, 560, 900, 1400]) {
      const before = layoutFleetGraph(large, closed, width);
      const layout = layoutFleetGraph(large, open, width);
      expectNoOverlap(layout, membersOf(open));
      // Forty machines open to the first 24 and one card for the other 16, never forty cards.
      expect(layout.nodes.size).toBe(13 + FLEET_STACK_SHOWN_MAX);
      const { face, tray } = layout.stacks.get(stackId)!;
      const more = fleetFocusRects(layout).get(fleetMoreNodeId(stackId))!;
      expect(layout.nodes.has(open[0]!.memberIds[FLEET_STACK_SHOWN_MAX]!)).toBe(false);
      for (const rect of [more, ...open[0]!.shownIds.map((member) => layout.nodes.get(member)!)]) {
        expect(rect.x).toBeGreaterThanOrEqual(tray!.x);
        expect(rect.y).toBeGreaterThanOrEqual(tray!.y);
        expect(rect.x + rect.width).toBeLessThanOrEqual(tray!.x + tray!.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(tray!.y + tray!.height);
      }
      // The card, its lines, every route and every column stay put: the width's measures are
      // those of the closed map, so opening never closes the columns up.
      expect(face).toEqual(before.stacks.get(stackId)!.face);
      expect(layout.stacks.get(stackId)!.lines.map((line) => line.arrow)).toEqual(
        before.stacks.get(stackId)!.lines.map((line) => line.arrow),
      );
      expect(layout.routes).toEqual(before.routes);
      expect(layout.columns).toEqual(before.columns);
      expect(tray!.y).toBeGreaterThanOrEqual(face.y + face.height);
      // Only machines the tray would cover move, and only down.
      for (const [nodeId, rect] of before.nodes) {
        const now = layout.nodes.get(nodeId)!;
        if (rect.x === face.x && rect.y > face.y) {
          expect(now.y, nodeId).toBeGreaterThanOrEqual(tray!.y + tray!.height);
          expect({ ...now, y: rect.y }, nodeId).toEqual(rect);
        } else {
          expect(now, nodeId).toEqual(rect);
        }
      }
    }
  });

  it("opens a group of environments where its card is, moving only the cards below it", () => {
    const graph = hugeSetup();
    const closed = fleetStacks(graph, new Set());
    const fold = closed.find((stack) => stack.kind === "environments")!;
    const open = fleetStacks(graph, new Set([fold.id]));
    for (const width of [560, 1400]) {
      const before = layoutFleetGraph(graph, closed, width);
      const layout = layoutFleetGraph(graph, open, width);
      expectNoOverlap(layout, membersOf(open));
      const { face } = layout.stacks.get(fold.id)!;
      expect(face).toEqual(before.stacks.get(fold.id)!.face);
      for (const [nodeId, rect] of before.nodes) {
        const now = layout.nodes.get(nodeId)!;
        if (rect.y < face.y) expect(now, nodeId).toEqual(rect);
        else expect({ ...now, y: rect.y }, nodeId).toEqual(rect);
      }
    }
  });

  it("draws the same map whatever order links arrive in", () => {
    const forward = build([environment("a", [...vms(7), link("x"), link("y")])]);
    const backward = build([environment("a", [link("y"), link("x"), ...vms(7).toReversed()])]);
    const lay = (graph: ReturnType<typeof build>) => {
      const layout = layoutFleetGraph(graph, fleetStacks(graph, new Set()));
      return [...layout.nodes].toSorted(([left], [right]) => (left < right ? -1 : 1));
    };
    expect(lay(backward)).toEqual(lay(forward));
  });

  it("names the access of links between environments on their own lane, clear of everything", () => {
    const graph = build([
      environment("a", [link("b"), link("c"), link("x")]),
      // At another access than the links back, so each of the four is its own line.
      environment("b", [link("a", { access: "auto" }), link("x")]),
      environment("c", [link("a", { access: "auto" })]),
    ]);
    const layout = layoutFleetGraph(graph);
    const geometry = (from: string, to: string) =>
      layout.links.get(`link:${node(from)}>${node(to)}`)!;
    expect(geometry("a", "x").badge).toBeNull();
    expect(geometry("b", "x").badge).toBeNull();
    const badges = [
      ["a", "b"],
      ["a", "c"],
      ["b", "a"],
      ["c", "a"],
    ].map(([from, to]) => {
      const { badge, d } = geometry(from!, to!);
      // On the link's own vertical run, between the two machines it joins.
      const run = samplePath(d).filter(
        (point) => point.y > badge!.y && point.y < badge!.y + badge!.height,
      );
      expect(run.length).toBeGreaterThan(0);
      for (const point of run) {
        expect(point.x).toBeGreaterThan(badge!.x);
        expect(point.x).toBeLessThan(badge!.x + badge!.width);
      }
      const ends = [layout.nodes.get(node(from!))!, layout.nodes.get(node(to!))!];
      expect(badge!.y).toBeGreaterThan(Math.min(...ends.map((rect) => rect.y)));
      expect(badge!.y).toBeLessThan(Math.max(...ends.map((rect) => rect.y + rect.height)));
      expect(badge!.x).toBeGreaterThanOrEqual(0);
      expect(badge!.x + badge!.width).toBeLessThanOrEqual(layout.width);
      return badge!;
    });
    const boxes = [...badges, ...solidRects(layout).map((box) => box.rect)];
    for (const [index, badge] of badges.entries()) {
      for (const other of boxes) {
        if (other !== badge && boxes.indexOf(other) > index) {
          expect(overlaps(badge, other)).toBe(false);
        }
      }
    }
  });

  it("runs links between environments left of them and links to other machines right", () => {
    const graph = largeSetup();
    const layout = layoutFleetGraph(graph, fleetStacks(graph, new Set()));
    const card = layout.nodes.get(node("nucbox"))!;
    for (const edge of graph.edges) {
      const geometry = edge.kind === "link" ? layout.links.get(edge.id) : undefined;
      if (geometry === undefined) continue;
      const between = layout.nodes.get(edge.to)!.x === card.x;
      for (const point of samplePath(geometry.d)) {
        if (between) expect(point.x, edge.id).toBeLessThanOrEqual(card.x);
        else expect(point.x, edge.id).toBeGreaterThanOrEqual(card.x + card.width);
      }
    }
  });

  it("keeps two hosts' links into one machine apart, and every link clear of other boxes", () => {
    for (const graph of [sharedSetup(), largeSetup(), hugeSetup()]) {
      for (const expanded of [false, true]) {
        const closed = fleetStacks(graph, new Set());
        const stacks = expanded
          ? fleetStacks(graph, new Set(closed.map((stack) => stack.id)))
          : closed;
        const layout = layoutFleetGraph(graph, stacks);
        expectNoOverlap(layout, membersOf(stacks));
        const boxes = solidRects(layout);
        const drawn = [
          ...[...layout.links].map(([key, geometry]) => ({ key, d: geometry.d })),
          ...[...layout.stacks].flatMap(([key, geometry]) =>
            geometry.lines.map((line) => ({ key, d: line.d })),
          ),
        ];
        for (const { key, d } of drawn) {
          for (const point of samplePath(d)) {
            const hit = boxes.find(
              ({ rect }) =>
                point.x > rect.x + 0.5 &&
                point.x < rect.x + rect.width - 0.5 &&
                point.y > rect.y + 0.5 &&
                point.y < rect.y + rect.height - 0.5,
            );
            expect(hit?.key, `${key} passes through ${hit?.key}`).toBeUndefined();
          }
        }
        // The last stretch into a machine is level, so two that differ in height never share it.
        const arrivals = new Map<string, number[]>();
        for (const edge of graph.edges) {
          const geometry = edge.kind === "link" ? layout.links.get(edge.id) : undefined;
          if (geometry === undefined) continue;
          const [before, last] = samplePath(geometry.d).slice(-2);
          // A machine an open stack pushed far down is reached by a steeper curve.
          expect(Math.abs(before!.y - geometry.arrow.y)).toBeLessThan(1);
          expect(last!.y).toBe(geometry.arrow.y);
          arrivals.set(edge.to, [...(arrivals.get(edge.to) ?? []), geometry.arrow.y]);
        }
        // A stack several hosts link to takes one line from each, each with its own entry.
        for (const [stackId, geometry] of layout.stacks) {
          for (const line of geometry.lines) {
            if (line.arrow === null) continue;
            if (geometry.lines.length > 1) {
              expect(samplePath(line.d).at(-2)!.y).toBeCloseTo(line.arrow.y, 0);
            }
            arrivals.set(stackId, [...(arrivals.get(stackId) ?? []), line.arrow.y]);
          }
        }
        for (const [target, heights] of arrivals) {
          const sorted = heights.toSorted((left, right) => left - right);
          for (const [index, height] of sorted.entries()) {
            if (index > 0) {
              expect(height - sorted[index - 1]!, `into ${target}`).toBeGreaterThanOrEqual(6);
            }
          }
        }
      }
    }
  });

  it("draws 1000 shared machines and 20 environments as a few stacks, open or closed", () => {
    const graph = hugeSetup();
    const closed = fleetStacks(graph, new Set());
    expect(closed.map((stack) => [stack.kind, stack.memberIds.length])).toEqual([
      ["targets", 1000],
      ["environments", 6],
      ["environments", 4],
    ]);
    const layout = layoutFleetGraph(graph, closed);
    expectNoOverlap(layout, membersOf(closed));
    // The client and the ten environments that stay cards: nothing per folded machine.
    expect(layout.nodes.size).toBe(11);
    expect(layout.links.size).toBe(2);
    expect(layout.routes.size).toBe(10);
    expect(layout.stacks.get(closed[0]!.id)!.lines.map((line) => line.sourceId)).toEqual([
      node("nucbox"),
      node("cups"),
    ]);
    const open = fleetStacks(graph, new Set(closed.map((stack) => stack.id)));
    const opened = layoutFleetGraph(graph, open);
    expectNoOverlap(opened, membersOf(open));
    expect(opened.nodes.size).toBe(11 + FLEET_STACK_SHOWN_MAX + 6 + 4);
    expect(layoutFleetGraph(graph, open)).toEqual(opened);
  });

  it("sizes a card by its name alone, whatever routes and links attach to it", () => {
    const routes = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `r${index}`, kind: "tailnet" as const }));
    const names = ["a", "b", "c", "d", "e"];
    const mesh = build(
      names.map((name, index) =>
        environment(
          name,
          names.filter((other) => other !== name).map((other) => link(other)),
          { routes: routes(index * 2 + 1) },
        ),
      ),
    );
    const layout = layoutFleetGraph(mesh);
    expectNoOverlap(layout, new Map());
    const plain = layoutFleetGraph(build([environment("a")])).nodes.get(node("a"))!;
    const cards = names.map((name) => layout.nodes.get(node(name))!);
    // Nine routes and eight links leave a card the size of one with a single route.
    expect(cards.map((card) => card.height)).toEqual(names.map(() => plain.height));
    expect(plain.height).toBeLessThanOrEqual(64);
    const long = layoutFleetGraph(build([environment("Julius's MacBook Pro")]));
    const wrapped = long.nodes.get(node("Julius's MacBook Pro"))!.height;
    expect(wrapped).toBeGreaterThan(plain.height);
    expect(wrapped).toBeLessThanOrEqual(72);
    for (const [index, name] of names.entries()) {
      const card = cards[index]!;
      const pills = mesh.edges
        .filter(isRouteEdge)
        .filter((edge) => edge.to === node(name))
        .map((edge) => layout.routes.get(edge.id)!);
      const centers = pills.map(({ pill }) => pill.y + pill.height / 2);
      // The route names keep their own pitch, centred on the card, and may reach past it.
      expect((centers[0]! + centers.at(-1)!) / 2).toBeCloseTo(card.y + card.height / 2, 5);
      for (const [at, center] of centers.entries()) {
        if (at > 0) expect(center - centers[at - 1]!).toBe(FLEET_ROUTE_PITCH);
      }
      // Their wires close up and enter the card as one bundle, each at its own height.
      const entries = pills.map(({ d }) => samplePath(d).at(-1)!.y);
      expect(new Set(entries).size).toBe(entries.length);
      expect(Math.max(...entries) - Math.min(...entries)).toBeLessThanOrEqual(10);
      for (const entry of entries) {
        expect(entry).toBeGreaterThan(card.y);
        expect(entry).toBeLessThan(card.y + card.height);
      }
    }
    // The gap between two cards grows only by what the taller column of route names needs.
    const gap = (upper: number) => cards[upper + 1]!.y - cards[upper]!.y - cards[upper]!.height;
    const two = layoutFleetGraph(build([environment("a"), environment("b")]));
    expect(gap(0)).toBe(two.nodes.get(node("b"))!.y - plain.y - plain.height);
    expect(gap(3)).toBeGreaterThan(gap(0));
  });

  it("gives every link into a card its own arrowhead on the edge the card already has", () => {
    const fan = build([
      ...["a", "b", "c", "d"].map((name) => environment(name, [link("e")])),
      environment("e"),
    ]);
    const pair = build([
      environment("a", [link("b"), link("c")]),
      environment("b"),
      environment("c", [link("b")]),
    ]);
    const names = ["a", "b", "c", "d", "e"];
    const mesh = build(
      names.map((name) =>
        environment(
          name,
          names.filter((other) => other !== name).map((other) => link(other)),
        ),
      ),
    );
    for (const [graph, roomy] of [
      [pair, true],
      [fan, false],
      [mesh, false],
    ] as const) {
      const layout = layoutFleetGraph(graph);
      expectNoOverlap(layout, new Map());
      const arrivals = new Map<string, number[]>();
      for (const edge of graph.edges) {
        const geometry = edge.kind === "link" ? layout.links.get(edge.id) : undefined;
        if (edge.kind !== "link" || geometry === undefined) continue;
        const from = layout.nodes.get(edge.from)!;
        const leaves = samplePath(geometry.d)[0]!.y;
        expect(leaves).toBeGreaterThan(from.y);
        expect(leaves).toBeLessThan(from.y + from.height);
        arrivals.set(edge.to, [...(arrivals.get(edge.to) ?? []), geometry.arrow.y]);
        if (geometry.twoWay !== null) {
          const into = arrivals.get(edge.from) ?? [];
          arrivals.set(edge.from, [...into, geometry.twoWay.backArrow.y]);
        }
      }
      for (const [id, heights] of arrivals) {
        const card = layout.nodes.get(id)!;
        const sorted = heights.toSorted((left, right) => left - right);
        expect(sorted[0]!).toBeGreaterThan(card.y);
        expect(sorted.at(-1)!).toBeLessThan(card.y + card.height);
        for (const [index, height] of sorted.entries()) {
          if (index === 0) continue;
          // With room they are a full lane apart; a crowded edge closes them up, never onto
          // one another.
          expect(height - sorted[index - 1]!, `at ${id}`).toBeGreaterThanOrEqual(
            roomy ? FLEET_LANE_PITCH : 3,
          );
        }
      }
    }
  });

  it("draws a two-way link once, on one lane, with an arrowhead into each card", () => {
    const setup = (back: Partial<PeerLinkSummary>) =>
      build([environment("a", [link("b")]), environment("b", [link("a", back)])]);
    const merged = setup({});
    const apart = setup({ access: "auto" });
    const forward = `link:${node("a")}>${node("b")}`;
    const reverse = `link:${node("b")}>${node("a")}`;
    const layout = layoutFleetGraph(merged);
    const two = layoutFleetGraph(apart);
    expect([...layout.links.keys()]).toEqual([forward]);
    expect([...two.links.keys()].toSorted()).toEqual([forward, reverse]);
    // Two lines need two lanes left of the cards; the merged one needs a single lane.
    expect(two.nodes.get(node("a"))!.x - layout.nodes.get(node("a"))!.x).toBeGreaterThan(0);
    expect(two.links.get(forward)!.twoWay).toBeNull();
    const geometry = layout.links.get(forward)!;
    const { twoWay } = geometry;
    expect(twoWay).not.toBeNull();
    for (const [arrow, cardId] of [
      [geometry.arrow, "b"],
      [twoWay!.backArrow, "a"],
    ] as const) {
      const card = layout.nodes.get(node(cardId))!;
      expect(arrow.x).toBe(card.x);
      expect(arrow.y).toBeGreaterThan(card.y);
      expect(arrow.y).toBeLessThan(card.y + card.height);
    }
    // Each half ends at its own arrowhead and the two meet, so one direction's state shows at
    // its end without a gap in the line.
    const forwardHalf = samplePath(twoWay!.forward);
    const backHalf = samplePath(twoWay!.back);
    expect(forwardHalf.at(-1)!.y).toBe(geometry.arrow.y);
    expect(backHalf[0]!.y).toBe(twoWay!.backArrow.y);
    expect(backHalf.at(-1)).toEqual(forwardHalf[0]);
    expect(geometry.badge?.onDemand).toBe(false);
    // Health is no part of the shape: one direction failing redraws nothing.
    expect(fleetShapeKey(setup({ status: "unreachable" }), [])).toBe(fleetShapeKey(merged, []));
  });

  it("shows a link's name only on demand where it has no clear place", () => {
    const names = ["a", "b", "c", "d", "e"];
    const graph = build(
      names.map((name) =>
        environment(
          name,
          names.filter((other) => other !== name).map((other) => link(other)),
        ),
      ),
    );
    const layout = layoutFleetGraph(graph);
    const between = [...layout.links.values()];
    const always = between.flatMap(({ badge }) => (badge && !badge.onDemand ? [badge] : []));
    // Every link keeps a name; the ones always drawn sit on no other link's lane and no other name.
    expect(between.every(({ badge }) => badge !== null)).toBe(true);
    expect(always.length).toBeGreaterThan(0);
    expect(always.length).toBeLessThan(between.length);
    for (const [index, badge] of always.entries()) {
      for (const other of always.slice(index + 1)) expect(overlaps(badge, other)).toBe(false);
      const crossing = between.filter(({ badge: own, d }) => {
        if (own === badge) return false;
        return samplePath(d).some(
          (point) =>
            point.x > badge.x + 0.5 &&
            point.x < badge.x + badge.width - 0.5 &&
            point.y > badge.y + 0.5 &&
            point.y < badge.y + badge.height - 0.5,
        );
      });
      expect(crossing).toEqual([]);
    }
  });

  it("puts a machine several hosts link to between them, and one host's machines beside it", () => {
    const layout = layoutFleetGraph(sharedSetup());
    const center = (name: string) => {
      const rect = layout.nodes.get(node(name))!;
      return rect.y + rect.height / 2;
    };
    for (const name of ["fs-1", "fs-2", "fs-3"]) {
      expect(center(name)).toBeGreaterThan(center("nucbox"));
      expect(center(name)).toBeLessThan(center("cups"));
    }
    expect(center("fs-5")).toBe(center("cups"));
    // The upper host's link arrives above the lower host's.
    const arrival = (from: string) => layout.links.get(`link:${node(from)}>${node("fs-2")}`)!.arrow;
    expect(arrival("nucbox").y).toBeLessThan(arrival("cups").y);
  });

  it("gives up gutters before scale: a real setup stays legible from 560 to 1400 wide", () => {
    const routes = (...kinds: ReadonlyArray<"lan" | "tailnet" | "relay">) =>
      kinds.map((kind, index) => ({ id: `${kind}-${index}`, kind }));
    const graph = build([
      environment("cups", "unknown", {
        phase: "offline",
        routes: routes("tailnet", "tailnet", "relay"),
      }),
      environment(
        "nucbox-1",
        [
          link("Julius's MacBook Pro", { access: "full-access" }),
          ...vms(7, "fs", { access: "full-access" }),
          ...vms(37, "gs", { access: "full-access", status: "unreachable" }),
        ],
        { routes: routes("lan", "tailnet", "tailnet", "relay"), activeRouteId: "lan-0" },
      ),
      environment("Julius's MacBook Pro"),
    ]);
    const stacks = fleetStacks(graph, new Set());
    expect(stacks.map((stack) => [stack.memberIds.length, stack.reachable])).toEqual([[44, 7]]);
    const regular = layoutFleetGraph(graph, stacks);
    const widths = [560, 900, 1400].map((width) => {
      const layout = layoutFleetGraph(graph, stacks, width);
      expectNoOverlap(layout, membersOf(stacks));
      const height = fleetCanvasHeight(layout, width, { min: 0, max: 840 });
      expect(fitFleetLayout(layout, { width, height }).scale, `at ${width}`).toBeGreaterThanOrEqual(
        FLEET_FIT_LEGIBLE_SCALE,
      );
      // Only the columns move: every height, and so every lane and entry, is the regular one.
      expect(layout.height).toBe(regular.height);
      // Each route enters its machine at its own height, and a link's arrowhead stands clear
      // of all of them.
      const arrivals = new Map<string, { routes: number[]; links: number[] }>();
      const into = (id: string) =>
        arrivals.get(id) ?? arrivals.set(id, { routes: [], links: [] }).get(id)!;
      for (const edge of graph.edges) {
        if (edge.kind === "route") {
          into(edge.to).routes.push(samplePath(layout.routes.get(edge.id)!.d).at(-1)!.y);
        } else if (layout.links.has(edge.id)) {
          into(edge.to).links.push(layout.links.get(edge.id)!.arrow.y);
        }
      }
      for (const [id, { routes: entries, links: arrows }] of arrivals) {
        expect(new Set(entries).size, `into ${id}`).toBe(entries.length);
        for (const arrow of arrows) {
          for (const entry of entries) {
            expect(Math.abs(arrow - entry), `into ${id}`).toBeGreaterThanOrEqual(8);
          }
        }
      }
      // Every wire and link still ends level, however short its run became.
      for (const { d } of [...layout.routes.values(), ...layout.links.values()]) {
        const [before, last] = samplePath(d).slice(-2);
        expect(before!.y).toBe(last!.y);
      }
      return layout.width;
    });
    expect(widths[0]).toBeLessThan(regular.width);
    expect(widths[2]).toBeGreaterThan(regular.width);
  });

  it("gives a stack room to say how many machines answer only when some do not", () => {
    const face = (links: ReadonlyArray<PeerLinkSummary>) => {
      const graph = build([environment("host", links)]);
      const stacks = fleetStacks(graph, new Set());
      expect(fleetStackPartial(stacks[0]!)).toBe(
        links.some((entry) => entry.status !== "reachable"),
      );
      return {
        key: fleetShapeKey(graph, stacks),
        height: layoutFleetGraph(graph, stacks).stacks.get(stacks[0]!.id)!.face.height,
      };
    };
    const whole = face(vms(6));
    const partial = face([...vms(5), link("vm-6", { status: "unreachable" })]);
    expect(partial.height).toBeGreaterThan(whole.height);
    // The card changes size, so the layout has to be made again.
    expect(partial.key).not.toBe(whole.key);
  });

  it("keeps the shape key when only health, route state or status changes", () => {
    const key = (graph: ReturnType<typeof build>) =>
      fleetShapeKey(graph, fleetStacks(graph, new Set()));
    // One machine already not answering: how many more go quiet does not resize the card.
    const before = build([environment("a", [...vms(5), link("vm-6", { status: "unreachable" })])]);
    const after = build([
      environment("a", [...vms(6, "vm", { status: "unreachable" })], {
        activeRouteId: null,
        phase: "connected",
      }),
    ]);
    expect(key(after)).toBe(key(before));
    const moved = build([environment("a", [...vms(6, "vm", { access: "read-only" })])]);
    expect(key(moved)).not.toBe(key(before));
    const stacks = fleetStacks(before, new Set());
    expect(fleetShapeKey(before, fleetStacks(before, new Set([stacks[0]!.id])))).not.toBe(
      key(before),
    );
    // An environment that comes back leaves its folded group, with the group's id unchanged.
    const labs = (firstPhase: FleetEnvironmentInput["phase"]) =>
      build(
        Array.from({ length: 14 }, (_, index) =>
          environment(`lab-${index}`, "unknown", { phase: index === 0 ? firstPhase : "offline" }),
        ),
      );
    expect(key(labs("connecting"))).not.toBe(key(labs("offline")));
  });
});

describe("nextFleetNode", () => {
  it("steps between columns and down a column, stacks included", () => {
    const graph = build([
      environment("a", [...vms(5), link("x", { access: "read-only" })]),
      environment("b"),
    ]);
    const stacks = fleetStacks(graph, new Set());
    const rects = fleetFocusRects(layoutFleetGraph(graph, stacks));
    expect(nextFleetNode(rects, FLEET_CLIENT_NODE_ID, "right")).toBe(node("a"));
    expect(nextFleetNode(rects, node("a"), "down")).toBe(node("b"));
    expect(nextFleetNode(rects, node("a"), "right")).toBe(stacks[0]!.id);
    expect(nextFleetNode(rects, stacks[0]!.id, "down")).toBe(node("x"));
    expect(nextFleetNode(rects, FLEET_CLIENT_NODE_ID, "left")).toBeNull();
  });
});

describe("fitting the view", () => {
  it("fills the canvas but caps the zoom for a small map", () => {
    const view = fitFleetLayout({ width: 300, height: 60 }, { width: 900, height: 400 });
    expect(view.scale).toBe(1.15);
    expect(view.x).toBeCloseTo((900 - 300 * 1.15) / 2);
  });

  it("fits a map taller than the manual minimum allows, and zooming out does not jump back", () => {
    const view = fitFleetLayout({ width: 700, height: 1572 }, { width: 800, height: 360 });
    expect(view.scale).toBeLessThan(0.3);
    expect(1572 * view.scale).toBeLessThanOrEqual(360);
    expect(zoomFleetView(view, 0.8, { x: 0, y: 0 }).scale).toBe(view.scale);
    const closer = zoomFleetView(view, 1.25, { x: 0, y: 0 }, view.scale);
    expect(closer.scale).toBeGreaterThan(view.scale);
    expect(zoomFleetView(closer, 0.8, { x: 0, y: 0 }, view.scale).scale).toBeCloseTo(view.scale);
  });

  it("sizes the canvas to the fitted map within its bounds", () => {
    const bounds = { min: 240, max: 640 };
    expect(fleetCanvasHeight({ width: 400, height: 60 }, 900, bounds)).toBe(240);
    expect(fleetCanvasHeight({ width: 800, height: 2000 }, 900, bounds)).toBe(640);
    expect(fleetCanvasHeight({ width: 800, height: 300 }, 900, bounds)).toBe(
      Math.ceil(300 * ((900 - 56) / 800) + 56),
    );
  });

  it("keeps a stack where it is on screen when it opens, and returns when it closes", () => {
    const graph = largeSetup();
    const closed = fleetStacks(graph, new Set());
    const stackId = closed[0]!.id;
    const open = fleetStacks(graph, new Set([stackId]));
    const bounds = { min: 180, max: 840 };
    const onScreen = (view: { x: number; y: number; scale: number }, rect: FleetRect) => ({
      x: rect.x * view.scale + view.x,
      y: rect.y * view.scale + view.y,
    });
    for (const width of [560, 640, 1400]) {
      const before = layoutFleetGraph(graph, closed, width);
      const after = layoutFleetGraph(graph, open, width);
      const size = { width, height: fleetCanvasHeight(before, width, bounds) };
      const fit = fitFleetLayout(before, size);
      const face = before.stacks.get(stackId)!.face;
      const opened = anchorFleetView({
        key: "open",
        from: { key: "closed", held: null, view: fit, size, face },
        stack: after.stacks.get(stackId)!,
        layout: after,
        bounds,
      });
      expect(opened.key).toBe("open");
      expect(opened.glide).toBe(true);
      // The canvas only grows, to show what opened, and never past its bound.
      expect(opened.height).toBeGreaterThanOrEqual(size.height);
      expect(opened.height).toBeLessThanOrEqual(bounds.max);
      // The scale holds, and the card and every machine beside it stay where they were.
      expect(opened.view).toEqual(fit);
      expect(onScreen(opened.view, after.nodes.get(node("nucbox"))!)).toEqual(
        onScreen(fit, before.nodes.get(node("nucbox"))!),
      );
      const tray = after.stacks.get(stackId)!.rect;
      expect(onScreen(opened.view, tray).x + tray.width * opened.view.scale).toBeLessThanOrEqual(
        width,
      );

      // Zoomed in until the stack is wider than the canvas, the view shrinks to its width, once.
      const close = { x: fit.x - 600, y: fit.y, scale: 6 };
      const shrunk = anchorFleetView({
        key: "open",
        from: { key: "closed", held: null, view: close, size, face },
        stack: after.stacks.get(stackId)!,
        layout: after,
        bounds,
      });
      expect(shrunk.view.scale).toBeLessThan(6);
      expect(onScreen(shrunk.view, tray).x).toBeGreaterThanOrEqual(0);
      expect(onScreen(shrunk.view, tray).x + tray.width * shrunk.view.scale).toBeLessThanOrEqual(
        width,
      );
      expect(onScreen(shrunk.view, face).y).toBeCloseTo(onScreen(close, face).y);

      // Closing it again goes back to the fit it came from.
      const back = anchorFleetView({
        key: "closed",
        from: { key: "open", held: opened, view: opened.view, size, face },
        stack: before.stacks.get(stackId)!,
        layout: before,
        bounds,
      });
      expect(back.key).toBe("");
      expect(back.glide).toBe(true);

      // After a pan the view is the user's: closing keeps the card under the pointer instead.
      const panned = { ...opened, view: { ...opened.view, x: opened.view.x - 40 }, undo: null };
      const closedAgain = anchorFleetView({
        key: "closed",
        from: { key: "open", held: panned, view: panned.view, size, face },
        stack: before.stacks.get(stackId)!,
        layout: before,
        bounds,
      });
      expect(closedAgain.key).toBe("closed");
      expect(closedAgain.view.scale).toBe(panned.view.scale);
      expect(onScreen(closedAgain.view, face)).toEqual(onScreen(panned.view, face));
      expect(closedAgain.height).toBeLessThanOrEqual(size.height);
      // The canvas that grew for the tray gives that room back, not just the pre-open size.
      const grown = { width, height: opened.height };
      const givenBack = anchorFleetView({
        key: "closed",
        from: { key: "open", held: panned, view: panned.view, size: grown, face },
        stack: before.stacks.get(stackId)!,
        layout: before,
        bounds,
      });
      expect(givenBack.height).toBeLessThan(opened.height);
    }
  });

  it("returns to a view set by hand before the stack opened", () => {
    const graph = largeSetup();
    const closed = fleetStacks(graph, new Set());
    const stackId = closed[0]!.id;
    const before = layoutFleetGraph(graph, closed, 1400);
    const after = layoutFleetGraph(graph, fleetStacks(graph, new Set([stackId])), 1400);
    const bounds = { min: 180, max: 840 };
    const size = { width: 1400, height: 500 };
    const held = {
      key: "closed",
      view: { x: -120, y: 30, scale: 1.4 },
      height: 500,
      glide: false,
      undo: null,
    };
    const face = before.stacks.get(stackId)!.face;
    const opened = anchorFleetView({
      key: "open",
      from: { key: "closed", held, view: held.view, size, face },
      stack: after.stacks.get(stackId)!,
      layout: after,
      bounds,
    });
    expect(opened.view.scale).toBe(1.4);
    const back = anchorFleetView({
      key: "closed",
      from: { key: "open", held: opened, view: opened.view, size, face },
      stack: before.stacks.get(stackId)!,
      layout: before,
      bounds,
    });
    expect(back).toEqual({ ...held, glide: true });
  });

  it("zooms around the anchor", () => {
    const view = zoomFleetView({ x: 10, y: 20, scale: 1 }, 2, { x: 100, y: 100 });
    expect(view).toEqual({ scale: 2, x: -80, y: -60 });
  });
});
