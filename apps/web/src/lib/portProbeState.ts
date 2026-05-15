/**
 * Lightweight port liveness probing keyed by environment.
 *
 * Many sidebar rows may want to know whether a localhost port (parsed from
 * agent activity) is currently being held open by some process. Rather than
 * have each row poll independently, this module:
 *   - dedupes the union of requested ports per environment
 *   - polls the server's `localProcesses.probePorts` RPC every PROBE_INTERVAL_MS
 *   - publishes results through a Zustand store so consumers re-render only
 *     when their specific ports flip state
 *
 * Use the `useListeningPortProbe(environmentId, ports)` hook from React.
 */

import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { readEnvironmentApi } from "../environmentApi";

const PROBE_INTERVAL_MS = 5_000;
const PROBE_MAX_PORTS = 32;

interface PortStatus {
  isListening: boolean;
  pids: ReadonlyArray<number>;
  checkedAt: number;
}

type PortStatusMap = Record<number, PortStatus>;

interface PortProbeStoreState {
  byEnvironment: Record<EnvironmentId, PortStatusMap>;
  applyProbe: (
    environmentId: EnvironmentId,
    results: ReadonlyArray<{ port: number; isListening: boolean; pids: ReadonlyArray<number> }>,
  ) => void;
  removeEnvironment: (environmentId: EnvironmentId) => void;
}

export const usePortProbeStore = create<PortProbeStoreState>()((set) => ({
  byEnvironment: {},
  applyProbe: (environmentId, results) =>
    set((state) => {
      const previous = state.byEnvironment[environmentId] ?? {};
      const next: PortStatusMap = { ...previous };
      const checkedAt = Date.now();
      let changed = false;
      for (const result of results) {
        const prior = previous[result.port];
        const isListening = result.isListening;
        const pids = [...result.pids];
        if (
          prior &&
          prior.isListening === isListening &&
          prior.pids.length === pids.length &&
          prior.pids.every((pid, index) => pid === pids[index])
        ) {
          // Refresh checkedAt without triggering selector changes that compare
          // by identity. We replace the slot only if a value actually changed.
          continue;
        }
        next[result.port] = { isListening, pids, checkedAt };
        changed = true;
      }
      if (!changed) {
        return state;
      }
      return {
        byEnvironment: {
          ...state.byEnvironment,
          [environmentId]: next,
        },
      };
    }),
  removeEnvironment: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.byEnvironment)) {
        return state;
      }
      const { [environmentId]: _removed, ...rest } = state.byEnvironment;
      return { byEnvironment: rest };
    }),
}));

// Per-environment ref counting and polling lives outside React state so that
// adding/removing subscribers does not trigger re-renders.
interface EnvironmentRegistry {
  refCounts: Map<number, number>;
  interval: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
}

const registries = new Map<EnvironmentId, EnvironmentRegistry>();

function ensureRegistry(environmentId: EnvironmentId): EnvironmentRegistry {
  let registry = registries.get(environmentId);
  if (!registry) {
    registry = { refCounts: new Map(), interval: null, inFlight: false };
    registries.set(environmentId, registry);
  }
  return registry;
}

function activePorts(registry: EnvironmentRegistry): number[] {
  const ports: number[] = [];
  for (const [port, count] of registry.refCounts.entries()) {
    if (count > 0) {
      ports.push(port);
    }
    if (ports.length >= PROBE_MAX_PORTS) {
      break;
    }
  }
  return ports.toSorted((left, right) => left - right);
}

async function runProbe(environmentId: EnvironmentId): Promise<void> {
  const registry = registries.get(environmentId);
  if (!registry || registry.inFlight) return;
  const ports = activePorts(registry);
  if (ports.length === 0) return;

  const api = readEnvironmentApi(environmentId);
  const probePorts = api?.localProcesses?.probePorts;
  if (!probePorts) return;

  registry.inFlight = true;
  try {
    const result = await probePorts({ ports });
    if (registries.get(environmentId) !== registry) {
      return;
    }
    usePortProbeStore.getState().applyProbe(environmentId, result.results);
  } catch {
    // Probe failures are non-fatal; we silently keep last-known state and try
    // again on the next tick.
  } finally {
    if (registries.get(environmentId) === registry) {
      registry.inFlight = false;
    }
  }
}

function startInterval(environmentId: EnvironmentId): void {
  const registry = ensureRegistry(environmentId);
  if (registry.interval !== null) return;
  // Probe immediately so callers don't wait a full interval for first results.
  void runProbe(environmentId);
  registry.interval = setInterval(() => {
    void runProbe(environmentId);
  }, PROBE_INTERVAL_MS);
}

function stopIntervalIfIdle(environmentId: EnvironmentId): void {
  const registry = registries.get(environmentId);
  if (!registry) return;
  if (registry.refCounts.size === 0 && registry.interval !== null) {
    clearInterval(registry.interval);
    registry.interval = null;
    usePortProbeStore.getState().removeEnvironment(environmentId);
    registries.delete(environmentId);
  }
}

function registerPorts(environmentId: EnvironmentId, ports: ReadonlyArray<number>): () => void {
  if (ports.length === 0) {
    return () => {};
  }
  const registry = ensureRegistry(environmentId);
  for (const port of ports) {
    registry.refCounts.set(port, (registry.refCounts.get(port) ?? 0) + 1);
  }
  startInterval(environmentId);

  return () => {
    const current = registries.get(environmentId);
    if (!current) return;
    for (const port of ports) {
      const count = current.refCounts.get(port) ?? 0;
      if (count <= 1) {
        current.refCounts.delete(port);
      } else {
        current.refCounts.set(port, count - 1);
      }
    }
    stopIntervalIfIdle(environmentId);
  };
}

const EMPTY_PORT_STATUS_MAP: PortStatusMap = Object.freeze({});

/**
 * Subscribe to liveness probing for the given ports and return the set of
 * those ports currently observed listening. Empty `ports` (or empty
 * `environmentId`) is a no-op that returns an empty set.
 */
export function useListeningPortProbe(
  environmentId: EnvironmentId | null | undefined,
  ports: ReadonlyArray<number>,
): ReadonlySet<number> {
  // Stable identity key so the registration effect doesn't churn per render.
  const portsKey = useMemo(
    () =>
      [...new Set(ports.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65_535))]
        .toSorted((a, b) => a - b)
        .join(","),
    [ports],
  );

  useEffect(() => {
    if (!environmentId || portsKey.length === 0) {
      return;
    }
    const portList = portsKey.split(",").map((value) => Number(value));
    const dispose = registerPorts(environmentId, portList);
    return dispose;
  }, [environmentId, portsKey]);

  const statusMap = usePortProbeStore((state) =>
    environmentId
      ? (state.byEnvironment[environmentId] ?? EMPTY_PORT_STATUS_MAP)
      : EMPTY_PORT_STATUS_MAP,
  );

  return useMemo(() => {
    if (!environmentId || portsKey.length === 0) return new Set<number>();
    const requestedPorts = portsKey.split(",").map((value) => Number(value));
    const listening = new Set<number>();
    for (const port of requestedPorts) {
      if (statusMap[port]?.isListening) {
        listening.add(port);
      }
    }
    return listening;
  }, [environmentId, portsKey, statusMap]);
}
