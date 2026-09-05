import {
  type DesktopJarvisVoiceState,
  type JarvisNodeCapabilities,
  type ServerConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  FolderGit2Icon,
  NetworkIcon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { openCommandPalette } from "../../commandPaletteBus";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { JARVIS_BRAND_NAME, JARVIS_BRAND_TAGLINE, JARVIS_MARK_SRC } from "./JarvisBrand";
import {
  classifyJarvisOnboardingProvider,
  jarvisConnectionRouteLabel,
  jarvisNodeCapabilitySummary,
  jarvisNodePresetLabel,
  jarvisOnboardingProviderStatusLabel,
  jarvisOnboardingExecutionNodeId,
  jarvisOnboardingExecutionNodeSelection,
  jarvisOnboardingReadiness,
  shouldPrepareJarvisOnboardingVoice,
  jarvisOnboardingNextStep,
  jarvisOnboardingPreviousStep,
  jarvisOnboardingStepIndex,
  jarvisOnboardingSteps,
  jarvisOnboardingVoiceBridgeFailureState,
  jarvisRefreshRequestIsCurrent,
  jarvisTailscaleStatus,
  validateJarvisNodeLabel,
  type JarvisOnboardingStepId,
  readJarvisOnboardingCompletion,
  writeJarvisOnboardingCompletion,
} from "./JarvisOnboarding.logic";

export interface JarvisOnboardingProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenConnections: (environmentId?: EnvironmentId, action?: "rename" | "remove") => void;
  readonly onOpenProviderSettings: () => void;
}

function capabilityForPrimaryNode(config: ServerConfig | null): JarvisNodeCapabilities | null {
  return config?.environment.capabilities.jarvisNode ?? null;
}

function providerStatusClass(status: ReturnType<typeof classifyJarvisOnboardingProvider>): string {
  switch (status) {
    case "ready":
      return "text-success";
    case "sign-in":
      return "text-warning-foreground";
    case "not-installed":
      return "text-muted-foreground";
    case "attention":
      return "text-destructive-foreground";
  }
}

