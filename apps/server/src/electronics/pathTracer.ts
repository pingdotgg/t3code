import type {
  ElectronicsCircuitModel,
  ElectronicsComponent,
  ElectronicsComponentKind,
  ElectronicsPathHop,
  ElectronicsTracePathResult,
} from "@t3tools/contracts";

import { isGroundNetName, parseEngineeringNumber } from "./parsers.ts";
import { computePcbCopperIslands } from "./validator.ts";

const TRAVERSABLE_SERIES_KINDS: ReadonlySet<ElectronicsComponentKind> = new Set([
  "resistor",
  "inductor",
  "fuse",
  "switch",
  "diode",
]);

interface ResolvedPin {
  readonly ref: string;
  readonly pin: string;
  readonly net: string;
}

interface ResolvedEndpoint {
  readonly query: string;
  readonly nets: ReadonlySet<string>;
  readonly matchedPins: ReadonlyArray<ResolvedPin>;
  readonly componentRef?: string;
  readonly pinNumber?: string;
  readonly warnings: string[];
}

function resolveEndpoint(model: ElectronicsCircuitModel, rawQuery: string): ResolvedEndpoint {
  const query = rawQuery.trim();
  const warnings: string[] = [];
  const nets = new Set<string>();

  // 1. Exact net match (prefer exact case; case-insensitive fallback only when unambiguous)
  const exactCaseNet = model.nets.find((n) => n.name === query);
  if (exactCaseNet) {
    nets.add(exactCaseNet.name);
    return { query, nets, matchedPins: [], warnings };
  }
  const lowerQuery = query.toLowerCase();
  const ciNetMatches = model.nets.filter((n) => n.name.toLowerCase() === lowerQuery);
  if (ciNetMatches.length === 1) {
    nets.add(ciNetMatches[0]!.name);
    return { query, nets, matchedPins: [], warnings };
  }
  if (ciNetMatches.length > 1) {
    warnings.push(
      `Net query "${query}" matched multiple nets differing only by case (${ciNetMatches.map((n) => n.name).join(", ")}); specify exact case.`,
    );
    return { query, nets, matchedPins: [], warnings };
  }

  // 2. Component.Pin or Component:Pin syntax (e.g. U1.3, U1.VOUT, J1:1) — search across all units of a multi-unit ref
  const dotIdx = query.search(/[.:]/u);
  if (dotIdx > 0) {
    const refPart = query.slice(0, dotIdx).trim();
    const pinPart = query.slice(dotIdx + 1).trim();
    const matchingUnits = model.components.filter(
      (c) => c.ref.toLowerCase() === refPart.toLowerCase(),
    );
    if (matchingUnits.length === 0) {
      warnings.push(`Component "${refPart}" was not found in ${model.filePath}.`);
      return { query, nets, matchedPins: [], warnings };
    }
    const primaryRef = matchingUnits[0]!.ref;
    const allPins = matchingUnits.flatMap((c) => c.pins);
    const pin = allPins.find(
      (p) =>
        p.number.toLowerCase() === pinPart.toLowerCase() ||
        (p.name !== undefined && p.name.toLowerCase() === pinPart.toLowerCase()),
    );
    if (!pin) {
      warnings.push(`Pin "${pinPart}" was not found on component ${primaryRef}.`);
      return { query, nets, matchedPins: [], componentRef: primaryRef, warnings };
    }
    const matchedPins: ResolvedPin[] = [];
    if (pin.net) {
      nets.add(pin.net);
      matchedPins.push({ ref: primaryRef, pin: pin.number, net: pin.net });
    } else {
      warnings.push(
        `Pin ${primaryRef}.${pin.number}${pin.name ? ` (${pin.name})` : ""} is unconnected.`,
      );
    }
    return {
      query,
      nets,
      matchedPins,
      componentRef: primaryRef,
      pinNumber: pin.number,
      warnings,
    };
  }

  // 3. Component reference match (aggregate all nets across all units of a multi-unit symbol)
  const matchingUnits = model.components.filter((c) => c.ref.toLowerCase() === query.toLowerCase());
  if (matchingUnits.length > 0) {
    const primaryRef = matchingUnits[0]!.ref;
    const matchedPins: ResolvedPin[] = [];
    for (const unit of matchingUnits) {
      for (const pin of unit.pins) {
        if (pin.net) {
          nets.add(pin.net);
          matchedPins.push({ ref: unit.ref, pin: pin.number, net: pin.net });
        }
      }
    }
    if (nets.size === 0) {
      warnings.push(`Component ${primaryRef} has no connected nets.`);
    }
    return { query, nets, matchedPins, componentRef: primaryRef, warnings };
  }

  warnings.push(
    `Endpoint "${query}" did not match any net, component, or pin in ${model.filePath}.`,
  );
  return { query, nets, matchedPins: [], warnings };
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

  // Helper for PCB physical copper-island keying so both direct and multi-hop passive traces
  // verify real copper continuity on kicad_pcb boards.
  const isPcb = model.format === "kicad_pcb";
  const pcbCopperCache = new Map<string, ReturnType<typeof computePcbCopperIslands>>();
  const getPcbCopper = (netName: string) => {
    let cached = pcbCopperCache.get(netName);
    if (!cached) {
      cached = computePcbCopperIslands(model, netName);
      pcbCopperCache.set(netName, cached);
    }
    return cached;
  };
  const islandKey = (netName: string, islandId: number) => `${netName}\0${islandId}`;

  const resolveEndpointNodes = (
    resolved: ResolvedEndpoint,
  ): Array<{ readonly key: string; readonly net: string }> => {
    if (!isPcb) {
      return Array.from(resolved.nets, (net) => ({ key: net, net }));
    }
    const out: Array<{ readonly key: string; readonly net: string }> = [];
    const seen = new Set<string>();
    if (resolved.matchedPins.length > 0) {
      for (const pin of resolved.matchedPins) {
        const copper = getPcbCopper(pin.net);
        const islandId = copper.padIslandByRefPin.get(
          `${pin.ref.toLowerCase()}:${pin.pin.toLowerCase()}`,
        );
        const key =
          islandId !== undefined
            ? islandKey(pin.net, islandId)
            : `${pin.net}\0pin:${pin.ref}:${pin.pin}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ key, net: pin.net });
        }
      }
      return out;
    }
    // Net-name endpoint on PCB: collect all copper islands of the net
    for (const netName of resolved.nets) {
      const copper = getPcbCopper(netName);
      const uniqueIslands = new Set(copper.padIslandByRefPin.values());
      if (uniqueIslands.size === 0) {
        if (!seen.has(netName)) {
          seen.add(netName);
          out.push({ key: netName, net: netName });
        }
      } else {
        for (const id of uniqueIslands) {
          const key = islandKey(netName, id);
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ key, net: netName });
          }
        }
      }
    }
    return out;
  };

  const fromNodes = resolveEndpointNodes(fromResolved);
  const toNodes = resolveEndpointNodes(toResolved);
  const toNodeKeySet = new Set(toNodes.map((n) => n.key));

  // 1. Check direct same-net connectivity (and verify physical copper continuity on PCBs)
  for (const netName of fromNets) {
    if (toResolved.nets.has(netName)) {
      const highlightedComponents = new Set<string>();
      if (fromResolved.componentRef) highlightedComponents.add(fromResolved.componentRef);
      if (toResolved.componentRef) highlightedComponents.add(toResolved.componentRef);

      let physicallyConnected = true;
      if (isPcb) {
        const copper = getPcbCopper(netName);
        if (fromResolved.matchedPins.length > 0 && toResolved.matchedPins.length > 0) {
          const sameIsland = fromNodes.some((fn) => fn.net === netName && toNodeKeySet.has(fn.key));
          if (!sameIsland) {
            physicallyConnected = false;
            warnings.push(
              `Endpoints share logical PCB net "${netName}", but their pads sit on disconnected copper islands (unrouted copper).`,
            );
          }
        } else if (copper.islandCount > 1) {
          physicallyConnected = false;
          warnings.push(
            `Logical PCB net "${netName}" is split across ${copper.islandCount} disconnected copper islands; physical continuity is broken.`,
          );
        }
      }

      return {
        filePath: model.filePath,
        from: options.from,
        to: options.to,
        connected: physicallyConnected,
        directNet: netName,
        fromNets,
        toNets,
        hops: [{ kind: "net", name: netName }],
        highlightedNets: [netName],
        highlightedComponents: Array.from(highlightedComponents),
        ...(physicallyConnected ? { estimatedResistanceOhms: 0 } : {}),
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

  // 2. Build adjacency through 2-pin series passives (keyed by copper island on PCBs)
  interface Edge {
    readonly comp: ElectronicsComponent;
    readonly fromPin: string;
    readonly toPin: string;
    readonly nextKey: string;
    readonly nextNet: string;
  }

  const adj = new Map<string, Edge[]>();
  const addEdge = (key: string, edge: Edge) => {
    let list = adj.get(key);
    if (!list) {
      list = [];
      adj.set(key, list);
    }
    list.push(edge);
  };

  for (const comp of model.components) {
    if (!isSeriesTraversable(comp)) continue;
    const p1 = comp.pins[0]!;
    const p2 = comp.pins[1]!;
    if (!p1.net || !p2.net || p1.net === p2.net) continue;
    let key1 = p1.net;
    let key2 = p2.net;
    if (isPcb) {
      const c1 = getPcbCopper(p1.net);
      const c2 = getPcbCopper(p2.net);
      const id1 = c1.padIslandByRefPin.get(`${comp.ref.toLowerCase()}:${p1.number.toLowerCase()}`);
      const id2 = c2.padIslandByRefPin.get(`${comp.ref.toLowerCase()}:${p2.number.toLowerCase()}`);
      key1 = id1 !== undefined ? islandKey(p1.net, id1) : `${p1.net}\0pin:${comp.ref}:${p1.number}`;
      key2 = id2 !== undefined ? islandKey(p2.net, id2) : `${p2.net}\0pin:${comp.ref}:${p2.number}`;
    }
    addEdge(key1, { comp, fromPin: p1.number, toPin: p2.number, nextKey: key2, nextNet: p2.net });
    addEdge(key2, { comp, fromPin: p2.number, toPin: p1.number, nextKey: key1, nextNet: p1.net });
  }

  // BFS from all source nodes to any target node
  interface QueueNode {
    readonly key: string;
    readonly net: string;
    readonly depth: number;
    readonly hops: ElectronicsPathHop[];
  }

  const targetIsGround = toNets.some((n) => isGroundNetName(n));
  const visited = new Set<string>(fromNodes.map((n) => n.key));
  const queue: QueueNode[] = fromNodes.map((n) => ({
    key: n.key,
    net: n.net,
    depth: 0,
    hops: [{ kind: "net", name: n.net }],
  }));

  let winningHops: ElectronicsPathHop[] | null = null;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxHops) continue;

    for (const edge of adj.get(current.key) ?? []) {
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
      if (toNodeKeySet.has(edge.nextKey)) {
        winningHops = nextHops;
        break;
      }
      if (!visited.has(edge.nextKey)) {
        visited.add(edge.nextKey);
        queue.push({
          key: edge.nextKey,
          net: edge.nextNet,
          depth: current.depth + 1,
          hops: nextHops,
        });
      }
    }
    if (winningHops) break;
  }

  if (!winningHops) {
    if (isPcb) {
      // Check if a logical-only passive path exists so we can emit a clear unrouted-copper warning
      const logicalAdj = new Map<string, string[]>();
      for (const comp of model.components) {
        if (!isSeriesTraversable(comp)) continue;
        const p1 = comp.pins[0]!;
        const p2 = comp.pins[1]!;
        if (!p1.net || !p2.net || p1.net === p2.net) continue;
        logicalAdj.set(p1.net, [...(logicalAdj.get(p1.net) ?? []), p2.net]);
        logicalAdj.set(p2.net, [...(logicalAdj.get(p2.net) ?? []), p1.net]);
      }
      const lVisited = new Set<string>(fromNets);
      const lQueue: Array<{ net: string; depth: number }> = fromNets.map((net) => ({
        net,
        depth: 0,
      }));
      let logicalConnected = false;
      while (lQueue.length > 0 && !logicalConnected) {
        const cur = lQueue.shift()!;
        if (cur.depth >= maxHops) continue;
        for (const nextNet of logicalAdj.get(cur.net) ?? []) {
          if (isGroundNetName(nextNet) && !toResolved.nets.has(nextNet) && !targetIsGround)
            continue;
          if (toResolved.nets.has(nextNet)) {
            logicalConnected = true;
            break;
          }
          if (!lVisited.has(nextNet)) {
            lVisited.add(nextNet);
            lQueue.push({ net: nextNet, depth: cur.depth + 1 });
          }
        }
      }
      if (logicalConnected) {
        warnings.push(
          `A logical passive path exists between "${options.from}" and "${options.to}", but required PCB copper tracks are missing (unrouted copper).`,
        );
      }
    }
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
