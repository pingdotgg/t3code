import { DeviceHostUpdates } from "./DeviceHostUpdates";
import type {
  DeviceHostSummary,
  DevicePlatform,
  DeviceServiceState,
  DeviceSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomMount } from "@effect/atom-react";
import { Schema } from "effect";
import {
  ArrowUpRight,
  CloudIcon,
  Info,
  Monitor,
  Play,
  Power,
  RotateCw,
  Server,
  Smartphone,
  Tablet,
  TriangleAlert,
  X,
} from "lucide-react";
import { useState } from "react";

import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DiscoveryList } from "~/components/ui/discovery-list";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Dialog } from "~/components/ui/dialog";
import { WizardPopup } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { focusPanelTerminalAfterClose } from "~/lib/terminalFocus";
import {
  deviceEnvironment,
  deviceHostProbeAtom,
  NO_DEVICE_PROBE_ATOM,
  useDeviceState,
} from "~/state/device";
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

const FLOAT_OVER_CHAT_STORAGE_KEY = "t3code:devices:float-over-chat";
const DISMISSED_AVAILABILITY_STORAGE_KEY = "t3code:devices:dismissed-availability";

export function DevicePanel(props: {
  readonly mode: PreviewPanelMode;
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "device" }>;
  readonly visible: boolean;
  readonly onDismissSetup: () => void;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { state, loaded, error: stateError, refresh: refreshState } = useDeviceState(environmentId);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const open = useAtomCommand(deviceEnvironment.open);
  const close = useAtomCommand(deviceEnvironment.close);
  const shutdown = useAtomCommand(deviceEnvironment.shutdown);
  // The panel stays mounted across thread switches, so an in-flight open or
  // power-off is tagged with the thread it belongs to and only shown there.
  const scope = `${environmentId}\u0000${threadId}`;
  const [operation, setOperation] = useState<{
    readonly scope: string;
    readonly pending: DeviceSummary | null;
    readonly poweringOffKey: string | null;
    readonly error: string | null;
  } | null>(null);
  const pendingDevice = operation?.scope === scope ? operation.pending : null;
  const operationError = operation?.scope === scope ? operation.error : null;
  const poweringOffKey = operation?.scope === scope ? operation.poweringOffKey : null;
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  // Persistent: when on, a device opened from this list floats over chat
  // instead of taking the panel. The workspace's own Float action still works.
  const [floatOverChat, setFloatOverChat] = useLocalStorage(
    FLOAT_OVER_CHAT_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  // Holds the text of the last dismissed info alert, so a change in what the
  // host can run brings the alert back.
  const [dismissedAvailability, setDismissedAvailability] = useLocalStorage(
    DISMISSED_AVAILABILITY_STORAGE_KEY,
    "",
    Schema.String,
  );
  const pendingDeviceKey = pendingDevice ? deviceKey(pendingDevice) : null;

  const hostDisabled = state.hostStatus === "disabled";

  useAtomMount(
    props.visible && loaded && !hostDisabled
      ? deviceHostProbeAtom(environmentId)
      : NO_DEVICE_PROBE_ATOM,
  );

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
  const activeHost = activeDevice
    ? state.hosts.find((host) => host.id === activeDevice.hostId)
    : undefined;

  const selectedHost =
    state.hosts.find((host) => host.id === selectedHostId) ??
    state.hosts.find((host) => state.hostStatuses[host.id]?.status === "ready") ??
    state.hosts[0] ??
    null;
  const selectedHostKey = selectedHost?.id ?? null;
  const grouped = groupDevices(state, selectedHostKey);

  const startOperation = (pending: DeviceSummary | null, poweringOffKey: string | null = null) => {
    const started = { scope, pending, poweringOffKey, error: null };
    setOperation(started);
    // Returning to the same thread can start a newer operation before this one settles.
    return (error: string | null) =>
      setOperation((current) =>
        current === started ? { ...started, pending: null, poweringOffKey: null, error } : current,
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
    if (result._tag === "Failure") {
      settleOperation(formatEnvironmentQueryError(result.cause));
    } else {
      const target = {
        hostId: result.value.hostId,
        deviceId: result.value.deviceId,
        platform: device.platform,
        name: device.name,
      };
      if (floatOverChat) {
        usePreviewMiniPlayerStore.getState().open(props.threadRef, { kind: "device", ...target });
        useRightPanelStore.getState().close(props.threadRef);
      } else {
        useRightPanelStore.getState().openDevice(props.threadRef, target);
      }
      settleOperation(null);
    }
  };

  const powerOffDevice = (device: DeviceSummary) => {
    const key = deviceKey(device);
    const settleOperation = startOperation(null, key);
    void shutdown({
      environmentId,
      input: { hostId: device.hostId, deviceId: device.id, platform: device.platform },
    }).then((result) => {
      settleOperation(result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null);
    });
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

  const closeSurface = () => {
    const store = useRightPanelStore.getState();
    const { activeSurfaceId } = selectThreadRightPanelState(store.byThreadKey, props.threadRef);
    store.closeSurface(props.threadRef, props.surface.id);
    focusPanelTerminalAfterClose(props.threadRef, activeSurfaceId);
  };

  const closeActive = (powerOff: boolean) => {
    if (!powerOff) {
      closeSurface();
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
      else closeSurface();
    });
  };

  const bootingDevices =
    state.bootingDevices?.filter((device) => device.threadId === threadId) ?? [];
  const { ready: hostReady, busy: hostBusy } = deviceHubReadiness(state);
  const loading = !activeDevice && (pendingDevice !== null || hostBusy || !loaded);
  // Without a first snapshot a failed subscription never settles on its own.
  const loadError = loaded ? null : stateError;
  const diagnostics = state.hosts.flatMap((host) => {
    const status = state.hostStatuses[host.id];
    const detail = status?.detail ?? (host.kind === "local" ? state.hostStatusDetail : undefined);
    return detail && (status?.status ?? state.hostStatus) === "ready"
      ? [{ hostId: host.id, label: host.label, detail }]
      : [];
  });
  const availability = selectedHost
    ? describeHostAvailability(
        selectedHost,
        state.devices.some(
          (device) => device.hostId === selectedHost.id && device.platform === "android",
        ),
        state.agentAccessEnabled,
        isAndroidDiscoveryUncertain(state),
      )
    : null;
  const availabilityKey = availability
    ? [availability.title, ...availability.details].join("\n")
    : "";

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
            <div
              role="alert"
              className="flex items-start gap-2 border-b bg-error/5 px-3 py-2 text-xs text-error-foreground"
            >
              <p
                tabIndex={0}
                className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words"
              >
                {operationError}
              </p>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Dismiss device error"
                onClick={() => setOperation(null)}
              >
                <X className="size-3" />
              </Button>
            </div>
          ) : null}
        </div>
        <div className="@container relative flex min-h-0 flex-1">
          {activeDevice && activeSession ? (
            <DeviceWorkspace
              key={`${environmentId}\u0000${deviceKey(activeDevice)}`}
              environmentId={environmentId}
              device={activeDevice}
              hostLabel={activeHost?.label ?? "Device host"}
              hostKind={activeHost?.kind}
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
                loadError ??
                (pendingDevice
                  ? pendingDevice.booted
                    ? "Opening device…"
                    : "Starting device…"
                  : state.hostStatus === "installing"
                    ? (state.hostStatusDetail ?? "Installing device support…")
                    : "Finding devices…")
              }
              error={loadError !== null}
            >
              {loadError !== null ? (
                <Button size="sm" variant="secondary" onClick={refreshState}>
                  Retry
                </Button>
              ) : null}
            </DeviceLoadingView>
          ) : (
            <div className="scrollbar-gutter-both flex size-full flex-col overflow-y-auto px-4 py-3.5 text-sm text-muted-foreground">
              <div className="mx-auto flex w-full max-w-xl flex-col gap-3.5">
                <div className="flex items-center gap-2">
                  {selectedHost ? (
                    <Select
                      value={selectedHost.id}
                      items={Object.fromEntries(
                        state.hosts.map((host) => [host.id, `Device host · ${host.label}`]),
                      )}
                      onValueChange={(value) => {
                        if (typeof value === "string") setSelectedHostId(value);
                      }}
                    >
                      <SelectTrigger aria-label="Device host" className="w-auto max-w-60">
                        {selectedHost.kind === "eas" || selectedHost.kind === "simlock" ? (
                          <CloudIcon />
                        ) : selectedHost.kind === "ssh" ? (
                          <Server />
                        ) : (
                          <Monitor />
                        )}
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {state.hosts.map((host) => (
                          <SelectItem key={host.id} value={host.id}>
                            Device host · {host.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : null}
                  <div className="flex-1" />
                  <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    Float over chat
                    <Switch
                      size="sm"
                      checked={floatOverChat}
                      onCheckedChange={(checked) => setFloatOverChat(checked)}
                    />
                  </label>
                </div>
                {grouped.length === 0 ? (
                  <Empty size="compact" role="status" className="min-h-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        {state.hostStatus === "failed" ? <TriangleAlert /> : <Smartphone />}
                      </EmptyMedia>
                      <EmptyTitle>
                        {state.hostStatus === "failed"
                          ? "Device hub didn't start"
                          : "No devices found"}
                      </EmptyTitle>
                      <EmptyDescription
                        className="max-h-32 w-full overflow-y-auto whitespace-pre-line break-words"
                        tabIndex={state.hostStatus === "failed" ? 0 : undefined}
                      >
                        {state.hostStatus === "failed"
                          ? (state.hostStatusDetail ?? "The device hub failed to start.")
                          : "No simulators or emulators were found on this environment."}
                      </EmptyDescription>
                    </EmptyHeader>
                    {loaded && !hostBusy ? (
                      <EmptyContent>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void list({ environmentId, input: {} })}
                        >
                          <RotateCw />
                          Refresh devices
                        </Button>
                      </EmptyContent>
                    ) : null}
                  </Empty>
                ) : null}
                {hostReady && grouped.length > 0
                  ? grouped.map((group) => (
                      <section key={group.platform} className="flex flex-col gap-2">
                        <h3 className="text-xs font-medium text-dim-foreground">
                          {platformLabel(group.platform)}
                        </h3>
                        <DiscoveryList>
                          {group.devices.map((device) => (
                            <DeviceRow
                              key={deviceKey(device)}
                              device={device}
                              simlock={selectedHost?.kind === "simlock"}
                              pending={
                                pendingDeviceKey === deviceKey(device) ||
                                poweringOffKey === deviceKey(device)
                              }
                              disabled={pendingDeviceKey !== null || poweringOffKey !== null}
                              onOpen={() => void selectDevice(deviceKey(device))}
                              onPowerOff={() => powerOffDevice(device)}
                            />
                          ))}
                        </DiscoveryList>
                      </section>
                    ))
                  : null}
                {hostReady &&
                availability &&
                !(availability.available && dismissedAvailability === availabilityKey) ? (
                  <Alert
                    role="status"
                    variant={availability.available ? "info" : "warning"}
                    controlAlignment="first-line"
                  >
                    {availability.available ? <Info /> : <TriangleAlert />}
                    <AlertTitle>{availability.title}</AlertTitle>
                    {availability.details.length > 0 ? (
                      <AlertDescription>{availability.details.join(" ")}</AlertDescription>
                    ) : null}
                    {availability.available ? (
                      <AlertAction>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Dismiss device availability"
                          onClick={() => setDismissedAvailability(availabilityKey)}
                        >
                          <X />
                        </Button>
                      </AlertAction>
                    ) : null}
                  </Alert>
                ) : null}
                {loaded && !hostBusy && grouped.length > 0 ? (
                  <Button
                    className="self-start"
                    variant="ghost"
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

/**
 * One device: the name opens (or starts) it like the whole row did before, the
 * chip says whether it runs, and the button boots or powers it off.
 */
function DeviceRow(props: {
  readonly device: DeviceSummary;
  readonly simlock: boolean;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onOpen: () => void;
  readonly onPowerOff: () => void;
}) {
  const { device } = props;
  const DeviceIcon = /ipad|tablet/i.test(device.name) ? Tablet : Smartphone;
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <Button
        type="button"
        variant="bare"
        size="sm-multiline"
        disabled={props.disabled}
        aria-label={`${device.booted ? "Open" : "Start"} ${device.name}`}
        onClick={props.onOpen}
        className="-ms-2.5 min-w-0 flex-1 justify-start text-left"
      >
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-control surface-raised text-foreground">
            <DeviceIcon className="size-3.75" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-label text-foreground">{device.name}</span>
            <span className="truncate text-caption text-dim-foreground">{device.version}</span>
          </span>
        </span>
      </Button>
      <Badge variant={device.booted ? "success" : "secondary"}>
        {device.physical
          ? "Connected"
          : device.booted
            ? "Running"
            : props.simlock
              ? "Available"
              : "Shut down"}
      </Badge>
      {props.pending ? (
        <Spinner size="xs" />
      ) : device.physical ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={props.disabled}
          aria-label={`Open ${device.name}`}
          onClick={props.onOpen}
        >
          <ArrowUpRight />
          Open
        </Button>
      ) : device.booted ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={props.disabled}
          aria-label={`${props.simlock ? "Return to pool" : "Power off"} ${device.name}`}
          onClick={props.onPowerOff}
        >
          <Power />
          {props.simlock ? "Return to pool" : "Power off"}
        </Button>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={props.disabled}
          aria-label={`${props.simlock ? "Lease" : "Boot"} ${device.name}`}
          onClick={props.onOpen}
        >
          <Play />
          {props.simlock ? "Lease" : "Boot"}
        </Button>
      )}
    </div>
  );
}

function DeviceDiscoveryWarning(props: { readonly label: string; readonly detail: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <TriangleAlert />
      <AlertTitle>Device discovery warning · {props.label}</AlertTitle>
      <AlertDescription
        className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words"
        tabIndex={0}
      >
        {props.detail}
      </AlertDescription>
      <AlertAction>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Dismiss device warning"
          onClick={() => setDismissed(true)}
        >
          <X />
        </Button>
      </AlertAction>
    </Alert>
  );
}

const platformToolLabel = (platform: DevicePlatform) =>
  platform === "ios" ? "Xcode and iOS Simulator" : "The Android SDK and Emulator";

/** The availability alert under the list: what this host can run and why not. */
function describeHostAvailability(
  host: DeviceHostSummary,
  hasAndroidDevices: boolean,
  agentAccessEnabled: boolean,
  androidDiscoveryUncertain: boolean,
) {
  const ios = host.platforms.find((platform) => platform.platform === "ios");
  const android = host.platforms.find((platform) => platform.platform === "android");
  const available = host.platforms.filter((platform) => platform.available);
  if (host.kind === "simlock") {
    return {
      available: available.length > 0,
      title: `${host.label} leases devices from a Simlock pool.`,
      details: [
        "Returning a device to the pool wipes it.",
        ...new Set(
          host.platforms.flatMap((platform) =>
            !platform.available && platform.reason ? [platform.reason] : [],
          ),
        ),
      ],
    };
  }
  const details: string[] = [];
  const first = available[0];
  const cloudDevices = available
    .map(({ platform }) => (platform === "ios" ? "iOS Simulators" : "Android emulators"))
    .join(" and ");
  const title = first
    ? host.kind === "eas"
      ? `${host.label} starts ${cloudDevices} in the cloud with EAS Simulator.`
      : `${platformToolLabel(first.platform)} are available.`
    : host.kind === "eas"
      ? "EAS Simulator is unavailable on this host."
      : "No simulator or emulator tools are available on this host.";
  if (host.kind !== "eas" && ios?.available && android?.available) {
    details.push(`${platformToolLabel("android")} are available too.`);
  }
  for (const platform of host.platforms) {
    if (platform.available) continue;
    details.push(
      platform.reason ?? `${platform.platform === "ios" ? "iOS" : "Android"} is unavailable.`,
    );
  }
  if (
    host.kind !== "eas" &&
    !androidDiscoveryUncertain &&
    android?.available !== false &&
    !hasAndroidDevices
  ) {
    details.push(
      "No Android virtual devices found. Create one in Android Studio's Device Manager, then refresh.",
    );
  }
  if (agentAccessEnabled && available.length > 0) {
    details.push("Agents can boot a device when they need one.");
  }
  return { available: available.length > 0, title, details };
}

function groupDevices(state: DeviceServiceState, hostId: string | null) {
  const groups: Array<{ platform: DevicePlatform; devices: DeviceSummary[] }> = [];
  for (const platform of ["ios", "android"] as const) {
    const devices = state.devices
      .filter(
        (device) => device.platform === platform && (hostId === null || device.hostId === hostId),
      )
      .toSorted((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    if (devices.length > 0) groups.push({ platform, devices });
  }
  return groups;
}
