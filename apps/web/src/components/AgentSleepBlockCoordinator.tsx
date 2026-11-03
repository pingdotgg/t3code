import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef } from "react";

import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";

/**
 * Holds the desktop sleep blocker while agents work: every live environment
 * reports whether it currently has a thread in Working status (turn in
 * flight, starting, or a working background fleet), and the aggregate boolean
 * drives `desktopBridge.setAgentSleepBlock`. Approval, input, and monitoring
 * threads do not hold it — the agent is idle in those states and suspend is
 * safe, so a machine never goes to sleep only while an agent is computing.
 */
export function AgentSleepBlockCoordinator() {
  const { environments } = useEnvironments();
  const working = useRef(new Set<EnvironmentId>());

  const push = useCallback((active: boolean) => {
    void window.desktopBridge?.setAgentSleepBlock?.(active).catch(() => undefined);
  }, []);

  const onWorking = useCallback(
    (environmentId: EnvironmentId, isWorking: boolean) => {
      const before = working.current.size > 0;
      if (isWorking) working.current.add(environmentId);
      else working.current.delete(environmentId);
      if (before !== (working.current.size > 0)) push(working.current.size > 0);
    },
    [push],
  );

  useEffect(() => {
    // An environment that dropped out of the catalog must not hold the
    // blocker through its stale entry.
    const known = new Set(environments.map(({ environmentId }) => environmentId));
    for (const environmentId of working.current) {
      if (!known.has(environmentId)) onWorking(environmentId, false);
    }
  }, [environments, onWorking]);

  useEffect(() => () => push(false), [push]);

  return environments.map((environment) => (
    <EnvironmentAgentSleepBlock
      key={environment.environmentId}
      environmentId={environment.environmentId}
      onWorking={onWorking}
    />
  ));
}

function EnvironmentAgentSleepBlock({
  environmentId,
  onWorking,
}: {
  environmentId: EnvironmentId;
  onWorking: (environmentId: EnvironmentId, isWorking: boolean) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));

  useEffect(() => {
    let isWorking = false;
    if (shell.status === "live" && Option.isSome(shell.snapshot)) {
      for (const thread of shell.snapshot.value.threads) {
        if (thread.archivedAt !== null) continue;
        if (resolveSidebarThreadStatus(thread) !== "working") continue;
        isWorking = true;
        break;
      }
    }
    onWorking(environmentId, isWorking);
  }, [environmentId, onWorking, shell]);

  return null;
}
