import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { portForwardConnectionSummary } from "../desktop/desktopPortForwardPresentation";
import {
  parseDesktopPortForwardPort,
  useDesktopPortForwards,
} from "../desktop/useDesktopPortForwards";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DesktopPortForwardsSettings() {
  const {
    available,
    connectedEnvironments,
    create: createForward,
    creating,
    environmentLabels,
    error,
    forwardableEnvironments,
    forwards,
    stop,
    stoppingId,
  } = useDesktopPortForwards();
  const primaryEnvironment = usePrimaryEnvironment();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [remotePort, setRemotePort] = useState("3000");
  const [localPort, setLocalPort] = useState("");

  useEffect(() => {
    if (
      environmentId !== null &&
      forwardableEnvironments.some((environment) => environment.environmentId === environmentId)
    ) {
      return;
    }
    const primaryConnected = forwardableEnvironments.some(
      (environment) => environment.environmentId === primaryEnvironment?.environmentId,
    );
    const fallback = primaryConnected
      ? (primaryEnvironment?.environmentId ?? null)
      : (forwardableEnvironments[0]?.environmentId ?? null);
    setEnvironmentId(fallback);
  }, [environmentId, forwardableEnvironments, primaryEnvironment?.environmentId]);

  if (!available) return null;

  const parsedRemotePort = parseDesktopPortForwardPort(remotePort);
  const parsedLocalPort =
    localPort.trim() === "" ? undefined : parseDesktopPortForwardPort(localPort);
  const canCreate =
    environmentId !== null && parsedRemotePort !== null && parsedLocalPort !== null && !creating;

  const create = async () => {
    if (!canCreate || environmentId === null || parsedRemotePort === null) return;
    const created = await createForward({
      environmentId,
      remoteHost: "127.0.0.1",
      remotePort: parsedRemotePort,
      ...(parsedLocalPort === undefined ? {} : { localPort: parsedLocalPort }),
    });
    if (created) {
      setLocalPort("");
    }
  };

  return (
    <SettingsSection title="Port forwarding">
      <SettingsRow
        title="New TCP forward"
        description="Expose a remote loopback port on this computer. Leaving the local port blank tries the same port first, then nearby free ports. Forwards last until you stop them or quit T3 Code."
        status={error === null ? null : <span className="text-destructive">{error}</span>}
      >
        <div className="space-y-1 pb-2">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-end">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Environment</span>
              <Select
                value={environmentId ?? ""}
                onValueChange={(value) => {
                  if (typeof value === "string" && value !== "") {
                    setEnvironmentId(value as EnvironmentId);
                  }
                }}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label="Forward environment"
                  aria-describedby={
                    connectedEnvironments.length === 0 || forwardableEnvironments.length === 0
                      ? "desktop-port-forward-environment-hint"
                      : undefined
                  }
                >
                  <SelectValue>
                    {environmentId === null
                      ? "Select"
                      : (environmentLabels.get(environmentId) ?? environmentId)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {forwardableEnvironments.map((environment) => (
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
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Remote port</span>
              <Input
                type="number"
                min={1}
                max={65_535}
                step={1}
                inputMode="numeric"
                value={remotePort}
                onChange={(event) => setRemotePort(event.target.value)}
                aria-label="Remote port"
                aria-invalid={parsedRemotePort === null}
                aria-describedby={
                  parsedRemotePort === null ? "desktop-port-forward-remote-port-error" : undefined
                }
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Local port</span>
              <Input
                type="number"
                min={1}
                max={65_535}
                step={1}
                inputMode="numeric"
                value={localPort}
                placeholder="Same as remote"
                onChange={(event) => setLocalPort(event.target.value)}
                aria-label="Local port"
                aria-invalid={localPort.trim() !== "" && parsedLocalPort === null}
                aria-describedby={
                  localPort.trim() !== "" && parsedLocalPort === null
                    ? "desktop-port-forward-local-port-error"
                    : undefined
                }
              />
            </label>
            <Button size="sm" disabled={!canCreate} onClick={() => void create()}>
              {creating ? "Starting…" : "Start"}
            </Button>
          </div>
          {connectedEnvironments.length === 0 ? (
            <p
              id="desktop-port-forward-environment-hint"
              className="text-[11px] text-muted-foreground"
            >
              Connect an environment to start forwarding ports.
            </p>
          ) : forwardableEnvironments.length === 0 ? (
            <p
              id="desktop-port-forward-environment-hint"
              className="text-[11px] text-muted-foreground"
            >
              Update the connected T3 server to enable port forwarding.
            </p>
          ) : null}
          {parsedRemotePort === null ? (
            <p id="desktop-port-forward-remote-port-error" className="text-[11px] text-destructive">
              Remote port: enter a value from 1 to 65535.
            </p>
          ) : null}
          {localPort.trim() !== "" && parsedLocalPort === null ? (
            <p id="desktop-port-forward-local-port-error" className="text-[11px] text-destructive">
              Local port: enter a value from 1 to 65535.
            </p>
          ) : null}
        </div>
      </SettingsRow>
      {forwards.map((forward) => (
        <SettingsRow
          key={forward.id}
          title={`${forward.localHost}:${forward.localPort}`}
          description={`${environmentLabels.get(forward.environmentId) ?? forward.environmentId} · ${forward.remoteHost}:${forward.remotePort}`}
          status={
            <span className="flex flex-col items-end gap-0.5">
              <span>{portForwardConnectionSummary(forward)}</span>
              {forward.lastError === null ? null : (
                <span className="max-w-96 text-right text-destructive">{forward.lastError}</span>
              )}
            </span>
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
