import type {
  DesktopPortForwardCreateInput,
  DesktopPortForwardId,
  DesktopPortForwardSnapshot,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";

export function parseDesktopPortForwardPort(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null;
}

export function useDesktopPortForwards() {
  const bridge = window.desktopBridge?.portForward;
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  const [forwards, setForwards] = useState<ReadonlyArray<DesktopPortForwardSnapshot>>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [stoppingId, setStoppingId] = useState<DesktopPortForwardId | null>(null);
  const connectedEnvironments = useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
  );
  const forwardableEnvironments = useMemo(
    () =>
      connectedEnvironments.filter(
        (environment) =>
          serverConfigs.get(environment.environmentId)?.environment.capabilities
            .tcpPortForwarding === true,
      ),
    [connectedEnvironments, serverConfigs],
  );
  const environmentLabels = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );

  useEffect(() => {
    if (bridge === undefined) return;
    let disposed = false;
    let stateChangeReceived = false;
    const unsubscribe = bridge.onStateChange((next) => {
      stateChangeReceived = true;
      setForwards(next);
    });
    void bridge.list().then(
      (next) => {
        if (!disposed && !stateChangeReceived) setForwards(next);
      },
      (cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  const create = async (input: DesktopPortForwardCreateInput): Promise<boolean> => {
    if (bridge === undefined || creating) return false;
    setCreating(true);
    setError(null);
    try {
      const created = await bridge.create(input);
      setForwards((current) =>
        current.some((forward) => forward.id === created.id) ? current : [...current, created],
      );
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setCreating(false);
    }
  };

  const stop = async (id: DesktopPortForwardId): Promise<void> => {
    if (bridge === undefined) return;
    setStoppingId(id);
    setError(null);
    try {
      await bridge.stop(id);
      setForwards((current) => current.filter((forward) => forward.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStoppingId(null);
    }
  };

  return {
    available: bridge !== undefined,
    connectedEnvironments,
    create,
    creating,
    environmentLabels,
    error,
    forwardableEnvironments,
    forwards,
    stop,
    stoppingId,
  };
}
