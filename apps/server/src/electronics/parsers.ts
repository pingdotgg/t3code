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

export function parseEngineeringNumber(raw: string): number | null {
  const cleaned = raw
    .trim()
    .replace(/Ω|OHMS?|OHM|F|H|V|A|HZ$/iu, "")
    .trim();
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(meg|t|g|k|m|u|µ|n|p|f|r)?/iu.exec(
    cleaned,
  );
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = (match[2] ?? "").toLowerCase();
  switch (suffix) {
    case "t":
      return base * 1e12;
    case "g":
      return base * 1e9;
    case "meg":
      return base * 1e6;
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
      refs: string[];
    }
  >();

  for (const comp of components) {
    if (comp.kind === "power_symbol" || comp.ref.startsWith("#")) continue;
    const key = `${comp.value}||${comp.footprint ?? ""}||${comp.libId ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.refs.push(comp.ref);
    } else {
      groups.set(key, {
        value: comp.value,
        ...(comp.footprint !== undefined ? { footprint: comp.footprint } : {}),
        ...(comp.libId !== undefined ? { libId: comp.libId } : {}),
        kind: comp.kind,
        refs: [comp.ref],
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      value: group.value,
      ...(group.footprint !== undefined ? { footprint: group.footprint } : {}),
      ...(group.libId !== undefined ? { libId: group.libId } : {}),
      kind: group.kind,
      refs: group.refs.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      quantity: group.refs.length,
    }))
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
}

function extractLibSymbols(schRoot: SExprList): Map<string, LibPinDef[]> {
  const libMap = new Map<string, LibPinDef[]>();
  const libSymbols = findChild(schRoot, "lib_symbols");
  if (!libSymbols) return libMap;

  for (const sym of findChildren(libSymbols, "symbol")) {
    const libId = atomString(sym[1]);
    if (!libId) continue;
    const pins: LibPinDef[] = [];

    const collectPins = (node: SExprList) => {
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
          pins.push({ number, name, electricalType, x, y });
        }
      }
      for (const sub of findChildren(node, "symbol")) {
        collectPins(sub);
      }
    };

    collectPins(sym);
    libMap.set(libId, pins);
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

    const kind = inferComponentKind(ref, libId, value);
    const libPins = libId ? (libMap.get(libId) ?? []) : [];
    const pins = libPins.map((lp) => {
      const pos = transformKiCadSchPin(x, y, rotation, mirror, lp.x, lp.y);
      return {
        number: lp.number,
        ...(lp.name && lp.name !== "~" ? { name: lp.name } : {}),
        electricalType: lp.electricalType,
        x: pos.x,
        y: pos.y,
      };
    });

    if (kind === "power_symbol") {
      labels.push({ text: value, kind: "power", x, y });
    }

    components.push({
      ref,
      value,
      kind,
      ...(libId !== undefined ? { libId } : {}),
      ...(footprint !== undefined ? { footprint } : {}),
      x,
      y,
      rotation,
      pins,
    });
  }

  // Build spatial connectivity graph
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

  // Connect wire endpoints
  const wireStartIds: number[] = [];
  for (const w of wires) {
    const a = getPointId(w.x1, w.y1);
    const b = getPointId(w.x2, w.y2);
    uf.union(a, b);
    wireStartIds.push(a);
  }

  // Connect junctions lying on any wire segment
  for (const j of junctions) {
    const jId = getPointId(j.x, j.y);
    for (let i = 0; i < wires.length; i += 1) {
      if (isPointOnSegment(j.x, j.y, wires[i]!)) {
        uf.union(jId, wireStartIds[i]!);
      }
    }
  }

  // Connect pins and labels lying on wire endpoints or segments
  for (const comp of components) {
    for (const pin of comp.pins) {
      const pId = getPointId(pin.x, pin.y);
      for (let i = 0; i < wires.length; i += 1) {
        if (isPointOnSegment(pin.x, pin.y, wires[i]!)) {
          uf.union(pId, wireStartIds[i]!);
        }
      }
    }
  }

  const labelGroupsByName = new Map<string, number>();
  for (const lbl of labels) {
    const lId = getPointId(lbl.x, lbl.y);
    for (let i = 0; i < wires.length; i += 1) {
      if (isPointOnSegment(lbl.x, lbl.y, wires[i]!)) {
        uf.union(lId, wireStartIds[i]!);
      }
    }
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
    for (const pin of comp.pins) {
      if (comp.kind === "power_symbol") continue;
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
    for (const pin of comp.pins) {
      if (comp.kind === "power_symbol") {
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

  for (const netNode of findChildren(root, "net")) {
    const code = atomNumber(netNode[1]);
    const name = atomString(netNode[2]) ?? "";
    if (code !== undefined && name.length > 0) {
      netIdToName.set(code, name);
      netCodeMap.set(name, code);
      if (!netPinsMap.has(name)) netPinsMap.set(name, []);
    }
  }

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

    const pins: ElectronicsPin[] = [];
    for (const pad of findChildren(fp, "pad")) {
      const padNum = atomString(pad[1]) ?? "";
      const padAt = findChild(pad, "at");
      const pxLocal = atomNumber(padAt?.[1]) ?? 0;
      const pyLocal = atomNumber(padAt?.[2]) ?? 0;
      const wx = Number((fx + pxLocal * cos - pyLocal * sin).toFixed(3));
      const wy = Number((fy + pxLocal * sin + pyLocal * cos).toFixed(3));

      const netNode = findChild(pad, "net");
      const netCode = atomNumber(netNode?.[1]);
      const netName =
        atomString(netNode?.[2]) ?? (netCode !== undefined ? netIdToName.get(netCode) : undefined);

      const cleanNet = netName && netName.length > 0 ? netName : undefined;
      pins.push({
        number: padNum || String(pins.length + 1),
        electricalType: "passive",
        ...(cleanNet !== undefined ? { net: cleanNet } : {}),
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
    const netCode = atomNumber(findChild(seg, "net")?.[1]);
    const net = netCode !== undefined ? netIdToName.get(netCode) : undefined;
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
    const netCode = atomNumber(findChild(via, "net")?.[1]);
    const net = netCode !== undefined ? netIdToName.get(netCode) : undefined;
    if (x !== undefined && y !== undefined) {
      vias.push({
        x,
        y,
        size,
        ...(drill !== undefined ? { drill } : {}),
        ...(net !== undefined ? { net } : {}),
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

    const nodeNames = tokens.slice(1, 1 + nodeCount).map((n) => (n === "0" ? "GND" : n));
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

  // Union-find across source_ports via source_trace
  const portIndex = new Map<string, number>();
  let nextPortId = 1;
  const getPid = (id: string) => {
    const existing = portIndex.get(id);
    if (existing !== undefined) return existing;
    const assigned = nextPortId;
    nextPortId += 1;
    portIndex.set(id, assigned);
    return assigned;
  };
  const uf = new UnionFind();
  const rootNetLabel = new Map<number, string>();

  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const connectedPorts = Array.isArray(el.connected_source_port_ids)
      ? el.connected_source_port_ids.filter((id): id is string => typeof id === "string")
      : [];
    const connectedNets = Array.isArray(el.connected_source_net_ids)
      ? el.connected_source_net_ids.filter((id): id is string => typeof id === "string")
      : [];

    for (let i = 0; i + 1 < connectedPorts.length; i += 1) {
      uf.union(getPid(connectedPorts[i]!), getPid(connectedPorts[i + 1]!));
    }
    const explicitNetName =
      (typeof el.display_name === "string" && el.display_name.trim().length > 0
        ? el.display_name.trim()
        : undefined) ??
      connectedNets.map((nid) => sourceNets.get(nid)).find((n): n is string => Boolean(n));

    if (explicitNetName && connectedPorts.length > 0) {
      rootNetLabel.set(uf.find(getPid(connectedPorts[0]!)), explicitNetName);
    }
  }

  const netPinsMap = new Map<string, ElectronicsNetPinRef[]>();
  const portToNet = new Map<string, string>();
  const rootToAutoName = new Map<number, string>();
  let netCounter = 1;

  for (const [portId, sp] of sourcePorts.entries()) {
    const pid = portIndex.get(portId);
    if (pid === undefined) continue;
    const root = uf.find(pid);
    let netName = rootNetLabel.get(root) ?? rootToAutoName.get(root);
    if (!netName) {
      netName = `NET_${netCounter}`;
      netCounter += 1;
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
    const geom = pcbComponents.get(compId) ?? schComponents.get(compId);
    const center = geom?.center as { x?: number; y?: number } | undefined;
    const cx = typeof center?.x === "number" ? center.x : (fallbackIdx % 4) * 30;
    const cy = typeof center?.y === "number" ? center.y : Math.floor(fallbackIdx / 4) * 24;
    fallbackIdx += 1;

    const pins: ElectronicsPin[] = [];
    let pIdx = 0;
    for (const [portId, sp] of sourcePorts.entries()) {
      if (sp.source_component_id !== compId) continue;
      const pinNum =
        typeof sp.pin_number === "number" || typeof sp.pin_number === "string"
          ? String(sp.pin_number)
          : typeof sp.name === "string"
            ? sp.name
            : String(pIdx + 1);
      const pinName = typeof sp.name === "string" ? sp.name : undefined;
      const schP = schPorts.get(portId);
      const schCenter = schP?.center as { x?: number; y?: number } | undefined;
      const px = typeof schCenter?.x === "number" ? schCenter.x : cx + (pIdx % 2 === 0 ? -6 : 6);
      const py = typeof schCenter?.y === "number" ? schCenter.y : cy + Math.floor(pIdx / 2) * 4;
      const net = portToNet.get(portId);
      pins.push({
        number: pinNum,
        ...(pinName !== undefined ? { name: pinName } : {}),
        electricalType: "passive",
        ...(net !== undefined ? { net } : {}),
        x: px,
        y: py,
      });
      pIdx += 1;
    }

    components.push({
      ref,
      value,
      kind: inferComponentKind(ref, typeof sc.ftype === "string" ? sc.ftype : undefined, value),
      x: cx,
      y: cy,
      rotation: typeof geom?.rotation === "number" ? geom.rotation : 0,
      layer: typeof geom?.layer === "string" ? geom.layer : "F.Cu",
      pins,
    });
  }

  const wires: ElectronicsWireSegment[] = [];
  const boardOutline: ElectronicsWireSegment[] = [];

  for (const el of elements) {
    if (el.type === "pcb_trace" && Array.isArray(el.route)) {
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
    } else if (el.type === "schematic_trace" && Array.isArray(el.edges)) {
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
