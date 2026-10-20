import { DeviceHostUpdates } from "./DeviceHostUpdates";
import type {
  DevicePlatform,
  DeviceServiceState,
  DeviceSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowUpRight, CircleAlert, Play, Smartphone, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { Button } from "~/components/ui/button";
import { DiscoveryList } from "~/components/ui/discovery-list";
import { Dialog } from "~/components/ui/dialog";
import { WizardPopup } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { DeviceSetup, deviceHubReadiness, isAndroidDiscoveryUncertain } from "./DeviceSetup";
import { DeviceWorkspace } from "./DeviceWorkspace";
import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";

const platformLabel = (platform: DevicePlatform) =>
  platform === "ios" ? "iOS Simulators" : "Android Emulators";

const deviceKey = (device: Pick<DeviceSummary, "hostId" | "id">) =>
  `${device.hostId}\u0000${device.id}`;

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
  // The panel stays mounted across thread switches, so an in-flight open or
  // power-off is tagged with the thread it belongs to and only shown there.
  const scope = `${environmentId}\u0000${threadId}`;
  const [operation, setOperation] = useState<{
    readonly scope: string;
    readonly pending: DeviceSummary | null;
    readonly error: string | null;
  } | null>(null);
  const pendingDevice = operation?.scope === scope ? operation.pending : null;
  const operationError = operation?.scope === scope ? operation.error : null;
  const pendingDeviceKey = pendingDevice ? deviceKey(pendingDevice) : null;

  const hostDisabled = state.hostStatus === "disabled";

  // Opening setup never grants permission to install or start helpers.
  useEffect(() => {
    if (!props.visible || !loaded || hostDisabled) return;
    void list({ environmentId, input: {} });
  }, [environmentId, list, loaded, props.visible, hostDisabled]);

  const sessions = state.sessions.filter((session) => session.threadId === threadId);
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

  const grouped = groupDevices(state);

  const startOperation = (pending: DeviceSummary | null) => {
    const started = { scope, pending, error: null };
    setOperation(started);
    // Returning to the same thread can start a newer operation before this one settles.
    return (error: string | null) =>
      setOperation((current) =>
        current === started ? { ...started, pending: null, error } : current,
      );
  };

  const selectDevice = async (value: string) => {
    const device = state.devices.find((candidate) => deviceKey(candidate) === value);
    if (!device) return;
    const settleOperation = startOperation(device);
    const result = await open({
      environmentId,
      input: {
        threadId,
        hostId: device.hostId,
        deviceId: device.id,
        platform: device.platform,
      },
    });
    if (result._tag === "Failure") settleOperation(formatEnvironmentQueryError(result.cause));
    else {
      // The server opened the device for the starting thread, so its tab opens there.
      useRightPanelStore.getState().openDevice(props.threadRef, {
        hostId: result.value.hostId,
        deviceId: result.value.deviceId,
        platform: device.platform,
        name: device.name,
      });
      settleOperation(null);
    }
  };

  const floatActive = () => {
    if (!activeDevice) return;
    usePreviewMiniPlayerStore.getState().open(props.threadRef, {
      kind: "device",
      hostId: activeDevice.hostId,
      deviceId: activeDevice.id,
      platform: activeDevice.platform,
      name: activeDevice.name,
    });
    useRightPanelStore.getState().close(props.threadRef);
  };

  const closeActive = (powerOff: boolean) => {
    if (!powerOff) {
      useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
      return;
    }
    if (!activeSession) return;
    const settleOperation = startOperation(null);
    void close({
      environmentId,
      input: {
        threadId,
        hostId: activeSession.hostId,
        deviceId: activeSession.deviceId,
        shutdown: powerOff,
      },
    }).then((result) => {
      if (result._tag === "Failure") settleOperation(formatEnvironmentQueryError(result.cause));
      else useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
    });
  };

  const bootingDevices =
    state.bootingDevices?.filter((device) => device.threadId === threadId) ?? [];
  const { ready: hostReady, busy: hostBusy } = deviceHubReadiness(state);
  const loading = !activeDevice && (pendingDevice !== null || hostBusy || !loaded);
  const diagnostics = state.hosts.flatMap((host) => {
    const status = state.hostStatuses[host.id];
    const detail = status?.detail ?? (host.kind === "local" ? state.hostStatusDetail : undefined);
    return detail && (status?.status ?? state.hostStatus) === "ready"
      ? [{ hostId: host.id, label: host.label, detail }]
      : [];
  });
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
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "shrink-0 bg-background",
            loading && "absolute inset-x-0 top-0 z-10 max-h-[40%] overflow-y-auto",
          )}
        >
          <div hidden={!!activeDevice}>
            {diagnostics.map((diagnostic) => (
              <DeviceDiscoveryWarning
                key={`${environmentId}\u0000${diagnostic.hostId}\u0000${diagnostic.detail}`}
                label={diagnostic.label}
                detail={diagnostic.detail}
              />
            ))}
          </div>
          <DeviceHostUpdates state={state} environmentId={environmentId} />
          {bootingDevices.length > 0 ? (
            <div role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
              Starting {bootingDevices.map((device) => device.name).join(", ")}… This can take a
              minute.
            </div>
          ) : null}
          {operationError ? (
            <DeviceNotice tone="error" onDismiss={() => setOperation(null)}>
              {operationError}
            </DeviceNotice>
          ) : null}
        </div>
        <div className="@container relative flex min-h-0 flex-1">
          {activeDevice && activeSession ? (
            <DeviceWorkspace
              key={`${environmentId}\u0000${deviceKey(activeDevice)}`}
              environmentId={environmentId}
              device={activeDevice}
              hostLabel={
                state.hosts.find((host) => host.id === activeDevice.hostId)?.label ?? "Device host"
              }
              hostDiagnostics={
                diagnostics.find(({ hostId }) => hostId === activeDevice.hostId)?.detail
              }
              visible={props.visible}
              onFloat={floatActive}
              onClose={() => closeActive(false)}
              onPowerOff={() => closeActive(true)}
            />
          ) : loading ? (
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
                    ? (state.hostStatusDetail ?? "Installing device support…")
                    : "Finding devices…"
              }
            />
          ) : (
            <div className="scrollbar-gutter-both flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
              <div
                className={cn(
                  "mx-auto flex w-full max-w-xl flex-col gap-6",
                  grouped.length === 0 && "my-auto items-center text-center",
                )}
              >
                {grouped.length === 0 ? (
                  <>
                    <Smartphone className="size-6 opacity-60" />
                    <p
                      className="max-h-32 w-full max-w-sm overflow-y-auto whitespace-pre-line break-words"
                      tabIndex={state.hostStatus === "failed" ? 0 : undefined}
                    >
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
                            <div
                              key={deviceKey(device)}
                              className="flex items-center gap-3 px-3 py-3"
                            >
                              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                                <Smartphone className="size-4" />
                              </span>
                              <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {device.name}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                  {`${state.hosts.find((host) => host.id === device.hostId)?.label} · ${device.version} · ${device.booted ? "Running" : "Stopped"}`}
                                </span>
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pendingDeviceKey !== null}
                                aria-label={`${device.booted ? "Open" : "Start"} ${device.name}`}
                                onClick={() => void selectDevice(deviceKey(device))}
                              >
                                {pendingDeviceKey === deviceKey(device) ? (
                                  <Spinner size="xs" />
                                ) : device.booted ? (
                                  <ArrowUpRight />
                                ) : (
                                  <Play />
                                )}
                                {device.booted ? "Open" : "Start"}
                              </Button>
                            </div>
                          ))}
                        </DiscoveryList>
                      </section>
                    ))}
                  </div>
                ) : null}
                {hostReady &&
                !isAndroidDiscoveryUncertain(state) &&
                !state.devices.some((device) => device.platform === "android") &&
                !unavailablePlatforms.some((platform) => platform.platform === "android") ? (
                  <p className="max-w-sm text-xs">
                    No Android virtual devices found. Create one in Android Studio's Device Manager,
                    then refresh.
                  </p>
                ) : null}
                {loaded && !hostBusy ? (
                  <Button
                    className={grouped.length > 0 ? "self-start" : "self-center"}
                    variant="outline"
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
      </div>
    </PreviewPanelShell>
  );
}

function DeviceNotice(props: {
  readonly tone: "warning" | "error";
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 border-b px-3 py-2 text-xs",
        props.tone === "warning"
          ? "bg-warning-surface text-warning-foreground"
          : "bg-destructive/5 text-destructive",
      )}
    >
      <CircleAlert className="mt-1 size-3.5 shrink-0" />
      <div
        className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words"
        tabIndex={0}
      >
        {props.children}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={props.tone === "warning" ? "Dismiss device warning" : "Dismiss device error"}
        onClick={props.onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}

function DeviceDiscoveryWarning(props: { readonly label: string; readonly detail: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <DeviceNotice tone="warning" onDismiss={() => setDismissed(true)}>
      <p className="font-medium">Device discovery warning · {props.label}</p>
      {props.detail}
    </DeviceNotice>
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
