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
  return `${environmentId}:${projectId}`;
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
}): MachineProfileSummary {
  const profile = input.profile ?? null;
  const modelSelection = profile ? resolveProfileModel(profile) : null;
  const branchLabel = profile?.branch ?? "Current checkout";
  const workspaceLabel = profile
    ? (profile.worktreePath ??
      (profile.envMode === "worktree" ? "New worktree" : "Current checkout"))
    : "Current checkout";
  const modelLabel =
    modelSelection?.model ?? input.defaultModelSelection?.model ?? "Project default";
  const providerLabel =
    modelSelection?.instanceId ?? input.defaultModelSelection?.instanceId ?? "Project default";
  const executionLabel = profile
    ? `${RUNTIME_MODE_LABELS[profile.runtimeMode]} \u00b7 ${INTERACTION_MODE_LABELS[profile.interactionMode]}${profile.startFromOrigin ? " \u00b7 origin" : ""}`
    : "Project defaults";

  return {
    branchLabel,
    workspaceLabel,
    providerLabel,
    modelLabel,
    executionLabel,
    startFromOrigin: profile?.startFromOrigin ?? false,
  };
}
