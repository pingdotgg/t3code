import type { MachineStatus } from "@t3tools/contracts";

// Ported from Hub Power's `capacity()` (radys-s/hub-power, app.pyw), constants unchanged.
// Measured on hub2: an agent holds 120-400 MB, up to 0.7-1.7 GB while it builds or tests.
const MB = 1024 * 1024;
const AGENT_MEMORY_BYTES = 700 * MB;
const RESERVE_SHARE = 0.15;
const RESERVE_MIN_BYTES = 512 * MB;
// Hub Power reads PSI avg60 for memory and CPU; the IO gate is avg10, as in the hubs' rules.
const MEMORY_PRESSURE_MAX = 10;
const CPU_PRESSURE_MAX = 25;
const IO_PRESSURE_MAX = 50;
const LOAD_PER_CORE_MAX = 0.85;

/** What sets `more`: free memory, a pressure gate, or the owner's cap. */
export type MachineLimit = "memory" | "memoryPressure" | "cpu" | "io" | "cap";

export interface MachineCapacity {
  /** How many more agents fit. */
  readonly more: number;
  readonly limit: MachineLimit;
  /** room: an agent fits; full: at the cap or the memory reserve; pressure: the machine is strained. */
  readonly level: "room" | "full" | "pressure";
}

export type MachineCapacityInput = Pick<
  MachineStatus,
  "cores" | "load" | "cpuUtilization" | "memory" | "pressure" | "working" | "maxWorkingAgents"
>;

function pressureLimit(status: MachineCapacityInput): MachineLimit | null {
  const { pressure } = status;
  if (pressure !== null && pressure.memory.avg60 > MEMORY_PRESSURE_MAX) return "memoryPressure";
  // Windows has no load average; its sampled CPU share stands in for load per core.
  const cpuBusy =
    status.load !== null
      ? status.load[1] >= status.cores * LOAD_PER_CORE_MAX
      : status.cpuUtilization !== null && status.cpuUtilization >= LOAD_PER_CORE_MAX;
  if (cpuBusy || (pressure !== null && pressure.cpu.avg60 > CPU_PRESSURE_MAX)) return "cpu";
  if (pressure !== null && pressure.io.avg10 > IO_PRESSURE_MAX) return "io";
  return null;
}

export function machineCapacity(status: MachineCapacityInput): MachineCapacity {
  const strained = pressureLimit(status);
  if (strained !== null) return { more: 0, limit: strained, level: "pressure" };
  const { memory, maxWorkingAgents, working } = status;
  const reserve = Math.max(RESERVE_MIN_BYTES, memory.totalBytes * RESERVE_SHARE);
  let more = Math.max(0, Math.floor((memory.availableBytes - reserve) / AGENT_MEMORY_BYTES));
  let limit: MachineLimit = "memory";
  if (maxWorkingAgents !== null && maxWorkingAgents - working < more) {
    more = Math.max(0, maxWorkingAgents - working);
    limit = "cap";
  }
  return { more, limit, level: more > 0 ? "room" : "full" };
}

export interface MachineCandidate {
  readonly id: string;
  /** null when the machine is offline or sent nothing. */
  readonly status: MachineCapacityInput | null;
}

export type NextMachine =
  | { readonly kind: "start"; readonly id: string; readonly more: number }
  /** Nothing fits; `limits` holds each reporting machine's reason, empty when none reported. */
  | { readonly kind: "wait"; readonly limits: ReadonlyArray<MachineLimit> };

/**
 * The machine with the most room. Ties go to the larger share of free memory, then to the
 * earlier candidate.
 */
export function recommendNextMachine(candidates: ReadonlyArray<MachineCandidate>): NextMachine {
  let best: { readonly id: string; readonly more: number; readonly freeShare: number } | null =
    null;
  const limits = new Set<MachineLimit>();
  for (const { id, status } of candidates) {
    if (status === null) continue;
    const capacity = machineCapacity(status);
    if (capacity.more === 0) {
      limits.add(capacity.limit);
      continue;
    }
    const freeShare =
      status.memory.totalBytes > 0 ? status.memory.availableBytes / status.memory.totalBytes : 0;
    if (
      best === null ||
      capacity.more > best.more ||
      (capacity.more === best.more && freeShare > best.freeShare)
    ) {
      best = { id, more: capacity.more, freeShare };
    }
  }
  return best === null
    ? { kind: "wait", limits: [...limits] }
    : { kind: "start", id: best.id, more: best.more };
}
