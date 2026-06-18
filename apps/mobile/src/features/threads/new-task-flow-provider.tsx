import React, { useCallback, useMemo, useRef, useState } from "react";

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
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("local");
  const [selectedBranchName, setSelectedBranchName] = useState<string | null>(null);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const branchLoadVersionRef = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>(
    DEFAULT_PROVIDER_INTERACTION_MODE,
  );
  const [modelSelectionOverrides, setModelSelectionOverrides] = useState<
    Record<string, ModelSelection>
  >({});
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const reset = useCallback(() => {
    setSelectedEnvironmentId(null);
    setSelectedProjectKey(null);
    setSelectedModelKey(null);
    setWorkspaceMode("local");
    setSelectedBranchName(null);
    setSelectedWorktreePath(null);
    setSubmitting(false);
    setBranchQuery("");
    setRuntimeMode(DEFAULT_RUNTIME_MODE);
    setInteractionMode(DEFAULT_PROVIDER_INTERACTION_MODE);
    setModelSelectionOverrides({});
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

  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        selectedEnvironmentServerConfig,
        selectedProject?.defaultModelSelection ?? null,
      ),
    [selectedEnvironmentServerConfig, selectedProject?.defaultModelSelection],
  );

  const defaultModelKey = selectedProject?.defaultModelSelection
    ? `${selectedProject.defaultModelSelection.instanceId}:${selectedProject.defaultModelSelection.model}`
    : null;
  const baseSelectedModel =
    modelOptions.find((option) => option.key === selectedModelKey)?.selection ??
    (defaultModelKey
      ? modelOptions.find((option) => option.key === defaultModelKey)?.selection
      : null) ??
    selectedProject?.defaultModelSelection ??
    modelOptions[0]?.selection ??
    null;
  const selectedModelIdentity = baseSelectedModel
    ? `${baseSelectedModel.instanceId}:${baseSelectedModel.model}`
    : null;
  const selectedModel =
    (selectedModelIdentity ? modelSelectionOverrides[selectedModelIdentity] : null) ??
    baseSelectedModel;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.instanceId === selectedModel.instanceId &&
        option.selection.model === selectedModel.model,
    ) ?? null;
  const selectedProviderSkills =
    selectedEnvironmentServerConfig?.providers.find(
      (provider) => provider.instanceId === selectedModel?.instanceId,
    )?.skills ?? [];
  const setSelectedModelOptions = useCallback(
    (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
      if (!selectedModel || !selectedModelIdentity) {
        return;
      }
      const nextSelection: ModelSelection = options
        ? { ...selectedModel, options }
        : {
            instanceId: selectedModel.instanceId,
            model: selectedModel.model,
          };
      setModelSelectionOverrides((current) => ({
        ...current,
        [selectedModelIdentity]: nextSelection,
      }));
    },
    [selectedModel, selectedModelIdentity],
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
    branchLoadVersionRef.current += 1;
    setSelectedEnvironmentId(project.environmentId);
    setSelectedProjectKey(nextProjectKey);
    setSelectedBranchName(null);
    setSelectedWorktreePath(null);
    setModelSelectionOverrides({});
  }, []);

  const selectEnvironment = useCallback((environmentId: EnvironmentId) => {
    branchLoadVersionRef.current += 1;
    setSelectedEnvironmentId(environmentId);
    setSelectedProjectKey(null);
    setSelectedBranchName(null);
    setSelectedWorktreePath(null);
    setModelSelectionOverrides({});
  }, []);

  const selectBranch = useCallback(
    (branch: VcsRef) => {
      setSelectedBranchName(branch.name);
      setSelectedWorktreePath(
        selectedProject ? normalizeSelectedWorktreePath(selectedProject, branch) : null,
      );
    },
    [selectedProject],
  );

  const loadBranches = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    const loadVersion = ++branchLoadVersionRef.current;
    const projectKey = scopedProjectKey(selectedProject.environmentId, selectedProject.id);
    branchState.refresh();
    if (loadVersion !== branchLoadVersionRef.current || selectedProjectKey !== projectKey) {
      return;
    }
    setPendingConnectionError(null);
    if (workspaceMode === "worktree" && !selectedBranchName) {
      const preferredBranch =
        availableBranches.find((branch) => branch.current)?.name ??
        availableBranches.find((branch) => branch.isDefault)?.name ??
        null;
      if (preferredBranch) {
        setSelectedBranchName(preferredBranch);
      }
    }
  }, [
    availableBranches,
    branchState,
    selectedBranchName,
    selectedProject,
    selectedProjectKey,
    workspaceMode,
  ]);

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
