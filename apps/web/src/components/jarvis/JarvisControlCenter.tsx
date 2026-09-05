import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopJarvisVoiceState, EnvironmentId } from "@t3tools/contracts";
import type { JarvisMeshCatalog, JarvisMeshNode } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { useNavigate } from "@tanstack/react-router";
import {
  AudioLinesIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  FolderGit2Icon,
  MicIcon,
  MonitorSpeakerIcon,
  RefreshCwIcon,
  ServerIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SquareIcon,
  WifiOffIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { openJarvisOnboarding } from "../../jarvisBus";
import {
  areJarvisVoiceReportsEnabled,
  isPreferredJarvisSpeaker,
  setJarvisVoiceReportsEnabled,
  setPreferredJarvisSpeaker,
} from "../../jarvisPreferences";
import { cn } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { JARVIS_MARK_SRC } from "./JarvisBrand";
import {
  buildJarvisControlCenterView,
  type JarvisControlCenterDevice,
  type JarvisControlCenterView,
} from "./JarvisControlCenter.logic";
import { jarvisErrorMessage } from "./JarvisManager.logic";
import { JarvisNodeAgentSettings } from "./JarvisNodeAgentSettings";

const EMPTY_CATALOG: JarvisMeshCatalog = { nodes: [], projects: [], providers: [] };

function StatusDot({ online }: { readonly online: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        online ? "bg-emerald-400 shadow-[0_0_9px_rgb(52_211_153/0.55)]" : "bg-muted-foreground/35",
      )}
    />
  );
}

function EnvironmentSummary({ summary }: { readonly summary: JarvisControlCenterView["summary"] }) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="text-4xl font-semibold tracking-tight text-foreground tabular-nums">
          {summary.onlineDevices}/{summary.devices}
        </span>
        <span className="text-xs text-muted-foreground">devices online</span>
      </div>
      <div className="grid grid-cols-2 gap-5">
        <div className="flex flex-col gap-1">
          <span className="text-lg font-medium text-foreground tabular-nums">
            {summary.readyProviders}/{summary.providers}
          </span>
          <span className="text-[11px] text-muted-foreground">providers ready</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-lg font-medium text-foreground tabular-nums">
            {summary.projects}
          </span>
          <span className="text-[11px] text-muted-foreground">projects available</span>
        </div>
      </div>
    </div>
  );
}

