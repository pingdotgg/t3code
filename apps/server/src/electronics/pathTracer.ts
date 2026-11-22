import type {
  ElectronicsCircuitModel,
  ElectronicsComponent,
  ElectronicsComponentKind,
  ElectronicsPathHop,
  ElectronicsTracePathResult,
} from "@t3tools/contracts";

import { isGroundNetName, parseEngineeringNumber } from "./parsers.ts";

const TRAVERSABLE_SERIES_KINDS: ReadonlySet<ElectronicsComponentKind> = new Set([
  "resistor",
  "inductor",
  "fuse",
  "switch",
  "diode",
]);

interface ResolvedEndpoint {
  readonly query: string;
  readonly nets: ReadonlySet<string>;
  readonly componentRef?: string;
  readonly pinNumber?: string;
  readonly warnings: string[];
}

function resolveEndpoint(model: ElectronicsCircuitModel, rawQuery: string): ResolvedEndpoint {
  const query = rawQuery.trim();
  const warnings: string[] = [];
  const nets = new Set<string>();

  // 1. Exact net match (case-insensitive)
  const exactNet = model.nets.find((n) => n.name.toLowerCase() === query.toLowerCase());
  if (exactNet) {
    nets.add(exactNet.name);
    return { query, nets, warnings };
  }

  // 2. Component.Pin or Component:Pin syntax (e.g. U1.3, U1.VOUT, J1:1)
  const dotIdx = query.search(/[.:]/u);
  if (dotIdx > 0) {
    const refPart = query.slice(0, dotIdx).trim();
    const pinPart = query.slice(dotIdx + 1).trim();
    const comp = model.components.find((c) => c.ref.toLowerCase() === refPart.toLowerCase());
    if (!comp) {
      warnings.push(`Component "${refPart}" was not found in ${model.filePath}.`);
      return { query, nets, warnings };
    }
    const pin = comp.pins.find(
      (p) =>
        p.number.toLowerCase() === pinPart.toLowerCase() ||
        (p.name !== undefined && p.name.toLowerCase() === pinPart.toLowerCase()),
    );
    if (!pin) {
      warnings.push(`Pin "${pinPart}" was not found on component ${comp.ref}.`);
      return { query, nets, componentRef: comp.ref, warnings };
    }
    if (pin.net) {
      nets.add(pin.net);
    } else {
      warnings.push(
        `Pin ${comp.ref}.${pin.number}${pin.name ? ` (${pin.name})` : ""} is unconnected.`,
      );
    }
    return { query, nets, componentRef: comp.ref, pinNumber: pin.number, warnings };
  }

  // 3. Component reference match (all nets touching this component)
  const comp = model.components.find((c) => c.ref.toLowerCase() === query.toLowerCase());
  if (comp) {
    for (const pin of comp.pins) {
      if (pin.net) nets.add(pin.net);
    }
    if (nets.size === 0) {
      warnings.push(`Component ${comp.ref} has no connected nets.`);
    }
    return { query, nets, componentRef: comp.ref, warnings };
  }

  warnings.push(
    `Endpoint "${query}" did not match any net, component, or pin in ${model.filePath}.`,
  );
  return { query, nets, warnings };
}

function isSeriesTraversable(comp: ElectronicsComponent): boolean {
  if (comp.pins.length !== 2) return false;
  if (TRAVERSABLE_SERIES_KINDS.has(comp.kind)) return true;
  // Also allow 2-pin jumper connectors (JP1 / J_BRIDGE)
  if (comp.kind === "connector" && /^JP\d/iu.test(comp.ref)) return true;
  return false;
}