export function JarvisOnboarding({
  open,
  onOpenChange,
  onOpenConnections,
  onOpenProviderSettings,
}: JarvisOnboardingProps) {
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const capabilities = capabilityForPrimaryNode(primaryServerConfig);
  const desktopNetworkAccess = useEnvironmentQuery(
    typeof window !== "undefined" && window.desktopBridge !== undefined
      ? desktopNetworkAccessStateAtom
      : null,
  );
  const refreshMesh = useAtomCommand(jarvisMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const setEnvironmentLabel = useAtomCommand(serverEnvironment.setEnvironmentLabel, {
    reportFailure: false,
    reportDefect: false,
  });
  const [catalog, setCatalog] = useState<JarvisMeshCatalog | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<JarvisOnboardingStepId>("device");
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [labelSaving, setLabelSaving] = useState(false);
  const [voiceHelperState, setVoiceHelperState] = useState<DesktopJarvisVoiceState | null>(null);
  const [voiceHelperRefreshToken, setVoiceHelperRefreshToken] = useState(0);
  const [selectedExecutionNodeId, setSelectedExecutionNodeId] = useState<string | null>(null);
  const refreshRequestIdRef = useRef(0);
  const voiceHelperSetupAttemptRef = useRef<string | null>(null);
  const voiceHelperGenerationRef = useRef(0);

  const dismiss = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const refreshCatalog = useCallback(() => {
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    setCatalog(null);
    setPending(true);
    setError(null);
    void refreshMesh(undefined).then((result) => {
      if (
        !jarvisRefreshRequestIsCurrent({
          requestId,
          latestRequestId: refreshRequestIdRef.current,
        })
      )
        return;
      setPending(false);
      if (result._tag === "Failure") {
        setError("Could not refresh the Jarvis node.");
        return;
      }
      setCatalog(result.value);
    });
  }, [refreshMesh]);

  useEffect(() => {
    if (!open) return;
    setActiveStep("device");
    setSelectedExecutionNodeId(null);
    refreshCatalog();
    return () => {
      refreshRequestIdRef.current += 1;
    };
  }, [open, refreshCatalog]);

  useEffect(() => {
    if (!open || activeStep !== "essentials") {
      voiceHelperSetupAttemptRef.current = null;
      return;
    }
    const voice = window.desktopBridge?.jarvisVoice;
    if (voice === undefined || primaryEnvironmentId === null) return;
    if (capabilities === null) return;
    const generation = voiceHelperGenerationRef.current + 1;
    voiceHelperGenerationRef.current = generation;
    const attemptKey = `${primaryEnvironmentId}:${capabilities.preset}:${capabilities.parakeet}:${capabilities.pocket ?? capabilities.kokoro}:${voiceHelperRefreshToken}`;
    if (voiceHelperSetupAttemptRef.current === attemptKey) return;
    voiceHelperSetupAttemptRef.current = attemptKey;
    let cancelled = false;
    const isCurrent = () => !cancelled && voiceHelperGenerationRef.current === generation;
    const projectBridgeFailure = (): boolean => {
      const failed = jarvisOnboardingVoiceBridgeFailureState({
        capabilities,
        bridgePresent: true,
      });
      if (failed !== null && isCurrent()) setVoiceHelperState(failed);
      return failed !== null;
    };
    const readVoiceState = async (): Promise<DesktopJarvisVoiceState | null> => {
      try {
        return await voice.getState();
      } catch {
        projectBridgeFailure();
        return null;
      }
    };
    void (async () => {
      const current = await readVoiceState();
      if (current !== null && isCurrent()) setVoiceHelperState(current);
      if (!isCurrent()) return;
      // Entering onboarding must stay cheap and cannot eagerly load both speech
      // models. Only an explicit Retry is allowed to prepare the worker.
      if (
        !shouldPrepareJarvisOnboardingVoice({
          activeStep,
          retryRequested: voiceHelperRefreshToken > 0,
          currentState: current,
        })
      )
        return;
      let prepared: DesktopJarvisVoiceState | null = null;
      let prepareFailed = false;
      try {
        prepared = await voice.prepare();
      } catch {
        prepareFailed = projectBridgeFailure();
      }
      if (prepared !== null && isCurrent()) setVoiceHelperState(prepared);
      const refreshed = await readVoiceState();
      if (refreshed !== null && isCurrent() && !prepareFailed) {
        setVoiceHelperState(refreshed);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeStep, capabilities, open, primaryEnvironmentId, voiceHelperRefreshToken]);

  const currentLabel =
    primaryServerConfig?.environment.label ?? primaryEnvironment?.entry.target.label ?? "";
  const labelValue = labelDraft ?? currentLabel;
  const saveLabel = useCallback(async (): Promise<boolean> => {
    if (primaryEnvironmentId === null) return false;
    const validation = validateJarvisNodeLabel(labelValue);
    if (!validation.valid) {
      setLabelError(validation.message);
      return false;
    }
    setLabelError(null);
    setLabelSaving(true);
    try {
      const result = await setEnvironmentLabel({
        environmentId: primaryEnvironmentId,
        input: { label: validation.value },
      });
      if (result._tag === "Failure") {
        setLabelError("Could not save the device name.");
        return false;
      }
      setLabelDraft(result.value.label);
      refreshCatalog();
      return true;
    } catch {
      setLabelError("Could not save the device name.");
      return false;
    } finally {
      setLabelSaving(false);
    }
  }, [labelValue, primaryEnvironmentId, refreshCatalog, setEnvironmentLabel]);

  const primaryNode = catalog?.nodes.find((node) => node.nodeId === primaryEnvironmentId) ?? null;
  const onboardingCatalog = catalog ?? { nodes: [], projects: [], providers: [] };
  const primaryReachability =
    primaryNode?.reachability ??
    (primaryEnvironment?.connection.phase === "connected" ? "online" : "offline");
  const executionNodeId = jarvisOnboardingExecutionNodeId({
    primaryNodeId: primaryEnvironmentId ?? "primary",
    primaryReachability,
    capabilities,
    catalog: onboardingCatalog,
    selectedExecutionNodeId,
  });
  const executionNodeSelection = jarvisOnboardingExecutionNodeSelection({
    primaryNodeId: primaryEnvironmentId ?? "primary",
    primaryReachability,
    capabilities,
    catalog: onboardingCatalog,
    selectedExecutionNodeId,
  });
  const executionNode = catalog?.nodes.find((node) => node.nodeId === executionNodeId) ?? null;
  const executionEnvironment =
    environments.find((environment) => environment.environmentId === executionNodeId) ?? null;
  const resourceNodeId =
    executionNodeId ?? (executionNodeSelection.kind === "ambiguous" ? null : primaryEnvironmentId);
  const executionCapabilities =
    executionNode?.capabilities ??
    (executionNodeId === primaryEnvironmentId && executionNode?.catalogError === undefined
      ? capabilities
      : null);
  const executionProviders = useMemo(
    () => catalog?.providers.filter((provider) => provider.nodeId === resourceNodeId) ?? [],
    [catalog?.providers, resourceNodeId],
  );
  const executionProjects = useMemo(
    () => catalog?.projects.filter((project) => project.ref.nodeId === resourceNodeId) ?? [],
    [catalog?.projects, resourceNodeId],
  );
  const routeEnvironment =
    executionEnvironment ?? (executionNodeId === primaryEnvironmentId ? primaryEnvironment : null);
  const connectionRoute = routeEnvironment
    ? jarvisConnectionRouteLabel({
        targetTag: routeEnvironment.entry.target._tag,
        displayUrl: routeEnvironment.displayUrl,
        ...(routeEnvironment.environmentId === primaryEnvironmentId && desktopNetworkAccess.data
          ? { advertisedEndpoints: desktopNetworkAccess.data.advertisedEndpoints }
          : {}),
      })
    : executionNodeId === null
      ? "Execution route pending"
      : "Remote route";
  const routeDetails = useMemo(
    () =>
      (catalog?.nodes ?? [])
        .filter((node) => node.reachability === "online")
        .map((node) => {
          const environment = environments.find(
            (candidate) => candidate.environmentId === node.nodeId,
          );
          if (environment === undefined) return `${node.label}: connected`;
          return `${node.label}: ${jarvisConnectionRouteLabel({
            targetTag: environment.entry.target._tag,
            displayUrl: environment.displayUrl,
            ...(environment.environmentId === primaryEnvironmentId && desktopNetworkAccess.data
              ? { advertisedEndpoints: desktopNetworkAccess.data.advertisedEndpoints }
              : {}),
          })}`;
        }),
    [catalog?.nodes, desktopNetworkAccess.data, environments, primaryEnvironmentId],
  );
  const executionConnected = executionEnvironment
    ? executionEnvironment.connection.phase === "connected"
    : executionNode?.reachability === "online";
  const tailscaleStatus = routeEnvironment
    ? jarvisTailscaleStatus({
        connectionPhase: routeEnvironment.connection.phase,
        targetTag: routeEnvironment.entry.target._tag,
        displayUrl: routeEnvironment.displayUrl,
        ...(routeEnvironment.environmentId === primaryEnvironmentId && desktopNetworkAccess.data
          ? { advertisedEndpoints: desktopNetworkAccess.data.advertisedEndpoints }
          : {}),
      })
    : "not-detected";
  const readiness = jarvisOnboardingReadiness({
    primaryNodeId: primaryEnvironmentId ?? "primary",
    primaryReachability,
    capabilities,
    catalog: onboardingCatalog,
    selectedExecutionNodeId,
  });
  const readinessMessage = readiness.ready
    ? "All required execution resources are connected."
    : readiness.reason === "connection-required"
      ? "Connect this node before marking setup complete."
      : readiness.reason === "catalog-unavailable"
        ? (executionNode?.catalogError ??
          "Jarvis capabilities are unavailable. Refresh the node before marking setup complete.")
        : readiness.reason === "execution-node-required"
          ? "Pair an online execution node before marking setup complete."
          : readiness.reason === "execution-node-ambiguous"
            ? "Choose one execution node before marking setup complete."
            : readiness.reason === "project-required"
              ? "Add a project on the execution node before marking setup complete."
              : "Sign in to a ready provider on the execution node before marking setup complete.";
  const complete = useCallback(() => {
    if (!readiness.ready) return;
    if (typeof window !== "undefined") {
      writeJarvisOnboardingCompletion(window.localStorage, {
        environmentId: primaryEnvironmentId ?? "unknown",
        preset: capabilities?.preset ?? "full",
      });
    }
    onOpenChange(false);
  }, [capabilities?.preset, onOpenChange, primaryEnvironmentId, readiness.ready]);

  const activeStepIndex = jarvisOnboardingStepIndex(activeStep);
  const continueSetup = useCallback(async () => {
    if (activeStep === "device" && !(await saveLabel())) return;
    setActiveStep((current) => jarvisOnboardingNextStep(current));
  }, [activeStep, saveLabel]);
  const goBack = useCallback(() => {
    setActiveStep((current) => jarvisOnboardingPreviousStep(current));
  }, []);
  const canContinue = activeStep !== "device" || (primaryEnvironmentId !== null && !labelSaving);
  const showVoiceHelperStatus =
    executionCapabilities !== null &&
    executionCapabilities.preset === "full" &&
    (executionCapabilities.parakeet ||
      (executionCapabilities.pocket ?? executionCapabilities.kokoro)) &&
    voiceHelperState !== null;
  const voiceHelperStatusLabel = voiceHelperState
    ? (
        {
          unavailable: "Local voice unavailable",
          starting: "Local voice available",
          ready: "Local voice ready",
          capturing: "Listening…",
          transcribing: "Understanding…",
          speaking: "Speaking…",
          error: "Local voice needs a retry",
        } satisfies Record<DesktopJarvisVoiceState["status"], string>
      )[voiceHelperState.status]
    : null;
  const canRetryVoiceHelper = voiceHelperState !== null && voiceHelperState.status === "error";
  const executionCatalogAvailable =
    executionNode?.catalogError === undefined && executionCapabilities !== null;
  const retryVoiceHelper = useCallback(() => {
    setVoiceHelperRefreshToken((current) => current + 1);
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogPopup className="w-[calc(100vw-1rem)] max-w-2xl overflow-hidden rounded-xl border-border/70 bg-background/98 p-0 shadow-xl shadow-black/20">
        <header className="border-b border-border/70 px-5 py-4 pr-12">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-muted/15">
              <img
                src={JARVIS_MARK_SRC}
                alt=""
                aria-hidden="true"
                className="size-full object-cover"
              />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <DialogTitle className="font-mono text-base tracking-tight">
                  {JARVIS_BRAND_NAME}
                </DialogTitle>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {JARVIS_BRAND_TAGLINE}
                </span>
              </div>
              <p className="mt-1 text-sm font-medium">Set up this device</p>
              <DialogDescription className="mt-1 max-w-xl text-sm">
                Name this node, confirm its route, then choose what Jarvis can use to work.
              </DialogDescription>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-info" aria-hidden="true" />
              {primaryReachability === "online" ? "Device connected" : "Connection pending"}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
              Step {activeStepIndex + 1} of 3
            </span>
          </div>
        </header>

        <DialogPanel className="space-y-5 p-5">
          <nav aria-label="Jarvis setup progress" className="grid grid-cols-3 gap-1.5">
            {jarvisOnboardingSteps.map((step, index) => (
              <Button
                key={step.id}
                type="button"
                size="xs"
                variant={step.id === activeStep ? "secondary" : "ghost"}
                className="justify-start px-2 text-left"
                aria-current={step.id === activeStep ? "step" : undefined}
                disabled={index > activeStepIndex}
                onClick={() => setActiveStep(step.id)}
              >
                <span className="font-mono text-[9px] text-muted-foreground">0{index + 1}</span>
                <span className="truncate">{step.label}</span>
              </Button>
            ))}
          </nav>

          {activeStep === "device" ? (
            <section aria-labelledby="jarvis-onboarding-device" className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2
                  id="jarvis-onboarding-device"
                  className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
                >
                  01 · Device
                </h2>
                <ServerIcon className="size-3.5 text-muted-foreground" />
              </div>
              <div className="border border-border/60 bg-muted/5 p-3">
                <label className="block space-y-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    Name this device
                  </span>
                  <input
                    value={labelValue}
                    maxLength={80}
                    onChange={(event) => {
                      setLabelDraft(event.target.value);
                      setLabelError(null);
                    }}
                    className="h-9 w-full rounded-md border border-border/70 bg-background px-2.5 text-sm outline-none focus:border-info"
                    placeholder="This device"
                    aria-invalid={labelError !== null}
                    aria-describedby={labelError !== null ? "jarvis-device-name-error" : undefined}
                  />
                </label>
                <p className="mt-2 text-xs text-muted-foreground">
                  Jarvis uses this name anywhere this node appears. It saves when you continue.
                </p>
                {labelError ? (
                  <p
                    id="jarvis-device-name-error"
                    className="mt-2 text-xs text-destructive-foreground"
                    role="alert"
                  >
                    {labelError}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeStep === "essentials" ? (
            <section aria-labelledby="jarvis-onboarding-essentials" className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2
                  id="jarvis-onboarding-essentials"
                  className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
                >
                  02 · Connections
                </h2>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                    {executionCapabilities === null
                      ? "Capabilities unavailable"
                      : `${jarvisNodePresetLabel(executionCapabilities.preset)} · ${jarvisNodeCapabilitySummary(executionCapabilities)}`}
                  </span>
                  <ShieldCheckIcon className="size-3.5 text-muted-foreground" />
                </div>
              </div>
              <div className="border border-border/60 bg-muted/5 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <NetworkIcon className="mt-0.5 size-4 shrink-0 text-info-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Connection health</p>
                      <p className="text-xs text-muted-foreground">
                        {executionConnected && executionCatalogAvailable
                          ? "This device is connected and ready."
                          : executionConnected
                            ? "Connected, but setup details are still loading."
                            : "Connect a device to continue."}
                      </p>
                    </div>
                  </div>
                  <span
                    className={
                      executionConnected && executionCatalogAvailable
                        ? "font-mono text-[10px] uppercase text-success"
                        : "font-mono text-[10px] uppercase text-warning-foreground"
                    }
                  >
                    {executionConnected
                      ? executionCatalogAvailable
                        ? "Connected"
                        : "Capabilities unknown"
                      : "Needs connection"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {executionNode?.label ?? "Execution node"}:{" "}
                  <span className="font-medium text-foreground">{connectionRoute}</span>.{" "}
                  {tailscaleStatus === "route-detected"
                    ? "A direct route is available."
                    : "Jarvis will use the best available route."}
                </p>
                {routeDetails.length > 1 ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Connected routes: {routeDetails.join(" · ")}
                  </p>
                ) : null}
                {executionNodeSelection.kind === "ambiguous" ? (
                  <div className="mt-2 rounded-lg border border-warning/35 bg-warning/5 px-3 py-2">
                    <p className="text-xs text-warning-foreground">
                      More than one ready device was found. Choose where Jarvis should work.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {executionNodeSelection.nodeIds.map((nodeId) => {
                        const node = onboardingCatalog.nodes.find(
                          (candidate) => candidate.nodeId === nodeId,
                        );
                        return (
                          <Button
                            key={nodeId}
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => setSelectedExecutionNodeId(nodeId)}
                          >
                            {node?.label ?? nodeId}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button type="button" size="xs" variant="ghost" onClick={() => refreshCatalog()}>
                    Refresh <Spinner className={pending ? "size-3" : "hidden"} />
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      dismiss();
                      onOpenConnections();
                    }}
                  >
                    Open Connections <ChevronRightIcon />
                  </Button>
                </div>
              </div>
              {showVoiceHelperStatus ? (
                <div
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/8 px-3 py-2"
                  aria-live="polite"
                >
                  <span className="text-xs text-muted-foreground">Local voice</span>
                  <span
                    className={`font-mono text-[10px] uppercase ${
                      voiceHelperState?.status === "error" ||
                      voiceHelperState?.status === "unavailable"
                        ? "text-warning-foreground"
                        : voiceHelperState?.status === "ready"
                          ? "text-success"
                          : "text-muted-foreground"
                    }`}
                  >
                    {voiceHelperStatusLabel}
                  </span>
                  {canRetryVoiceHelper ? (
                    <Button type="button" size="xs" variant="ghost" onClick={retryVoiceHelper}>
                      Retry
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Providers
                  </h3>
                  {executionCapabilities?.providers && executionProviders.length === 0 ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        dismiss();
                        onOpenProviderSettings();
                      }}
                    >
                      Manage <Settings2Icon />
                    </Button>
                  ) : null}
                </div>
                {!executionCatalogAvailable ? (
                  <p className="rounded-lg border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                    Provider details are still loading. Refresh this device before continuing.
                  </p>
                ) : !executionCapabilities.providers ? (
                  <p className="rounded-lg border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                    No provider is available yet. Connect a device with a provider to run tasks.
                  </p>
                ) : executionProviders.length > 0 ? (
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {executionProviders.map(({ snapshot }) => {
                      const status = classifyJarvisOnboardingProvider(snapshot);
                      const option = getDriverOption(snapshot.driver);
                      const ProviderIcon = option?.icon;
                      return (
                        <button
                          key={snapshot.instanceId}
                          type="button"
                          className="flex min-w-0 items-center gap-2 border border-border/50 bg-muted/5 px-3 py-2 text-left hover:bg-muted/20"
                          onClick={() => {
                            dismiss();
                            onOpenProviderSettings();
                          }}
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/70">
                            {ProviderIcon ? (
                              <ProviderIcon className="size-4" />
                            ) : (
                              <CircleIcon
                                className={`size-2.5 fill-current ${providerStatusClass(status)}`}
                              />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {snapshot.displayName ?? option?.label ?? snapshot.driver}
                          </span>
                          <span
                            className={`shrink-0 font-mono text-[10px] uppercase ${providerStatusClass(status)}`}
                          >
                            {jarvisOnboardingProviderStatusLabel(status)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    No provider status is available yet.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Projects
                  </h3>
                  <FolderGit2Icon className="size-3.5 text-muted-foreground" />
                </div>
                {!executionCatalogAvailable ? (
                  <p className="rounded-lg border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                    Project details are still loading. Refresh this device before continuing.
                  </p>
                ) : !executionCapabilities.projects ? (
                  <p className="rounded-lg border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                    No projects are connected yet. Add one to this device to get started.
                  </p>
                ) : executionProjects.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {executionProjects.map((project) => (
                      <span
                        key={`${project.ref.nodeId}:${project.ref.projectId}`}
                        className="border border-border/50 bg-muted/5 px-2.5 py-1.5 text-xs"
                        aria-label={`${project.title}: ${project.workspaceRoot}`}
                      >
                        {project.title}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    No projects are configured on this execution node yet.
                  </p>
                )}
                {executionCapabilities?.projects ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      dismiss();
                      openCommandPalette({ open: "add-project" });
                    }}
                  >
                    Add project <ChevronRightIcon />
                  </Button>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeStep === "ready" ? (
            <section aria-labelledby="jarvis-onboarding-ready" className="space-y-3">
              <h2
                id="jarvis-onboarding-ready"
                className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
              >
                03 · Ready
              </h2>
              <div className="border border-border/60 bg-muted/5 px-3 py-3">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <CheckCircle2Icon
                    className={
                      readiness.ready ? "size-4 text-success" : "size-4 text-warning-foreground"
                    }
                  />
                  {readinessMessage}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  You can revisit any completed step above before finishing setup.
                </p>
              </div>
            </section>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground"
            >
              <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
        </DialogPanel>

        <DialogFooter className="items-center sm:flex-row sm:justify-between">
          <Button type="button" variant="ghost" onClick={goBack} disabled={activeStepIndex === 0}>
            Back
          </Button>
          {activeStep === "ready" ? (
            <Button type="button" onClick={complete} disabled={!readiness.ready}>
              {readiness.ready ? "Ready" : "Finish setup"}
            </Button>
          ) : (
            <Button type="button" onClick={() => void continueSetup()} disabled={!canContinue}>
              Continue <ChevronRightIcon />
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function shouldShowJarvisOnboarding(input?: {
  readonly environmentId: string | null;
  readonly preset: "full" | "controller" | "headless";
}): boolean {
  if (typeof window === "undefined") return false;
  if (input?.environmentId === null) return true;
  try {
    return !readJarvisOnboardingCompletion(
      window.localStorage,
      input === undefined || input.environmentId === null
        ? undefined
        : { environmentId: input.environmentId, preset: input.preset },
    );
  } catch {
    return false;
  }
}
