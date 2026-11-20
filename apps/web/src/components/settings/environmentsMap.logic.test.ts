import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleetGraph,
  fitFleetLayout,
  fleetCanvasHeight,
  FLEET_CLIENT_NODE_ID,
  fleetEnvironmentNodeId,
  fleetFocusRects,
  fleetLinkOffer,
  fleetNeighborhood,
  fleetShapeKey,
  fleetStacks,
  fleetSummary,
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
    expect(fleetStacks(graph, new Set([stacks[0]!.id]))[0]!.expanded).toBe(true);
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

  it("opens a stack in place, each machine inside its frame", () => {
    const large = largeSetup();
    const stackId = fleetStacks(large, new Set())[0]!.id;
    const open = fleetStacks(large, new Set([stackId]));
    const layout = layoutFleetGraph(large, open);
    expectNoOverlap(layout, membersOf(open));
    expect(layout.nodes.size).toBe(53);
    const frame = layout.stacks.get(stackId)!.rect;
    for (const member of open[0]!.memberIds) {
      const rect = layout.nodes.get(member)!;
      expect(rect.x).toBeGreaterThanOrEqual(frame.x);
      expect(rect.y).toBeGreaterThanOrEqual(frame.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(frame.y + frame.height);
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
      environment("b", [link("a"), link("x")]),
      environment("c", [link("a")]),
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
    for (const graph of [sharedSetup(), largeSetup()]) {
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
          ...[...layout.stacks].map(([key, geometry]) => ({ key, d: geometry.d })),
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
          expect(before!.y).toBeCloseTo(geometry.arrow.y, 0);
          expect(last!.y).toBe(geometry.arrow.y);
          arrivals.set(edge.to, [...(arrivals.get(edge.to) ?? []), geometry.arrow.y]);
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

  it("keeps the shape key when only health, route state or status changes", () => {
    const key = (graph: ReturnType<typeof build>) =>
      fleetShapeKey(graph, fleetStacks(graph, new Set()));
    const before = build([environment("a", [...vms(6)])]);
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

  it("zooms around the anchor", () => {
    const view = zoomFleetView({ x: 10, y: 20, scale: 1 }, 2, { x: 100, y: 100 });
    expect(view).toEqual({ scale: 2, x: -80, y: -60 });
  });
});
