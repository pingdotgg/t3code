import type { EnvironmentId } from "@t3tools/contracts";
import { CableIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { portForwardConnectionSummary } from "./desktopPortForwardPresentation";
import { parseDesktopPortForwardPort, useDesktopPortForwards } from "./useDesktopPortForwards";

interface EnvironmentSelection {
  readonly contextEnvironmentId: EnvironmentId;
  readonly environmentId: EnvironmentId;
}

export function resolvePortForwardEnvironmentId(input: {
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly preferredEnvironmentId: EnvironmentId;
  readonly selection: EnvironmentSelection;
}): EnvironmentId | null {
  const { connectedEnvironmentIds, preferredEnvironmentId, selection } = input;
  if (
    selection.contextEnvironmentId === preferredEnvironmentId &&
    connectedEnvironmentIds.includes(selection.environmentId)
  ) {
    return selection.environmentId;
  }
  if (connectedEnvironmentIds.includes(preferredEnvironmentId)) {
    return preferredEnvironmentId;
  }
  return connectedEnvironmentIds[0] ?? null;
}

export function DesktopPortForwardControl({
  preferredEnvironmentId,
}: {
  preferredEnvironmentId: EnvironmentId;
}) {
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
  const [environmentSelection, setEnvironmentSelection] = useState<EnvironmentSelection>(() => ({
    contextEnvironmentId: preferredEnvironmentId,
    environmentId: preferredEnvironmentId,
  }));
  const [remotePort, setRemotePort] = useState("3000");
  const [localPort, setLocalPort] = useState("");

  const selectedEnvironmentId = resolvePortForwardEnvironmentId({
    connectedEnvironmentIds: forwardableEnvironments.map(
      (environment) => environment.environmentId,
    ),
    preferredEnvironmentId,
    selection: environmentSelection,
  });

  if (!available) return null;

  const parsedRemotePort = parseDesktopPortForwardPort(remotePort);
  const parsedLocalPort =
    localPort.trim() === "" ? undefined : parseDesktopPortForwardPort(localPort);
  const canCreate =
    selectedEnvironmentId !== null &&
    parsedRemotePort !== null &&
    parsedLocalPort !== null &&
    !creating;

  const create = async () => {
    if (!canCreate || selectedEnvironmentId === null || parsedRemotePort === null) return;
    const created = await createForward({
      environmentId: selectedEnvironmentId,
      remoteHost: "127.0.0.1",
      remotePort: parsedRemotePort,
      ...(parsedLocalPort === undefined ? {} : { localPort: parsedLocalPort }),
    });
    if (created) {
      setLocalPort("");
    }
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label={
                    forwards.length > 0
                      ? `Port forwarding, ${forwards.length} active`
                      : "Port forwarding"
                  }
                  className="relative shrink-0 [--control-icon-color:var(--foreground)]"
                  data-toolbar-control=""
                  size="icon-xs"
                  variant="outline"
                />
              }
            >
              <CableIcon aria-hidden className="size-3.5" />
              {forwards.length > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
                >
                  {forwards.length}
                </span>
              ) : null}
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="bottom">Port forwarding</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" className="w-88" sideOffset={8} viewportClassName="space-y-4">
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">Port forwarding</p>
          <p className="text-xs text-muted-foreground">
            Forward remote loopback ports to this computer.
          </p>
        </div>
        {connectedEnvironments.length === 0 ? (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Connect an environment before starting a port forward.
          </p>
        ) : forwardableEnvironments.length === 0 ? (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Update the connected T3 server before starting a port forward.
          </p>
        ) : null}
        <div className="space-y-3">
          <label className="text-xs text-muted-foreground">
            <span className="mb-1.5 block">Environment</span>
            <Select
              value={selectedEnvironmentId ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string" && value !== "") {
                  setEnvironmentSelection({
                    contextEnvironmentId: preferredEnvironmentId,
                    environmentId: value as EnvironmentId,
                  });
                }
              }}
            >
              <SelectTrigger className="w-full" aria-label="Forward environment">
                <SelectValue>
                  {selectedEnvironmentId === null
                    ? "Select an environment"
                    : (environmentLabels.get(selectedEnvironmentId) ?? selectedEnvironmentId)}
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
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-muted-foreground">
              <span className="mb-1.5 block">Remote port</span>
              <Input
                aria-label="Remote port"
                aria-invalid={parsedRemotePort === null}
                type="number"
                min={1}
                max={65_535}
                step={1}
                inputMode="numeric"
                value={remotePort}
                onChange={(event) => setRemotePort(event.target.value)}
              />
              {parsedRemotePort === null ? (
                <span className="mt-1 block text-[11px] text-destructive">
                  Enter a port from 1 to 65535.
                </span>
              ) : null}
            </label>
            <label className="text-xs text-muted-foreground">
              <span className="mb-1.5 block">Local port</span>
              <Input
                aria-label="Local port"
                aria-invalid={localPort.trim() !== "" && parsedLocalPort === null}
                type="number"
                min={1}
                max={65_535}
                step={1}
                inputMode="numeric"
                placeholder="Same as remote"
                value={localPort}
                onChange={(event) => setLocalPort(event.target.value)}
              />
              {localPort.trim() !== "" && parsedLocalPort === null ? (
                <span className="mt-1 block text-[11px] text-destructive">
                  Enter a port from 1 to 65535.
                </span>
              ) : null}
            </label>
          </div>
          <Button className="w-full" size="sm" disabled={!canCreate} onClick={() => void create()}>
            {creating ? "Starting…" : "Start forward"}
          </Button>
        </div>
        {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
        {forwards.length > 0 ? (
          <div className="space-y-1 border-t border-border/60 pt-3">
            {forwards.map((forward) => (
              <div
                key={forward.id}
                className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-2 py-1.5"
              >
                <div className="min-w-0 text-xs">
                  <p className="truncate font-medium tabular-nums">
                    {forward.localHost}:{forward.localPort}
                  </p>
                  <p className="truncate text-muted-foreground tabular-nums">
                    {environmentLabels.get(forward.environmentId) ?? "Unknown environment"} ·{" "}
                    <span aria-hidden="true">→</span> {forward.remoteHost}:{forward.remotePort} ·{" "}
                    {portForwardConnectionSummary(forward)}
                  </p>
                  {forward.lastError === null ? null : (
                    <p className="truncate text-destructive">{forward.lastError}</p>
                  )}
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={stoppingId === forward.id}
                  onClick={() => void stop(forward.id)}
                >
                  Stop
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
