import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ScopedThreadRef,
  type ThreadEnvMode,
  type VcsRef,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveDefaultThreadEnvMode } from "@t3tools/shared/threadEnvMode";

import {
  deriveEffectiveComposerModelState,
  type ComposerThreadDraftState,
  type DraftId,
  type DraftSessionState,
} from "../composerDraftStore";
import { getComposerProviderState } from "../components/chat/composerProviderState";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { getAppModelOptionsForInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveProviderDriverKindForInstanceSelection,
  resolveSelectableProviderInstanceEntry,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import type { ThreadRouteTarget } from "../threadRoutes";
import type {
  VoiceToolsWebRepositoryDependencies,
  VoiceWebStartThreadDefaults,
} from "./voiceToolsRepository";

type ComposerTarget = ScopedThreadRef | DraftId;

export interface VoiceStartDefaultsEnvironmentState {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}

export interface VoiceStartDefaultsGitState {
  readonly isRepo: boolean;
  readonly refs: ReadonlyArray<Pick<VcsRef, "name" | "current" | "isDefault">>;
  readonly currentBranch: string | null;
}

export interface VoiceStartDefaultsResolverDependencies {
  readonly getCurrentRouteTarget: () => ThreadRouteTarget | null;
  readonly readComposerDraft: (
    target: ComposerTarget,
  ) => Pick<
    ComposerThreadDraftState,
    "activeProvider" | "modelSelectionByProvider" | "runtimeMode" | "interactionMode"
  > | null;
  readonly readThreadShell: (
    ref: ScopedThreadRef,
  ) => Pick<EnvironmentThreadShell, "modelSelection" | "runtimeMode" | "interactionMode"> | null;
  readonly readDraftSession: (
    draftId: DraftId,
  ) => Pick<DraftSessionState, "runtimeMode" | "interactionMode"> | null;
  readonly readStickyModelState: () => Pick<
    ComposerThreadDraftState,
    "activeProvider" | "modelSelectionByProvider"
  >;
  readonly readTargetEnvironment: (
    environmentId: EnvironmentId,
  ) => VoiceStartDefaultsEnvironmentState | null;
  readonly readPrimaryThreadDefaults: () => Pick<
    ServerSettings,
    "defaultThreadEnvMode" | "newWorktreesStartFromOrigin"
  >;
  readonly readProjectFileDefaultThreadEnvMode: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => Promise<ThreadEnvMode | null>;
  readonly readGitState: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => Promise<VoiceStartDefaultsGitState>;
}

export type VoiceStartDefaultsUnavailableReason =
  | "target-environment-unavailable"
  | "provider-unavailable"
  | "model-unavailable"
  | "git-unavailable"
  | "worktree-base-unavailable";

export class VoiceStartDefaultsUnavailableError extends Error {
  override readonly name = "VoiceStartDefaultsUnavailableError";

  constructor(readonly reason: VoiceStartDefaultsUnavailableReason) {
    super(`Voice start defaults unavailable: ${reason}.`);
  }
}

function resolveCarryState(dependencies: VoiceStartDefaultsResolverDependencies) {
  const routeTarget = dependencies.getCurrentRouteTarget();
  const composerTarget =
    routeTarget?.kind === "server"
      ? routeTarget.threadRef
      : routeTarget?.kind === "draft"
        ? routeTarget.draftId
        : null;
  const composer = composerTarget ? dependencies.readComposerDraft(composerTarget) : null;
  const shell =
    routeTarget?.kind === "server" ? dependencies.readThreadShell(routeTarget.threadRef) : null;
  const draft =
    routeTarget?.kind === "draft" ? dependencies.readDraftSession(routeTarget.draftId) : null;
  const composerModelSelection = composer?.activeProvider
    ? (composer.modelSelectionByProvider[composer.activeProvider] ?? null)
    : null;

  return {
    modelSelection: composerModelSelection ?? shell?.modelSelection ?? null,
    runtimeMode:
      composer?.runtimeMode ?? shell?.runtimeMode ?? draft?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      composer?.interactionMode ??
      shell?.interactionMode ??
      draft?.interactionMode ??
      DEFAULT_PROVIDER_INTERACTION_MODE,
  };
}

function resolveDraftModelState(
  sticky: Pick<ComposerThreadDraftState, "activeProvider" | "modelSelectionByProvider">,
  carryModelSelection: ModelSelection | null,
): Pick<ComposerThreadDraftState, "activeProvider" | "modelSelectionByProvider"> {
  if (carryModelSelection === null) {
    return {
      activeProvider: sticky.activeProvider,
      modelSelectionByProvider: { ...sticky.modelSelectionByProvider },
    };
  }
  return {
    activeProvider: carryModelSelection.instanceId,
    modelSelectionByProvider: {
      ...sticky.modelSelectionByProvider,
      [carryModelSelection.instanceId]: carryModelSelection,
    },
  };
}

function resolveProviderEntry(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly draft: Pick<ComposerThreadDraftState, "activeProvider" | "modelSelectionByProvider">;
  readonly projectModelSelection: ModelSelection | null | undefined;
}): ProviderInstanceEntry | undefined {
  const explicitInstanceId = input.draft.activeProvider ?? input.projectModelSelection?.instanceId;
  const requestedDriverKind =
    resolveProviderDriverKindForInstanceSelection(
      input.entries,
      input.providers,
      explicitInstanceId,
    ) ?? input.entries[0]?.driverKind;

  const candidates: ReadonlyArray<ProviderInstanceId | null | undefined> = [
    input.draft.activeProvider,
    input.projectModelSelection?.instanceId,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const entry = input.entries.find(
      (item) => item.instanceId === candidate && item.enabled && item.isAvailable,
    );
    if (entry) return entry;
  }

  const requestedEntries = input.entries.filter(
    (entry) => entry.driverKind === requestedDriverKind,
  );
  return (
    resolveSelectableProviderInstanceEntry(requestedEntries, undefined) ??
    resolveSelectableProviderInstanceEntry(input.entries, undefined)
  );
}

function resolveModelSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly draft: Pick<ComposerThreadDraftState, "activeProvider" | "modelSelectionByProvider">;
}): ModelSelection {
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(input.providers), input.settings),
  );
  const entry = resolveProviderEntry({ ...input, entries });
  if (!entry) {
    throw new VoiceStartDefaultsUnavailableError("provider-unavailable");
  }

  const effective = deriveEffectiveComposerModelState({
    draft: input.draft,
    providers: input.providers,
    selectedProvider: entry.driverKind,
    selectedInstanceId: entry.instanceId,
    threadModelSelection: null,
    projectModelSelection: input.projectModelSelection,
    settings: input.settings,
  });
  const model = effective.selectedModel;
  const realModel = getAppModelOptionsForInstance(input.settings, entry).some(
    (option) => option.slug === model,
  );
  if (!model || !realModel) {
    throw new VoiceStartDefaultsUnavailableError("model-unavailable");
  }

  const providerState = getComposerProviderState({
    provider: entry.driverKind,
    model,
    models: entry.models,
    modelOptions: effective.modelOptions?.[entry.instanceId],
  });
  return createModelSelection(entry.instanceId, model, providerState.modelOptionsForDispatch);
}

function resolveWorktreeBaseBranch(git: VoiceStartDefaultsGitState): string | null {
  return (
    git.refs.find((ref) => ref.isDefault)?.name ??
    git.currentBranch ??
    git.refs.find((ref) => ref.current)?.name ??
    null
  );
}

export function createVoiceStartDefaultsResolver(
  dependencies: VoiceStartDefaultsResolverDependencies,
): VoiceToolsWebRepositoryDependencies["resolveStartThreadDefaults"] {
  return async ({ project }): Promise<VoiceWebStartThreadDefaults> => {
    const environment = dependencies.readTargetEnvironment(project.environmentId);
    if (environment === null) {
      throw new VoiceStartDefaultsUnavailableError("target-environment-unavailable");
    }

    const carry = resolveCarryState(dependencies);
    const draft = resolveDraftModelState(dependencies.readStickyModelState(), carry.modelSelection);
    const modelSelection = resolveModelSelection({
      providers: environment.providers,
      settings: environment.settings,
      projectModelSelection: project.defaultModelSelection,
      draft,
    });
    // Match useHandleNewThread: global thread defaults belong to the primary
    // client environment even when the selected project is remote.
    const primaryDefaults = dependencies.readPrimaryThreadDefaults();
    const projectFileMode =
      project.defaultThreadEnvMode == null
        ? await dependencies.readProjectFileDefaultThreadEnvMode(
            project.environmentId,
            project.workspaceRoot,
          )
        : null;
    const envMode = resolveDefaultThreadEnvMode({
      projectSetting: project.defaultThreadEnvMode,
      projectFile: projectFileMode,
      globalDefault: primaryDefaults.defaultThreadEnvMode,
    });
    const interactionMode = environment.settings.planModeEnabled
      ? carry.interactionMode
      : DEFAULT_PROVIDER_INTERACTION_MODE;

    if (envMode === "local") {
      return {
        modelSelection,
        runtimeMode: carry.runtimeMode,
        interactionMode,
        workspace: { mode: "local", branch: null, worktreePath: null },
      };
    }

    let git: VoiceStartDefaultsGitState;
    try {
      git = await dependencies.readGitState(project.environmentId, project.workspaceRoot);
    } catch {
      throw new VoiceStartDefaultsUnavailableError("git-unavailable");
    }
    if (!git.isRepo) {
      return {
        modelSelection,
        runtimeMode: carry.runtimeMode,
        interactionMode,
        workspace: { mode: "local", branch: null, worktreePath: null },
      };
    }

    const baseBranch = resolveWorktreeBaseBranch(git);
    if (baseBranch === null) {
      throw new VoiceStartDefaultsUnavailableError("worktree-base-unavailable");
    }
    return {
      modelSelection,
      runtimeMode: carry.runtimeMode,
      interactionMode,
      workspace: {
        mode: "worktree",
        baseBranch,
        startFromOrigin: resolveNewDraftStartFromOrigin({
          envMode,
          newWorktreesStartFromOrigin: primaryDefaults.newWorktreesStartFromOrigin,
        }),
      },
    };
  };
}
