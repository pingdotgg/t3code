import { useAtomValue } from "@effect/atom-react";
import type {
  DiscoveredLocalServer,
  DiscoveredLocalServerList,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { previewEnvironment } from "./state/preview";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);

const NO_DISCOVERED_SERVERS_ATOM = Atom.make(
  AsyncResult.initial<DiscoveredLocalServerList, never>(false),
).pipe(Atom.withLabel("preview:discovered-servers:none"));

export function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<DiscoveredLocalServer> {
  const result = useAtomValue(
    environmentId === null
      ? NO_DISCOVERED_SERVERS_ATOM
      : previewEnvironment.discoveredServers({ environmentId, input: {} }),
  );
  return Option.getOrNull(AsyncResult.value(result))?.servers ?? EMPTY_PORTS;
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
