import React, { useCallback, useEffect, useMemo, useState } from "react";

import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";

import { useEnvironmentServerConfig, useProjects, useThreadShells } from "../../state/entities";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import { scopedProjectKey } from "../../lib/scopedEntities";
import {
  appendComposerDraftAttachments,
  removeComposerDraftAttachment,
  replaceComposerDraftAttachments,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { useBranches } from "../../state/queries";
import {
  setPendingConnectionError,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type VcsRef } from "@t3tools/client-runtime/state/vcs";

type WorkspaceMode = "local" | "worktree";

function normalizeSelectedWorktreePath(project: EnvironmentProject, branch: VcsRef): string | null {
  if (!branch.worktreePath) {
    return null;
  }

  return branch.worktreePath === project.workspaceRoot ? null : branch.worktreePath;
}

export function branchBadgeLabel(input: {
  readonly branch: VcsRef;
  readonly project: EnvironmentProject | null;
}): string | null {
  if (input.branch.current) {
    return "current";
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot) {
    return "worktree";
  }
  if (input.branch.isDefault) {
    return "default";
  }
  if (input.branch.isRemote) {
    return "remote";
  }
  return null;
}

type NewTaskFlowContextValue = {
  readonly logicalProjects: ReadonlyArray<{
    readonly key: string;
    readonly project: EnvironmentProject;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModelKey: string | null;
  readonly workspaceMode: WorkspaceMode;
  readonly selectedBranchName: string | null;
  readonly selectedWorktreePath: string | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly submitting: boolean;
  readonly branchQuery: string;
  readonly branchesLoading: boolean;
  readonly availableBranches: ReadonlyArray<VcsRef>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }>;
  readonly selectedProject: EnvironmentProject | null;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly selectedProviderSkills: ReadonlyArray<ServerProviderSkill>;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly filteredBranches: ReadonlyArray<VcsRef>;
  readonly reset: () => void;
  readonly setProject: (project: EnvironmentProject) => void;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  readonly setSelectedModelKey: (key: string | null) => void;
  readonly setWorkspaceMode: (mode: WorkspaceMode) => void;
  readonly selectBranch: (branch: VcsRef) => void;
  readonly setPrompt: (value: string) => void;
  readonly replaceAttachments: (attachments: ReadonlyArray<DraftComposerImageAttachment>) => void;
  readonly appendAttachments: (attachments: ReadonlyArray<DraftComposerImageAttachment>) => void;
  readonly removeAttachment: (imageId: string) => void;
  readonly clearAttachments: () => void;
  readonly setSubmitting: (value: boolean) => void;
  readonly setBranchQuery: (value: string) => void;
  readonly loadBranches: () => Promise<void>;
  readonly setRuntimeMode: (value: RuntimeMode) => void;
  readonly setInteractionMode: (value: ProviderInteractionMode) => void;
  readonly setSelectedModelOptions: (
    value: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(props: React.PropsWithChildren) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();

  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects, threads }),
    [projects, threads],
  );
  const logicalProjects = useMemo(
    () =>
      pipe(
        repositoryGroups,
        Arr.map((group) => {
          const primaryProject = group.projects[0]?.project;
          if (!primaryProject) {
            return null;
          }
          return { key: group.key, project: primaryProject };
        }),
        Arr.filter(
          (
            entry,
          ): entry is {
            readonly key: string;
            readonly project: EnvironmentProject;
          } => entry !== null,
        ),
      ),
    [repositoryGroups],
  );

  const [selectedEnvironmentIdOverride, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const selectedEnvironmentId =
    selectedEnvironmentIdOverride !== null &&
    projects.some((project) => project.environmentId === selectedEnvironmentIdOverride)
      ? selectedEnvironmentIdOverride
      : (projects[0]?.environmentId ?? null);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const reset = useCallback(() => {
    setSelectedEnvironmentId(null);
    setSelectedProjectKey(null);
    setSubmitting(false);
    setBranchQuery("");
    setExpandedProvider(null);
  }, []);

  const environments = useMemo(
    () =>
      pipe(
        [
          ...new Set(
            pipe(
              projects,
              Arr.map((project) => project.environmentId),
            ),
          ),
        ],
        Arr.map((environmentId) => {
          const environment = savedConnectionsById[environmentId];
          if (!environment) {
            return null;
          }

          return {
            environmentId,
            environmentLabel: environment.environmentLabel,
          };
        }),
        Arr.filter(
          (
            entry,
          ): entry is {
            readonly environmentId: EnvironmentId;
            readonly environmentLabel: string;
          } => entry !== null,
        ),
      ),
    [projects, savedConnectionsById],
  );

  const projectsForEnvironment = useMemo(
    () =>
      pipe(
        projects,
        Arr.filter((project) => project.environmentId === selectedEnvironmentId),
      ),
    [projects, selectedEnvironmentId],
  );

  const selectedProject =
    projectsForEnvironment.find(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    ) ??
    projectsForEnvironment[0] ??
    null;
  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(
    selectedProject?.environmentId ?? null,
  );
  const selectedProjectDraftKey = selectedProject
    ? `new-task:${scopedProjectKey(selectedProject.environmentId, selectedProject.id)}`
    : null;
  const selectedProjectDraft = useComposerDraft(selectedProjectDraftKey);
  const prompt = selectedProjectDraft.text;
  const attachments = selectedProjectDraft.attachments;
  const workspaceMode = selectedProjectDraft.workspaceSelection?.mode ?? "local";
  const selectedBranchName = selectedProjectDraft.workspaceSelection?.branch ?? null;
  const selectedWorktreePath = selectedProjectDraft.workspaceSelection?.worktreePath ?? null;
  const runtimeMode = selectedProjectDraft.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = selectedProjectDraft.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;

  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        selectedEnvironmentServerConfig,
        selectedProjectDraft.modelSelection ?? selectedProject?.defaultModelSelection ?? null,
      ),
    [
      selectedEnvironmentServerConfig,
      selectedProject?.defaultModelSelection,
      selectedProjectDraft.modelSelection,
    ],
  );

  const selectedModel =
    selectedProjectDraft.modelSelection ??
    selectedProject?.defaultModelSelection ??
    modelOptions[0]?.selection ??
    null;
  const selectedModelKey = selectedModel
    ? `${selectedModel.instanceId}:${selectedModel.model}`
    : null;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.instanceId === selectedModel.instanceId &&
        option.selection.model === selectedModel.model,
    ) ?? null;
  const selectedProviderSkills = useMemo(
    () =>
      selectedEnvironmentServerConfig?.providers.find(
        (provider) => provider.instanceId === selectedModel?.instanceId,
      )?.skills ?? [],
    [selectedEnvironmentServerConfig, selectedModel?.instanceId],
  );
  const setSelectedModelKey = useCallback(
    (key: string | null) => {
      if (!key || !selectedProjectDraftKey) {
        return;
      }
      const option = modelOptions.find((candidate) => candidate.key === key);
      if (!option) {
        return;
      }
      updateComposerDraftSettings(selectedProjectDraftKey, {
        modelSelection: option.selection,
      });
    },
    [modelOptions, selectedProjectDraftKey],
  );
  const setSelectedModelOptions = useCallback(
    (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
      if (!selectedModel || !selectedProjectDraftKey) {
        return;
      }
      const nextSelection: ModelSelection = options
        ? { ...selectedModel, options }
        : {
            instanceId: selectedModel.instanceId,
            model: selectedModel.model,
          };
      updateComposerDraftSettings(selectedProjectDraftKey, {
        modelSelection: nextSelection,
      });
    },
    [selectedModel, selectedProjectDraftKey],
  );

  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const setPrompt = useCallback(
    (value: string) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      setComposerDraftText(selectedProjectDraftKey, value);
    },
    [selectedProjectDraftKey],
  );
  const replaceAttachments = useCallback(
    (nextAttachments: ReadonlyArray<DraftComposerImageAttachment>) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      replaceComposerDraftAttachments(selectedProjectDraftKey, nextAttachments);
    },
    [selectedProjectDraftKey],
  );
  const appendAttachments = useCallback(
    (nextAttachments: ReadonlyArray<DraftComposerImageAttachment>) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      appendComposerDraftAttachments(selectedProjectDraftKey, nextAttachments);
    },
    [selectedProjectDraftKey],
  );
  const removeAttachment = useCallback(
    (imageId: string) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      removeComposerDraftAttachment(selectedProjectDraftKey, imageId);
    },
    [selectedProjectDraftKey],
  );
  const clearAttachments = useCallback(() => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, []);
  }, [selectedProjectDraftKey]);
  const branchTarget = useMemo(
    () => ({
      environmentId: selectedProject?.environmentId ?? null,
      cwd: selectedProject?.workspaceRoot ?? null,
      query: null,
    }),
    [selectedProject?.environmentId, selectedProject?.workspaceRoot],
  );
  const branchState = useBranches(branchTarget);
  const branchesLoading = branchState.isPending;
  const availableBranches = useMemo(
    () =>
      pipe(
        branchState.data?.refs ?? [],
        Arr.filter((branch) => !branch.isRemote),
      ),
    [branchState.data?.refs],
  );

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase();
    if (query.length === 0) {
      return availableBranches;
    }

    return pipe(
      availableBranches,
      Arr.filter((branch) => branch.name.toLowerCase().includes(query)),
    );
  }, [availableBranches, branchQuery]);

  const setProject = useCallback((project: EnvironmentProject) => {
    const nextProjectKey = scopedProjectKey(project.environmentId, project.id);
    setSelectedEnvironmentId(project.environmentId);
    setSelectedProjectKey(nextProjectKey);
  }, []);

  const selectEnvironment = useCallback((environmentId: EnvironmentId) => {
    setSelectedEnvironmentId(environmentId);
    setSelectedProjectKey(null);
  }, []);

  const setWorkspaceMode = useCallback(
    (mode: WorkspaceMode) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      updateComposerDraftSettings(selectedProjectDraftKey, {
        workspaceSelection: {
          mode,
          branch: selectedBranchName,
          worktreePath: selectedWorktreePath,
        },
      });
    },
    [selectedBranchName, selectedProjectDraftKey, selectedWorktreePath],
  );

  const selectBranch = useCallback(
    (branch: VcsRef) => {
      if (!selectedProject || !selectedProjectDraftKey) {
        return;
      }
      updateComposerDraftSettings(selectedProjectDraftKey, {
        workspaceSelection: {
          mode: workspaceMode,
          branch: branch.name,
          worktreePath: normalizeSelectedWorktreePath(selectedProject, branch),
        },
      });
    },
    [selectedProject, selectedProjectDraftKey, workspaceMode],
  );

  const refreshBranches = branchState.refresh;
  const loadBranches = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    setPendingConnectionError(null);
    refreshBranches();
  }, [refreshBranches, selectedProject]);

  useEffect(() => {
    if (workspaceMode !== "worktree" || selectedBranchName !== null) {
      return;
    }
    const preferredBranch =
      availableBranches.find((branch) => branch.current) ??
      availableBranches.find((branch) => branch.isDefault) ??
      null;
    if (preferredBranch) {
      selectBranch(preferredBranch);
    }
  }, [availableBranches, selectBranch, selectedBranchName, workspaceMode]);

  const setRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (selectedProjectDraftKey) {
        updateComposerDraftSettings(selectedProjectDraftKey, { runtimeMode: value });
      }
    },
    [selectedProjectDraftKey],
  );
  const setInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (selectedProjectDraftKey) {
        updateComposerDraftSettings(selectedProjectDraftKey, { interactionMode: value });
      }
    },
    [selectedProjectDraftKey],
  );

  const value = useMemo<NewTaskFlowContextValue>(
    () => ({
      logicalProjects,
      selectedEnvironmentId,
      selectedProjectKey,
      selectedModelKey,
      workspaceMode,
      selectedBranchName,
      selectedWorktreePath,
      prompt,
      attachments,
      submitting,
      branchQuery,
      branchesLoading,
      availableBranches,
      runtimeMode,
      interactionMode,
      expandedProvider,
      environments,
      selectedProject,
      modelOptions,
      selectedModel,
      selectedModelOption,
      selectedProviderSkills,
      providerGroups,
      filteredBranches,
      reset,
      setProject,
      selectEnvironment,
      setSelectedModelKey,
      setWorkspaceMode,
      selectBranch,
      setPrompt,
      replaceAttachments,
      appendAttachments,
      removeAttachment,
      clearAttachments,
      setSubmitting,
      setBranchQuery,
      loadBranches,
      setRuntimeMode,
      setInteractionMode,
      setSelectedModelOptions,
      setExpandedProvider,
    }),
    [
      attachments,
      availableBranches,
      branchQuery,
      branchesLoading,
      environments,
      expandedProvider,
      filteredBranches,
      interactionMode,
      loadBranches,
      logicalProjects,
      modelOptions,
      prompt,
      providerGroups,
      replaceAttachments,
      reset,
      runtimeMode,
      selectedBranchName,
      selectedEnvironmentId,
      selectedModel,
      selectedModelKey,
      selectedModelOption,
      selectedProviderSkills,
      setSelectedModelOptions,
      selectedProject,
      selectedProjectKey,
      selectedWorktreePath,
      setProject,
      selectBranch,
      selectEnvironment,
      setInteractionMode,
      setPrompt,
      setRuntimeMode,
      setSelectedModelKey,
      setWorkspaceMode,
      submitting,
      workspaceMode,
      appendAttachments,
      clearAttachments,
      removeAttachment,
    ],
  );

  return <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>;
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}