function DeviceRail({
  devices,
  selectedNodeId,
  onSelect,
  onManage,
}: {
  readonly devices: ReadonlyArray<JarvisControlCenterDevice>;
  readonly selectedNodeId: EnvironmentId | null;
  readonly onSelect: (nodeId: EnvironmentId) => void;
  readonly onManage: () => void;
}) {
  return (
    <aside className="min-w-0">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">Devices</h2>
        <button
          type="button"
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onManage}
        >
          Manage
        </button>
      </div>
      <div className="flex gap-1 overflow-x-auto lg:grid lg:overflow-visible">
        {devices.map((device) => {
          const selected = device.node.nodeId === selectedNodeId;
          const online = device.node.reachability === "online";
          return (
            <button
              key={device.node.nodeId}
              type="button"
              aria-pressed={selected}
              className={cn(
                "group flex min-w-52 items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors lg:min-w-0",
                selected
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() => onSelect(device.node.nodeId)}
            >
              <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <StatusDot online={online} />
                  <span className="truncate text-sm font-medium">{device.node.label}</span>
                  {device.isCurrentDevice ? (
                    <Badge variant="outline" className="shrink-0 text-[9px]">
                      This device
                    </Badge>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                  {device.node.capabilities?.preset ?? "unknown"} · {device.projects.length}{" "}
                  projects
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function LocalVoiceConsole() {
  const [voiceState, setVoiceState] = useState<DesktopJarvisVoiceState | null>(null);
  const [captureActive, setCaptureActive] = useState(false);
  const [outputTesting, setOutputTesting] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [reportsEnabled, setReportsEnabled] = useState(areJarvisVoiceReportsEnabled);
  const [preferredSpeaker, setPreferredSpeakerState] = useState(isPreferredJarvisSpeaker);
  const voice = typeof window === "undefined" ? undefined : window.desktopBridge?.jarvisVoice;

  useEffect(() => {
    if (voice === undefined) return;
    let active = true;
    void voice.getState().then(
      (state) => active && setVoiceState(state),
      () =>
        active &&
        setVoiceState({ status: "unavailable", native: true, errorCode: "STATE_UNAVAILABLE" }),
    );
    const removeState = voice.onState((state) => {
      setVoiceState(state);
      if (state.status === "ready" || state.status === "error" || state.status === "unavailable") {
        setCaptureActive(false);
      }
    });
    const removeTranscript = voice.onTranscript((transcript) => {
      setLastTranscript(transcript);
      setCaptureActive(false);
    });
    return () => {
      active = false;
      removeState();
      removeTranscript();
    };
  }, [voice]);

  const toggleMicrophone = useCallback(async () => {
    if (voice === undefined) return;
    if (captureActive) {
      const result = await voice.releaseCapture();
      if (!result.accepted) setCaptureActive(false);
      return;
    }
    setLastTranscript(null);
    const result = await voice.startCapture();
    setCaptureActive(result.accepted);
    if (!result.accepted) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Microphone did not start",
          description: "Jarvis could not open local capture. Check the voice status below.",
        }),
      );
    }
  }, [captureActive, voice]);

  const testOutput = useCallback(async () => {
    if (voice === undefined || outputTesting) return;
    setOutputTesting(true);
    try {
      const result = await voice.speak("Jarvis is ready on this device.");
      if (!result.accepted) throw new Error("The local speech engine rejected the test.");
    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Voice output failed",
          description: cause instanceof Error ? cause.message : "Local speech could not start.",
        }),
      );
    } finally {
      setOutputTesting(false);
    }
  }, [outputTesting, voice]);

  const status = voice === undefined ? "Desktop required" : (voiceState?.status ?? "Checking");
  return (
    <section id="jarvis-local-voice" className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AudioLinesIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-foreground">Voice on this device</h2>
            <Badge className="text-[9px]" variant="outline">
              {status}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Parakeet listens locally. Pocket loads only when Jarvis has something to say.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={captureActive ? "destructive" : "outline"}
            disabled={voice === undefined}
            onClick={() => void toggleMicrophone()}
          >
            {captureActive ? <SquareIcon /> : <MicIcon />}
            {captureActive ? "Stop and transcribe" : "Test microphone"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={voice === undefined || outputTesting}
            onClick={() => void testOutput()}
          >
            <MonitorSpeakerIcon />
            {outputTesting ? "Speaking…" : "Test output"}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid border-y border-border/60 md:grid-cols-2">
        <label className="flex items-center justify-between gap-4 py-3 md:pr-5">
          <span>
            <span className="block text-xs font-medium text-foreground">Speak agent reports</span>
            <span className="mt-0.5 block text-[10px] text-muted-foreground">
              Results and approvals aloud
            </span>
          </span>
          <Switch
            checked={reportsEnabled}
            aria-label="Speak Jarvis reports"
            onCheckedChange={(checked) => {
              const enabled = Boolean(checked);
              setJarvisVoiceReportsEnabled(enabled);
              setReportsEnabled(enabled);
            }}
          />
        </label>
        <label className="flex items-center justify-between gap-4 border-t border-border/50 py-3 md:border-t-0 md:border-l md:pl-5">
          <span>
            <span className="block text-xs font-medium text-foreground">Prefer this speaker</span>
            <span className="mt-0.5 block text-[10px] text-muted-foreground">
              Wins when multiple devices can speak
            </span>
          </span>
          <Switch
            checked={preferredSpeaker}
            aria-label="Preferred Jarvis speaker"
            onCheckedChange={(checked) => {
              const preferred = Boolean(checked);
              setPreferredJarvisSpeaker(preferred);
              setPreferredSpeakerState(preferred);
            }}
          />
        </label>
      </div>

      {lastTranscript ? (
        <p className="mt-3 truncate text-xs text-foreground/80">
          <span className="mr-2 text-muted-foreground">Last transcript</span>
          Heard: “{lastTranscript}”
        </p>
      ) : null}
    </section>
  );
}

function DeviceEnvironment({
  device,
  onManageConnections,
  onManageProviders,
}: {
  readonly device: JarvisControlCenterDevice;
  readonly onManageConnections: () => void;
  readonly onManageProviders: () => void;
}) {
  const online = device.node.reachability === "online";
  const capabilities = device.node.capabilities;
  const capabilityCount = capabilities
    ? [
        capabilities.ui,
        capabilities.parakeet,
        capabilities.pocket ?? capabilities.kokoro,
        capabilities.execution,
        capabilities.projects,
        capabilities.providers,
      ].filter(Boolean).length
    : 0;
  const capabilityRows = [
    ["Interface", capabilities?.ui],
    ["Microphone", capabilities?.parakeet],
    [
      "Voice output",
      capabilities === undefined ? undefined : (capabilities.pocket ?? capabilities.kokoro),
    ],
    ["Execution", capabilities?.execution],
    ["Projects", capabilities?.projects],
    ["Providers", capabilities?.providers],
  ] as const;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/55 pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <StatusDot online={online} />
            <h2 className="text-base font-medium">{device.node.label}</h2>
            {device.isCurrentDevice ? <Badge variant="outline">This device</Badge> : null}
            <span className="text-[11px] text-muted-foreground">
              {online ? "Online" : "Offline"}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {capabilities?.preset ?? "Unknown"} node · {capabilityCount}/6 capabilities ·{" "}
            {device.providers.filter((provider) => provider.available).length}/
            {device.providers.length} providers ready
          </p>
        </div>
        <Button size="xs" variant="ghost" onClick={onManageConnections}>
          <Settings2Icon /> Device settings
        </Button>
      </div>

      {device.node.catalogError ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-destructive/6 px-3 py-2.5 text-xs text-destructive-foreground">
          <WifiOffIcon className="mt-0.5 size-3.5 shrink-0" /> {device.node.catalogError}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-b border-border/55 pb-4">
        {capabilityRows.map(([label, enabled]) => (
          <span
            key={label}
            className={cn(
              "inline-flex items-center gap-1.5 text-[11px]",
              enabled ? "text-foreground/80" : "text-muted-foreground/45",
            )}
          >
            {enabled ? (
              <CheckIcon className="size-3 text-emerald-500" />
            ) : (
              <CircleAlertIcon className="size-3" />
            )}
            {label}
          </span>
        ))}
      </div>

      <div className="flex min-w-0 flex-col gap-7 pt-5">
        <JarvisNodeAgentSettings
          key={device.node.nodeId}
          environmentId={device.node.nodeId}
          online={online}
          executionEnabled={capabilities?.execution === true}
        />
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <BotIcon className="size-3.5 text-muted-foreground" /> Providers
            </h3>
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onManageProviders}
            >
              Configure
            </button>
          </div>
          <div className="border-y border-border/55">
            {device.providers.length === 0 ? (
              <p className="py-5 text-xs text-muted-foreground">No providers advertised.</p>
            ) : (
              <>
                <div className="hidden grid-cols-[minmax(0,1fr)_9rem_8rem_5rem] gap-4 border-b border-border/45 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                  <span>Provider</span>
                  <span>Authentication</span>
                  <span>Runtime</span>
                  <span className="text-right">Status</span>
                </div>
                <div className="divide-y divide-border/45">
                  {device.providers.map((provider) => (
                    <div
                      key={provider.snapshot.instanceId}
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_9rem_8rem_5rem] sm:gap-4"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <StatusDot online={provider.available} />
                        <span className="truncate text-xs font-medium">
                          {provider.snapshot.displayName ?? provider.snapshot.driver}
                        </span>
                      </span>
                      <span className="hidden truncate text-[11px] text-muted-foreground sm:block">
                        {provider.snapshot.auth.status}
                      </span>
                      <span className="hidden truncate text-[11px] text-muted-foreground sm:block">
                        {provider.snapshot.status}
                      </span>
                      <span
                        className={cn(
                          "text-right text-[10px]",
                          provider.available ? "text-emerald-500" : "text-amber-500",
                        )}
                      >
                        {provider.available ? "Ready" : "Attention"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
        <section className="min-w-0">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <FolderGit2Icon className="size-3.5 text-muted-foreground" /> Projects
          </h3>
          <div className="border-y border-border/55">
            {device.projects.length === 0 ? (
              <p className="py-5 text-xs text-muted-foreground">No projects available.</p>
            ) : (
              <div className="divide-y divide-border/45">
                {device.projects.map((project) => (
                  <div
                    key={project.ref.projectId}
                    className="grid min-w-0 gap-1 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-4"
                  >
                    <span className="truncate text-xs font-medium">{project.title}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {project.workspaceRoot}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export function JarvisControlCenter() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const refreshMesh = useAtomCommand(jarvisMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const [catalog, setCatalog] = useState<JarvisMeshCatalog | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<EnvironmentId | null>(primaryEnvironmentId);
  const refreshGeneration = useRef(0);
  const connectionKey = JSON.stringify(
    environments.map((environment) => [environment.environmentId, environment.connection.phase]),
  );
  const registeredNodes = useMemo(
    () =>
      environments.map(
        (environment): JarvisMeshNode => ({
          nodeId: environment.environmentId,
          label: environment.serverConfig?.environment.label ?? environment.label,
          reachability: environment.connection.phase === "connected" ? "online" : "offline",
          ...(environment.serverConfig?.environment.capabilities.jarvisNode === undefined
            ? {}
            : { capabilities: environment.serverConfig.environment.capabilities.jarvisNode }),
          ...(environment.connection.error === null
            ? {}
            : { catalogError: environment.connection.error }),
        }),
      ),
    [environments],
  );

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setPending(true);
    setError(null);
    const result = await refreshMesh(undefined);
    if (generation !== refreshGeneration.current) return;
    if (result._tag === "Failure") {
      setError(jarvisErrorMessage(squashAtomCommandFailure(result)));
    } else {
      setCatalog(result.value);
    }
    setPending(false);
  }, [refreshMesh]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh, connectionKey]);
  const view = useMemo(
    () =>
      buildJarvisControlCenterView(catalog ?? EMPTY_CATALOG, {
        registeredNodes,
        currentNodeId: isElectron ? primaryEnvironmentId : null,
      }),
    [catalog, registeredNodes, primaryEnvironmentId],
  );
  const selectedDevice = useMemo(
    () =>
      view.devices.find((device) => device.node.nodeId === selectedNodeId) ??
      view.devices[0] ??
      null,
    [selectedNodeId, view.devices],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Jarvis environment breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <span className="flex items-center gap-2">
                <img src={JARVIS_MARK_SRC} alt="" className="size-4 rounded-sm" />
                <h1>Jarvis</h1>
              </span>
            </WorkspaceBreadcrumbItem>
            {selectedDevice ? (
              <>
                <WorkspaceBreadcrumbSeparator className="hidden sm:flex" />
                <WorkspaceBreadcrumbItem className="hidden min-w-0 shrink sm:flex">
                  <span className="truncate">{selectedDevice.node.label}</span>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          <div className="ms-auto flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => openJarvisOnboarding()}>
              <SlidersHorizontalIcon /> Setup
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              <Settings2Icon /> Connections
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh Jarvis environment"
              disabled={pending}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon
                className={cn("size-3.5", pending && "animate-spin motion-reduce:animate-none")}
              />
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <section className="grid gap-8 border-b border-border/60 pb-7 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
              <EnvironmentSummary summary={view.summary} />
              <LocalVoiceConsole />
            </section>

            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs text-destructive-foreground">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {error}
              </div>
            ) : null}

            {pending && catalog === null && view.devices.length === 0 ? (
              <div className="grid min-h-52 place-items-center border-y border-border/45 text-xs text-muted-foreground">
                Loading your environment…
              </div>
            ) : view.devices.length === 0 ? (
              <div className="grid min-h-52 place-items-center border-y border-border/45 px-6 text-center">
                <div>
                  <ServerIcon className="mx-auto size-5 text-muted-foreground" />
                  <div className="mt-3 text-sm font-medium">No devices connected</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Open Connections to pair or reconnect a node.
                  </div>
                </div>
              </div>
            ) : (
              <section className="min-w-0">
                <div className="mb-5">
                  <h2 className="text-sm font-medium text-foreground">Your Jarvis mesh</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Devices and the projects, providers, and voice capabilities they own.
                  </p>
                </div>
                <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                  <DeviceRail
                    devices={view.devices}
                    selectedNodeId={selectedDevice?.node.nodeId ?? null}
                    onSelect={setSelectedNodeId}
                    onManage={() => void navigate({ to: "/settings/connections" })}
                  />
                  {selectedDevice ? (
                    <DeviceEnvironment
                      device={selectedDevice}
                      onManageConnections={() =>
                        void navigate({
                          to: "/settings/connections",
                          search: { environmentId: selectedDevice.node.nodeId },
                        })
                      }
                      onManageProviders={() =>
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: selectedDevice.node.nodeId },
                        })
                      }
                    />
                  ) : null}
                </div>
              </section>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
