import type {
  DesktopPortForwardId,
  DesktopPortForwardSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function parsePort(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null;
}

export function DesktopPortForwardsSettings() {
  const bridge = window.desktopBridge?.portForward;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [remotePort, setRemotePort] = useState("3000");
  const [localPort, setLocalPort] = useState("");
  const [forwards, setForwards] = useState<ReadonlyArray<DesktopPortForwardSnapshot>>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [stoppingId, setStoppingId] = useState<DesktopPortForwardId | null>(null);
  const connectedEnvironments = useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
  );

  useEffect(() => {
    if (
      environmentId !== null &&
      connectedEnvironments.some((environment) => environment.environmentId === environmentId)
    ) {
      return;
    }
    const primaryConnected = connectedEnvironments.some(
      (environment) => environment.environmentId === primaryEnvironment?.environmentId,
    );
    const fallback = primaryConnected
      ? (primaryEnvironment?.environmentId ?? null)
      : (connectedEnvironments[0]?.environmentId ?? null);
    setEnvironmentId(fallback);
  }, [connectedEnvironments, environmentId, primaryEnvironment?.environmentId]);

  useEffect(() => {
    if (bridge === undefined) return;
    let disposed = false;
    void bridge.list().then(
      (next) => {
        if (!disposed) setForwards(next);
      },
      (cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    const unsubscribe = bridge.onStateChange((next) => setForwards(next));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  const labels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  if (bridge === undefined) return null;

  const parsedRemotePort = parsePort(remotePort);
  const parsedLocalPort = localPort.trim() === "" ? undefined : parsePort(localPort);
  const canCreate =
    environmentId !== null && parsedRemotePort !== null && parsedLocalPort !== null && !creating;

  const create = async () => {
    if (!canCreate || environmentId === null || parsedRemotePort === null) return;
    setCreating(true);
    setError(null);
    try {
      const created = await bridge.create({
        environmentId,
        remoteHost: "127.0.0.1",
        remotePort: parsedRemotePort,
        ...(parsedLocalPort === undefined ? {} : { localPort: parsedLocalPort }),
      });
      setForwards((current) =>
        current.some((forward) => forward.id === created.id) ? current : [...current, created],
      );
      setLocalPort("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const stop = async (id: DesktopPortForwardId) => {
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

  return (
    <SettingsSection title="Port forwarding">
      <SettingsRow
        title="New TCP forward"
        description="Expose a remote loopback port on this computer. Leaving the local port blank tries the same port first, then nearby free ports. Forwards last until you stop them or quit T3 Code."
        status={error === null ? null : <span className="text-destructive">{error}</span>}
      >
        <div className="grid gap-2 pb-2 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-end">
          <label className="space-y-1 text-xs text-muted-foreground">
            Environment
            <Select
              value={environmentId ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string" && value !== "") {
                  setEnvironmentId(value as EnvironmentId);
                }
              }}
            >
              <SelectTrigger className="w-full" aria-label="Forward environment">
                <SelectValue>
                  {environmentId === null ? "Select" : (labels.get(environmentId) ?? environmentId)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {connectedEnvironments.map((environment) => (
                  <SelectItem
                    hideIndicator
                    key={environment.environmentId}
                    value={environment.environmentId}
                  >
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {connectedEnvironments.length === 0 ? (
              <span className="block pt-1 text-[11px] text-muted-foreground">
                Connect an environment to start forwarding ports.
              </span>
            ) : null}
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Remote port
            <Input
              inputMode="numeric"
              value={remotePort}
              onChange={(event) => setRemotePort(event.target.value)}
              aria-label="Remote port"
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Local port
            <Input
              inputMode="numeric"
              value={localPort}
              placeholder="Same as remote"
              onChange={(event) => setLocalPort(event.target.value)}
              aria-label="Local port"
            />
          </label>
          <Button size="sm" disabled={!canCreate} onClick={() => void create()}>
            {creating ? "Starting…" : "Start"}
          </Button>
        </div>
      </SettingsRow>
      {forwards.map((forward) => (
        <SettingsRow
          key={forward.id}
          title={`${forward.localHost}:${forward.localPort}`}
          description={`${labels.get(forward.environmentId) ?? forward.environmentId} · ${forward.remoteHost}:${forward.remotePort}`}
          status={
            forward.lastError === null ? (
              `${forward.activeConnections} active connection${forward.activeConnections === 1 ? "" : "s"}`
            ) : (
              <span className="text-destructive">{forward.lastError}</span>
            )
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={stoppingId === forward.id}
              onClick={() => void stop(forward.id)}
            >
              Stop
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
