import type {
  ElectronicsBomEntry,
  ElectronicsBounds,
  ElectronicsCircuitModel,
  ElectronicsComponent,
  ElectronicsComponentKind,
  ElectronicsDesignFormat,
  ElectronicsLabelMarker,
  ElectronicsNet,
  ElectronicsNetPinRef,
  ElectronicsPin,
  ElectronicsPinElectricalType,
  ElectronicsPoint,
  ElectronicsVia,
  ElectronicsWireSegment,
} from "@t3tools/contracts";

import {
  atomNumber,
  atomString,
  findChild,
  findChildren,
  isSExprList,
  parseSExpr,
  type SExprList,
} from "./sexpr.ts";

export function detectElectronicsFormat(filePath: string): ElectronicsDesignFormat | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".kicad_sch")) return "kicad_sch";
  if (lower.endsWith(".kicad_pcb")) return "kicad_pcb";
  if (
    lower.endsWith(".circuit.json") ||
    lower.endsWith("/circuit.json") ||
    lower === "circuit.json"
  ) {
    return "circuit_json";
  }
  if (
    lower.endsWith(".cir") ||
    lower.endsWith(".sp") ||
    lower.endsWith(".spice") ||
    lower.endsWith(".net")
  ) {
    return "spice";
  }
  return null;
}

export function isGroundNetName(name: string): boolean {
  const upper = name.trim().toUpperCase();
  if (upper === "0") return true;
  return (
    upper === "GND" ||
    upper === "AGND" ||
    upper === "DGND" ||
    upper === "PGND" ||
    upper === "VSS" ||
    upper === "GNDA" ||
    upper === "GNDD" ||
    upper === "GNDREF" ||
    upper === "COM" ||
    upper.startsWith("GND_") ||
    upper.endsWith("_GND")
  );
}

export function isPowerNetName(name: string): boolean {
  if (isGroundNetName(name)) return false;
  const upper = name.trim().toUpperCase();
  if (/^[+-]?\d+(\.\d+)?V\d*$/u.test(upper)) return true;
  if (/^[+-]?\d+V\d+$/u.test(upper)) return true;
  return (
    upper === "VCC" ||
    upper === "VDD" ||
    upper === "VIN" ||
    upper === "VOUT" ||
    upper === "VBUS" ||
    upper === "VBAT" ||
    upper === "VSYS" ||
    upper === "AVDD" ||
    upper === "DVDD" ||
    upper === "AVCC" ||
    upper === "VREF" ||
    upper.startsWith("VCC_") ||
    upper.startsWith("VDD_") ||
    upper.startsWith("+3V3") ||
    upper.startsWith("+5V") ||
    upper.startsWith("+12V") ||
    upper.startsWith("+24V") ||
    upper.startsWith("V3V3") ||
    upper.startsWith("V5V")
  );
}

function inferComponentKind(ref: string, libId?: string, value?: string): ElectronicsComponentKind {
  const upperRef = ref.trim().toUpperCase();
  const upperLib = (libId ?? "").toUpperCase();
  const libSymbolName = upperLib.includes(":")
    ? upperLib.slice(upperLib.lastIndexOf(":") + 1)
    : upperLib;
  const upperVal = (value ?? "").toUpperCase();

  if (upperRef.startsWith("#PWR") || upperLib.startsWith("POWER:")) return "power_symbol";
  if (/^R\d/u.test(upperRef) || upperRef === "R" || /^R($|_|_SMALL|_US)/u.test(libSymbolName)) {
    return "resistor";
  }
  if (
    /^C\d/u.test(upperRef) ||
    upperRef === "C" ||
    /^C($|_SMALL|_POLARIZED)/u.test(libSymbolName)
  ) {
    return "capacitor";
  }
  if (/^L\d/u.test(upperRef) || upperRef === "L" || /^L($|_SMALL|_CORE)/u.test(libSymbolName)) {
    return "inductor";
  }
  if (/^FB\d/u.test(upperRef)) return "inductor";
  if (/^D\d/u.test(upperRef) || /^LED\d/u.test(upperRef) || libSymbolName === "LED") {
    return "diode";
  }
  if (/^[QM]\d/u.test(upperRef) || upperLib.includes("TRANSISTOR") || upperLib.includes("MOSFET")) {
    return "transistor";
  }
  if (/^[UJ]\d/u.test(upperRef)) {
    if (upperRef.startsWith("J") || upperRef.startsWith("JP") || upperRef.startsWith("P")) {
      return "connector";
    }
    return "ic";
  }
  if (/^JP\d/u.test(upperRef) || /^CON\d/u.test(upperRef) || /^P\d/u.test(upperRef)) {
    return "connector";
  }
  if (/^[VI]\d/u.test(upperRef) || /^BT\d/u.test(upperRef) || upperVal.includes("BATTERY")) {
    return "power_source";
  }
  if (/^SW\d/u.test(upperRef) || /^S\d/u.test(upperRef) || upperLib.includes("SWITCH")) {
    return "switch";
  }
  if (/^F\d/u.test(upperRef) || upperLib.includes("FUSE")) return "fuse";
  if (/^[YX]\d/u.test(upperRef) || upperLib.includes("CRYSTAL")) return "crystal";
  if (/^IC\d/u.test(upperRef)) return "ic";
  return "other";
}

function mapKiCadPinType(raw: string | undefined): ElectronicsPinElectricalType {
  switch (raw) {
    case "input":
      return "input";
    case "output":
      return "output";
    case "bidirectional":
      return "bidirectional";
    case "tri_state":
      return "tri_state";
    case "passive":
      return "passive";
    case "power_in":
      return "power_in";
    case "power_out":
      return "power_out";
    case "open_collector":
      return "open_collector";
    case "open_emitter":
      return "open_emitter";
    case "unconnected":
    case "no_connect":
      return "unconnected";
    default:
      return "unspecified";
  }
}

export function parseEngineeringNumber(
  raw: string,
  options: { readonly spice?: boolean } = {},
): number | null {
  const spice = options.spice ?? false;
  const withoutParams = raw.trim().replace(/\s+[a-z_][a-z0-9_]*\s*=.*$/iu, "");
  const cleaned = withoutParams
    .trim()
    .replace(/Ω|OHMS?|OHM|HZ$/iu, "")
    .trim();
  const match =
    /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(meg|mil|t|g|k|m|u|µ|n|p|f|r)?([a-z]*)$/iu.exec(
      cleaned,
    );
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const rawSuffix = match[2] ?? "";
  const trailingUnit = match[3] ?? "";
  // In non-SPICE display values:
  // - uppercase standalone "F" (e.g. "1F") is Farads, while "10f"/"10fF" (and SPICE "10f"/"10F") is femto (1e-15).
  // - uppercase "M" (e.g. "1M", "10MΩ") is Mega (1e6), while lowercase "m" ("10m", "50mΩ") is milli (1e-3).
  // In SPICE mode, "m"/"M" is milli (1e-3) and "meg" is Mega (1e6).
  if (!spice && rawSuffix === "F" && trailingUnit.length === 0) {
    return base;
  }
  if (!spice && rawSuffix === "M") {
    return base * 1e6;
  }
  const suffix = rawSuffix.toLowerCase();
  switch (suffix) {
    case "t":
      return base * 1e12;
    case "g":
      return base * 1e9;
    case "meg":
      return base * 1e6;
    case "mil":
      return base * 25.4e-6;
    case "k":
      return base * 1e3;
    case "m":
      return base * 1e-3;
    case "u":
    case "µ":
      return base * 1e-6;
    case "n":
      return base * 1e-9;
    case "p":
      return base * 1e-12;
    case "f":
      return base * 1e-15;
    case "r":
    case "":
      return base;
    default:
      return base;
  }
}

