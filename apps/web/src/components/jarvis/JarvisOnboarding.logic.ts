import type {
  AdvertisedEndpoint,
  DesktopJarvisVoiceState,
  JarvisNodeCapabilities,
  JarvisNodePreset,
  ServerProvider,
} from "@t3tools/contracts";
import { SERVER_ENVIRONMENT_LABEL_MAX_LENGTH, jarvisNodeSpeechOutput } from "@t3tools/contracts";

export const JARVIS_ONBOARDING_STORAGE_KEY = "t3code:jarvis:onboarding:v1";

export function jarvisRefreshRequestIsCurrent(input: {
  readonly requestId: number;
  readonly latestRequestId: number;
}): boolean {
  return input.requestId === input.latestRequestId;
}

export function validateJarvisNodeLabel(
  input: string,
):
  | { readonly valid: true; readonly value: string }
  | { readonly valid: false; readonly message: string } {
  const value = input.trim();
  if (value.length === 0) {
    return { valid: false, message: "Enter a device name." };
  }
  if (value.length > SERVER_ENVIRONMENT_LABEL_MAX_LENGTH) {
    return {
      valid: false,
      message: `Device names must be ${SERVER_ENVIRONMENT_LABEL_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { valid: true, value };
}

export const jarvisOnboardingSteps = [
  { id: "device", label: "Device" },
  { id: "essentials", label: "Essentials" },
  { id: "ready", label: "Ready" },
] as const;

export type JarvisOnboardingStepId = (typeof jarvisOnboardingSteps)[number]["id"];

export function jarvisOnboardingStepIndex(step: JarvisOnboardingStepId): number {
  return jarvisOnboardingSteps.findIndex((candidate) => candidate.id === step);
}

export function jarvisOnboardingNextStep(step: JarvisOnboardingStepId): JarvisOnboardingStepId {
  return jarvisOnboardingSteps[
    Math.min(jarvisOnboardingSteps.length - 1, jarvisOnboardingStepIndex(step) + 1)
  ]!.id;
}

export function jarvisOnboardingPreviousStep(step: JarvisOnboardingStepId): JarvisOnboardingStepId {
  return jarvisOnboardingSteps[Math.max(0, jarvisOnboardingStepIndex(step) - 1)]!.id;
}

export function canAutoOpenJarvisOnboarding(input: {
  readonly companionMode: boolean;
  readonly environmentReady: boolean;
  readonly attentionTargetPresent: boolean;
  readonly attemptMade: boolean;
  readonly completionStored: boolean;
}): boolean {
  return (
    !input.companionMode &&
    input.environmentReady &&
    !input.attentionTargetPresent &&
    !input.attemptMade &&
    !input.completionStored
  );
}

export function shouldPrepareJarvisOnboardingVoice(input: {
  readonly activeStep: JarvisOnboardingStepId;
  readonly retryRequested: boolean;
  readonly currentState: DesktopJarvisVoiceState | null;
}): boolean {
  return (
    input.activeStep === "essentials" &&
    input.retryRequested &&
    input.currentState !== null &&
    input.currentState.status !== "unavailable"
  );
}

export type JarvisOnboardingProviderStatus = "ready" | "sign-in" | "not-installed" | "attention";

export function classifyJarvisOnboardingProvider(
  provider: Pick<ServerProvider, "enabled" | "installed" | "status" | "auth" | "availability">,
): JarvisOnboardingProviderStatus {
  // Keep this in lockstep with isProviderAvailable: an unavailable driver
  // is a missing setup, while an unauthenticated but installed provider is a
  // sign-in action rather than an unavailable runtime.
  if (provider.availability === "unavailable" || !provider.installed) return "not-installed";
  if (provider.auth.status === "unauthenticated") return "sign-in";
  if (provider.enabled && provider.status === "ready") {
    return "ready";
  }
  return "attention";
}

export function jarvisOnboardingProviderStatusLabel(
  status: JarvisOnboardingProviderStatus,
): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "sign-in":
      return "Sign in";
    case "not-installed":
      return "Not installed";
    case "attention":
      return "Needs attention";
  }
}

export function jarvisNodePresetLabel(preset: JarvisNodeCapabilities["preset"]): string {
  switch (preset) {
    case "full":
      return "Full node";
    case "controller":
      return "Controller node";
    case "headless":
      return "Headless node";
  }
}

export function jarvisNodeCapabilitySummary(capabilities: JarvisNodeCapabilities): string {
  const labels: string[] = [];
  if (capabilities.ui) labels.push("UI");
  if (capabilities.parakeet || jarvisNodeSpeechOutput(capabilities)) labels.push("voice");
  if (capabilities.execution) labels.push("execution");
  if (capabilities.projects) labels.push("projects");
  if (capabilities.providers) labels.push("providers");
  return labels.join(" · ");
}

export function jarvisOnboardingVoiceBridgeFailureState(input: {
  readonly capabilities: JarvisNodeCapabilities | null;
  readonly bridgePresent: boolean;
}): DesktopJarvisVoiceState | null {
  if (
    !input.bridgePresent ||
    input.capabilities?.preset !== "full" ||
    (!input.capabilities.parakeet && !jarvisNodeSpeechOutput(input.capabilities))
  ) {
    return null;
  }
  return { status: "error", native: true, errorCode: "VOICE_BRIDGE_FAILED" };
}

type JarvisTailscaleEndpoint = Pick<AdvertisedEndpoint, "provider" | "httpBaseUrl" | "status">;

function normalizedEndpointUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function jarvisConnectionRouteLabel(input: {
  readonly targetTag: string;
  readonly displayUrl: string | null;
  readonly advertisedEndpoints?: ReadonlyArray<JarvisTailscaleEndpoint>;
}): string {
  if (input.targetTag === "RelayConnectionTarget") return "Relay route";
  if (input.targetTag === "SshConnectionTarget") return "SSH route";
  const matchingEndpoint = input.advertisedEndpoints?.find(
    (endpoint) =>
      input.displayUrl !== null &&
      normalizedEndpointUrl(endpoint.httpBaseUrl) === normalizedEndpointUrl(input.displayUrl),
  );
  if (matchingEndpoint?.provider.id === "tailscale" && matchingEndpoint.status === "available") {
    return "Tailscale route";
  }
  if (input.targetTag === "PrimaryConnectionTarget") return "Local route";
  return "Remote route";
}

export type JarvisTailscaleStatus = "route-detected" | "not-detected";

export function jarvisTailscaleStatus(input: {
  readonly connectionPhase: string;
  readonly targetTag: string;
  readonly displayUrl: string | null;
  /** Existing desktop endpoint metadata is stronger than URL-shape inference. */
  readonly advertisedEndpoints?: ReadonlyArray<JarvisTailscaleEndpoint>;
}): JarvisTailscaleStatus {
  if (input.connectionPhase !== "connected") return "not-detected";
  if (input.targetTag === "RelayConnectionTarget" || input.targetTag === "SshConnectionTarget") {
    return "not-detected";
  }

  const matchingEndpoint = input.advertisedEndpoints?.find(
    (endpoint) =>
      input.displayUrl !== null &&
      normalizedEndpointUrl(endpoint.httpBaseUrl) === normalizedEndpointUrl(input.displayUrl),
  );
  if (matchingEndpoint !== undefined) {
    return matchingEndpoint.provider.id === "tailscale" && matchingEndpoint.status === "available"
      ? "route-detected"
      : "not-detected";
  }

  return "not-detected";
}

type JarvisOnboardingProviderSnapshot = Parameters<typeof classifyJarvisOnboardingProvider>[0];

export interface JarvisOnboardingCatalog {
  readonly nodes: ReadonlyArray<{
    readonly nodeId: string;
    readonly reachability: "online" | "offline";
    readonly capabilities?: JarvisNodeCapabilities;
    readonly catalogError?: string;
  }>;
  readonly projects: ReadonlyArray<{
    readonly ref: { readonly nodeId: string };
  }>;
  readonly providers: ReadonlyArray<{
    readonly nodeId: string;
    readonly snapshot: JarvisOnboardingProviderSnapshot;
  }>;
}

export type JarvisOnboardingReadinessReason =
  | "connection-required"
  | "catalog-unavailable"
  | "execution-node-required"
  | "execution-node-ambiguous"
  | "project-required"
  | "provider-required";

export type JarvisOnboardingReadiness =
  | { readonly ready: true; readonly executionNodeId: string }
  | { readonly ready: false; readonly reason: JarvisOnboardingReadinessReason };

export type JarvisOnboardingExecutionNodeSelection =
  | { readonly kind: "selected"; readonly nodeId: string }
  | { readonly kind: "ambiguous"; readonly nodeIds: ReadonlyArray<string> }
  | { readonly kind: "none" };

function hasProject(catalog: JarvisOnboardingCatalog, nodeId: string): boolean {
  return catalog.projects.some((project) => project.ref.nodeId === nodeId);
}

function hasReadyProvider(catalog: JarvisOnboardingCatalog, nodeId: string): boolean {
  return catalog.providers.some(
    (provider) =>
      provider.nodeId === nodeId && classifyJarvisOnboardingProvider(provider.snapshot) === "ready",
  );
}

/** Selects the node whose resources Essentials should describe and whose readiness can satisfy Jarvis. */
function executionNodeActionability(
  catalog: JarvisOnboardingCatalog,
  node: JarvisOnboardingCatalog["nodes"][number],
): number {
  if (node.capabilities?.execution !== true) return -1;
  let score = 0;
  if (hasProject(catalog, node.nodeId)) score += 2;
  if (hasReadyProvider(catalog, node.nodeId)) score += 1;
  return score;
}

export function jarvisOnboardingExecutionNodeSelection(input: {
  readonly primaryNodeId: string;
  readonly primaryReachability: "online" | "offline";
  readonly capabilities: JarvisNodeCapabilities | null;
  readonly catalog: JarvisOnboardingCatalog;
  readonly selectedExecutionNodeId?: string | null;
}): JarvisOnboardingExecutionNodeSelection {
  if (input.primaryReachability !== "online") return { kind: "none" };
  if (
    input.capabilities?.execution &&
    input.capabilities.projects &&
    input.capabilities.providers
  ) {
    const primary = input.catalog.nodes.find(
      (node) => node.nodeId === input.primaryNodeId && node.reachability === "online",
    );
    return primary === undefined ? { kind: "none" } : { kind: "selected", nodeId: primary.nodeId };
  }
  const candidates = input.catalog.nodes
    .filter(
      (node) =>
        node.nodeId !== input.primaryNodeId &&
        node.reachability === "online" &&
        node.capabilities?.execution === true &&
        node.catalogError === undefined,
    )
    .sort(
      (left, right) =>
        executionNodeActionability(input.catalog, right) -
        executionNodeActionability(input.catalog, left),
    );
  if (candidates.length === 0) return { kind: "none" };
  const selected = candidates.find(
    (candidate) => candidate.nodeId === input.selectedExecutionNodeId,
  );
  if (selected !== undefined) return { kind: "selected", nodeId: selected.nodeId };
  const bestScore = executionNodeActionability(input.catalog, candidates[0]!);
  const best = candidates.filter(
    (candidate) => executionNodeActionability(input.catalog, candidate) === bestScore,
  );
  return best.length === 1
    ? { kind: "selected", nodeId: best[0]!.nodeId }
    : { kind: "ambiguous", nodeIds: best.map((candidate) => candidate.nodeId) };
}

export function jarvisOnboardingExecutionNodeId(input: {
  readonly primaryNodeId: string;
  readonly primaryReachability: "online" | "offline";
  readonly capabilities: JarvisNodeCapabilities | null;
  readonly catalog: JarvisOnboardingCatalog;
  readonly selectedExecutionNodeId?: string | null;
}): string | null {
  const selection = jarvisOnboardingExecutionNodeSelection(input);
  return selection.kind === "selected" ? selection.nodeId : null;
}

export function jarvisOnboardingReadiness(input: {
  readonly primaryNodeId: string;
  readonly primaryReachability: "online" | "offline";
  readonly capabilities: JarvisNodeCapabilities | null;
  readonly catalog: JarvisOnboardingCatalog;
  readonly selectedExecutionNodeId?: string | null;
}): JarvisOnboardingReadiness {
  if (input.primaryReachability !== "online") {
    return { ready: false, reason: "connection-required" };
  }
  const primaryNode = input.catalog.nodes.find((node) => node.nodeId === input.primaryNodeId);
  if (
    input.capabilities === null ||
    primaryNode === undefined ||
    primaryNode.catalogError !== undefined
  ) {
    return { ready: false, reason: "catalog-unavailable" };
  }

  const executionNodeSelection = jarvisOnboardingExecutionNodeSelection(input);
  if (executionNodeSelection.kind === "none") {
    return { ready: false, reason: "execution-node-required" };
  }
  if (executionNodeSelection.kind === "ambiguous") {
    return { ready: false, reason: "execution-node-ambiguous" };
  }
  const executionNodeId = executionNodeSelection.nodeId;
  const executionNode = input.catalog.nodes.find((node) => node.nodeId === executionNodeId);
  if (executionNode?.catalogError !== undefined || executionNode?.capabilities === undefined) {
    return { ready: false, reason: "catalog-unavailable" };
  }
  if (!hasProject(input.catalog, executionNodeId)) {
    return { ready: false, reason: "project-required" };
  }
  if (!hasReadyProvider(input.catalog, executionNodeId)) {
    return { ready: false, reason: "provider-required" };
  }
  return { ready: true, executionNodeId };
}

const JARVIS_ONBOARDING_MIGRATION_KEY = `${JARVIS_ONBOARDING_STORAGE_KEY}:migrated`;

export function readJarvisOnboardingCompletion(
  storage: Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>,
  input?: { readonly environmentId: string; readonly preset: JarvisNodePreset },
): boolean {
  try {
    if (input === undefined) return storage.getItem(JARVIS_ONBOARDING_STORAGE_KEY) === "completed";
    const scopedKey = jarvisOnboardingCompletionKey(input);
    if (storage.getItem(scopedKey) === "completed") return true;
    if (storage.getItem(JARVIS_ONBOARDING_STORAGE_KEY) !== "completed") return false;
    const migratedTo = storage.getItem(JARVIS_ONBOARDING_MIGRATION_KEY);
    if (migratedTo !== null && migratedTo !== scopedKey) return false;
    storage.setItem(scopedKey, "completed");
    storage.setItem(JARVIS_ONBOARDING_MIGRATION_KEY, scopedKey);
    storage.removeItem?.(JARVIS_ONBOARDING_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function jarvisOnboardingCompletionKey(input: {
  readonly environmentId: string;
  readonly preset: JarvisNodePreset;
}): string {
  return `${JARVIS_ONBOARDING_STORAGE_KEY}:${encodeURIComponent(input.environmentId)}:${input.preset}`;
}

export function writeJarvisOnboardingCompletion(
  storage: Pick<Storage, "setItem">,
  input?: { readonly environmentId: string; readonly preset: JarvisNodePreset },
): void {
  try {
    storage.setItem(
      input === undefined ? JARVIS_ONBOARDING_STORAGE_KEY : jarvisOnboardingCompletionKey(input),
      "completed",
    );
  } catch {
    // A blocked localStorage should not prevent the user from using Jarvis.
  }
}
