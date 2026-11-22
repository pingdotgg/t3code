import * as DateTime from "effect/DateTime";
import type {
  ElectronicsCircuitModel,
  ElectronicsValidationIssue,
  ElectronicsValidationReport,
  ElectronicsValidationSource,
} from "@t3tools/contracts";

import { isGroundNetName, isPowerNetName } from "./parsers.ts";

function nearPoint(ax: number, ay: number, bx: number, by: number, tol = 0.25): boolean {
  return Math.hypot(ax - bx, ay - by) <= tol;
}

function copperLayerOrder(layer: string): number | null {
  if (layer === "F.Cu") return 0;
  if (layer === "B.Cu") return 31;
  const inner = /^In(\d+)\.Cu$/u.exec(layer);
  if (inner) return Number(inner[1]);
  return null;
}

function padMatchesTrackLayer(
  padLayers: ReadonlyArray<string> | undefined,
  trackLayer: string | undefined,
): boolean {
  if (!trackLayer || !padLayers || padLayers.length === 0) return true;
  return padLayers.includes(trackLayer) || padLayers.includes("*.Cu") || padLayers.includes("*");
}

function viaMatchesTrackLayer(
  viaLayers: ReadonlyArray<string> | undefined,
  trackLayer: string | undefined,
): boolean {
  if (!trackLayer || !viaLayers || viaLayers.length === 0) return true;
  if (viaLayers.includes(trackLayer) || viaLayers.includes("*.Cu") || viaLayers.includes("*")) {
    return true;
  }
  if (viaLayers.length === 2) {
    const start = copperLayerOrder(viaLayers[0]!);
    const end = copperLayerOrder(viaLayers[1]!);
    const target = copperLayerOrder(trackLayer);
    if (start !== null && end !== null && target !== null) {
      return target >= Math.min(start, end) && target <= Math.max(start, end);
    }
  }
  return false;
}

export interface PcbCopperIslandResult {
  readonly padPoints: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly ref: string;
    readonly pin: string;
    readonly layers?: ReadonlyArray<string>;
  }>;
  readonly islandCount: number;
  readonly trackCount: number;
  readonly padIslandByRefPin: ReadonlyMap<string, number>;
}

