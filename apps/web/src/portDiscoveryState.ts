import type {
  DiscoveredLocalServer,
  EnvironmentApi,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";
import { create } from "zustand";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);

interface PortDiscoveryState {
  readonly byEnvironment: Record<string, ReadonlyArray<DiscoveredLocalServer>>;
  setPorts: (environmentId: EnvironmentId, ports: ReadonlyArray<DiscoveredLocalServer>) => void;
  clearEnvironment: (environmentId: EnvironmentId) => void;
  reset: () => void;
}

export const usePortDiscoveryStore = create<PortDiscoveryState>((set) => ({
  byEnvironment: {},
  setPorts: (environmentId, ports) =>
    set((state) => ({
      byEnvironment: {
        ...state.byEnvironment,
        [environmentId]: ports,
      },
    })),
  clearEnvironment: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.byEnvironment)) return state;
      const { [environmentId]: _removed, ...byEnvironment } = state.byEnvironment;
      return { byEnvironment };
    }),
  reset: () => set({ byEnvironment: {} }),
}));

export function subscribePortDiscovery(input: {
  readonly environmentId: EnvironmentId;
  readonly previewApi: Pick<EnvironmentApi["preview"], "subscribePorts">;
}): () => void {
  usePortDiscoveryStore.getState().clearEnvironment(input.environmentId);
  return input.previewApi.subscribePorts((snapshot) => {
    usePortDiscoveryStore.getState().setPorts(input.environmentId, snapshot.servers);
  });
}

export function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<DiscoveredLocalServer> {
  return usePortDiscoveryStore(
    (state) => (environmentId ? state.byEnvironment[environmentId] : undefined) ?? EMPTY_PORTS,
  );
}

export function useThreadDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.threadId
        ? ports.filter((port) => port.terminal?.threadId === input.threadId)
        : EMPTY_PORTS,
    [input.threadId, ports],
  );
}

export function useTerminalDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly terminalId: string | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.threadId && input.terminalId
        ? ports.filter(
            (port) =>
              port.terminal?.threadId === input.threadId &&
              port.terminal.terminalId === input.terminalId,
          )
        : EMPTY_PORTS,
    [input.terminalId, input.threadId, ports],
  );
}
