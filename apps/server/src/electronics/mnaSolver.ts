import * as DateTime from "effect/DateTime";
import type {
  ElectronicsCircuitModel,
  ElectronicsSimulationComponentReading,
  ElectronicsSimulationKind,
  ElectronicsSimulationMetric,
  ElectronicsSimulationNodeVoltage,
  ElectronicsSimulationResult,
  ElectronicsSimulationTraceSeries,
} from "@t3tools/contracts";

import { isGroundNetName, parseEngineeringNumber } from "./parsers.ts";

const MAX_MNA_MATRIX_SIZE = 256;

interface LinearElement {
  readonly ref: string;
  readonly valueText: string;
  readonly type: "R" | "C" | "L" | "V" | "I";
  readonly n1: string;
  readonly n2: string;
  readonly numericValue: number;
  readonly acMag: number;
  readonly acPhaseRad: number;
  readonly hasExplicitAc: boolean;
  readonly pulse?: {
    readonly v1: number;
    readonly v2: number;
    readonly td: number;
    readonly tr: number;
    readonly tf: number;
    readonly pw: number;
    readonly per: number;
  };
  readonly sin?: {
    readonly vo: number;
    readonly va: number;
    readonly freq: number;
  };
}

function parseSourceSpec(
  raw: string,
  spiceMode: boolean,
): {
  dc: number;
  acMag: number;
  acPhaseRad: number;
  hasExplicitAc: boolean;
  pulse?: LinearElement["pulse"];
  sin?: LinearElement["sin"];
} {
  let dc = 0;
  let acMag = 0;
  let acPhaseRad = 0;
  let hasExplicitAc = false;
  let pulse: LinearElement["pulse"];
  let sin: LinearElement["sin"];
  const parseNum = (t: string) => parseEngineeringNumber(t, { spice: spiceMode });

  const pulseMatch = /PULSE\s*\(([^)]+)\)/iu.exec(raw);
  if (pulseMatch) {
    const nums = pulseMatch[1]!
      .trim()
      .split(/[\s,]+/u)
      .map((t) => parseNum(t) ?? 0);
    pulse = {
      v1: nums[0] ?? 0,
      v2: nums[1] ?? 5,
      td: nums[2] ?? 0,
      tr: Math.max(1e-12, nums[3] ?? 1e-6),
      tf: Math.max(1e-12, nums[4] ?? nums[3] ?? 1e-6),
      pw: nums[5] ?? 1e-3,
      per: nums[6] ?? 2e-3,
    };
    dc = pulse.v1;
  }

  const sinMatch = /SIN\s*\(([^)]+)\)/iu.exec(raw);
  if (sinMatch) {
    const nums = sinMatch[1]!
      .trim()
      .split(/[\s,]+/u)
      .map((t) => parseNum(t) ?? 0);
    sin = {
      vo: nums[0] ?? 0,
      va: nums[1] ?? 1,
      freq: nums[2] ?? 1000,
    };
    dc = sin.vo;
  }

  const acMatch = /\bAC\s+([^\s]+)(?:\s+([^\s]+))?/iu.exec(raw);
  if (acMatch) {
    hasExplicitAc = true;
    acMag = parseNum(acMatch[1]!) ?? 1;
    const phaseDeg = acMatch[2] ? (parseNum(acMatch[2]) ?? 0) : 0;
    acPhaseRad = (phaseDeg * Math.PI) / 180;
  }

  const dcMatch = /\bDC\s+([^\s]+)/iu.exec(raw);
  if (dcMatch) {
    dc = parseNum(dcMatch[1]!) ?? dc;
  } else if (!pulse && !sin) {
    const firstToken = raw.trim().split(/\s+/u)[0] ?? "";
    const parsed = parseNum(firstToken);
    if (parsed !== null) dc = parsed;
  }

  return {
    dc,
    acMag,
    acPhaseRad,
    hasExplicitAc,
    ...(pulse !== undefined ? { pulse } : {}),
    ...(sin !== undefined ? { sin } : {}),
  };
}

