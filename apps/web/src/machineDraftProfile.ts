import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadEnvMode,
} from "@t3tools/contracts";

export interface MachineDraftProfile {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
  envMode: ThreadEnvMode;
  startFromOrigin: boolean;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  activeProvider: ProviderInstanceId | null;
}

export type MachineDraftProfileMap = Record<string, MachineDraftProfile>;

export interface MachineProfileSummary {
  branchLabel: string;
  workspaceLabel: string;
  providerLabel: string;
  modelLabel: string;
  executionLabel: string;
  startFromOrigin: boolean;
}

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Approval required",
  auto: "Auto",
  "auto-accept-edits": "Auto accept edits",
  "full-access": "Full access",
};

const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Build",
  plan: "Plan",
};

export function physicalProjectProfileKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string {
  return JSON.stringify([environmentId, projectId]);
}

function resolveProfileModel(profile: MachineDraftProfile): ModelSelection | null {
  if (profile.activeProvider) {
    const activeSelection = profile.modelSelectionByProvider[profile.activeProvider];
    if (activeSelection) return activeSelection;
  }
  return Object.values(profile.modelSelectionByProvider)[0] ?? null;
}

export function resolveMachineProfileSummary(input: {
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null | undefined;
  profile: MachineDraftProfile | null | undefined;
  modelSelectionOverride?: ModelSelection | null;
  fallbackExecutionProfile?: Pick<
    MachineDraftProfile,
    "runtimeMode" | "interactionMode" | "startFromOrigin"
  > | null;
}): MachineProfileSummary {
  const profile = input.profile ?? null;
  const executionProfile = profile ?? input.fallbackExecutionProfile ?? null;
  const hasModelSelectionOverride = input.modelSelectionOverride !== undefined;
  const modelSelection = hasModelSelectionOverride
    ? input.modelSelectionOverride
    : profile
      ? resolveProfileModel(profile)
      : null;
  const defaultModelSelection = hasModelSelectionOverride ? null : input.defaultModelSelection;
  const branchLabel = profile?.branch ?? "Current checkout";
  const workspaceLabel = profile
    ? (profile.worktreePath ??
      (profile.envMode === "worktree" ? "New worktree" : "Current checkout"))
    : "Current checkout";
  const modelLabel =
    modelSelection?.model ??
    defaultModelSelection?.model ??
    (hasModelSelectionOverride ? "No model available" : "Project default");
  const providerLabel =
    modelSelection?.instanceId ??
    defaultModelSelection?.instanceId ??
    (hasModelSelectionOverride ? "No provider available" : "Project default");
  const executionLabel = executionProfile
    ? `${RUNTIME_MODE_LABELS[executionProfile.runtimeMode]} \u00b7 ${INTERACTION_MODE_LABELS[executionProfile.interactionMode]}${executionProfile.startFromOrigin ? " \u00b7 origin" : ""}`
    : "Project defaults";

  return {
    branchLabel,
    workspaceLabel,
    providerLabel,
    modelLabel,
    executionLabel,
    startFromOrigin: executionProfile?.startFromOrigin ?? false,
  };
}
