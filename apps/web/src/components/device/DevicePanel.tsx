import type {
  DevicePlatform,
  DeviceServiceState,
  DeviceSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ChevronLeft,
  Circle,
  Home,
  Power,
  RotateCcw,
  SlidersHorizontal,
  Smartphone,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import { Dialog } from "~/components/ui/dialog";
import { WizardPopup } from "~/components/ui/wizard";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { deviceEnvironment, useDeviceHubAccess, useDeviceState } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { DeviceStreamView, type DeviceStreamHandle } from "./DeviceStreamView";
import { DeviceSetup } from "./DeviceSetup";
import { DeviceToolsPanel } from "./DeviceToolsPanel";
import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";

const NEW_DEVICE_VALUE = "__new__";

const platformLabel = (platform: DevicePlatform) =>
  platform === "ios" ? "iOS Simulators" : "Android Emulators";

const deviceKey = (device: Pick<DeviceSummary, "hostId" | "id">) =>
  `${device.hostId}\u0000${device.id}`;

/**
 * The Device right-panel surface: one open device (from the thread's device
 * sessions) with a picker to switch or boot another. Booting and streaming are
 * server-owned; this panel only asks and renders.
 */
export function DevicePanel(props: {
  readonly mode: PreviewPanelMode;
  readonly threadRef: ScopedThreadRef;
  /** `null` renders the picker with nothing open. */
  readonly deviceId: string | null;
  readonly visible: boolean;
  readonly onDismissSetup: () => void;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { state, loaded } = useDeviceState(environmentId);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const open = useAtomCommand(deviceEnvironment.open);
  const close = useAtomCommand(deviceEnvironment.close);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pendingDeviceKey, setPendingDeviceKey] = useState<string | null>(null);
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
  const activeSession =
    (props.deviceId
      ? sessions.find((session) => session.deviceId === props.deviceId)
      : undefined) ?? sessions.at(-1);
  const activeDevice = activeSession
    ? state.devices.find(
        (device) => device.hostId === activeSession.hostId && device.id === activeSession.deviceId,
      )
    : undefined;

  const grouped = useMemo(() => groupDevices(state), [state]);

  const selectDevice = useCallback(
    async (value: string) => {
      if (value === NEW_DEVICE_VALUE) return;
      const device = state.devices.find((candidate) => deviceKey(candidate) === value);
      if (!device) return;
      setOperationError(null);
      setPendingDeviceKey(value);
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
      } finally {
        setPendingDeviceKey(null);
      }
    },
    [environmentId, open, state.devices, threadId],
  );

  const closeActive = useCallback(
    (powerOff: boolean) => {
      if (!activeSession) return;
      setOperationError(null);
      void close({
        environmentId,
        input: { threadId, deviceId: activeSession.deviceId, shutdown: powerOff },
      }).then((result) => {
        if (result._tag === "Failure") setOperationError(formatEnvironmentQueryError(result.cause));
      });
    },
    [activeSession, close, environmentId, threadId],
  );

  const bootingDevices =
    state.bootingDevices?.filter((device) => device.threadId === threadId) ?? [];
  const hostReady = state.hostStatus === "ready";
  const hostBusy = state.hostStatus === "installing" || state.hostStatus === "starting";
  const unavailablePlatforms = state.hosts.flatMap((host) =>
    host.platforms.filter((platform) => !platform.available),
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
        <Select
          value={activeDevice ? deviceKey(activeDevice) : NEW_DEVICE_VALUE}
          onValueChange={(value) => {
            if (value !== null) void selectDevice(value);
          }}
          disabled={!loaded || hostBusy || hostDisabled || pendingDeviceKey !== null}
        >
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Device">
            <SelectValue>
              {activeDevice ? (
                <span className="flex items-center gap-1.5 truncate">
                  <Smartphone className="size-3.5 shrink-0" />
                  <span className="truncate">{activeDevice.name}</span>
                  <span className="shrink-0 text-muted-foreground">{activeDevice.version}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {hostBusy
                    ? state.hostStatus === "installing"
                      ? "Installing device tools…"
                      : "Starting device hub…"
                    : "Choose a device"}
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false} className="min-w-72">
            {grouped.map((group) => (
              <SelectGroup key={group.platform}>
                <SelectGroupLabel>{platformLabel(group.platform)}</SelectGroupLabel>
                {group.devices.map((device) => (
                  <SelectItem key={deviceKey(device)} value={deviceKey(device)}>
                    <span className="flex w-full items-center gap-2">
                      <Circle
                        className={cn(
                          "size-2 shrink-0",
                          device.booted ? "fill-success text-success" : "text-muted-foreground/50",
                        )}
                      />
                      <span className="truncate">
                        {device.booted ? device.name : `Start ${device.name}`}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {device.version}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
            {grouped.length === 0 ? (
              <SelectItem value={NEW_DEVICE_VALUE} disabled>
                {loaded ? "No devices found" : "Loading…"}
              </SelectItem>
            ) : null}
          </SelectPopup>
        </Select>
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
        ) : (
          <div className="flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
            <div
              className={cn(
                "mx-auto flex w-full max-w-xl flex-col gap-6",
                grouped.length === 0 && "my-auto items-center text-center",
              )}
            >
              {grouped.length === 0 || hostBusy || pendingDeviceKey ? (
                <>
                  {hostBusy || pendingDeviceKey ? (
                    <Spinner />
                  ) : (
                    <Smartphone className="size-6 opacity-60" />
                  )}
                  <p className="max-w-sm">
                    {state.hostStatus === "failed"
                      ? (state.hostStatusDetail ?? "The device hub failed to start.")
                      : pendingDeviceKey
                        ? "Booting device… this can take a minute."
                        : hostBusy
                          ? state.hostStatus === "installing"
                            ? "Installing device tools…"
                            : "Starting the device hub…"
                          : !loaded
                            ? "Connecting…"
                            : grouped.length === 0
                              ? "No simulators or emulators were found on this environment."
                              : "Choose a device to open."}
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
                            description={`${device.version} · ${device.booted ? "Running" : "Stopped"}`}
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
              {unavailablePlatforms.length > 0 && hostReady ? (
                <ul className="max-w-sm space-y-1 text-xs opacity-70">
                  {unavailablePlatforms.map((platform) => (
                    <li key={platform.platform}>
                      {platform.platform === "ios" ? "iOS" : "Android"}: {platform.reason}
                    </li>
                  ))}
                </ul>
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