function extractLinearElements(model: ElectronicsCircuitModel): {
  elements: LinearElement[];
  skipped: string[];
} {
  const spiceMode = model.format === "spice";
  const elements: LinearElement[] = [];
  const skipped: string[] = [];

  for (const comp of model.components) {
    if (comp.kind === "power_symbol" || comp.ref.startsWith("#")) continue;
    if (comp.pins.length < 2) continue;
    const n1 = comp.pins[0]!.net;
    const n2 = comp.pins[1]!.net;
    if (!n1 || !n2) {
      skipped.push(`${comp.ref} (unconnected pin)`);
      continue;
    }

    const prefix = comp.ref[0]?.toUpperCase();
    const allowPrefixFallback = spiceMode || comp.kind === "other";
    const firstValueToken = comp.value.trim().split(/\s+/u)[0] ?? comp.value;
    if (comp.kind === "resistor" || (allowPrefixFallback && prefix === "R")) {
      const val = parseEngineeringNumber(firstValueToken, { spice: spiceMode });
      if (val !== null && val > 0) {
        elements.push({
          ref: comp.ref,
          valueText: comp.value,
          type: "R",
          n1,
          n2,
          numericValue: val,
          acMag: 0,
          acPhaseRad: 0,
          hasExplicitAc: false,
        });
      } else {
        skipped.push(`${comp.ref} (unparseable resistance "${comp.value}")`);
      }
    } else if (comp.kind === "capacitor" || (allowPrefixFallback && prefix === "C")) {
      const val = parseEngineeringNumber(firstValueToken, { spice: spiceMode });
      if (val !== null && val > 0) {
        elements.push({
          ref: comp.ref,
          valueText: comp.value,
          type: "C",
          n1,
          n2,
          numericValue: val,
          acMag: 0,
          acPhaseRad: 0,
          hasExplicitAc: false,
        });
      } else {
        skipped.push(`${comp.ref} (unparseable capacitance "${comp.value}")`);
      }
    } else if (comp.kind === "inductor" || (allowPrefixFallback && prefix === "L")) {
      const val = parseEngineeringNumber(firstValueToken, { spice: spiceMode });
      if (val !== null && val > 0) {
        elements.push({
          ref: comp.ref,
          valueText: comp.value,
          type: "L",
          n1,
          n2,
          numericValue: val,
          acMag: 0,
          acPhaseRad: 0,
          hasExplicitAc: false,
        });
      } else {
        skipped.push(`${comp.ref} (unparseable inductance "${comp.value}")`);
      }
    } else if (
      comp.kind === "power_source" ||
      (allowPrefixFallback && (prefix === "V" || prefix === "I"))
    ) {
      const spec = parseSourceSpec(comp.value, spiceMode);
      elements.push({
        ref: comp.ref,
        valueText: comp.value,
        type: prefix === "I" ? "I" : "V",
        n1,
        n2,
        numericValue: spec.dc,
        acMag: spec.acMag,
        acPhaseRad: spec.acPhaseRad,
        hasExplicitAc: spec.hasExplicitAc,
        ...(spec.pulse !== undefined ? { pulse: spec.pulse } : {}),
        ...(spec.sin !== undefined ? { sin: spec.sin } : {}),
      });
    } else {
      skipped.push(
        `${comp.ref} (${comp.kind}, nonlinear/active; requires ngspice for exact model)`,
      );
    }
  }

  return { elements, skipped };
}

function solveRealLinear(AInput: number[][], bInput: number[]): number[] {
  const n = bInput.length;
  const A = AInput.map((row) => [...row]);
  const b = [...bInput];

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let maxAbs = Math.abs(A[col]![col]!);
    for (let row = col + 1; row < n; row += 1) {
      const v = Math.abs(A[row]![col]!);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = row;
      }
    }
    if (maxAbs < 1e-18) {
      throw new Error(
        "Circuit matrix is singular (check for floating nodes or shorted voltage sources).",
      );
    }
    if (pivotRow !== col) {
      const tmpRow = A[col]!;
      A[col] = A[pivotRow]!;
      A[pivotRow] = tmpRow;
      const tmpB = b[col]!;
      b[col] = b[pivotRow]!;
      b[pivotRow] = tmpB;
    }
    const pivot = A[col]![col]!;
    for (let row = col + 1; row < n; row += 1) {
      const factor = A[row]![col]! / pivot;
      if (factor === 0) continue;
      for (let k = col; k < n; k += 1) {
        A[row]![k] = A[row]![k]! - factor * A[col]![k]!;
      }
      b[row] = b[row]! - factor * b[col]!;
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row]!;
    for (let k = row + 1; k < n; k += 1) {
      sum -= A[row]![k]! * x[k]!;
    }
    x[row] = sum / A[row]![row]!;
  }
  return x;
}

