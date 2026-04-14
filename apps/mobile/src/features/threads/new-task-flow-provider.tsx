import React, { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ClaudeCodeEffort,
  EnvironmentId,
  GitBranch,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";

import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { gitBranchManager, useGitBranches } from "../../state/use-git-branches";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import {
  setPendingConnectionError,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";
import { EnvironmentScopedProjectShell } from "@t3tools/client-runtime";

type WorkspaceMode = "local" | "worktree";

function normalizeSelectedWorktreePath(
  project: EnvironmentScopedProjectShell,
  branch: GitBranch,
): string | null {
  if (!branch.worktreePath) {
    return null;
  }

  return branch.worktreePath === project.workspaceRoot ? null : branch.worktreePath;
}

export function branchBadgeLabel(input: {
  readonly branch: GitBranch;
  readonly project: EnvironmentScopedProjectShell | null;
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
    readonly project: EnvironmentScopedProjectShell;
  }>;
  readonly selectedEnvironmentId: EnvironmentId;
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
  readonly availableBranches: ReadonlyArray<GitBranch>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly effort: ClaudeCodeEffort;
  readonly fastMode: boolean;
  readonly contextWindow: string;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }>;
  readonly selectedProject: EnvironmentScopedProjectShell | null;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly filteredBranches: ReadonlyArray<GitBranch>;
  readonly reset: () => void;
  readonly setProject: (project: EnvironmentScopedProjectShell) => void;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  readonly setSelectedModelKey: (key: string | null) => void;
  readonly setWorkspaceMode: (mode: WorkspaceMode) => void;
  readonly selectBranch: (branch: GitBranch) => void;
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
  readonly setEffort: (value: ClaudeCodeEffort) => void;
  readonly setFastMode: (value: boolean) => void;
  readonly setContextWindow: (value: string) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(props: React.PropsWithChildren) {
  const { projects, serverConfigByEnvironmentId, threads } = useRemoteCatalog();
  const { savedConnectionsById } = useRemoteEnvironmentState();

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
            readonly project: EnvironmentScopedProjectShell;
          } => entry !== null,
        ),
      ),
    [repositoryGroups],
  );

  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    projects[0]?.environmentId ?? "",
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("local");
  const [selectedBranchName, setSelectedBranchName] = useState<string | null>(null);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerImageAttachment>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>(
    DEFAULT_PROVIDER_INTERACTION_MODE,
  );
  const [effort, setEffort] = useState<ClaudeCodeEffort>("high");
  const [fastMode, setFastMode] = useState(false);
  const [contextWindow, setContextWindow] = useState("1M");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const replaceAttachments = useCallback(
    (nextAttachments: ReadonlyArray<DraftComposerImageAttachment>) => {
      setAttachments(nextAttachments);
    },
    [],
  );

  const appendAttachments = useCallback(
    (nextAttachments: ReadonlyArray<DraftComposerImageAttachment>) => {
      setAttachments((current) => [...current, ...nextAttachments]);
    },
    [],
  );

  const removeAttachment = useCallback((imageId: string) => {
    setAttachments((current) => current.filter((candidate) => candidate.id !== imageId));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  const reset = useCallback(() => {
    console.log("[new task flow] reset", {
      defaultEnvironmentId: projects[0]?.environmentId ?? null,
      projectCount: projects.length,
    });
    setSelectedEnvironmentId(projects[0]?.environmentId ?? "");
    setSelectedProjectKey(null);
    setSelectedModelKey(null);
    setWorkspaceMode("local");
    setSelectedBranchName(null);
    setSelectedWorktreePath(null);
    setPrompt("");
    clearAttachments();
    setSubmitting(false);
    setBranchQuery("");
    setRuntimeMode(DEFAULT_RUNTIME_MODE);
    setInteractionMode(DEFAULT_PROVIDER_INTERACTION_MODE);
    setEffort("high");
    setFastMode(false);
    setContextWindow("1M");
    setExpandedProvider(null);
  }, [clearAttachments, projects]);

  useEffect(() => {
    if (selectedEnvironmentId || projects.length === 0) {
      return;
    }

    console.log("[new task flow] initializing environment", {
      environmentId: projects[0]!.environmentId,
    });
    setSelectedEnvironmentId(projects[0]!.environmentId);
  }, [projects, selectedEnvironmentId]);

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

  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        selectedProject
          ? (serverConfigByEnvironmentId[selectedProject.environmentId] ?? null)
          : null,
        selectedProject?.defaultModelSelection ?? null,
      ),
    [selectedProject, serverConfigByEnvironmentId],
  );

  const selectedModel =
    modelOptions.find((option) => option.key === selectedModelKey)?.selection ??
    selectedProject?.defaultModelSelection ??
    modelOptions[0]?.selection ??
    null;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.provider === selectedModel.provider &&
        option.selection.model === selectedModel.model,
    ) ?? null;

  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const branchTarget = useMemo(
    () => ({
      environmentId: selectedProject?.environmentId ?? null,
      cwd: selectedProject?.workspaceRoot ?? null,
      query: null,
    }),
    [selectedProject?.environmentId, selectedProject?.workspaceRoot],
  );
  const branchState = useGitBranches(branchTarget);
  const branchesLoading = branchState.isPending;
  const availableBranches = useMemo(
    () =>
      pipe(
        branchState.data?.branches ?? [],
        Arr.filter((branch) => !branch.isRemote),
      ),
    [branchState.data?.branches],
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

  const setProject = useCallback((project: EnvironmentScopedProjectShell) => {
    setSelectedEnvironmentId(project.environmentId);
    setSelectedProjectKey(scopedProjectKey(project.environmentId, project.id));
  }, []);

  const selectEnvironment = useCallback((environmentId: EnvironmentId) => {
    setSelectedEnvironmentId(environmentId);
    setSelectedProjectKey(null);
    setSelectedBranchName(null);
    setSelectedWorktreePath(null);
  }, []);

  const selectBranch = useCallback(
    (branch: GitBranch) => {
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

    try {
      const result = await gitBranchManager.load({
        environmentId: selectedProject.environmentId,
        cwd: selectedProject.workspaceRoot,
        query: null,
      });
      setPendingConnectionError(null);
      const branches = pipe(
        result?.branches ?? [],
        Arr.filter((branch) => !branch.isRemote),
      );

      if (workspaceMode === "worktree" && !selectedBranchName) {
        const preferredBranch =
          branches.find((branch) => branch.current)?.name ??
          branches.find((branch) => branch.isDefault)?.name ??
          null;
        if (preferredBranch) {
          setSelectedBranchName(preferredBranch);
        }
      }
    } catch {
      setPendingConnectionError("Failed to load branches.");
    }
  }, [selectedBranchName, selectedProject, workspaceMode]);

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
      effort,
      fastMode,
      contextWindow,
      expandedProvider,
      environments,
      selectedProject,
      modelOptions,
      selectedModel,
      selectedModelOption,
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
      setEffort,
      setFastMode,
      setContextWindow,
      setExpandedProvider,
    }),
    [
      attachments,
      availableBranches,
      branchQuery,
      branchesLoading,
      contextWindow,
      effort,
      environments,
      expandedProvider,
      fastMode,
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

  useEffect(() => {
    console.log("[new task flow] state", {
      availableBranchCount: availableBranches.length,
      environmentCount: environments.length,
      logicalProjectCount: logicalProjects.length,
      selectedEnvironmentId,
      selectedProjectKey,
      selectedProjectTitle: selectedProject?.title ?? null,
    });
  }, [
    availableBranches.length,
    environments.length,
    logicalProjects.length,
    selectedEnvironmentId,
    selectedProject?.title,
    selectedProjectKey,
  ]);

  return <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>;
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}