export function traceCircuitPath(
  model: ElectronicsCircuitModel,
  options: {
    readonly from: string;
    readonly to?: string;
    readonly traversePassives?: boolean;
    readonly maxHops?: number;
  },
): ElectronicsTracePathResult {
  const traversePassives = options.traversePassives ?? true;
  const maxHops = options.maxHops ?? 8;

  const fromResolved = resolveEndpoint(model, options.from);
  const warnings = [...fromResolved.warnings];

  // Single-endpoint inspection mode: return the net(s) and directly connected components
  if (options.to === undefined || options.to.trim().length === 0) {
    const highlightedNets = Array.from(fromResolved.nets);
    const highlightedCompSet = new Set<string>();
    if (fromResolved.componentRef) highlightedCompSet.add(fromResolved.componentRef);
    const hops: ElectronicsPathHop[] = [];
    for (const netName of highlightedNets) {
      hops.push({ kind: "net", name: netName });
      const net = model.nets.find((n) => n.name === netName);
      if (net) {
        for (const p of net.pins) highlightedCompSet.add(p.ref);
      }
    }
    return {
      filePath: model.filePath,
      from: options.from,
      connected: highlightedNets.length > 0,
      ...(highlightedNets.length === 1 ? { directNet: highlightedNets[0]! } : {}),
      fromNets: highlightedNets,
      toNets: [],
      hops,
      highlightedNets,
      highlightedComponents: Array.from(highlightedCompSet),
      warnings,
    };
  }

  const toResolved = resolveEndpoint(model, options.to);
  warnings.push(...toResolved.warnings);

  const fromNets = Array.from(fromResolved.nets);
  const toNets = Array.from(toResolved.nets);

  if (fromNets.length === 0 || toNets.length === 0) {
    return {
      filePath: model.filePath,
      from: options.from,
      to: options.to,
      connected: false,
      fromNets,
      toNets,
      hops: [],
      highlightedNets: [...fromNets, ...toNets],
      highlightedComponents: [
        ...(fromResolved.componentRef ? [fromResolved.componentRef] : []),
        ...(toResolved.componentRef ? [toResolved.componentRef] : []),
      ],
      warnings,
    };
  }

  // 1. Check direct same-net connectivity
  for (const netName of fromNets) {
    if (toResolved.nets.has(netName)) {
      const highlightedComponents = new Set<string>();
      if (fromResolved.componentRef) highlightedComponents.add(fromResolved.componentRef);
      if (toResolved.componentRef) highlightedComponents.add(toResolved.componentRef);
      return {
        filePath: model.filePath,
        from: options.from,
        to: options.to,
        connected: true,
        directNet: netName,
        fromNets,
        toNets,
        hops: [{ kind: "net", name: netName }],
        highlightedNets: [netName],
        highlightedComponents: Array.from(highlightedComponents),
        estimatedResistanceOhms: 0,
        warnings,
      };
    }
  }

  if (!traversePassives) {
    warnings.push(
      `No direct single-net connection between "${options.from}" and "${options.to}" (passive traversal disabled).`,
    );
    return {
      filePath: model.filePath,
      from: options.from,
      to: options.to,
      connected: false,
      fromNets,
      toNets,
      hops: [],
      highlightedNets: [...fromNets, ...toNets],
      highlightedComponents: [
        ...(fromResolved.componentRef ? [fromResolved.componentRef] : []),
        ...(toResolved.componentRef ? [toResolved.componentRef] : []),
      ],
      warnings,
    };
  }

  // 2. Build net-to-net adjacency through 2-pin series passives
  interface Edge {
    readonly comp: ElectronicsComponent;
    readonly fromPin: string;
    readonly toPin: string;
    readonly nextNet: string;
  }

  const adj = new Map<string, Edge[]>();
  const addEdge = (net: string, edge: Edge) => {
    let list = adj.get(net);
    if (!list) {
      list = [];
      adj.set(net, list);
    }
    list.push(edge);
  };

  for (const comp of model.components) {
    if (!isSeriesTraversable(comp)) continue;
    const p1 = comp.pins[0]!;
    const p2 = comp.pins[1]!;
    if (!p1.net || !p2.net || p1.net === p2.net) continue;
    addEdge(p1.net, { comp, fromPin: p1.number, toPin: p2.number, nextNet: p2.net });
    addEdge(p2.net, { comp, fromPin: p2.number, toPin: p1.number, nextNet: p1.net });
  }

  // BFS from all source nets to any target net
  interface QueueNode {
    readonly net: string;
    readonly depth: number;
    readonly hops: ElectronicsPathHop[];
  }

  const targetIsGround = toNets.some((n) => isGroundNetName(n));
  const visited = new Set<string>(fromNets);
  const queue: QueueNode[] = fromNets.map((net) => ({
    net,
    depth: 0,
    hops: [{ kind: "net", name: net }],
  }));

  let winningHops: ElectronicsPathHop[] | null = null;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxHops) continue;

    for (const edge of adj.get(current.net) ?? []) {
      // Do not route through GND as an intermediate node unless GND is the target
      if (isGroundNetName(edge.nextNet) && !toResolved.nets.has(edge.nextNet) && !targetIsGround) {
        continue;
      }
      const nextHops: ElectronicsPathHop[] = [
        ...current.hops,
        {
          kind: "component",
          name: edge.comp.ref,
          value: edge.comp.value,
          fromPin: edge.fromPin,
          toPin: edge.toPin,
          componentKind: edge.comp.kind,
        },
        { kind: "net", name: edge.nextNet },
      ];
      if (toResolved.nets.has(edge.nextNet)) {
        winningHops = nextHops;
        break;
      }
      if (!visited.has(edge.nextNet)) {
        visited.add(edge.nextNet);
        queue.push({ net: edge.nextNet, depth: current.depth + 1, hops: nextHops });
      }
    }
    if (winningHops) break;
  }

  if (!winningHops) {
    warnings.push(
      `No electrical path found from "${options.from}" to "${options.to}" within ${maxHops} passive hops.`,
    );
    return {
      filePath: model.filePath,
      from: options.from,
      to: options.to,
      connected: false,
      fromNets,
      toNets,
      hops: [],
      highlightedNets: [...fromNets, ...toNets],
      highlightedComponents: [
        ...(fromResolved.componentRef ? [fromResolved.componentRef] : []),
        ...(toResolved.componentRef ? [toResolved.componentRef] : []),
      ],
      warnings,
    };
  }

  const highlightedNets: string[] = [];
  const highlightedComponents = new Set<string>();
  if (fromResolved.componentRef) highlightedComponents.add(fromResolved.componentRef);
  if (toResolved.componentRef) highlightedComponents.add(toResolved.componentRef);

  let totalResistanceOhms = 0;
  let hasResistiveEstimate = true;

  for (const hop of winningHops) {
    if (hop.kind === "net") {
      highlightedNets.push(hop.name);
    } else {
      highlightedComponents.add(hop.name);
      if (hop.componentKind === "resistor") {
        const val = hop.value ? parseEngineeringNumber(hop.value) : null;
        if (val !== null) totalResistanceOhms += val;
        else hasResistiveEstimate = false;
      } else if (hop.componentKind === "diode") {
        warnings.push(
          `Path crosses diode ${hop.name} (${hop.fromPin}→${hop.toPin}); verify forward polarity.`,
        );
      } else if (hop.componentKind === "switch") {
        warnings.push(`Path crosses switch ${hop.name}; connectivity depends on switch state.`);
      }
    }
  }

  if (hasResistiveEstimate && totalResistanceOhms >= 100_000) {
    warnings.push(
      `High series resistance along path (~${(totalResistanceOhms / 1000).toFixed(1)} kΩ); verify current drive.`,
    );
  }

  return {
    filePath: model.filePath,
    from: options.from,
    to: options.to,
    connected: true,
    fromNets,
    toNets,
    hops: winningHops,
    highlightedNets,
    highlightedComponents: Array.from(highlightedComponents),
    ...(hasResistiveEstimate
      ? { estimatedResistanceOhms: Number(totalResistanceOhms.toFixed(4)) }
      : {}),
    warnings,
  };
}