interface Complex {
  re: number;
  im: number;
}

const cAdd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
const cSub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
const cDiv = (a: Complex, b: Complex): Complex => {
  const denom = b.re * b.re + b.im * b.im;
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom,
  };
};
const cAbs = (a: Complex): number => Math.hypot(a.re, a.im);

function solveComplexLinear(AInput: Complex[][], bInput: Complex[]): Complex[] {
  const n = bInput.length;
  const A = AInput.map((row) => row.map((c) => ({ re: c.re, im: c.im })));
  const b = bInput.map((c) => ({ re: c.re, im: c.im }));

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let maxAbs = cAbs(A[col]![col]!);
    for (let row = col + 1; row < n; row += 1) {
      const v = cAbs(A[row]![col]!);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = row;
      }
    }
    if (maxAbs < 1e-18) {
      throw new Error("Complex AC circuit matrix is singular at this frequency.");
    }
    if (pivotRow !== col) {
      const tmpRow = A[col]!;
      A[col] = A[pivotRow]!;
      A[pivotRow] = tmpRow;
      const tmpB = b[col]!;
      b[col] = b[pivotRow]!;
      b[pivotRow] = tmpB;
    }
    const pivot = A[col]![col]!;
    for (let row = col + 1; row < n; row += 1) {
      const factor = cDiv(A[row]![col]!, pivot);
      if (factor.re === 0 && factor.im === 0) continue;
      for (let k = col; k < n; k += 1) {
        A[row]![k] = cSub(A[row]![k]!, cMul(factor, A[col]![k]!));
      }
      b[row] = cSub(b[row]!, cMul(factor, b[col]!));
    }
  }

  const x: Complex[] = Array.from({ length: n }, () => ({ re: 0, im: 0 }));
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row]!;
    for (let k = row + 1; k < n; k += 1) {
      sum = cSub(sum, cMul(A[row]![k]!, x[k]!));
    }
    x[row] = cDiv(sum, A[row]![row]!);
  }
  return x;
}

function sourceValueAtTime(el: LinearElement, t: number): number {
  if (el.sin) {
    return el.sin.vo + el.sin.va * Math.sin(2 * Math.PI * el.sin.freq * t);
  }
  if (el.pulse) {
    const p = el.pulse;
    if (t < p.td) return p.v1;
    const phase = p.per > 0 ? (t - p.td) % p.per : t - p.td;
    if (phase < p.tr) return p.v1 + ((p.v2 - p.v1) * phase) / p.tr;
    if (phase < p.tr + p.pw) return p.v2;
    if (phase < p.tr + p.pw + p.tf) {
      return p.v2 - ((p.v2 - p.v1) * (phase - p.tr - p.pw)) / p.tf;
    }
    return p.v1;
  }
  return el.numericValue;
}

function chooseDefaultOutputNode(
  nonGroundNodes: ReadonlyArray<string>,
  voltageSources: ReadonlyArray<LinearElement>,
  isRefNode: (netName: string) => boolean,
): string | undefined {
  if (nonGroundNodes.length === 0) return undefined;
  const preferred = nonGroundNodes.find((n) => /OUT|FILT|MID|DIV|LOAD/iu.test(n));
  if (preferred) return preferred;
  const drivenByVSource = new Set<string>();
  for (const vs of voltageSources) {
    if (!isRefNode(vs.n1)) drivenByVSource.add(vs.n1);
  }
  return nonGroundNodes.find((n) => !drivenByVSource.has(n)) ?? nonGroundNodes[0];
}

