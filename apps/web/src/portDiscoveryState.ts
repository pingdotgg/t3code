import type {
  DiscoveredLocalServer,
  EnvironmentId,
  ThreadId,
  ThreadOwnedProcess,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { previewEnvironment } from "./state/preview";
import { useEnvironmentQuery } from "./state/query";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);
const EMPTY_PROCESSES: ReadonlyArray<ThreadOwnedProcess> = Object.freeze([]);

export function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<DiscoveredLocalServer> {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : previewEnvironment.discoveredServers({ environmentId, input: {} }),
  );
  return query.data?.servers ?? EMPTY_PORTS;
}

export function useThreadDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.threadId
        ? ports.filter(
            (port) =>
              port.terminal?.threadId === input.threadId || port.agent?.threadId === input.threadId,
          )
        : EMPTY_PORTS,
    [input.threadId, ports],
  );
}

/**
 * All live processes owned by the thread (agent session descendants and
 * terminal trees), including ones without a listening port — e.g. a running
 * `pnpm build`.
 */
export function useThreadOwnedProcesses(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<ThreadOwnedProcess> {
  const query = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : previewEnvironment.discoveredServers({ environmentId: input.environmentId, input: {} }),
  );
  const processes = query.data?.processes ?? EMPTY_PROCESSES;
  return useMemo(
    () =>
      input.threadId
        ? processes.filter((entry) => entry.threadId === input.threadId)
        : EMPTY_PROCESSES,
    [input.threadId, processes],
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