export function computePcbCopperIslands(
  model: ElectronicsCircuitModel,
  netName: string,
): PcbCopperIslandResult {
  const padPoints: Array<{
    x: number;
    y: number;
    ref: string;
    pin: string;
    layers?: ReadonlyArray<string>;
  }> = [];
  for (const comp of model.components) {
    for (const pin of comp.pins) {
      if (
        pin.net === netName &&
        pin.x !== undefined &&
        pin.y !== undefined &&
        Number.isFinite(pin.x) &&
        Number.isFinite(pin.y) &&
        Math.abs(pin.x) <= 1e6 &&
        Math.abs(pin.y) <= 1e6
      ) {
        padPoints.push({
          x: pin.x,
          y: pin.y,
          ref: comp.ref,
          pin: pin.number,
          ...(pin.layers !== undefined ? { layers: pin.layers } : {}),
        });
      }
    }
  }
  const netTracks = model.wires.filter(
    (w) =>
      w.net === netName &&
      Number.isFinite(w.x1) &&
      Number.isFinite(w.y1) &&
      Number.isFinite(w.x2) &&
      Number.isFinite(w.y2) &&
      Math.abs(w.x1) <= 1e6 &&
      Math.abs(w.y1) <= 1e6 &&
      Math.abs(w.x2) <= 1e6 &&
      Math.abs(w.y2) <= 1e6,
  );
  const netVias = model.vias.filter(
    (v) =>
      v.net === netName &&
      Number.isFinite(v.x) &&
      Number.isFinite(v.y) &&
      Math.abs(v.x) <= 1e6 &&
      Math.abs(v.y) <= 1e6,
  );

  const totalNodes = padPoints.length + netTracks.length + netVias.length;
  const parent = Array.from({ length: totalNodes }, (_, idx) => idx);
  const find = (a: number): number => {
    let cur = a;
    while (parent[cur] !== cur) cur = parent[cur]!;
    let walk = a;
    while (walk !== cur) {
      const next = parent[walk]!;
      parent[walk] = cur;
      walk = next;
    }
    return cur;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const trackOffset = padPoints.length;
  const viaOffset = padPoints.length + netTracks.length;

  const PCB_CELL = 1.0;
  const cellOf = (x: number, y: number) =>
    [Math.floor(x / PCB_CELL), Math.floor(y / PCB_CELL)] as const;
  const addToGrid = <T>(grid: Map<string, T[]>, x: number, y: number, item: T) => {
    const [cx, cy] = cellOf(x, y);
    const key = `${cx},${cy}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(item);
  };
  const forNearby = <T>(grid: Map<string, T[]>, x: number, y: number, fn: (item: T) => void) => {
    const [cx, cy] = cellOf(x, y);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const item of bucket) fn(item);
      }
    }
  };

  const padGrid = new Map<string, number[]>();
  for (let p = 0; p < padPoints.length; p += 1) {
    addToGrid(padGrid, padPoints[p]!.x, padPoints[p]!.y, p);
  }
  const viaGrid = new Map<string, number[]>();
  for (let v = 0; v < netVias.length; v += 1) {
    addToGrid(viaGrid, netVias[v]!.x, netVias[v]!.y, v);
  }
  const trackGridByLayer = new Map<
    string,
    Map<string, Array<{ idx: number; x: number; y: number; width: number }>>
  >();
  const getLayerGrid = (layerKey: string) => {
    let g = trackGridByLayer.get(layerKey);
    if (!g) {
      g = new Map();
      trackGridByLayer.set(layerKey, g);
    }
    return g;
  };

  for (let t = 0; t < netTracks.length; t += 1) {
    const seg = netTracks[t]!;
    const segWidth = seg.width ?? 0.2;
    const endpoints = [
      [seg.x1, seg.y1],
      [seg.x2, seg.y2],
    ] as const;

    for (const [ex, ey] of endpoints) {
      forNearby(padGrid, ex, ey, (p) => {
        const pad = padPoints[p]!;
        if (padMatchesTrackLayer(pad.layers, seg.layer) && nearPoint(pad.x, pad.y, ex, ey, 0.5)) {
          union(p, trackOffset + t);
        }
      });
      forNearby(viaGrid, ex, ey, (v) => {
        const via = netVias[v]!;
        const viaTol = Math.max(0.05, via.size / 2 + segWidth / 2);
        if (
          viaMatchesTrackLayer(via.layers, seg.layer) &&
          nearPoint(via.x, via.y, ex, ey, viaTol)
        ) {
          union(trackOffset + t, viaOffset + v);
        }
      });
      const layerKey = seg.layer ?? "__any__";
      const layerGrid = getLayerGrid(layerKey);
      forNearby(layerGrid, ex, ey, (other) => {
        // Use actual copper overlap radius (half-width sum) rather than a fixed 0.25mm gap
        const copperTol = Math.max(0.02, (segWidth + other.width) / 2);
        if (nearPoint(other.x, other.y, ex, ey, copperTol)) {
          union(trackOffset + t, trackOffset + other.idx);
        }
      });
      addToGrid(layerGrid, ex, ey, { idx: t, x: ex, y: ey, width: segWidth });
    }
  }

  const padRoots = new Set<number>();
  const padIslandByRefPin = new Map<string, number>();
  for (let p = 0; p < padPoints.length; p += 1) {
    const r = find(p);
    padRoots.add(r);
    const pad = padPoints[p]!;
    padIslandByRefPin.set(`${pad.ref.toLowerCase()}:${pad.pin.toLowerCase()}`, r);
  }
  return {
    padPoints,
    islandCount: padRoots.size,
    trackCount: netTracks.length,
    padIslandByRefPin,
  };
}

/**
 * Deterministic static electrical & layout rule checker.
 * Runs in pure TypeScript with zero external binaries required.
 */
export function runBuiltinCircuitValidation(model: ElectronicsCircuitModel): {
  readonly issues: ElectronicsValidationIssue[];
  readonly notes: string[];
} {
  const issues: ElectronicsValidationIssue[] = [];
  const notes: string[] = [];
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;

  // 1. Duplicate component references (allow distinct KiCad units of the same physical symbol)
  const seenByRef = new Map<
    string,
    { libId?: string; units: Set<number>; unnumberedCount: number }
  >();
  const flaggedDupRefs = new Set<string>();
  for (const comp of model.components) {
    if (comp.kind === "power_symbol" || comp.ref.startsWith("#")) continue;
    let entry = seenByRef.get(comp.ref);
    if (!entry) {
      entry = {
        ...(comp.libId !== undefined ? { libId: comp.libId } : {}),
        units: new Set<number>(),
        unnumberedCount: 0,
      };
      seenByRef.set(comp.ref, entry);
    }
    let isDuplicate = false;
    if (comp.unit !== undefined) {
      if (entry.units.has(comp.unit) || entry.unnumberedCount > 0) {
        isDuplicate = true;
      } else if (
        entry.libId !== undefined &&
        comp.libId !== undefined &&
        entry.libId !== comp.libId
      ) {
        isDuplicate = true;
      } else {
        entry.units.add(comp.unit);
      }
    } else {
      entry.unnumberedCount += 1;
      if (entry.unnumberedCount > 1 || entry.units.size > 0) {
        isDuplicate = true;
      }
    }
    if (isDuplicate && !flaggedDupRefs.has(comp.ref)) {
      flaggedDupRefs.add(comp.ref);
      issues.push({
        id: nextId("dup-ref"),
        code: "duplicate_reference",
        severity: "error",
        source: "builtin",
        message: `Duplicate component designator "${comp.ref}" found on the sheet/board.`,
        refs: [comp.ref],
        ...(comp.x !== undefined ? { x: comp.x } : {}),
        ...(comp.y !== undefined ? { y: comp.y } : {}),
      });
    }
  }

  // 2. Power rail shorts (e.g. GND shorted directly to +3V3 or +5V on the same net)
  for (const net of model.nets) {
    const parts = net.name.split(" / ").map((p) => p.trim());
    const distinctRails = parts.filter((p) => isGroundNetName(p) || isPowerNetName(p));
    if ((net.isPower && net.isGround) || distinctRails.length > 1) {
      const firstRef = net.pins[0]?.ref;
      const comp = firstRef ? model.components.find((c) => c.ref === firstRef) : undefined;
      issues.push({
        id: nextId("rail-short"),
        code: "power_rail_short",
        severity: "error",
        source: "builtin",
        message: `Power rail short detected on net "${net.name}": distinct power/ground rails are tied together.`,
        net: net.name,
        refs: Array.from(new Set(net.pins.map((p) => p.ref))),
        ...(comp?.x !== undefined ? { x: comp.x } : {}),
        ...(comp?.y !== undefined ? { y: comp.y } : {}),
      });
    }
  }

  // 3. Output-to-output conflicts and undriven inputs (primarily schematic ERC)
  for (const net of model.nets) {
    const drivers = net.pins.filter(
      (p) => p.electricalType === "output" || p.electricalType === "power_out",
    );
    if (drivers.length > 1) {
      const firstComp = model.components.find((c) => c.ref === drivers[0]!.ref);
      issues.push({
        id: nextId("out-conflict"),
        code: "output_conflict",
        severity: "error",
        source: "builtin",
        message: `Multiple output drivers (${drivers.map((d) => `${d.ref}.${d.pin}`).join(", ")}) share net "${net.name}".`,
        net: net.name,
        refs: Array.from(new Set(drivers.map((d) => d.ref))),
        ...(firstComp?.x !== undefined ? { x: firstComp.x } : {}),
        ...(firstComp?.y !== undefined ? { y: firstComp.y } : {}),
      });
    }

    const inputs = net.pins.filter((p) => p.electricalType === "input");
    const hasDriverOrPassive = net.pins.some(
      (p) =>
        p.electricalType === "output" ||
        p.electricalType === "power_out" ||
        p.electricalType === "bidirectional" ||
        p.electricalType === "tri_state" ||
        p.electricalType === "passive" ||
        p.electricalType === "open_collector" ||
        p.electricalType === "open_emitter",
    );
    if (inputs.length > 0 && !hasDriverOrPassive && !net.isPower && !net.isGround) {
      const firstComp = model.components.find((c) => c.ref === inputs[0]!.ref);
      issues.push({
        id: nextId("undriven"),
        code: "undriven_input",
        severity: "warning",
        source: "builtin",
        message: `Input pin(s) ${inputs.map((i) => `${i.ref}.${i.pin}`).join(", ")} on net "${net.name}" have no driver.`,
        net: net.name,
        refs: Array.from(new Set(inputs.map((i) => i.ref))),
        ...(firstComp?.x !== undefined ? { x: firstComp.x } : {}),
        ...(firstComp?.y !== undefined ? { y: firstComp.y } : {}),
      });
    }

    // 4. Single-pin named nets (catches typos in net labels like SDA vs SDA_1)
    if (net.pins.length === 1 && !net.isPower && !net.isGround && !net.name.startsWith("Net-(")) {
      const sole = net.pins[0]!;
      const comp = model.components.find((c) => c.ref === sole.ref);
      const pin = comp?.pins.find((p) => p.number === sole.pin);
      issues.push({
        id: nextId("single-pin"),
        code: "single_pin_net",
        severity: "warning",
        source: "builtin",
        message: `Named net "${net.name}" only connects to a single pin (${sole.ref}.${sole.pin}); check for a label typo or missing connection.`,
        net: net.name,
        refs: [sole.ref],
        ...(pin?.x !== undefined ? { x: pin.x } : comp?.x !== undefined ? { x: comp.x } : {}),
        ...(pin?.y !== undefined ? { y: pin.y } : comp?.y !== undefined ? { y: comp.y } : {}),
      });
    }
  }

  // 5. Floating / unconnected component pins (excluding explicit no_connects and power symbols)
  for (const comp of model.components) {
    if (comp.kind === "power_symbol" || comp.ref.startsWith("#")) continue;
    for (const pin of comp.pins) {
      if (pin.electricalType === "unconnected") continue;
      if (!pin.net) {
        issues.push({
          id: nextId("floating"),
          code: "floating_pin",
          severity: pin.electricalType === "power_in" ? "error" : "warning",
          source: "builtin",
          message: `Pin ${comp.ref}.${pin.number}${pin.name ? ` (${pin.name})` : ""} is unconnected${pin.electricalType === "power_in" ? " (power input)" : ""}.`,
          refs: [comp.ref],
          ...(pin.x !== undefined ? { x: pin.x } : comp.x !== undefined ? { x: comp.x } : {}),
          ...(pin.y !== undefined ? { y: pin.y } : comp.y !== undefined ? { y: comp.y } : {}),
        });
      }
    }
  }

  // 6. Missing ground reference
  const realComponents = model.components.filter(
    (c) => c.kind !== "power_symbol" && !c.ref.startsWith("#"),
  );
  const hasGround = model.nets.some((n) => n.isGround && n.pins.length > 0);
  if (realComponents.length > 0 && !hasGround) {
    issues.push({
      id: nextId("no-gnd"),
      code: "missing_ground",
      severity: "warning",
      source: "builtin",
      message: "No ground reference net (GND / 0 / VSS) was detected in this circuit.",
      refs: [],
    });
  }

  // 7. Missing decoupling capacitor hint for ICs with power + ground rails
  const netByName = new Map(model.nets.map((n) => [n.name, n]));
  const capacitors = realComponents.filter((c) => c.kind === "capacitor");
  for (const comp of realComponents) {
    if (comp.kind !== "ic") continue;
    const powerNets = Array.from(
      new Set(
        comp.pins
          .map((p) => p.net)
          .filter(
            (n): n is string => Boolean(n) && (netByName.get(n!)?.isPower ?? isPowerNetName(n!)),
          ),
      ),
    );
    const groundNets = Array.from(
      new Set(
        comp.pins
          .map((p) => p.net)
          .filter(
            (n): n is string => Boolean(n) && (netByName.get(n!)?.isGround ?? isGroundNetName(n!)),
          ),
      ),
    );
    if (powerNets.length === 0 || groundNets.length === 0) continue;

    for (const pNet of powerNets) {
      const hasDecoupling = capacitors.some((cap) => {
        const capNets = new Set(cap.pins.map((p) => p.net).filter((n): n is string => Boolean(n)));
        return capNets.has(pNet) && groundNets.some((g) => capNets.has(g));
      });
      if (!hasDecoupling) {
        issues.push({
          id: nextId("decoupling"),
          code: "missing_decoupling",
          severity: "info",
          source: "builtin",
          message: `IC ${comp.ref} (${comp.value}) uses power rail "${pNet}" with no decoupling capacitor detected between "${pNet}" and ground.`,
          net: pNet,
          refs: [comp.ref],
          ...(comp.x !== undefined ? { x: comp.x } : {}),
          ...(comp.y !== undefined ? { y: comp.y } : {}),
        });
      }
    }
  }

  // 8. PCB copper continuity / unrouted ratsnest check
  if (model.format === "kicad_pcb") {
    for (const net of model.nets) {
      const { padPoints, islandCount, trackCount } = computePcbCopperIslands(model, net.name);
      if (padPoints.length < 2) continue;
      if (islandCount > 1) {
        issues.push({
          id: nextId("unrouted"),
          code: "unrouted_pcb_net",
          severity: "warning",
          source: "builtin",
          message: `PCB net "${net.name}" has ${padPoints.length} pads split across ${islandCount} disconnected copper islands (${trackCount} track segment${trackCount === 1 ? "" : "s"}).`,
          net: net.name,
          refs: Array.from(new Set(padPoints.map((p) => p.ref))),
          x: padPoints[0]!.x,
          y: padPoints[0]!.y,
        });
      }
    }
  }

  return { issues, notes };
}

export function assembleValidationReport(input: {
  readonly model: ElectronicsCircuitModel;
  readonly builtinIssues: ReadonlyArray<ElectronicsValidationIssue>;
  readonly externalIssues: ReadonlyArray<ElectronicsValidationIssue>;
  readonly enginesUsed: ReadonlyArray<ElectronicsValidationSource>;
  readonly notes: ReadonlyArray<string>;
}): ElectronicsValidationReport {
  const issues = [...input.builtinIssues, ...input.externalIssues];
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const issue of issues) {
    if (issue.severity === "error") errorCount += 1;
    else if (issue.severity === "warning") warningCount += 1;
    else infoCount += 1;
  }

  return {
    filePath: input.model.filePath,
    format: input.model.format,
    passed: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    enginesUsed: [...input.enginesUsed],
    notes: [...input.notes],
    issues,
    checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
  };
}