export function runBuiltinMnaSimulation(
  model: ElectronicsCircuitModel,
  options: {
    readonly kind?: ElectronicsSimulationKind;
    readonly outputNode?: string;
    readonly startFreqHz?: number;
    readonly stopFreqHz?: number;
    readonly pointsPerDecade?: number;
    readonly stopTimeSeconds?: number;
    readonly stepTimeSeconds?: number;
  } = {},
): ElectronicsSimulationResult {
  const kind: ElectronicsSimulationKind = options.kind ?? "dc_op";
  const { elements, skipped } = extractLinearElements(model);
  const notes: string[] = [];
  if (skipped.length > 0) {
    notes.push(
      `Skipped non-linear/unparsed elements in built-in linear MNA solver: ${skipped.join(", ")}.`,
    );
  }

  if (elements.length === 0) {
    throw new Error("No simulatable linear elements (R, C, L, V, I) were found in this circuit.");
  }

  // Format-aware reference node rule: in SPICE decks, only node 0 (normalized to "GND") is ground;
  // arbitrary nodes such as VSS or AVSS remain independent solved nodes.
  const isRefNode = (name: string): boolean =>
    model.format === "spice" ? name === "0" || name.toUpperCase() === "GND" : isGroundNetName(name);

  // Gather non-ground nodes
  const nodeIndex = new Map<string, number>();
  const nonGroundNodes: string[] = [];
  let hasGround = false;
  for (const el of elements) {
    for (const n of [el.n1, el.n2]) {
      if (isRefNode(n)) {
        hasGround = true;
      } else if (!nodeIndex.has(n)) {
        nodeIndex.set(n, nonGroundNodes.length);
        nonGroundNodes.push(n);
      }
    }
  }
  if (!hasGround) {
    throw new Error("Circuit requires a ground reference node (GND or 0) for nodal simulation.");
  }

  const voltageSources = elements.filter((e) => e.type === "V");
  if (voltageSources.length === 0 && !elements.some((e) => e.type === "I")) {
    throw new Error(
      "Circuit requires at least one voltage (V*) or current (I*) source to simulate.",
    );
  }

  const N = nonGroundNodes.length;
  const M = voltageSources.length;
  const size = N + M;
  if (size > MAX_MNA_MATRIX_SIZE) {
    throw new Error(
      `Circuit has ${size} MNA unknowns, exceeding the built-in dense solver cap (${MAX_MNA_MATRIX_SIZE}). Enable ngspice in Settings -> Electronics for large circuits.`,
    );
  }

  const solveDc = (): {
    nodeVoltages: ElectronicsSimulationNodeVoltage[];
    componentReadings: ElectronicsSimulationComponentReading[];
    voltageByNode: Map<string, number>;
  } => {
    const A = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    const b = new Array<number>(size).fill(0);

    const stampG = (n1: string, n2: string, g: number) => {
      const i1 = isRefNode(n1) ? -1 : nodeIndex.get(n1)!;
      const i2 = isRefNode(n2) ? -1 : nodeIndex.get(n2)!;
      if (i1 >= 0) A[i1]![i1]! += g;
      if (i2 >= 0) A[i2]![i2]! += g;
      if (i1 >= 0 && i2 >= 0) {
        A[i1]![i2]! -= g;
        A[i2]![i1]! -= g;
      }
    };

    // Tiny gmin to prevent floating capacitor islands from making DC singular
    for (let i = 0; i < N; i += 1) A[i]![i]! += 1e-12;

    for (const el of elements) {
      if (el.type === "R") {
        stampG(el.n1, el.n2, 1 / el.numericValue);
      } else if (el.type === "C") {
        stampG(el.n1, el.n2, 1e-12);
      } else if (el.type === "L") {
        // DC short (1 mΩ)
        stampG(el.n1, el.n2, 1e3);
      } else if (el.type === "I") {
        const i1 = isRefNode(el.n1) ? -1 : nodeIndex.get(el.n1)!;
        const i2 = isRefNode(el.n2) ? -1 : nodeIndex.get(el.n2)!;
        if (i1 >= 0) b[i1]! -= el.numericValue;
        if (i2 >= 0) b[i2]! += el.numericValue;
      }
    }

    for (let s = 0; s < M; s += 1) {
      const vs = voltageSources[s]!;
      const row = N + s;
      const i1 = isRefNode(vs.n1) ? -1 : nodeIndex.get(vs.n1)!;
      const i2 = isRefNode(vs.n2) ? -1 : nodeIndex.get(vs.n2)!;
      const rowArr = A[row]!;
      if (i1 >= 0) {
        rowArr[i1] = 1;
        A[i1]![row] = 1;
      }
      if (i2 >= 0) {
        rowArr[i2] = -1;
        A[i2]![row] = -1;
      }
      b[row] = vs.numericValue;
    }

    const x = solveRealLinear(A, b);
    const voltageByNode = new Map<string, number>();
    const nodeVoltages: ElectronicsSimulationNodeVoltage[] = nonGroundNodes.map((node, idx) => {
      const v = Number(x[idx]!.toPrecision(6));
      voltageByNode.set(node, x[idx]!);
      return { node, voltageV: v };
    });

    const getV = (n: string) => (isRefNode(n) ? 0 : (voltageByNode.get(n) ?? 0));
    const componentReadings: ElectronicsSimulationComponentReading[] = [];

    for (const el of elements) {
      const vDrop = getV(el.n1) - getV(el.n2);
      let current = 0;
      if (el.type === "R") {
        current = vDrop / el.numericValue;
      } else if (el.type === "L") {
        current = vDrop * 1e3;
      } else if (el.type === "I") {
        current = el.numericValue;
      } else if (el.type === "V") {
        const sIdx = voltageSources.indexOf(el);
        current = sIdx >= 0 ? -x[N + sIdx]! : 0;
      }
      const power = Math.abs(vDrop * current);
      componentReadings.push({
        ref: el.ref,
        value: el.valueText,
        voltageDropV: Number(vDrop.toPrecision(5)),
        currentA: Number(current.toPrecision(5)),
        powerW: Number(power.toPrecision(5)),
      });
    }

    return { nodeVoltages, componentReadings, voltageByNode };
  };

  const dc = solveDc();
  const requestedOutputRaw = options.outputNode?.trim();
  const resolveRequestedOutputNode = (raw: string): string | undefined => {
    if (nodeIndex.has(raw)) return raw;
    if (model.format === "spice") {
      const lower = raw.toLowerCase();
      if (nodeIndex.has(lower)) return lower;
    }
    const ciMatches = nonGroundNodes.filter((n) => n.toLowerCase() === raw.toLowerCase());
    return ciMatches.length === 1 ? ciMatches[0] : undefined;
  };
  let targetNode: string | undefined;
  let targetIsExplicitGround = false;
  if (requestedOutputRaw !== undefined && requestedOutputRaw.length > 0) {
    if (isRefNode(requestedOutputRaw)) {
      targetIsExplicitGround = true;
      targetNode = model.format === "spice" ? "GND" : requestedOutputRaw;
    } else {
      const resolved = resolveRequestedOutputNode(requestedOutputRaw);
      if (resolved === undefined) {
        throw new Error(
          `Requested output node "${options.outputNode}" was not found in this circuit.`,
        );
      }
      targetNode = resolved;
    }
  } else {
    targetNode = chooseDefaultOutputNode(nonGroundNodes, voltageSources, isRefNode);
  }

  if (kind === "dc_op") {
    const totalPowerW = dc.componentReadings
      .filter((r) => !r.ref.toUpperCase().startsWith("V"))
      .reduce((acc, r) => acc + r.powerW, 0);
    const metrics: ElectronicsSimulationMetric[] = [
      { name: "Total dissipation", value: Number(totalPowerW.toPrecision(4)), unit: "W" },
    ];
    if (targetNode) {
      const tv = targetIsExplicitGround ? 0 : (dc.voltageByNode.get(targetNode) ?? 0);
      metrics.unshift({ name: `V(${targetNode})`, value: Number(tv.toPrecision(5)), unit: "V" });
    }
    return {
      filePath: model.filePath,
      kind: "dc_op",
      engine: "builtin_mna",
      xAxisLabel: "Node",
      xAxisUnit: "",
      xAxisLog: false,
      nodeVoltages: dc.nodeVoltages,
      componentReadings: dc.componentReadings,
      series: [],
      metrics,
      notes,
      simulatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    };
  }

  if (targetIsExplicitGround) {
    throw new Error(
      `Cannot plot reference ground node "${options.outputNode}"; choose a non-ground circuit node.`,
    );
  }

  if (kind === "ac_sweep") {
    const hasAnyExplicitAc = elements.some(
      (e) => (e.type === "V" || e.type === "I") && e.hasExplicitAc,
    );
    const fallbackAcSourceRef = !hasAnyExplicitAc ? voltageSources[0]?.ref : undefined;
    if (fallbackAcSourceRef) {
      notes.push(
        `No explicit AC stimulus found; applied a 1 V AC test excitation to ${fallbackAcSourceRef}.`,
      );
    }

    const startFreq = options.startFreqHz ?? 10;
    const stopFreq = options.stopFreqHz ?? Math.max(1_000_000, startFreq * 10);
    if (
      !Number.isFinite(startFreq) ||
      !Number.isFinite(stopFreq) ||
      startFreq <= 0 ||
      stopFreq <= startFreq
    ) {
      throw new Error(
        "AC sweep requires positive finite startFreqHz and stopFreqHz with stopFreqHz > startFreqHz.",
      );
    }
    const ptsPerDecade = options.pointsPerDecade ?? 12;
    const decades = Math.log10(stopFreq / startFreq);
    const totalPts = Math.min(200, Math.max(10, Math.round(decades * ptsPerDecade) + 1));

    const outNodes = targetNode ? [targetNode] : nonGroundNodes.slice(0, 3);
    const seriesMap = new Map<string, Array<{ x: number; y: number; phaseDeg: number }>>();
    for (const n of outNodes) seriesMap.set(n, []);

    for (let k = 0; k < totalPts; k += 1) {
      const frac = totalPts === 1 ? 0 : k / (totalPts - 1);
      const freq = startFreq * Math.pow(stopFreq / startFreq, frac);
      const omega = 2 * Math.PI * freq;

      const A: Complex[][] = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => ({ re: 0, im: 0 })),
      );
      const b: Complex[] = Array.from({ length: size }, () => ({ re: 0, im: 0 }));

      for (let i = 0; i < N; i += 1) A[i]![i]!.re += 1e-12;

      const stampY = (n1: string, n2: string, y: Complex) => {
        const i1 = isRefNode(n1) ? -1 : nodeIndex.get(n1)!;
        const i2 = isRefNode(n2) ? -1 : nodeIndex.get(n2)!;
        if (i1 >= 0) A[i1]![i1] = cAdd(A[i1]![i1]!, y);
        if (i2 >= 0) A[i2]![i2] = cAdd(A[i2]![i2]!, y);
        if (i1 >= 0 && i2 >= 0) {
          A[i1]![i2] = cSub(A[i1]![i2]!, y);
          A[i2]![i1] = cSub(A[i2]![i1]!, y);
        }
      };

      for (const el of elements) {
        if (el.type === "R") {
          stampY(el.n1, el.n2, { re: 1 / el.numericValue, im: 0 });
        } else if (el.type === "C") {
          stampY(el.n1, el.n2, { re: 0, im: omega * el.numericValue });
        } else if (el.type === "L") {
          stampY(el.n1, el.n2, { re: 0, im: -1 / (omega * el.numericValue) });
        } else if (el.type === "I") {
          const i1 = isRefNode(el.n1) ? -1 : nodeIndex.get(el.n1)!;
          const i2 = isRefNode(el.n2) ? -1 : nodeIndex.get(el.n2)!;
          const val: Complex = {
            re: el.acMag * Math.cos(el.acPhaseRad),
            im: el.acMag * Math.sin(el.acPhaseRad),
          };
          if (i1 >= 0) b[i1] = cSub(b[i1]!, val);
          if (i2 >= 0) b[i2] = cAdd(b[i2]!, val);
        }
      }

      for (let s = 0; s < M; s += 1) {
        const vs = voltageSources[s]!;
        const row = N + s;
        const i1 = isRefNode(vs.n1) ? -1 : nodeIndex.get(vs.n1)!;
        const i2 = isRefNode(vs.n2) ? -1 : nodeIndex.get(vs.n2)!;
        if (i1 >= 0) {
          A[row]![i1] = { re: 1, im: 0 };
          A[i1]![row] = { re: 1, im: 0 };
        }
        if (i2 >= 0) {
          A[row]![i2] = { re: -1, im: 0 };
          A[i2]![row] = { re: -1, im: 0 };
        }
        const effectiveAcMag = vs.ref === fallbackAcSourceRef ? 1 : vs.acMag;
        b[row] = {
          re: effectiveAcMag * Math.cos(vs.acPhaseRad),
          im: effectiveAcMag * Math.sin(vs.acPhaseRad),
        };
      }

      const sol = solveComplexLinear(A, b);
      for (const n of outNodes) {
        const cVal = sol[nodeIndex.get(n)!]!;
        const mag = Math.max(1e-12, cAbs(cVal));
        const db = 20 * Math.log10(mag);
        const phaseDeg = (Math.atan2(cVal.im, cVal.re) * 180) / Math.PI;
        seriesMap.get(n)!.push({
          x: Number(freq.toPrecision(5)),
          y: Number(db.toFixed(3)),
          phaseDeg: Number(phaseDeg.toFixed(2)),
        });
      }
    }

    const series: ElectronicsSimulationTraceSeries[] = outNodes.map((n) => ({
      label: `|V(${n})|`,
      unit: "dB",
      points: seriesMap.get(n)!,
    }));

    const metrics: ElectronicsSimulationMetric[] = [];
    const primary = series[0]?.points ?? [];
    if (primary.length >= 2) {
      const peakDb = Math.max(...primary.map((p) => p.y));
      metrics.push({ name: "Peak Gain", value: Number(peakDb.toFixed(2)), unit: "dB" });
      const targetDb = peakDb - 3.0103;
      for (let i = 1; i < primary.length; i += 1) {
        const prev = primary[i - 1]!;
        const curr = primary[i]!;
        if (
          (prev.y >= targetDb && curr.y <= targetDb) ||
          (prev.y <= targetDb && curr.y >= targetDb)
        ) {
          const frac = (targetDb - prev.y) / (curr.y - prev.y || 1);
          const fc = prev.x * Math.pow(curr.x / prev.x, Math.max(0, Math.min(1, frac)));
          metrics.push({ name: "-3 dB Cutoff", value: Number(fc.toPrecision(4)), unit: "Hz" });
          break;
        }
      }
    }

    return {
      filePath: model.filePath,
      kind: "ac_sweep",
      engine: "builtin_mna",
      xAxisLabel: "Frequency",
      xAxisUnit: "Hz",
      xAxisLog: true,
      nodeVoltages: dc.nodeVoltages,
      componentReadings: dc.componentReadings,
      series,
      metrics,
      notes,
      simulatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    };
  }

  // Transient analysis (Backward Euler companion models for C and L)
  // Auto-pick a sensible stop time from dominant RC time constant if omitted
  let estimatedTau = 1e-3;
  const firstR = elements.find((e) => e.type === "R")?.numericValue;
  const firstC = elements.find((e) => e.type === "C")?.numericValue;
  if (firstR && firstC) {
    estimatedTau = Math.max(1e-7, Math.min(1, firstR * firstC));
  }
  if (
    options.stopTimeSeconds !== undefined &&
    (!Number.isFinite(options.stopTimeSeconds) || options.stopTimeSeconds <= 0)
  ) {
    throw new Error("stopTimeSeconds must be a positive finite number.");
  }
  if (
    options.stepTimeSeconds !== undefined &&
    (!Number.isFinite(options.stepTimeSeconds) || options.stepTimeSeconds <= 0)
  ) {
    throw new Error("stepTimeSeconds must be a positive finite number.");
  }
  const stopTime = options.stopTimeSeconds ?? estimatedTau * 5;
  const steps = Math.min(
    240,
    Math.max(40, options.stepTimeSeconds ? Math.round(stopTime / options.stepTimeSeconds) : 100),
  );
  const dt = stopTime / steps;

  const outNodes = targetNode
    ? Array.from(
        new Set([
          ...voltageSources
            .map((v) => v.n1)
            .filter((n) => !isRefNode(n))
            .slice(0, 1),
          targetNode,
        ]),
      )
    : nonGroundNodes.slice(0, 2);

  const seriesMap = new Map<string, Array<{ x: number; y: number }>>();
  for (const n of outNodes) seriesMap.set(n, []);

  // Initialize reactive elements from the DC operating point (matching SPICE .tran without UIC)
  const getDcV = (n: string) => (isRefNode(n) ? 0 : (dc.voltageByNode.get(n) ?? 0));
  const capPrevV = new Map<string, number>();
  const indPrevI = new Map<string, number>();
  for (const el of elements) {
    if (el.type === "C") capPrevV.set(el.ref, getDcV(el.n1) - getDcV(el.n2));
    if (el.type === "L") indPrevI.set(el.ref, (getDcV(el.n1) - getDcV(el.n2)) * 1e3);
  }
  const hasTimeVaryingSource = elements.some(
    (e) => (e.type === "V" || e.type === "I") && (e.pulse !== undefined || e.sin !== undefined),
  );
  if (!hasTimeVaryingSource) {
    notes.push(
      "All sources are constant DC; transient starts from the DC operating point. Use PULSE(...) or SIN(...) to observe a step or waveform response.",
    );
  }

  for (let step = 0; step <= steps; step += 1) {
    const t = step * dt;
    if (step === 0) {
      for (const n of outNodes) {
        seriesMap.get(n)!.push({
          x: 0,
          y: Number(getDcV(n).toPrecision(5)),
        });
      }
      continue;
    }
    const A = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    const b = new Array<number>(size).fill(0);
    for (let i = 0; i < N; i += 1) A[i]![i]! += 1e-12;

    const stampG = (n1: string, n2: string, g: number) => {
      const i1 = isRefNode(n1) ? -1 : nodeIndex.get(n1)!;
      const i2 = isRefNode(n2) ? -1 : nodeIndex.get(n2)!;
      if (i1 >= 0) A[i1]![i1]! += g;
      if (i2 >= 0) A[i2]![i2]! += g;
      if (i1 >= 0 && i2 >= 0) {
        A[i1]![i2]! -= g;
        A[i2]![i1]! -= g;
      }
    };
    const stampI = (n1: string, n2: string, curr: number) => {
      const i1 = isRefNode(n1) ? -1 : nodeIndex.get(n1)!;
      const i2 = isRefNode(n2) ? -1 : nodeIndex.get(n2)!;
      if (i1 >= 0) b[i1]! -= curr;
      if (i2 >= 0) b[i2]! += curr;
    };

    for (const el of elements) {
      if (el.type === "R") {
        stampG(el.n1, el.n2, 1 / el.numericValue);
      } else if (el.type === "C") {
        const geq = el.numericValue / dt;
        const ieq = -geq * (capPrevV.get(el.ref) ?? 0);
        stampG(el.n1, el.n2, geq);
        stampI(el.n1, el.n2, ieq);
      } else if (el.type === "L") {
        const geq = dt / el.numericValue;
        const ieq = indPrevI.get(el.ref) ?? 0;
        stampG(el.n1, el.n2, geq);
        stampI(el.n1, el.n2, ieq);
      } else if (el.type === "I") {
        stampI(el.n1, el.n2, sourceValueAtTime(el, t));
      }
    }

    for (let s = 0; s < M; s += 1) {
      const vs = voltageSources[s]!;
      const row = N + s;
      const i1 = isRefNode(vs.n1) ? -1 : nodeIndex.get(vs.n1)!;
      const i2 = isRefNode(vs.n2) ? -1 : nodeIndex.get(vs.n2)!;
      const rowArr = A[row]!;
      if (i1 >= 0) {
        rowArr[i1] = 1;
        A[i1]![row] = 1;
      }
      if (i2 >= 0) {
        rowArr[i2] = -1;
        A[i2]![row] = -1;
      }
      b[row] = sourceValueAtTime(vs, t);
    }

    const sol = solveRealLinear(A, b);
    const vAt = (n: string) => (isRefNode(n) ? 0 : sol[nodeIndex.get(n)!]!);

    for (const el of elements) {
      if (el.type === "C") {
        capPrevV.set(el.ref, vAt(el.n1) - vAt(el.n2));
      } else if (el.type === "L") {
        const prevI = indPrevI.get(el.ref) ?? 0;
        indPrevI.set(el.ref, prevI + ((vAt(el.n1) - vAt(el.n2)) * dt) / el.numericValue);
      }
    }

    for (const n of outNodes) {
      seriesMap.get(n)!.push({
        x: Number((t * 1000).toPrecision(5)),
        y: Number(vAt(n).toPrecision(5)),
      });
    }
  }

  const series: ElectronicsSimulationTraceSeries[] = outNodes.map((n) => ({
    label: `V(${n})`,
    unit: "V",
    points: seriesMap.get(n)!,
  }));

  const primarySeries =
    series.find((s) => targetNode && s.label === `V(${targetNode})`) ?? series[0];
  const metrics: ElectronicsSimulationMetric[] = [];
  if (primarySeries && primarySeries.points.length > 0) {
    const ys = primarySeries.points.map((p) => p.y);
    const minV = Math.min(...ys);
    const maxV = Math.max(...ys);
    const finalV = ys[ys.length - 1]!;
    metrics.push(
      { name: "Final Value", value: Number(finalV.toPrecision(4)), unit: "V" },
      { name: "Peak-to-Peak", value: Number((maxV - minV).toPrecision(4)), unit: "V" },
    );
  }

  return {
    filePath: model.filePath,
    kind: "transient",
    engine: "builtin_mna",
    xAxisLabel: "Time",
    xAxisUnit: "ms",
    xAxisLog: false,
    nodeVoltages: dc.nodeVoltages,
    componentReadings: dc.componentReadings,
    series,
    metrics,
    notes,
    simulatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
  };
}