function computeBounds(input: {
  readonly components: ReadonlyArray<ElectronicsComponent>;
  readonly wires: ReadonlyArray<ElectronicsWireSegment>;
  readonly vias: ReadonlyArray<ElectronicsVia>;
  readonly labels: ReadonlyArray<ElectronicsLabelMarker>;
  readonly boardOutline: ReadonlyArray<ElectronicsWireSegment>;
}): ElectronicsBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const include = (x: number | undefined, y: number | undefined) => {
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const c of input.components) {
    include(c.x, c.y);
    for (const p of c.pins) include(p.x, p.y);
  }
  for (const w of input.wires) {
    include(w.x1, w.y1);
    include(w.x2, w.y2);
  }
  for (const b of input.boardOutline) {
    include(b.x1, b.y1);
    include(b.x2, b.y2);
  }
  for (const v of input.vias) include(v.x, v.y);
  for (const l of input.labels) include(l.x, l.y);

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  }
  const padX = Math.max(8, (maxX - minX) * 0.08);
  const padY = Math.max(8, (maxY - minY) * 0.08);
  return {
    minX: Number((minX - padX).toFixed(3)),
    minY: Number((minY - padY).toFixed(3)),
    maxX: Number((maxX + padX).toFixed(3)),
    maxY: Number((maxY + padY).toFixed(3)),
  };
}

