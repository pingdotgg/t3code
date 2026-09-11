import type {
  DevicePlatform,
  DeviceServiceState,
  DeviceSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ChevronLeft,
  Home,
  Power,
  RotateCcw,
  SlidersHorizontal,
  Smartphone,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { Button } from "~/components/ui/button";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import { Dialog } from "~/components/ui/dialog";
import { WizardPopup } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { deviceEnvironment, useDeviceHubAccess, useDeviceState } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { DeviceStreamView, type DeviceStreamHandle } from "./DeviceStreamView";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { DeviceSetup } from "./DeviceSetup";
import { DeviceToolsPanel } from "./DeviceToolsPanel";
import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";

const platformLabel = (platform: DevicePlatform) =>
  platform === "ios" ? "iOS Simulators" : "Android Emulators";

const deviceKey = (device: Pick<DeviceSummary, "hostId" | "id">) =>
  `${device.hostId}\u0000${device.id}`;

/** Each surface owns one host/device; only the visible surface streams. */
export function DevicePanel(props: {
  readonly mode: PreviewPanelMode;
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "device" }>;
  readonly visible: boolean;
  readonly onDismissSetup: () => void;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { state, loaded } = useDeviceState(environmentId);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const open = useAtomCommand(deviceEnvironment.open);
  const close = useAtomCommand(deviceEnvironment.close);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pendingDevice, setPendingDevice] = useState<DeviceSummary | null>(null);
  const pendingDeviceKey = pendingDevice ? deviceKey(pendingDevice) : null;
  const [handle, setHandle] = useState<DeviceStreamHandle | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [axOverlay, setAxOverlay] = useState(false);
  const access = useDeviceHubAccess(environmentId);

  const hostDisabled = state.hostStatus === "disabled";

  // Opening setup never grants permission to install or start helpers.
  useEffect(() => {
    if (!props.visible || !loaded || hostDisabled) return;
    void list({ environmentId, input: {} });
  }, [environmentId, list, loaded, props.visible, hostDisabled]);

  const sessions = useMemo(
    () => state.sessions.filter((session) => session.threadId === threadId),
    [state.sessions, threadId],
  );
  const activeSession = props.surface.target
    ? sessions.find(
        (session) =>
          session.deviceId === props.surface.target?.deviceId &&
          session.hostId === props.surface.target.hostId,
      )
    : undefined;
  const activeDevice = activeSession
    ? state.devices.find(
        (device) => device.hostId === activeSession.hostId && device.id === activeSession.deviceId,
      )
    : undefined;

  const grouped = useMemo(() => groupDevices(state), [state]);

  const selectDevice = async (value: string) => {
    const device = state.devices.find((candidate) => deviceKey(candidate) === value);
    if (!device) return;
    setOperationError(null);
    setPendingDevice(device);
    try {
      const result = await open({
        environmentId,
        input: {
          threadId,
          hostId: device.hostId,
          deviceId: device.id,
          platform: device.platform,
        },
      });
      if (result._tag === "Failure") setOperationError(formatEnvironmentQueryError(result.cause));
      else
        useRightPanelStore.getState().openDevice(props.threadRef, {
          hostId: result.value.hostId,
          deviceId: result.value.deviceId,
          platform: device.platform,
          name: device.name,
        });
    } finally {
      setPendingDevice(null);
    }
  };

  const closeActive = (powerOff: boolean) => {
    if (!powerOff) {
      useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
      return;
    }
    if (!activeSession) return;
    setOperationError(null);
    void close({
      environmentId,
      input: {
        threadId,
        hostId: activeSession.hostId,
        deviceId: activeSession.deviceId,
        shutdown: powerOff,
      },
    }).then((result) => {
      if (result._tag === "Failure") setOperationError(formatEnvironmentQueryError(result.cause));
      else useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
    });
  };

  const bootingDevices =
    state.bootingDevices?.filter((device) => device.threadId === threadId) ?? [];
  const hostReady = Object.values(state.hostStatuses).some((host) => host.status === "ready");
  const hostBusy =
    !hostReady &&
    Object.values(state.hostStatuses).some(
      (host) => host.status === "installing" || host.status === "starting",
    );
  const unavailablePlatforms = state.hosts.flatMap((host) =>
    host.platforms
      .filter((platform) => !platform.available)
      .map((platform) => ({ ...platform, hostId: host.id, hostLabel: host.label })),
  );

  if (loaded && (!state.onboardingCompleted || hostDisabled)) {
    return (
      <Dialog
        open={props.visible}
        onOpenChange={(isOpen) => {
          if (!isOpen) props.onDismissSetup();
        }}
      >
        <WizardPopup>
          <DeviceSetup environmentId={environmentId} state={state} />
        </WizardPopup>
      </Dialog>
    );
  }

  return (
    <PreviewPanelShell mode={props.mode}>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {props.surface.target
            ? `${state.hosts.find((host) => host.id === props.surface.target?.hostId)?.label ?? "Device host"} · ${activeDevice?.version ?? props.surface.target.platform}`
            : (pendingDevice?.name ?? "Choose a device")}
        </span>
        {activeDevice ? (
          <>
            <DeviceButton
              label="Home"
              onClick={() => handle?.pressButton("home")}
              disabled={!handle?.inputConnected}
            >
              <Home />
            </DeviceButton>
            {activeDevice.platform === "android" ? (
              <>
                <DeviceButton
                  label="Back"
                  onClick={() => handle?.pressButton("back")}
                  disabled={!handle?.inputConnected}
                >
                  <ChevronLeft />
                </DeviceButton>
                <DeviceButton
                  label="Recents"
                  onClick={() => handle?.pressButton("recents")}
                  disabled={!handle?.inputConnected}
                >
                  <Square />
                </DeviceButton>
              </>
            ) : (
              <DeviceButton
                label="Rotate"
                onClick={() => handle?.rotate()}
                disabled={!handle?.inputConnected}
              >
                <RotateCcw />
              </DeviceButton>
            )}
            <Toggle
              aria-label="Tools"
              variant="ghost"
              size="xs"
              pressed={toolsOpen}
              onPressedChange={(pressed) => setToolsOpen(Boolean(pressed))}
            >
              <SlidersHorizontal />
            </Toggle>
            <DeviceButton label="Power off" onClick={() => closeActive(true)}>
              <Power />
            </DeviceButton>
            <DeviceButton label="Close" onClick={() => closeActive(false)}>
              <X />
            </DeviceButton>
          </>
        ) : null}
      </div>
      {hostReady && state.hostStatusDetail ? (
        <div
          role="status"
          className="whitespace-pre-line border-b px-3 py-2 text-xs text-muted-foreground"
        >
          {state.hostStatusDetail}
        </div>
      ) : null}
      {bootingDevices.length > 0 ? (
        <div role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
          Starting {bootingDevices.map((device) => device.name).join(", ")}… This can take a minute.
        </div>
      ) : null}
      {operationError ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{operationError}</p>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss device error"
            onClick={() => setOperationError(null)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
      <div className="@container relative flex min-h-0 flex-1">
        {activeDevice && activeSession ? (
          <>
            <div className="relative min-h-0 min-w-0 flex-1">
              <DeviceStreamView
                key={deviceKey(activeDevice)}
                environmentId={environmentId}
                platform={activeDevice.platform}
                deviceName={activeDevice.name}
                deviceDescription={`${state.hosts.find((host) => host.id === activeDevice.hostId)?.label ?? "Device host"} · ${activeDevice.version}`}
                deviceId={activeDevice.id}
                hostId={activeDevice.hostId}
                visible={props.visible}
                axOverlay={axOverlay}
                onHandle={setHandle}
              />
            </div>
            {toolsOpen ? (
              <DeviceToolsPanel
                key={deviceKey(activeDevice)}
                environmentId={environmentId}
                device={activeDevice}
                access={access}
                axOverlay={axOverlay}
                onAxOverlayChange={setAxOverlay}
                onClose={() => setToolsOpen(false)}
                className="absolute inset-y-0 right-0 z-10 w-full max-w-72 border-l shadow-lg @[560px]:static @[560px]:w-72 @[560px]:shrink-0 @[560px]:shadow-none"
              />
            ) : null}
          </>
        ) : pendingDevice || hostBusy || !loaded ? (
          <DeviceLoadingView
            name={pendingDevice?.name ?? "Devices"}
            description={
              pendingDevice
                ? `${state.hosts.find((host) => host.id === pendingDevice.hostId)?.label ?? "Device host"} · ${pendingDevice.version}`
                : ""
            }
            stage="opening"
            message={
              pendingDevice
                ? pendingDevice.booted
                  ? "Opening device…"
                  : "Starting device…"
                : state.hostStatus === "installing"
                  ? "Installing device support…"
                  : "Finding devices…"
            }
          />
        ) : (
          <div className="flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
            <div
              className={cn(
                "mx-auto flex w-full max-w-xl flex-col gap-6",
                grouped.length === 0 && "my-auto items-center text-center",
              )}
            >
              {grouped.length === 0 ? (
                <>
                  <Smartphone className="size-6 opacity-60" />
                  <p className="max-w-sm">
                    {state.hostStatus === "failed"
                      ? (state.hostStatusDetail ?? "The device hub failed to start.")
                      : "No simulators or emulators were found on this environment."}
                  </p>
                </>
              ) : null}
              {hostReady && grouped.length > 0 ? (
                <div className="w-full space-y-6 text-left">
                  {grouped.map((group) => (
                    <section key={group.platform} className="space-y-3">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Smartphone className="size-4 shrink-0" />
                        <h3 className="font-medium">{platformLabel(group.platform)}</h3>
                      </div>
                      <DiscoveryList>
                        {group.devices.map((device) => (
                          <DiscoveryListRow
                            key={deviceKey(device)}
                            icon={
                              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                                <Smartphone className="size-4" />
                              </span>
                            }
                            title={device.name}
                            description={`${state.hosts.find((host) => host.id === device.hostId)?.label} · ${device.version} · ${device.booted ? "Running" : "Stopped"}`}
                            disabled={pendingDeviceKey !== null}
                            aria-label={`${device.booted ? "Open" : "Start"} ${device.name}`}
                            onClick={() => void selectDevice(deviceKey(device))}
                            action={
                              pendingDeviceKey === deviceKey(device) ? (
                                <Spinner className="size-3" />
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {device.booted ? "Open" : "Start"}
                                </span>
                              )
                            }
                          />
                        ))}
                      </DiscoveryList>
                    </section>
                  ))}
                </div>
              ) : null}
              {hostReady &&
              !state.devices.some((device) => device.platform === "android") &&
              !unavailablePlatforms.some((platform) => platform.platform === "android") ? (
                <p className="max-w-sm text-xs">
                  No Android virtual devices found. Create one in Android Studio's Device Manager,
                  then refresh.
                </p>
              ) : null}
              {loaded && !hostBusy ? (
                <Button
                  className="self-start"
                  variant={grouped.length > 0 ? "ghost" : "outline"}
                  size="sm"
                  onClick={() => void list({ environmentId, input: {} })}
                >
                  Refresh devices
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </PreviewPanelShell>
  );
}

function DeviceButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.label}
            onClick={props.onClick}
            disabled={props.disabled ?? false}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function groupDevices(state: DeviceServiceState) {
  const groups: Array<{ platform: DevicePlatform; devices: DeviceSummary[] }> = [];
  for (const platform of ["ios", "android"] as const) {
    const devices = state.devices
      .filter((device) => device.platform === platform)
      .toSorted((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    if (devices.length > 0) groups.push({ platform, devices });
  }
  return groups;
}
