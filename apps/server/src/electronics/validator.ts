import * as DateTime from "effect/DateTime";
import type {
  ElectronicsCircuitModel,
  ElectronicsValidationIssue,
  ElectronicsValidationReport,
  ElectronicsValidationSource,
} from "@t3tools/contracts";

import { isGroundNetName, isPowerNetName } from "./parsers.ts";

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

function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function segmentsIntersect(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  bx1: number,
  by1: number,
  bx2: number,
  by2: number,
): boolean {
  const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qy - py) * (rx - qx) - (qx - px) * (ry - qy);
  const onSeg = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    qx <= Math.max(px, rx) + 1e-9 &&
    qx >= Math.min(px, rx) - 1e-9 &&
    qy <= Math.max(py, ry) + 1e-9 &&
    qy >= Math.min(py, ry) - 1e-9;

  const o1 = orient(ax1, ay1, ax2, ay2, bx1, by1);
  const o2 = orient(ax1, ay1, ax2, ay2, bx2, by2);
  const o3 = orient(bx1, by1, bx2, by2, ax1, ay1);
  const o4 = orient(bx1, by1, bx2, by2, ax2, ay2);

  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  if (Math.abs(o1) <= 1e-9 && onSeg(ax1, ay1, bx1, by1, ax2, ay2)) return true;
  if (Math.abs(o2) <= 1e-9 && onSeg(ax1, ay1, bx2, by2, ax2, ay2)) return true;
  if (Math.abs(o3) <= 1e-9 && onSeg(bx1, by1, ax1, ay1, bx2, by2)) return true;
  if (Math.abs(o4) <= 1e-9 && onSeg(bx1, by1, ax2, ay2, bx2, by2)) return true;
  return false;
}

function segmentsWithinTolerance(
  a: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
  b: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
  tol: number,
): boolean {
  if (segmentsIntersect(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2)) return true;
  return (
    pointToSegmentDistance(a.x1, a.y1, b.x1, b.y1, b.x2, b.y2) <= tol ||
    pointToSegmentDistance(a.x2, a.y2, b.x1, b.y1, b.x2, b.y2) <= tol ||
    pointToSegmentDistance(b.x1, b.y1, a.x1, a.y1, a.x2, a.y2) <= tol ||
    pointToSegmentDistance(b.x2, b.y2, a.x1, a.y1, a.x2, a.y2) <= tol
  );
}

function pointToOrientedBoxDistance(
  px: number,
  py: number,
  boxCx: number,
  boxCy: number,
  halfW: number,
  halfH: number,
  rotDeg: number,
): number {
  const dx = px - boxCx;
  const dy = py - boxCy;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const ex = Math.max(0, Math.abs(lx) - halfW);
  const ey = Math.max(0, Math.abs(ly) - halfH);
  return Math.hypot(ex, ey);
}

function segmentToOrientedBoxDistance(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  boxCx: number,
  boxCy: number,
  halfW: number,
  halfH: number,
  rotDeg: number,
): number {
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const toLocal = (wx: number, wy: number) => {
    const dx = wx - boxCx;
    const dy = wy - boxCy;
    return [dx * cos - dy * sin, dx * sin + dy * cos] as const;
  };
  const [lx1, ly1] = toLocal(x1, y1);
  const [lx2, ly2] = toLocal(x2, y2);

  // If either endpoint lies inside the pad rectangle, distance is 0
  if (
    (Math.abs(lx1) <= halfW && Math.abs(ly1) <= halfH) ||
    (Math.abs(lx2) <= halfW && Math.abs(ly2) <= halfH)
  ) {
    return 0;
  }

  // If the segment crosses any of the 4 pad edges, distance is 0
  const edges = [
    [-halfW, -halfH, halfW, -halfH],
    [halfW, -halfH, halfW, halfH],
    [halfW, halfH, -halfW, halfH],
    [-halfW, halfH, -halfW, -halfH],
  ] as const;
  for (const [ex1, ey1, ex2, ey2] of edges) {
    if (segmentsIntersect(lx1, ly1, lx2, ly2, ex1, ey1, ex2, ey2)) {
      return 0;
    }
  }

  // Otherwise minimum distance is either an endpoint to the box or a box corner to the segment
  const d1 = Math.hypot(Math.max(0, Math.abs(lx1) - halfW), Math.max(0, Math.abs(ly1) - halfH));
  const d2 = Math.hypot(Math.max(0, Math.abs(lx2) - halfW), Math.max(0, Math.abs(ly2) - halfH));
  let best = Math.min(d1, d2);
  const corners = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ] as const;
  for (const [cx, cy] of corners) {
    best = Math.min(best, pointToSegmentDistance(cx, cy, lx1, ly1, lx2, ly2));
  }
  return best;
}