function buildBom(components: ReadonlyArray<ElectronicsComponent>): ElectronicsBomEntry[] {
  const groups = new Map<
    string,
    {
      value: string;
      footprint?: string;
      libId?: string;
      kind: ElectronicsComponentKind;
      refs: Set<string>;
    }
  >();

  for (const comp of components) {
    if (comp.kind === "power_symbol" || comp.ref.startsWith("#")) continue;
    const key = `${comp.value}||${comp.footprint ?? ""}||${comp.libId ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.refs.add(comp.ref);
    } else {
      groups.set(key, {
        value: comp.value,
        ...(comp.footprint !== undefined ? { footprint: comp.footprint } : {}),
        ...(comp.libId !== undefined ? { libId: comp.libId } : {}),
        kind: comp.kind,
        refs: new Set([comp.ref]),
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => {
      const sortedRefs = Array.from(group.refs).toSorted((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      );
      return {
        value: group.value,
        ...(group.footprint !== undefined ? { footprint: group.footprint } : {}),
        ...(group.libId !== undefined ? { libId: group.libId } : {}),
        kind: group.kind,
        refs: sortedRefs,
        quantity: sortedRefs.length,
      };
    })
    .toSorted((a, b) => a.refs[0]!.localeCompare(b.refs[0]!, undefined, { numeric: true }));
}

class UnionFind {
  readonly #parent = new Map<number, number>();

  find(id: number): number {
    let cur = id;
    while (this.#parent.has(cur) && this.#parent.get(cur) !== cur) {
      cur = this.#parent.get(cur)!;
    }
    let walk = id;
    while (walk !== cur) {
      const next = this.#parent.get(walk)!;
      this.#parent.set(walk, cur);
      walk = next;
    }
    return cur;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.#parent.set(ra, rb);
  }
}

function pointKey(x: number, y: number): string {
  // KiCad grid precision: 0.05 mm snap
  const rx = Math.round(x * 20);
  const ry = Math.round(y * 20);
  return `${rx}:${ry}`;
}

function isPointOnSegment(px: number, py: number, seg: ElectronicsWireSegment): boolean {
  const tol = 0.08;
  const minX = Math.min(seg.x1, seg.x2) - tol;
  const maxX = Math.max(seg.x1, seg.x2) + tol;
  const minY = Math.min(seg.y1, seg.y2) - tol;
  const maxY = Math.max(seg.y1, seg.y2) + tol;
  if (px < minX || px > maxX || py < minY || py > maxY) return false;
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) {
    return Math.hypot(px - seg.x1, py - seg.y1) <= tol;
  }
  const cross = Math.abs((px - seg.x1) * dy - (py - seg.y1) * dx);
  return cross / Math.sqrt(lenSq) <= tol;
}

interface LibPinDef {
  readonly number: string;
  readonly name: string;
  readonly electricalType: ElectronicsPinElectricalType;
  readonly x: number;
  readonly y: number;
  readonly unit: number;
  readonly style: number;
}

function parseKiCadSubSymbolUnitStyle(name: string | undefined): {
  readonly unit: number;
  readonly style: number;
} {
  if (!name) return { unit: 0, style: 0 };
  const match = /_(\d+)_(\d+)$/u.exec(name);
  if (!match) return { unit: 0, style: 0 };
  return {
    unit: Number(match[1]),
    style: Number(match[2]),
  };
}

function extractLibSymbols(schRoot: SExprList): Map<string, LibPinDef[]> {
  const libMap = new Map<string, LibPinDef[]>();
  const extendsMap = new Map<string, string>();
  const libSymbols = findChild(schRoot, "lib_symbols");
  if (!libSymbols) return libMap;

  for (const sym of findChildren(libSymbols, "symbol")) {
    const libId = atomString(sym[1]);
    if (!libId) continue;
    const parentName = atomString(findChild(sym, "extends")?.[1]);
    if (parentName) {
      const libPrefix = libId.includes(":") ? libId.slice(0, libId.indexOf(":") + 1) : "";
      extendsMap.set(libId, parentName.includes(":") ? parentName : `${libPrefix}${parentName}`);
    }
    const pins: LibPinDef[] = [];

    const collectPins = (node: SExprList, unit: number, style: number) => {
      for (const pin of findChildren(node, "pin")) {
        const electricalType = mapKiCadPinType(atomString(pin[1]));
        const at = findChild(pin, "at");
        const nameNode = findChild(pin, "name");
        const numNode = findChild(pin, "number");
        const number = atomString(numNode?.[1]) ?? "";
        const name = atomString(nameNode?.[1]) ?? "";
        const x = atomNumber(at?.[1]) ?? 0;
        const y = atomNumber(at?.[2]) ?? 0;
        if (number) {
          pins.push({ number, name, electricalType, x, y, unit, style });
        }
      }
      for (const sub of findChildren(node, "symbol")) {
        const subName = atomString(sub[1]);
        const parsed = parseKiCadSubSymbolUnitStyle(subName);
        collectPins(sub, parsed.unit, parsed.style);
      }
    };

    collectPins(sym, 0, 0);
    libMap.set(libId, pins);
  }

  // Resolve KiCad derived symbols `(extends "Parent")` with O(N) memoization, depth cap, and cycle protection
  const MAX_EXTENDS_DEPTH = 32;
  const resolvedCache = new Map<string, LibPinDef[]>();
  const resolveDerived = (id: string, stack: Set<string>, depth: number): LibPinDef[] => {
    const cached = resolvedCache.get(id);
    if (cached !== undefined) return cached;
    const own = libMap.get(id) ?? [];
    const parentId = extendsMap.get(id);
    if (!parentId || stack.has(parentId) || depth >= MAX_EXTENDS_DEPTH) {
      if (stack.size === 0) resolvedCache.set(id, own);
      return own;
    }
    stack.add(id);
    let parentPins = resolveDerived(parentId, stack, depth + 1);
    if (parentPins.length === 0) {
      const shortParent = parentId.split(":").pop() ?? parentId;
      if (shortParent !== parentId && !stack.has(shortParent)) {
        parentPins = resolveDerived(shortParent, stack, depth + 1);
      }
    }
    stack.delete(id);
    const ownKeys = new Set(own.map((p) => `${p.unit}:${p.style}:${p.number}`));
    const merged = [
      ...parentPins.filter((p) => !ownKeys.has(`${p.unit}:${p.style}:${p.number}`)),
      ...own,
    ];
    // Only memoize cycle-free resolutions (when not currently inside an active cycle)
    resolvedCache.set(id, merged);
    return merged;
  };

  for (const id of extendsMap.keys()) {
    libMap.set(id, resolveDerived(id, new Set(), 0));
  }
  return libMap;
}

function transformKiCadSchPin(
  symX: number,
  symY: number,
  rotDeg: number,
  mirror: string | undefined,
  pinX: number,
  pinY: number,
): { readonly x: number; readonly y: number } {
  // KiCad schematic symbols have Y-up in lib_symbols and Y-down on the sheet canvas.
  let lx = pinX;
  let ly = -pinY;
  if (mirror === "x") ly = -ly;
  else if (mirror === "y") lx = -lx;

  const rad = (-rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = lx * cos - ly * sin;
  const ry = lx * sin + ly * cos;
  return {
    x: Number((symX + rx).toFixed(3)),
    y: Number((symY + ry).toFixed(3)),
  };
}

function parseKiCadSchematic(filePath: string, content: string): ElectronicsCircuitModel {
  const parsed = parseSExpr(content);
  const root = parsed.find((n): n is SExprList => isSExprList(n) && n[0] === "kicad_sch");
  if (!root) {
    throw new Error("File does not contain a top-level (kicad_sch ...) S-expression.");
  }

  const parseWarnings: string[] = [];
  const subSheets = findChildren(root, "sheet");
  if (subSheets.length > 0) {
    parseWarnings.push(
      `Detected ${subSheets.length} hierarchical sub-sheet(s); only the current schematic sheet was parsed.`,
    );
  }
  const titleBlock = findChild(root, "title_block");
  const title = atomString(findChild(titleBlock ?? [], "title")?.[1]);

  const libMap = extractLibSymbols(root);

  const wires: ElectronicsWireSegment[] = [];
  for (const wire of findChildren(root, "wire")) {
    const pts = findChild(wire, "pts");
    if (!pts) continue;
    const xys = findChildren(pts, "xy");
    for (let i = 0; i + 1 < xys.length; i += 1) {
      const x1 = atomNumber(xys[i]?.[1]);
      const y1 = atomNumber(xys[i]?.[2]);
      const x2 = atomNumber(xys[i + 1]?.[1]);
      const y2 = atomNumber(xys[i + 1]?.[2]);
      if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
        wires.push({ x1, y1, x2, y2, layer: "wire" });
      }
    }
  }

  const junctions: ElectronicsPoint[] = [];
  for (const j of findChildren(root, "junction")) {
    const at = findChild(j, "at");
    const x = atomNumber(at?.[1]);
    const y = atomNumber(at?.[2]);
    if (x !== undefined && y !== undefined) junctions.push({ x, y });
  }

  const noConnects: ElectronicsPoint[] = [];
  for (const nc of findChildren(root, "no_connect")) {
    const at = findChild(nc, "at");
    const x = atomNumber(at?.[1]);
    const y = atomNumber(at?.[2]);
    if (x !== undefined && y !== undefined) noConnects.push({ x, y });
  }

  const labels: ElectronicsLabelMarker[] = [];
  for (const [tag, kind] of [
    ["label", "local"],
    ["global_label", "global"],
    ["hierarchical_label", "hierarchical"],
  ] as const) {
    for (const lbl of findChildren(root, tag)) {
      const text = atomString(lbl[1]);
      const at = findChild(lbl, "at");
      const x = atomNumber(at?.[1]);
      const y = atomNumber(at?.[2]);
      if (text && x !== undefined && y !== undefined) {
        labels.push({ text, kind, x, y });
      }
    }
  }

  interface MutableComp {
    ref: string;
    value: string;
    kind: ElectronicsComponentKind;
    libId?: string;
    footprint?: string;
    unit?: number;
    x: number;
    y: number;
    rotation: number;
    pins: Array<{
      number: string;
      name?: string;
      electricalType: ElectronicsPinElectricalType;
      net?: string;
      x: number;
      y: number;
    }>;
  }

  const components: MutableComp[] = [];
  for (const sym of findChildren(root, "symbol")) {
    const libId = atomString(findChild(sym, "lib_id")?.[1]);
    const at = findChild(sym, "at");
    const x = atomNumber(at?.[1]) ?? 0;
    const y = atomNumber(at?.[2]) ?? 0;
    const rotation = atomNumber(at?.[3]) ?? 0;
    const mirror = atomString(findChild(sym, "mirror")?.[1]);
    const symUnit = atomNumber(findChild(sym, "unit")?.[1]);
    const symStyle = atomNumber(findChild(sym, "convert")?.[1]) ?? 1;
    const targetUnit = symUnit ?? 1;

    let ref = "";
    let value = "";
    let footprint: string | undefined;
    for (const prop of findChildren(sym, "property")) {
      const propName = atomString(prop[1]);
      const propVal = atomString(prop[2]) ?? "";
      if (propName === "Reference") ref = propVal;
      else if (propName === "Value") value = propVal;
      else if (propName === "Footprint" && propVal.length > 0) footprint = propVal;
    }

    if (!ref) ref = libId ?? `SYM_${components.length + 1}`;
    if (!value) value = libId?.split(":").pop() ?? ref;

    const isPowerFlag =
      /^PWR_FLAG$/iu.test(value) ||
      /^#FLG/iu.test(ref) ||
      (libId !== undefined && /:PWR_FLAG$/iu.test(libId));

    const kind = inferComponentKind(ref, libId, value);
    const allLibPins = libId ? (libMap.get(libId) ?? []) : [];
    const libPins = allLibPins.filter(
      (lp) =>
        (lp.unit === 0 || lp.unit === targetUnit) && (lp.style === 0 || lp.style === symStyle),
    );
    const pins = libPins.map((lp) => {
      const pos = transformKiCadSchPin(x, y, rotation, mirror, lp.x, lp.y);
      return {
        number: lp.number,
        ...(lp.name && lp.name !== "~" ? { name: lp.name } : {}),
        electricalType: isPowerFlag ? ("power_out" as const) : lp.electricalType,
        x: pos.x,
        y: pos.y,
      };
    });

    // Never emit a shared global net label for power:PWR_FLAG (multiple PWR_FLAG symbols
    // sit on distinct rails such as +5V and GND to satisfy ERC, and must not short them).
    if (kind === "power_symbol" && !isPowerFlag) {
      labels.push({ text: value, kind: "power", x, y });
    }

    components.push({
      ref,
      value,
      kind,
      ...(libId !== undefined ? { libId } : {}),
      ...(footprint !== undefined ? { footprint } : {}),
      ...(symUnit !== undefined ? { unit: Math.round(symUnit) } : {}),
      x,
      y,
      rotation,
      pins,
    });
  }

  // Build spatial connectivity graph with a uniform spatial grid index for wire segments
  const uf = new UnionFind();
  const pointIds = new Map<string, number>();
  let nextId = 1;
  const getPointId = (x: number, y: number): number => {
    const key = pointKey(x, y);
    const existing = pointIds.get(key);
    if (existing !== undefined) return existing;
    const id = nextId;
    nextId += 1;
    pointIds.set(key, id);
    return id;
  };

  const SCH_GRID_CELL = 10;
  const MAX_SAFE_COORD = 1e6;
  const isSafeCoord = (x: number, y: number) =>
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Math.abs(x) <= MAX_SAFE_COORD &&
    Math.abs(y) <= MAX_SAFE_COORD;

  const wireGrid = new Map<string, number[]>();
  const largeWireIndices: number[] = [];
  const wireStartIds: number[] = [];
  let warnedExtremeCoords = false;
  for (let i = 0; i < wires.length; i += 1) {
    const w = wires[i]!;
    const a = getPointId(w.x1, w.y1);
    const b = getPointId(w.x2, w.y2);
    uf.union(a, b);
    wireStartIds.push(a);

    if (!isSafeCoord(w.x1, w.y1) || !isSafeCoord(w.x2, w.y2)) {
      if (!warnedExtremeCoords) {
        warnedExtremeCoords = true;
        parseWarnings.push("Skipped spatial indexing for wire(s) with extreme coordinates.");
      }
      largeWireIndices.push(i);
      continue;
    }

    const minCx = Math.floor((Math.min(w.x1, w.x2) - 0.5) / SCH_GRID_CELL);
    const maxCx = Math.floor((Math.max(w.x1, w.x2) + 0.5) / SCH_GRID_CELL);
    const minCy = Math.floor((Math.min(w.y1, w.y2) - 0.5) / SCH_GRID_CELL);
    const maxCy = Math.floor((Math.max(w.y1, w.y2) + 0.5) / SCH_GRID_CELL);
    if ((maxCx - minCx + 1) * (maxCy - minCy + 1) > 256) {
      largeWireIndices.push(i);
    } else {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        for (let cy = minCy; cy <= maxCy; cy += 1) {
          const cellKey = `${cx},${cy}`;
          let bucket = wireGrid.get(cellKey);
          if (!bucket) {
            bucket = [];
            wireGrid.set(cellKey, bucket);
          }
          bucket.push(i);
        }
      }
    }
  }

  const unionPointWithTouchingWires = (px: number, py: number, ptId: number) => {
    const cx = Math.floor(px / SCH_GRID_CELL);
    const cy = Math.floor(py / SCH_GRID_CELL);
    const bucket = wireGrid.get(`${cx},${cy}`);
    if (bucket) {
      for (const i of bucket) {
        if (isPointOnSegment(px, py, wires[i]!)) {
          uf.union(ptId, wireStartIds[i]!);
        }
      }
    }
    for (const i of largeWireIndices) {
      if (isPointOnSegment(px, py, wires[i]!)) {
        uf.union(ptId, wireStartIds[i]!);
      }
    }
  };

  // Connect junctions lying on any wire segment
  for (const j of junctions) {
    unionPointWithTouchingWires(j.x, j.y, getPointId(j.x, j.y));
  }

  // Connect pins lying on wire endpoints or segments
  for (const comp of components) {
    for (const pin of comp.pins) {
      unionPointWithTouchingWires(pin.x, pin.y, getPointId(pin.x, pin.y));
    }
  }

  const labelGroupsByName = new Map<string, number>();
  for (const lbl of labels) {
    const lId = getPointId(lbl.x, lbl.y);
    unionPointWithTouchingWires(lbl.x, lbl.y, lId);
    // Same-name labels connect electrically across the sheet
    const prev = labelGroupsByName.get(lbl.text);
    if (prev !== undefined) {
      uf.union(lId, prev);
    } else {
      labelGroupsByName.set(lbl.text, lId);
    }
  }

  // Map each connected component root to preferred net name(s)
  const rootLabelNames = new Map<number, Set<string>>();
  for (const lbl of labels) {
    const rootId = uf.find(getPointId(lbl.x, lbl.y));
    let names = rootLabelNames.get(rootId);
    if (!names) {
      names = new Set<string>();
      rootLabelNames.set(rootId, names);
    }
    names.add(lbl.text);
  }

  const rootToNetName = new Map<number, string>();
  const rootPins = new Map<number, ElectronicsNetPinRef[]>();
  const ncKeys = new Set(noConnects.map((nc) => pointKey(nc.x, nc.y)));

  for (const comp of components) {
    const isPowerFlag =
      /^PWR_FLAG$/iu.test(comp.value) ||
      /^#FLG/iu.test(comp.ref) ||
      (comp.libId !== undefined && /:PWR_FLAG$/iu.test(comp.libId));
    for (const pin of comp.pins) {
      if (comp.kind === "power_symbol" && !isPowerFlag) continue;
      if (ncKeys.has(pointKey(pin.x, pin.y))) {
        pin.electricalType = "unconnected";
        continue;
      }
      const rootId = uf.find(getPointId(pin.x, pin.y));
      let list = rootPins.get(rootId);
      if (!list) {
        list = [];
        rootPins.set(rootId, list);
      }
      list.push({
        ref: comp.ref,
        pin: pin.number,
        ...(pin.name !== undefined ? { pinName: pin.name } : {}),
        electricalType: pin.electricalType,
      });
    }
  }

  // Determine canonical net name for every root that has labels or >= 2 pins or wires
  let autoNetIndex = 1;
  const allRoots = new Set<number>([...rootLabelNames.keys(), ...rootPins.keys()]);
  for (const rootId of allRoots) {
    const labelSet = rootLabelNames.get(rootId);
    const pins = rootPins.get(rootId) ?? [];
    if (labelSet && labelSet.size > 0) {
      const sorted = Array.from(labelSet).toSorted((a, b) => a.localeCompare(b));
      // If multiple distinct power/ground labels landed on the same net, join them so validator flags a short!
      const distinctRails = sorted.filter((n) => isGroundNetName(n) || isPowerNetName(n));
      if (distinctRails.length > 1) {
        rootToNetName.set(rootId, distinctRails.join(" / "));
      } else {
        rootToNetName.set(rootId, sorted[0]!);
      }
    } else if (pins.length >= 2) {
      const first = pins[0]!;
      rootToNetName.set(rootId, `Net-(${first.ref}-Pad${first.pin})`);
      autoNetIndex += 1;
    } else if (pins.length === 1) {
      // Check if a wire actually touches this pin
      const p = pins[0]!;
      const comp = components.find((c) => c.ref === p.ref);
      const pinObj = comp?.pins.find((candidate) => candidate.number === p.pin);
      const hasWire = pinObj !== undefined && wireStartIds.some((wId) => uf.find(wId) === rootId);
      if (hasWire) {
        rootToNetName.set(rootId, `Net-(${p.ref}-Pad${p.pin})`);
        autoNetIndex += 1;
      }
    }
  }
  void autoNetIndex;

  // Assign resolved net names back to pins and wires
  for (const comp of components) {
    const isPowerFlag =
      /^PWR_FLAG$/iu.test(comp.value) ||
      /^#FLG/iu.test(comp.ref) ||
      (comp.libId !== undefined && /:PWR_FLAG$/iu.test(comp.libId));
    for (const pin of comp.pins) {
      if (comp.kind === "power_symbol" && !isPowerFlag) {
        pin.net = comp.value;
        continue;
      }
      if (ncKeys.has(pointKey(pin.x, pin.y))) continue;
      const rootId = uf.find(getPointId(pin.x, pin.y));
      const netName = rootToNetName.get(rootId);
      if (netName) pin.net = netName;
    }
  }

  const annotatedWires: ElectronicsWireSegment[] = wires.map((w, idx) => {
    const netName = rootToNetName.get(uf.find(wireStartIds[idx]!));
    return netName ? { ...w, net: netName } : w;
  });

  const netsByName = new Map<string, ElectronicsNetPinRef[]>();
  for (const [rootId, netName] of rootToNetName.entries()) {
    const pins = rootPins.get(rootId) ?? [];
    const existing = netsByName.get(netName);
    if (existing) existing.push(...pins);
    else netsByName.set(netName, [...pins]);
  }

  const nets: ElectronicsNet[] = Array.from(netsByName.entries())
    .map(([name, pins]) => {
      const parts = name.split(" / ");
      const hasGround = parts.some((p) => isGroundNetName(p));
      const hasPower = parts.some((p) => isPowerNetName(p));
      return {
        name,
        isPower: hasPower,
        isGround: hasGround,
        pins,
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const finalComponents: ElectronicsComponent[] = components.map((c) => ({
    ref: c.ref,
    value: c.value,
    kind: c.kind,
    ...(c.libId !== undefined ? { libId: c.libId } : {}),
    ...(c.footprint !== undefined ? { footprint: c.footprint } : {}),
    ...(c.unit !== undefined ? { unit: c.unit } : {}),
    x: c.x,
    y: c.y,
    rotation: c.rotation,
    pins: c.pins,
  }));

  return {
    format: "kicad_sch",
    filePath,
    ...(title !== undefined ? { title } : {}),
    layers: ["schematic", "wire"],
    bounds: computeBounds({
      components: finalComponents,
      wires: annotatedWires,
      vias: [],
      labels,
      boardOutline: [],
    }),
    components: finalComponents,
    nets,
    wires: annotatedWires,
    vias: [],
    junctions,
    noConnects,
    labels,
    boardOutline: [],
    bom: buildBom(finalComponents),
    parseWarnings,
  };
}

function parseKiCadPcb(filePath: string, content: string): ElectronicsCircuitModel {
  const parsed = parseSExpr(content);
  const root = parsed.find((n): n is SExprList => isSExprList(n) && n[0] === "kicad_pcb");
  if (!root) {
    throw new Error("File does not contain a top-level (kicad_pcb ...) S-expression.");
  }

  const parseWarnings: string[] = [];
  const titleBlock = findChild(root, "title_block");
  const title = atomString(findChild(titleBlock ?? [], "title")?.[1]);

  const layers: string[] = [];
  const layersNode = findChild(root, "layers");
  if (layersNode) {
    for (let i = 1; i < layersNode.length; i += 1) {
      const entry = layersNode[i];
      if (isSExprList(entry)) {
        const layerName = atomString(entry[1]);
        if (layerName) layers.push(layerName);
      }
    }
  }

  const netIdToName = new Map<number, string>();
  const netPinsMap = new Map<string, ElectronicsNetPinRef[]>();
  const netCodeMap = new Map<string, number>();

  const topLevelNetNodes = findChildren(root, "net");
  const hasLegacyNetTable = topLevelNetNodes.some(
    (n) => n.length >= 3 && atomNumber(n[1]) !== undefined,
  );
  for (const netNode of topLevelNetNodes) {
    const code = atomNumber(netNode[1]);
    const name = atomString(netNode[2]) ?? "";
    if (code !== undefined && name.length > 0) {
      netIdToName.set(code, name);
      netCodeMap.set(name, code);
      if (!netPinsMap.has(name)) netPinsMap.set(name, []);
    }
  }

  const resolvePcbNet = (node: SExprList | undefined): string | undefined => {
    if (!node) return undefined;
    // Legacy 2-argument form: (net <code> "<name>")
    if (node.length >= 3) {
      const inlineName = atomString(node[2]);
      if (inlineName && inlineName.length > 0) {
        if (!netPinsMap.has(inlineName)) netPinsMap.set(inlineName, []);
        return inlineName;
      }
      const code = atomNumber(node[1]);
      if (code !== undefined) {
        const mapped = netIdToName.get(code);
        return mapped && mapped.length > 0 ? mapped : undefined;
      }
      return undefined;
    }
    // 1-argument form: legacy `(net <code>)` when board defines a top-level net table,
    // or KiCad 10 name-based `(net "<name>")` (including numeric names like `(net "12")`).
    const raw = atomString(node[1]);
    if (!raw || raw.length === 0) return undefined;
    if (hasLegacyNetTable) {
      const code = atomNumber(node[1]);
      if (code !== undefined) {
        const mapped = netIdToName.get(code);
        return mapped && mapped.length > 0 ? mapped : undefined;
      }
    }
    if (!netPinsMap.has(raw)) netPinsMap.set(raw, []);
    return raw;
  };

  const components: ElectronicsComponent[] = [];
  for (const fp of findChildren(root, "footprint")) {
    const footprintName = atomString(fp[1]);
    const layer = atomString(findChild(fp, "layer")?.[1]) ?? "F.Cu";
    const at = findChild(fp, "at");
    const fx = atomNumber(at?.[1]) ?? 0;
    const fy = atomNumber(at?.[2]) ?? 0;
    const rot = atomNumber(at?.[3]) ?? 0;

    let ref = "";
    let value = "";
    // KiCad 8+ uses (property "Reference" ...), KiCad 6/7 uses (fp_text reference ...)
    for (const prop of findChildren(fp, "property")) {
      const key = atomString(prop[1]);
      const val = atomString(prop[2]) ?? "";
      if (key === "Reference") ref = val;
      else if (key === "Value") value = val;
    }
    for (const txt of findChildren(fp, "fp_text")) {
      const kind = atomString(txt[1]);
      const val = atomString(txt[2]) ?? "";
      if (kind === "reference" && !ref) ref = val;
      else if (kind === "value" && !value) value = val;
    }
    if (!ref) ref = `FP_${components.length + 1}`;
    if (!value) value = footprintName ?? ref;

    const rad = (-rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const readLayersList = (node: SExprList | undefined): string[] | undefined => {
      if (!node) return undefined;
      const out: string[] = [];
      for (let i = 1; i < node.length; i += 1) {
        const s = atomString(node[i]);
        if (s && s.length > 0) out.push(s);
      }
      return out.length > 0 ? out : undefined;
    };

    const pins: ElectronicsPin[] = [];
    for (const pad of findChildren(fp, "pad")) {
      const padNum = atomString(pad[1]) ?? "";
      const rawShape = atomString(pad[3])?.toLowerCase();
      const padShape =
        rawShape === "circle" ||
        rawShape === "oval" ||
        rawShape === "rect" ||
        rawShape === "roundrect" ||
        rawShape === "trapezoid" ||
        rawShape === "custom"
          ? rawShape
          : undefined;
      const padAt = findChild(pad, "at");
      const pxLocal = atomNumber(padAt?.[1]) ?? 0;
      const pyLocal = atomNumber(padAt?.[2]) ?? 0;
      // KiCad stores pad `(at x y [angle])` in board coordinates, defaulting to 0° when omitted.
      const padRot = atomNumber(padAt?.[3]) ?? 0;
      const padSize = findChild(pad, "size");
      const padW = atomNumber(padSize?.[1]);
      const padH = atomNumber(padSize?.[2]);
      const wx = Number((fx + pxLocal * cos - pyLocal * sin).toFixed(3));
      const wy = Number((fy + pxLocal * sin + pyLocal * cos).toFixed(3));

      const cleanNet = resolvePcbNet(findChild(pad, "net"));
      const rawLayers = readLayersList(findChild(pad, "layers"));
      const copperLayers = rawLayers?.filter((l) => l.endsWith(".Cu") || l === "*");
      pins.push({
        number: padNum || String(pins.length + 1),
        electricalType: "passive",
        ...(cleanNet !== undefined ? { net: cleanNet } : {}),
        ...(copperLayers && copperLayers.length > 0 ? { layers: copperLayers } : {}),
        ...(padW !== undefined && Number.isFinite(padW) && padW > 0 ? { padWidth: padW } : {}),
        ...(padH !== undefined && Number.isFinite(padH) && padH > 0 ? { padHeight: padH } : {}),
        ...(Number.isFinite(padRot) && padRot !== 0 ? { padRotation: padRot } : {}),
        ...(padShape !== undefined ? { padShape } : {}),
        x: wx,
        y: wy,
      });

      if (cleanNet) {
        let list = netPinsMap.get(cleanNet);
        if (!list) {
          list = [];
          netPinsMap.set(cleanNet, list);
        }
        list.push({
          ref,
          pin: padNum || String(pins.length),
          electricalType: "passive",
        });
      }
    }

    components.push({
      ref,
      value,
      kind: inferComponentKind(ref, footprintName, value),
      ...(footprintName !== undefined ? { footprint: footprintName } : {}),
      x: fx,
      y: fy,
      rotation: rot,
      layer,
      pins,
    });
  }

  const wires: ElectronicsWireSegment[] = [];
  for (const seg of findChildren(root, "segment")) {
    const start = findChild(seg, "start");
    const end = findChild(seg, "end");
    const x1 = atomNumber(start?.[1]);
    const y1 = atomNumber(start?.[2]);
    const x2 = atomNumber(end?.[1]);
    const y2 = atomNumber(end?.[2]);
    const width = atomNumber(findChild(seg, "width")?.[1]) ?? 0.25;
    const layer = atomString(findChild(seg, "layer")?.[1]) ?? "F.Cu";
    const net = resolvePcbNet(findChild(seg, "net"));
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      wires.push({
        x1,
        y1,
        x2,
        y2,
        layer,
        width,
        ...(net !== undefined ? { net } : {}),
      });
    }
  }

  const vias: ElectronicsVia[] = [];
  for (const via of findChildren(root, "via")) {
    const at = findChild(via, "at");
    const x = atomNumber(at?.[1]);
    const y = atomNumber(at?.[2]);
    const size = atomNumber(findChild(via, "size")?.[1]) ?? 0.6;
    const drill = atomNumber(findChild(via, "drill")?.[1]);
    const net = resolvePcbNet(findChild(via, "net"));
    const layersNode = findChild(via, "layers");
    const viaLayers: string[] = [];
    if (layersNode) {
      for (let i = 1; i < layersNode.length; i += 1) {
        const s = atomString(layersNode[i]);
        if (s && s.length > 0) viaLayers.push(s);
      }
    }
    if (x !== undefined && y !== undefined) {
      vias.push({
        x,
        y,
        size,
        ...(drill !== undefined ? { drill } : {}),
        ...(net !== undefined ? { net } : {}),
        ...(viaLayers.length > 0 ? { layers: viaLayers } : {}),
      });
    }
  }

  const boardOutline: ElectronicsWireSegment[] = [];
  for (const line of findChildren(root, "gr_line")) {
    const layer = atomString(findChild(line, "layer")?.[1]);
    if (layer !== "Edge.Cuts") continue;
    const start = findChild(line, "start");
    const end = findChild(line, "end");
    const x1 = atomNumber(start?.[1]);
    const y1 = atomNumber(start?.[2]);
    const x2 = atomNumber(end?.[1]);
    const y2 = atomNumber(end?.[2]);
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      boardOutline.push({ x1, y1, x2, y2, layer: "Edge.Cuts", width: 0.15 });
    }
  }
  for (const rect of findChildren(root, "gr_rect")) {
    const layer = atomString(findChild(rect, "layer")?.[1]);
    if (layer !== "Edge.Cuts") continue;
    const start = findChild(rect, "start");
    const end = findChild(rect, "end");
    const x1 = atomNumber(start?.[1]);
    const y1 = atomNumber(start?.[2]);
    const x2 = atomNumber(end?.[1]);
    const y2 = atomNumber(end?.[2]);
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      boardOutline.push(
        { x1, y1, x2, y2: y1, layer: "Edge.Cuts", width: 0.15 },
        { x1: x2, y1, x2, y2, layer: "Edge.Cuts", width: 0.15 },
        { x1: x2, y1: y2, x2: x1, y2, layer: "Edge.Cuts", width: 0.15 },
        { x1, y1: y2, x2: x1, y2: y1, layer: "Edge.Cuts", width: 0.15 },
      );
    }
  }

  const nets: ElectronicsNet[] = Array.from(netPinsMap.entries())
    .map(([name, pins]) => {
      const code = netCodeMap.get(name);
      return {
        name,
        ...(code !== undefined ? { code } : {}),
        isPower: isPowerNetName(name),
        isGround: isGroundNetName(name),
        pins,
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return {
    format: "kicad_pcb",
    filePath,
    ...(title !== undefined ? { title } : {}),
    layers: layers.length > 0 ? layers : ["F.Cu", "B.Cu", "Edge.Cuts"],
    bounds: computeBounds({
      components,
      wires,
      vias,
      labels: [],
      boardOutline,
    }),
    components,
    nets,
    wires,
    vias,
    junctions: [],
    noConnects: [],
    labels: [],
    boardOutline,
    bom: buildBom(components),
    parseWarnings,
  };
}

function spicePinNamesForType(
  prefix: string,
): ReadonlyArray<{ name: string; type: ElectronicsPinElectricalType }> {
  switch (prefix) {
    case "V":
    case "I":
      return [
        { name: "+", type: "power_out" },
        { name: "-", type: "passive" },
      ];
    case "D":
      return [
        { name: "A", type: "passive" },
        { name: "K", type: "passive" },
      ];
    case "Q":
      return [
        { name: "C", type: "passive" },
        { name: "B", type: "input" },
        { name: "E", type: "passive" },
      ];
    case "M":
      return [
        { name: "D", type: "passive" },
        { name: "G", type: "input" },
        { name: "S", type: "passive" },
        { name: "B", type: "passive" },
      ];
    default:
      return [
        { name: "1", type: "passive" },
        { name: "2", type: "passive" },
      ];
  }
}

function parseSpiceNetlist(filePath: string, content: string): ElectronicsCircuitModel {
  const rawLines = content.replace(/\r\n/g, "\n").split("\n");
  const logicalLines: string[] = [];
  let title: string | undefined;

  for (let i = 0; i < rawLines.length; i += 1) {
    const trimmed = rawLines[i]!.trim();
    if (i === 0 && trimmed.length > 0 && !trimmed.startsWith(".")) {
      title = trimmed.replace(/^\*+\s*/u, "").trim();
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith("*")) continue;
    // Strip inline semicolon or '$' comments
    const withoutComment = trimmed.replace(/\s+[;$].*$/u, "").trim();
    if (withoutComment.length === 0) continue;
    if (withoutComment.startsWith("+") && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += ` ${withoutComment.slice(1).trim()}`;
    } else {
      logicalLines.push(withoutComment);
    }
  }

  const components: ElectronicsComponent[] = [];
  const netPinsMap = new Map<string, ElectronicsNetPinRef[]>();
  const parseWarnings: string[] = [];
  const params = new Map<string, string>();
  let inControlBlock = false;
  let inSubckt = false;

  for (const line of logicalLines) {
    const lower = line.toLowerCase();
    if (lower.startsWith(".control")) {
      inControlBlock = true;
      continue;
    }
    if (lower.startsWith(".endc")) {
      inControlBlock = false;
      continue;
    }
    if (inControlBlock) continue;
    if (lower.startsWith(".subckt")) {
      inSubckt = true;
      continue;
    }
    if (lower.startsWith(".ends")) {
      inSubckt = false;
      continue;
    }
    if (inSubckt) continue;
    if (lower.startsWith(".param")) {
      const rest = line.slice(6);
      for (const m of rest.matchAll(/([A-Za-z_]\w*)\s*=\s*([^\s]+)/gu)) {
        params.set(m[1]!.toLowerCase(), m[2]!);
      }
      continue;
    }
    if (/^\.(include|inc|lib)\b/iu.test(lower)) {
      if (!parseWarnings.some((w) => w.includes("SPICE .include/.lib"))) {
        parseWarnings.push(
          "Deck references external SPICE .include/.lib files; included circuitry is expanded during simulation.",
        );
      }
      continue;
    }
    if (line.startsWith(".")) continue;

    const tokens = line.split(/\s+/u).filter(Boolean);
    if (tokens.length < 4) continue;
    const ref = tokens[0]!;
    const prefix = ref[0]!.toUpperCase();

    let nodeCount = 2;
    if (prefix === "Q") nodeCount = 3;
    else if (prefix === "M") nodeCount = 4;
    else if (prefix === "X") nodeCount = Math.max(2, tokens.length - 2);

    if (tokens.length < nodeCount + 2) {
      parseWarnings.push(`Skipped malformed SPICE element: ${line}`);
      continue;
    }

    // SPICE node names are case-insensitive in ngspice batch mode; node 0 / gnd maps to "GND".
    const nodeNames = tokens.slice(1, 1 + nodeCount).map((n) => {
      const lowerNode = n.toLowerCase();
      return lowerNode === "0" || lowerNode === "gnd" ? "GND" : lowerNode;
    });
    let value = tokens.slice(1 + nodeCount).join(" ");
    // Substitute simple {param} references
    value = value.replace(
      /\{([A-Za-z_]\w*)\}/gu,
      (full, key: string) => params.get(key.toLowerCase()) ?? full,
    );

    const pinDefs = spicePinNamesForType(prefix);
    const col = components.length % 4;
    const row = Math.floor(components.length / 4);
    const cx = 30 + col * 52;
    const cy = 26 + row * 38;

    const pins: ElectronicsPin[] = nodeNames.map((netName, idx) => {
      const def = pinDefs[idx] ?? { name: String(idx + 1), type: "passive" as const };
      const px = idx % 2 === 0 ? cx - 14 : cx + 14;
      const py = cy + (idx >= 2 ? 10 : 0);
      let list = netPinsMap.get(netName);
      if (!list) {
        list = [];
        netPinsMap.set(netName, list);
      }
      list.push({
        ref,
        pin: String(idx + 1),
        pinName: def.name,
        electricalType: def.type,
      });
      return {
        number: String(idx + 1),
        name: def.name,
        electricalType: def.type,
        net: netName,
        x: px,
        y: py,
      };
    });

    components.push({
      ref,
      value,
      kind: inferComponentKind(ref, undefined, value),
      x: cx,
      y: cy,
      rotation: 0,
      pins,
    });
  }

  // Synthesize orthogonal schematic wires connecting pins on the same net
  const wires: ElectronicsWireSegment[] = [];
  const labels: ElectronicsLabelMarker[] = [];
  const pinPosByKey = new Map<string, ElectronicsPoint>();
  for (const c of components) {
    for (const p of c.pins) {
      if (p.x !== undefined && p.y !== undefined) {
        pinPosByKey.set(`${c.ref}:${p.number}`, { x: p.x, y: p.y });
      }
    }
  }

  for (const [netName, netPins] of netPinsMap.entries()) {
    const pts = netPins
      .map((np) => pinPosByKey.get(`${np.ref}:${np.pin}`))
      .filter((pt): pt is ElectronicsPoint => pt !== undefined);
    if (pts.length > 0) {
      labels.push({
        text: netName,
        kind: isGroundNetName(netName) || isPowerNetName(netName) ? "power" : "local",
        x: pts[0]!.x,
        y: pts[0]!.y - 4,
      });
    }
    if (!isGroundNetName(netName)) {
      for (let i = 0; i + 1 < pts.length; i += 1) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const midX = Number(((a.x + b.x) / 2).toFixed(3));
        wires.push(
          { x1: a.x, y1: a.y, x2: midX, y2: a.y, layer: "wire", net: netName },
          { x1: midX, y1: a.y, x2: midX, y2: b.y, layer: "wire", net: netName },
          { x1: midX, y1: b.y, x2: b.x, y2: b.y, layer: "wire", net: netName },
        );
      }
    }
  }

  const nets: ElectronicsNet[] = Array.from(netPinsMap.entries())
    .map(([name, pins]) => ({
      name,
      isPower: isPowerNetName(name),
      isGround: isGroundNetName(name),
      pins,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return {
    format: "spice",
    filePath,
    ...(title !== undefined && title.length > 0 ? { title } : {}),
    layers: ["schematic", "wire"],
    bounds: computeBounds({
      components,
      wires,
      vias: [],
      labels,
      boardOutline: [],
    }),
    components,
    nets,
    wires,
    vias: [],
    junctions: [],
    noConnects: [],
    labels,
    boardOutline: [],
    bom: buildBom(components),
    parseWarnings,
  };
}

interface RawCircuitJsonElement {
  readonly type?: string;
  readonly [key: string]: unknown;
}

function parseCircuitJson(filePath: string, content: string): ElectronicsCircuitModel {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid Circuit JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  const elements: ReadonlyArray<RawCircuitJsonElement> = Array.isArray(raw)
    ? raw
    : typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as { elements?: unknown }).elements)
      ? (raw as { elements: RawCircuitJsonElement[] }).elements
      : [];

  if (elements.length === 0) {
    throw new Error("Circuit JSON must be a non-empty array of Circuit JSON elements.");
  }

  const sourceComponents = new Map<string, RawCircuitJsonElement>();
  const sourcePorts = new Map<string, RawCircuitJsonElement>();
  const sourceNets = new Map<string, string>();
  const schComponents = new Map<string, RawCircuitJsonElement>();
  const pcbComponents = new Map<string, RawCircuitJsonElement>();
  const schPorts = new Map<string, RawCircuitJsonElement>();
  const pcbPadsByPort = new Map<string, RawCircuitJsonElement>();

  for (const el of elements) {
    if (!el || typeof el.type !== "string") continue;
    if (el.type === "source_component" && typeof el.source_component_id === "string") {
      sourceComponents.set(el.source_component_id, el);
    } else if (el.type === "source_port" && typeof el.source_port_id === "string") {
      sourcePorts.set(el.source_port_id, el);
    } else if (el.type === "source_net" && typeof el.source_net_id === "string") {
      sourceNets.set(el.source_net_id, typeof el.name === "string" ? el.name : el.source_net_id);
    } else if (el.type === "schematic_component" && typeof el.source_component_id === "string") {
      schComponents.set(el.source_component_id, el);
    } else if (el.type === "pcb_component" && typeof el.source_component_id === "string") {
      pcbComponents.set(el.source_component_id, el);
    } else if (el.type === "schematic_port" && typeof el.source_port_id === "string") {
      schPorts.set(el.source_port_id, el);
    } else if (
      (el.type === "pcb_smtpad" || el.type === "pcb_plated_hole") &&
      typeof el.pcb_port_id === "string"
    ) {
      pcbPadsByPort.set(el.pcb_port_id, el);
    }
  }

  // Union-find across source_ports AND source_nets via source_trace so separate traces
  // referencing the same source_net_id are always unified into one electrical net.
  const graphIndex = new Map<string, number>();
  let nextGraphId = 1;
  const getGraphId = (key: string) => {
    const existing = graphIndex.get(key);
    if (existing !== undefined) return existing;
    const assigned = nextGraphId;
    nextGraphId += 1;
    graphIndex.set(key, assigned);
    return assigned;
  };
  const uf = new UnionFind();
  const pendingLabels: Array<{ readonly memberId: number; readonly name: string }> = [];

  for (const [netId, netName] of sourceNets.entries()) {
    pendingLabels.push({ memberId: getGraphId(`net:${netId}`), name: netName });
  }

  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const connectedPorts = Array.isArray(el.connected_source_port_ids)
      ? el.connected_source_port_ids.filter((id): id is string => typeof id === "string")
      : [];
    const connectedNets = Array.isArray(el.connected_source_net_ids)
      ? el.connected_source_net_ids.filter((id): id is string => typeof id === "string")
      : [];

    const memberIds: number[] = [
      ...connectedPorts.map((pid) => getGraphId(`port:${pid}`)),
      ...connectedNets.map((nid) => getGraphId(`net:${nid}`)),
    ];
    for (let i = 0; i + 1 < memberIds.length; i += 1) {
      uf.union(memberIds[i]!, memberIds[i + 1]!);
    }

    const explicitDisplayName =
      typeof el.display_name === "string" && el.display_name.trim().length > 0
        ? el.display_name.trim()
        : undefined;
    const explicitSourceNetNames = connectedNets
      .map((nid) => sourceNets.get(nid))
      .filter((n): n is string => Boolean(n));
    if (memberIds.length > 0) {
      if (explicitSourceNetNames.length > 0) {
        for (const name of explicitSourceNetNames) {
          pendingLabels.push({ memberId: memberIds[0]!, name });
        }
      } else if (explicitDisplayName) {
        pendingLabels.push({ memberId: memberIds[0]!, name: explicitDisplayName });
      }
    }
  }

  // Resolve explicit net names AFTER all unions finish so trace ordering never drops labels,
  // and preserve distinct joined power/ground rail names ("VCC / GND") so ERC flags rail shorts.
  const rootLabelSet = new Map<number, Set<string>>();
  for (const { memberId, name } of pendingLabels) {
    const root = uf.find(memberId);
    let set = rootLabelSet.get(root);
    if (!set) {
      set = new Set<string>();
      rootLabelSet.set(root, set);
    }
    set.add(name);
  }
  const rootNetLabel = new Map<number, string>();
  for (const [root, names] of rootLabelSet.entries()) {
    const distinct = Array.from(names);
    const railNames = distinct.filter((n) => isPowerNetName(n) || isGroundNetName(n));
    if (railNames.length > 1) {
      rootNetLabel.set(root, railNames.join(" / "));
    } else if (distinct[0] !== undefined) {
      rootNetLabel.set(root, distinct[0]);
    }
  }

  const netPinsMap = new Map<string, ElectronicsNetPinRef[]>();
  const portToNet = new Map<string, string>();
  const rootToAutoName = new Map<number, string>();
  const explicitNetNames = new Set(rootNetLabel.values());
  let netCounter = 1;

  // Group ports by component in O(N) once instead of scanning all ports per component.
  const portsByComponent = new Map<string, Array<readonly [string, Record<string, unknown>]>>();
  for (const [portId, sp] of sourcePorts.entries()) {
    if (typeof sp.source_component_id === "string") {
      let bucket = portsByComponent.get(sp.source_component_id);
      if (!bucket) {
        bucket = [];
        portsByComponent.set(sp.source_component_id, bucket);
      }
      bucket.push([portId, sp]);
    }
    const pid = graphIndex.get(`port:${portId}`);
    if (pid === undefined) continue;
    const root = uf.find(pid);
    let netName = rootNetLabel.get(root) ?? rootToAutoName.get(root);
    if (!netName) {
      do {
        netName = `NET_${netCounter}`;
        netCounter += 1;
      } while (explicitNetNames.has(netName));
      rootToAutoName.set(root, netName);
    }
    portToNet.set(portId, netName);
    const comp =
      typeof sp.source_component_id === "string"
        ? sourceComponents.get(sp.source_component_id)
        : undefined;
    const ref = typeof comp?.name === "string" ? comp.name : "U?";
    const pinNum =
      typeof sp.pin_number === "number" || typeof sp.pin_number === "string"
        ? String(sp.pin_number)
        : typeof sp.name === "string"
          ? sp.name
          : "1";
    const pinName = typeof sp.name === "string" ? sp.name : undefined;
    let list = netPinsMap.get(netName);
    if (!list) {
      list = [];
      netPinsMap.set(netName, list);
    }
    list.push({
      ref,
      pin: pinNum,
      ...(pinName !== undefined ? { pinName } : {}),
      electricalType: "passive",
    });
  }

  // Choose ONE consistent coordinate space (PCB if PCB geometry exists, else schematic)
  // so component centers, pin coordinates, and traces never mix two coordinate systems.
  const hasPcbBoard = elements.some((el) => el.type === "pcb_board");
  const usePcbCoords = pcbComponents.size > 0 || hasPcbBoard;

  // Map source_port_id -> pcb_port_id so PCB pads can supply pad coordinates in PCB view
  const pcbPortBySourcePort = new Map<string, string>();
  for (const el of elements) {
    if (
      el.type === "pcb_port" &&
      typeof el.pcb_port_id === "string" &&
      typeof el.source_port_id === "string"
    ) {
      pcbPortBySourcePort.set(el.source_port_id, el.pcb_port_id);
    }
  }

  const components: ElectronicsComponent[] = [];
  let fallbackIdx = 0;
  for (const [compId, sc] of sourceComponents.entries()) {
    const ref = typeof sc.name === "string" ? sc.name : `C_${fallbackIdx + 1}`;
    const value =
      typeof sc.display_value === "string"
        ? sc.display_value
        : typeof sc.resistance === "number"
          ? `${sc.resistance}Ω`
          : typeof sc.capacitance === "number"
            ? `${sc.capacitance}F`
            : typeof sc.ftype === "string"
              ? sc.ftype
              : ref;
    const geom = usePcbCoords ? pcbComponents.get(compId) : schComponents.get(compId);
    const center = geom?.center as { x?: number; y?: number } | undefined;
    const cx = typeof center?.x === "number" ? center.x : (fallbackIdx % 4) * 30;
    const cy = typeof center?.y === "number" ? center.y : Math.floor(fallbackIdx / 4) * 24;
    fallbackIdx += 1;

    const pins: ElectronicsPin[] = [];
    const compPorts = portsByComponent.get(compId) ?? [];
    for (let pIdx = 0; pIdx < compPorts.length; pIdx += 1) {
      const [portId, sp] = compPorts[pIdx]!;
      const pinNum =
        typeof sp.pin_number === "number" || typeof sp.pin_number === "string"
          ? String(sp.pin_number)
          : typeof sp.name === "string"
            ? sp.name
            : String(pIdx + 1);
      const pinName = typeof sp.name === "string" ? sp.name : undefined;
      let px = cx + (pIdx % 2 === 0 ? -6 : 6);
      let py = cy + Math.floor(pIdx / 2) * 4;
      if (usePcbCoords) {
        const pcbPortId = pcbPortBySourcePort.get(portId);
        const pad = pcbPortId ? pcbPadsByPort.get(pcbPortId) : undefined;
        if (typeof pad?.x === "number" && typeof pad?.y === "number") {
          px = pad.x;
          py = pad.y;
        }
      } else {
        const schP = schPorts.get(portId);
        const schCenter = schP?.center as { x?: number; y?: number } | undefined;
        if (typeof schCenter?.x === "number" && typeof schCenter?.y === "number") {
          px = schCenter.x;
          py = schCenter.y;
        }
      }
      const net = portToNet.get(portId);
      pins.push({
        number: pinNum,
        ...(pinName !== undefined ? { name: pinName } : {}),
        electricalType: "passive",
        ...(net !== undefined ? { net } : {}),
        x: px,
        y: py,
      });
    }

    components.push({
      ref,
      value,
      kind: inferComponentKind(ref, typeof sc.ftype === "string" ? sc.ftype : undefined, value),
      x: cx,
      y: cy,
      rotation: typeof geom?.rotation === "number" ? geom.rotation : 0,
      layer: typeof geom?.layer === "string" ? geom.layer : usePcbCoords ? "F.Cu" : "schematic",
      pins,
    });
  }

  const wires: ElectronicsWireSegment[] = [];
  const boardOutline: ElectronicsWireSegment[] = [];

  for (const el of elements) {
    if (usePcbCoords && el.type === "pcb_trace" && Array.isArray(el.route)) {
      const route = el.route as ReadonlyArray<{
        x?: number;
        y?: number;
        layer?: string;
        width?: number;
      }>;
      for (let i = 0; i + 1 < route.length; i += 1) {
        const a = route[i]!;
        const b = route[i + 1]!;
        if (
          typeof a.x === "number" &&
          typeof a.y === "number" &&
          typeof b.x === "number" &&
          typeof b.y === "number"
        ) {
          wires.push({
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            layer: a.layer === "bottom" ? "B.Cu" : "F.Cu",
            width: typeof a.width === "number" ? a.width : 0.25,
          });
        }
      }
    } else if (!usePcbCoords && el.type === "schematic_trace" && Array.isArray(el.edges)) {
      const edges = el.edges as ReadonlyArray<{
        from?: { x?: number; y?: number };
        to?: { x?: number; y?: number };
      }>;
      for (const edge of edges) {
        if (
          typeof edge.from?.x === "number" &&
          typeof edge.from?.y === "number" &&
          typeof edge.to?.x === "number" &&
          typeof edge.to?.y === "number"
        ) {
          wires.push({
            x1: edge.from.x,
            y1: edge.from.y,
            x2: edge.to.x,
            y2: edge.to.y,
            layer: "wire",
          });
        }
      }
    } else if (el.type === "pcb_board") {
      const center = (el.center as { x?: number; y?: number } | undefined) ?? { x: 0, y: 0 };
      const w = typeof el.width === "number" ? el.width : 50;
      const h = typeof el.height === "number" ? el.height : 30;
      const x1 = (center.x ?? 0) - w / 2;
      const y1 = (center.y ?? 0) - h / 2;
      const x2 = (center.x ?? 0) + w / 2;
      const y2 = (center.y ?? 0) + h / 2;
      boardOutline.push(
        { x1, y1, x2, y2: y1, layer: "Edge.Cuts", width: 0.15 },
        { x1: x2, y1, x2, y2, layer: "Edge.Cuts", width: 0.15 },
        { x1: x2, y1: y2, x2: x1, y2, layer: "Edge.Cuts", width: 0.15 },
        { x1, y1: y2, x2: x1, y2: y1, layer: "Edge.Cuts", width: 0.15 },
      );
    }
  }

  const nets: ElectronicsNet[] = Array.from(netPinsMap.entries())
    .map(([name, pins]) => ({
      name,
      isPower: isPowerNetName(name),
      isGround: isGroundNetName(name),
      pins,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return {
    format: "circuit_json",
    filePath,
    layers: boardOutline.length > 0 ? ["F.Cu", "B.Cu", "Edge.Cuts"] : ["schematic", "wire"],
    bounds: computeBounds({
      components,
      wires,
      vias: [],
      labels: [],
      boardOutline,
    }),
    components,
    nets,
    wires,
    vias: [],
    junctions: [],
    noConnects: [],
    labels: [],
    boardOutline,
    bom: buildBom(components),
    parseWarnings: [],
  };
}

export function parseElectronicsFile(filePath: string, content: string): ElectronicsCircuitModel {
  const format = detectElectronicsFormat(filePath);
  if (!format) {
    throw new Error(
      `Unsupported electronics format for "${filePath}". Supported: .kicad_sch, .kicad_pcb, .cir/.sp/.spice/.net, *.circuit.json.`,
    );
  }
  switch (format) {
    case "kicad_sch":
      return parseKiCadSchematic(filePath, content);
    case "kicad_pcb":
      return parseKiCadPcb(filePath, content);
    case "spice":
      return parseSpiceNetlist(filePath, content);
    case "circuit_json":
      return parseCircuitJson(filePath, content);
  }
}