export interface PcbCopperIslandResult {
  readonly padPoints: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly ref: string;
    readonly pin: string;
    readonly layers?: ReadonlyArray<string>;
    readonly padWidth?: number;
    readonly padHeight?: number;
    readonly padRotation?: number;
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
    padWidth?: number;
    padHeight?: number;
    padRotation?: number;
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
          ...(pin.padWidth !== undefined ? { padWidth: pin.padWidth } : {}),
          ...(pin.padHeight !== undefined ? { padHeight: pin.padHeight } : {}),
          ...(pin.padRotation !== undefined ? { padRotation: pin.padRotation } : {}),
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

  const PCB_CELL = 5.0;
  const cellOf = (x: number, y: number) =>
    [Math.floor(x / PCB_CELL), Math.floor(y / PCB_CELL)] as const;
  const addPointToGrid = <T>(grid: Map<string, T[]>, x: number, y: number, item: T) => {
    const [cx, cy] = cellOf(x, y);
    const key = `${cx},${cy}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(item);
  };

  const padGrid = new Map<string, number[]>();
  const largePads: number[] = [];
  for (let p = 0; p < padPoints.length; p += 1) {
    const pad = padPoints[p]!;
    const padExtent = Math.max(pad.padWidth ?? 0.2, pad.padHeight ?? 0.2) / 2;
    const minCx = Math.floor((pad.x - padExtent) / PCB_CELL);
    const maxCx = Math.floor((pad.x + padExtent) / PCB_CELL);
    const minCy = Math.floor((pad.y - padExtent) / PCB_CELL);
    const maxCy = Math.floor((pad.y + padExtent) / PCB_CELL);
    if ((maxCx - minCx + 1) * (maxCy - minCy + 1) > 64) {
      largePads.push(p);
    } else {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        for (let cy = minCy; cy <= maxCy; cy += 1) {
          const key = `${cx},${cy}`;
          let bucket = padGrid.get(key);
          if (!bucket) {
            bucket = [];
            padGrid.set(key, bucket);
          }
          bucket.push(p);
        }
      }
    }
  }
  const viaGrid = new Map<string, number[]>();
  for (let v = 0; v < netVias.length; v += 1) {
    addPointToGrid(viaGrid, netVias[v]!.x, netVias[v]!.y, v);
  }

  // Direct via-in-pad contact using real pad geometry and via diameter (including *.Cu through-hole pads)
  for (let v = 0; v < netVias.length; v += 1) {
    const via = netVias[v]!;
    const viaRadius = Math.max(0.01, via.size / 2);
    const [cx, cy] = cellOf(via.x, via.y);
    const checkedPads = new Set<number>();
    const testPadVia = (p: number) => {
      if (checkedPads.has(p)) return;
      checkedPads.add(p);
      const pad = padPoints[p]!;
      const halfW = (pad.padWidth ?? 0.2) / 2;
      const halfH = (pad.padHeight ?? 0.2) / 2;
      const layerMatches =
        pad.layers === undefined ||
        pad.layers.length === 0 ||
        pad.layers.some(
          (layer) => layer === "*.Cu" || layer === "*" || viaMatchesTrackLayer(via.layers, layer),
        );
      if (
        layerMatches &&
        pointToOrientedBoxDistance(
          via.x,
          via.y,
          pad.x,
          pad.y,
          halfW,
          halfH,
          pad.padRotation ?? 0,
        ) <=
          viaRadius + 0.01
      ) {
        union(p, viaOffset + v);
      }
    };
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = padGrid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const p of bucket) testPadVia(p);
      }
    }
    for (const p of largePads) testPadVia(p);
  }

  interface IndexedTrack {
    readonly idx: number;
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly width: number;
  }

  const trackGridByLayer = new Map<string, Map<string, IndexedTrack[]>>();
  const largeTracksByLayer = new Map<string, IndexedTrack[]>();
  const getLayerGrid = (layerKey: string) => {
    let g = trackGridByLayer.get(layerKey);
    if (!g) {
      g = new Map();
      trackGridByLayer.set(layerKey, g);
    }
    return g;
  };
  const getLayerLarge = (layerKey: string) => {
    let list = largeTracksByLayer.get(layerKey);
    if (!list) {
      list = [];
      largeTracksByLayer.set(layerKey, list);
    }
    return list;
  };

  for (let t = 0; t < netTracks.length; t += 1) {
    const seg = netTracks[t]!;
    const segWidth = seg.width ?? 0.2;
    const margin = Math.max(0.5, segWidth / 2);
    const minCx = Math.floor((Math.min(seg.x1, seg.x2) - margin) / PCB_CELL);
    const maxCx = Math.floor((Math.max(seg.x1, seg.x2) + margin) / PCB_CELL);
    const minCy = Math.floor((Math.min(seg.y1, seg.y2) - margin) / PCB_CELL);
    const maxCy = Math.floor((Math.max(seg.y1, seg.y2) + margin) / PCB_CELL);
    const cellCount = (maxCx - minCx + 1) * (maxCy - minCy + 1);
    const isLarge = cellCount > 256;

    const entry: IndexedTrack = {
      idx: t,
      x1: seg.x1,
      y1: seg.y1,
      x2: seg.x2,
      y2: seg.y2,
      width: segWidth,
    };

    const testPad = (p: number) => {
      const pad = padPoints[p]!;
      const halfW = (pad.padWidth ?? 0.2) / 2;
      const halfH = (pad.padHeight ?? 0.2) / 2;
      const trackHalfWidth = Math.max(0.01, segWidth / 2);
      if (
        padMatchesTrackLayer(pad.layers, seg.layer) &&
        segmentToOrientedBoxDistance(
          seg.x1,
          seg.y1,
          seg.x2,
          seg.y2,
          pad.x,
          pad.y,
          halfW,
          halfH,
          pad.padRotation ?? 0,
        ) <=
          trackHalfWidth + 0.01
      ) {
        union(p, trackOffset + t);
      }
    };
    const testVia = (v: number) => {
      const via = netVias[v]!;
      const viaTol = Math.max(0.05, via.size / 2 + segWidth / 2);
      if (
        viaMatchesTrackLayer(via.layers, seg.layer) &&
        pointToSegmentDistance(via.x, via.y, seg.x1, seg.y1, seg.x2, seg.y2) <= viaTol
      ) {
        union(trackOffset + t, viaOffset + v);
      }
    };

    const layerKey = seg.layer ?? "__any__";
    const layerGrid = getLayerGrid(layerKey);
    const layerLarge = getLayerLarge(layerKey);
    const checkedTracks = new Set<number>();

    const testTrack = (other: IndexedTrack) => {
      if (checkedTracks.has(other.idx)) return;
      checkedTracks.add(other.idx);
      const copperTol = Math.max(0.02, (segWidth + other.width) / 2);
      if (segmentsWithinTolerance(entry, other, copperTol)) {
        union(trackOffset + t, trackOffset + other.idx);
      }
    };

    if (isLarge) {
      for (let p = 0; p < padPoints.length; p += 1) testPad(p);
      for (let v = 0; v < netVias.length; v += 1) testVia(v);
      for (const bucket of layerGrid.values()) {
        for (const other of bucket) testTrack(other);
      }
      for (const other of layerLarge) testTrack(other);
      layerLarge.push(entry);
    } else {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        for (let cy = minCy; cy <= maxCy; cy += 1) {
          const cellKey = `${cx},${cy}`;
          const padsInCell = padGrid.get(cellKey);
          if (padsInCell) {
            for (const p of padsInCell) testPad(p);
          }
          const viasInCell = viaGrid.get(cellKey);
          if (viasInCell) {
            for (const v of viasInCell) testVia(v);
          }
          const tracksInCell = layerGrid.get(cellKey);
          if (tracksInCell) {
            for (const other of tracksInCell) testTrack(other);
          }
        }
      }
      for (const other of layerLarge) testTrack(other);
      for (const p of largePads) testPad(p);
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        for (let cy = minCy; cy <= maxCy; cy += 1) {
          const cellKey = `${cx},${cy}`;
          let bucket = layerGrid.get(cellKey);
          if (!bucket) {
            bucket = [];
            layerGrid.set(cellKey, bucket);
          }
          bucket.push(entry);
        }
      }
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
