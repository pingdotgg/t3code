import { ChevronDownIcon, PlusIcon, RefreshCwIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createDefaultModelSelection, createModelSelection } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import { AsyncResult } from "effect/unstable/reactivity";
import type {
  KeybindingCommand,
  ModelSelection,
  ProviderInstanceId,
  ProjectActionEnvironment,
  ProjectEffectiveRemote,
  ProjectRemoteOverride,
  ProjectScript,
  ProjectSettingsPatch,
  SidebarProjectGroupingMode,
  SourceControlProviderKind,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { DEFAULT_MODEL } from "@t3tools/contracts";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { ensureLocalApi, readLocalApi } from "../localApi";
import { Button } from "./ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "./ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";
import { Switch } from "./ui/switch";
import { SettingResetButton } from "./settings/settingsLayout";
import { toastManager, stackedThreadToast } from "./ui/toast";
import { DraftInput } from "./ui/draft-input";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "./ProjectScriptsControl";
import { commandForProjectScript, nextProjectScriptId } from "../projectScripts";
import {
  syncProjectScriptKeybinding,
  throwOnAtomCommandFailure,
} from "../lib/projectScriptKeybindings";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdateClientSettings,
} from "../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
} from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveProjectProviderInstancePolicy,
  sortProviderInstanceEntries,
} from "../providerInstances";
import {
  commitProviderSettingsThenDefaultModel,
  confirmedProjectSettingsDraftKeys,
  type ProjectSettingsDraft,
  type ProjectSettingsDraftKey,
} from "../projectSettingsCommit";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { TraitsPicker } from "./chat/TraitsPicker";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import {
  EMPTY_SERVER_PROVIDERS,
  primaryServerKeybindingsAtom,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../state/server";
import { deriveProjectGroupingOverrideKey, selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useT3ProjectFile } from "../hooks/useT3ProjectFileScripts";
import T3ProjectFileSettings from "./T3ProjectFileSettings";
import {
  clearComposerDraftsForProjectGroup,
  clearComposerDraftsForProjectGroupMember,
} from "../composerDraftStore";
import { removeProjectGroupMembersSequentially } from "../projectGroupRemoval";
import {
  openProjectSettingsDialog,
  useProjectSettingsDialogStore,
  type ProjectSettingsDialogTarget,
} from "../projectSettingsDialogStore";

const PROVIDER_LABELS: Record<SourceControlProviderKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  "azure-devops": "Azure DevOps",
  bitbucket: "Bitbucket",
  unknown: "Generic",
};

const DEFAULT_PROJECT_MODEL_SELECTION = createDefaultModelSelection();
const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL_MS = Duration.toMillis(Duration.seconds(30));
const GIT_FETCH_INTERVAL_STEP_SECONDS = 5;
const THREAD_ENV_MODE_LABELS: Record<ThreadEnvMode, string> = {
  local: "Local",
  worktree: "New worktree",
};
const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

const EMPTY_ACTION_ENVIRONMENT: ProjectActionEnvironment = {};
const EMPTY_DISABLED_PROVIDER_INSTANCE_IDS: ProviderInstanceId[] = [];
const ACTION_ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ACTION_ENVIRONMENT_RESERVED_PREFIX = "T3CODE_";

interface RemoteOverrideDraft {
  readonly enabled: boolean;
  readonly provider: SourceControlProviderKind;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly webUrl: string;
}

const REMOTE_OVERRIDE_DRAFT_KEYS: readonly ProjectSettingsDraftKey[] = [
  "overrideEnabled",
  "provider",
  "remoteName",
  "remoteUrl",
  "webUrl",
];

interface ProjectMetaPatch {
  readonly title?: string;
  readonly defaultModelSelection?: ModelSelection | null;
}

interface ProjectSettingsCommitState {
  readonly projectKey: string | null;
  queue: Promise<void>;
  inFlight: number;
  readonly draftKeysAwaitingRefresh: Set<ProjectSettingsDraftKey>;
}

const createProjectSettingsCommitState = (
  projectKey: string | null,
): ProjectSettingsCommitState => ({
  projectKey,
  queue: Promise.resolve(),
  inFlight: 0,
  draftKeysAwaitingRefresh: new Set(),
});

function draftKeysForSettingsPatch(patch: ProjectSettingsPatch): ProjectSettingsDraftKey[] {
  const keys: ProjectSettingsDraftKey[] = [];
  if ("remoteOverride" in patch) keys.push(...REMOTE_OVERRIDE_DRAFT_KEYS);
  if ("automaticGitFetchInterval" in patch) keys.push("automaticGitFetchInterval");
  if ("actionEnvironment" in patch) keys.push("actionEnvironment");
  if ("disabledProviderInstanceIds" in patch) keys.push("disabledProviderInstanceIds");
  if ("defaultThreadEnvMode" in patch) keys.push("defaultThreadEnvMode");
  if ("newWorktreesStartFromOrigin" in patch) keys.push("newWorktreesStartFromOrigin");
  return keys;
}

function draftKeysForMetaPatch(patch: ProjectMetaPatch): ProjectSettingsDraftKey[] {
  const keys: ProjectSettingsDraftKey[] = [];
  if ("title" in patch) keys.push("title");
  if ("defaultModelSelection" in patch) keys.push("defaultModelSelection");
  return keys;
}

function buildRemoteOverride(draft: RemoteOverrideDraft): ProjectRemoteOverride | null {
  if (!draft.enabled) return null;
  const remoteName = draft.remoteName.trim();
  const remoteUrl = draft.remoteUrl.trim();
  const webUrl = draft.webUrl.trim();
  if (!remoteName || !remoteUrl) return null;
  return {
    provider: draft.provider,
    remoteName,
    remoteUrl,
    ...(webUrl ? { webUrl } : {}),
  };
}

function isValidActionEnvironmentKey(key: string): boolean {
  return ACTION_ENVIRONMENT_KEY_PATTERN.test(key) && key.length <= 128;
}

function isReservedActionEnvironmentKey(key: string): boolean {
  return (
    key.startsWith(ACTION_ENVIRONMENT_RESERVED_PREFIX) ||
    key === "__proto__" ||
    key === "constructor" ||
    key === "prototype"
  );
}

function millisecondsToSeconds(milliseconds: number): number {
  return Math.round(milliseconds / 1_000);
}

function normalizeFetchIntervalSeconds(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function projectScriptActionFailure(message: string): ProjectScriptActionResult {
  return AsyncResult.failure(Cause.fail(new Error(message)));
}

function projectScriptPreviewFields(
  input: Pick<NewProjectScriptInput, "previewUrl" | "autoOpenPreview">,
): Pick<ProjectScript, "previewUrl" | "autoOpenPreview"> {
  return input.previewUrl
    ? {
        previewUrl: input.previewUrl,
        autoOpenPreview: input.autoOpenPreview,
      }
    : {};
}

export function ProjectSettingsDialog() {
  const target = useProjectSettingsDialogStore((state) => state.target);
  const closeProjectSettings = useProjectSettingsDialogStore((state) => state.closeProjectSettings);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) closeProjectSettings();
      }}
    >
      <DialogPopup className="flex max-h-[min(88dvh,860px)] max-w-[45rem] flex-col">
        {target ? (
          <ProjectSettingsDialogContent
            key={`${target.environmentId}\0${target.projectId}`}
            target={target}
            onClose={closeProjectSettings}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ProjectSettingsDialogContent({
  target,
  onClose,
}: {
  target: ProjectSettingsDialogTarget;
  onClose: () => void;
}) {
  const { environmentId, projectId } = target;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // The dialog sizes itself to the collapsed rows. Opening the advanced
  // sections pins that height so the extra rows scroll instead of stretching
  // the dialog out from under the pointer.
  const [lockedBodyHeight, setLockedBodyHeight] = useState<number | null>(null);
  const bodyContentRef = useRef<HTMLDivElement | null>(null);
  const toggleAdvanced = useCallback(() => {
    // Measure the scroll viewport, not the content: the viewport is what the
    // pinned height replaces, so the dialog keeps its exact current size.
    // clientHeight, not getBoundingClientRect — the popup carries an open
    // animation transform, and a scaled rect would pin a too-small height.
    const scroller = bodyContentRef.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    setAdvancedOpen((open) => !open);
    setLockedBodyHeight((current) => (current === null && scroller ? scroller.clientHeight : null));
  }, []);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const updateClientSettings = useUpdateClientSettings();
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroup = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (candidateEnvironmentId) =>
          environmentLabelById.get(candidateEnvironmentId) ?? null,
      }).find((group) =>
        group.memberProjects.some(
          (member) => member.environmentId === project?.environmentId && member.id === project?.id,
        ),
      ) ?? null,
    [
      environmentLabelById,
      primaryEnvironmentId,
      project?.environmentId,
      project?.id,
      projectGroupingSettings,
      projects,
    ],
  );
  const projectLocations = useMemo(
    () =>
      projectGroup?.memberProjects ??
      (project
        ? [
            {
              ...project,
              environmentLabel: environmentLabelById.get(project.environmentId) ?? null,
            },
          ]
        : []),
    [environmentLabelById, project, projectGroup?.memberProjects],
  );
  const currentEnvironmentLabel = project
    ? (environmentLabelById.get(project.environmentId) ?? "Current environment")
    : "Current environment";
  const projectGroupingSelection = project
    ? (projectGroupingSettings.sidebarProjectGroupingOverrides?.[
        deriveProjectGroupingOverrideKey(project)
      ] ?? "inherit")
    : "inherit";
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const primaryKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const primarySettings = usePrimarySettings();
  const serverConfigs = useServerConfigs();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const updateProjectSettings = useAtomCommand(projectEnvironment.updateSettings, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const projectServerConfig = project?.environmentId
    ? (serverConfigs.get(project.environmentId) ?? null)
    : null;
  const t3ProjectFile = useT3ProjectFile(environmentId, project?.workspaceRoot ?? null);
  const keybindings =
    project?.environmentId && project.environmentId !== primaryEnvironmentId
      ? (projectServerConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS)
      : primaryKeybindings;
  const settings = useMemo(
    () =>
      project?.environmentId && project.environmentId !== primaryEnvironmentId
        ? {
            ...primarySettings,
            ...projectServerConfig?.settings,
          }
        : primarySettings,
    [primaryEnvironmentId, primarySettings, project?.environmentId, projectServerConfig?.settings],
  );
  const serverProviders =
    project?.environmentId && project.environmentId !== primaryEnvironmentId
      ? // Never fall back to the primary environment's providers here: saving
        // while this project's config loads would persist instance IDs that do
        // not exist on the project's environment.
        (projectServerConfig?.providers ?? EMPTY_SERVER_PROVIDERS)
      : primaryProviders;
  const providerInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const projectDetails = useEnvironmentQuery(
    project
      ? projectEnvironment.getDetails({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        })
      : null,
  );

  const [draft, setDraft] = useState<ProjectSettingsDraft | null>(null);
  const [, bumpCommitSettledVersion] = useState(0);
  const details = projectDetails.data;
  const projectDraftKey = project && details ? `${project.environmentId}:${details.id}` : null;
  const currentDraft = draft?.projectKey === projectDraftKey ? draft : null;
  const commitStateRef = useRef(createProjectSettingsCommitState(projectDraftKey));
  if (commitStateRef.current.projectKey !== projectDraftKey) {
    commitStateRef.current = createProjectSettingsCommitState(projectDraftKey);
  }
  const override = details?.settings.remoteOverride ?? null;
  const title = currentDraft?.title ?? details?.title ?? project?.title ?? "";
  const overrideEnabled = currentDraft?.overrideEnabled ?? Boolean(override);
  const provider =
    currentDraft?.provider ??
    override?.provider ??
    details?.detected.primaryRemote?.provider?.kind ??
    "unknown";
  const remoteName =
    currentDraft?.remoteName ??
    override?.remoteName ??
    details?.detected.primaryRemote?.name ??
    "origin";
  const remoteUrl =
    currentDraft?.remoteUrl ?? override?.remoteUrl ?? details?.detected.primaryRemote?.url ?? "";
  const webUrl =
    currentDraft?.webUrl ??
    override?.webUrl ??
    details?.detected.primaryRemote?.provider?.baseUrl ??
    "";
  const defaultModelSelection =
    currentDraft && "defaultModelSelection" in currentDraft
      ? currentDraft.defaultModelSelection
      : (details?.defaultModelSelection ?? null);
  const automaticGitFetchInterval =
    currentDraft && "automaticGitFetchInterval" in currentDraft
      ? currentDraft.automaticGitFetchInterval
      : (details?.settings.automaticGitFetchInterval ?? null);
  const automaticGitFetchIntervalSeconds = millisecondsToSeconds(
    automaticGitFetchInterval ?? DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL_MS,
  );
  // null on either key means "Global": new threads follow the primary
  // environment's settings, which is where the global defaults are edited.
  const projectThreadEnvMode =
    currentDraft && "defaultThreadEnvMode" in currentDraft
      ? currentDraft.defaultThreadEnvMode
      : (details?.settings.defaultThreadEnvMode ?? null);
  const projectNewWorktreesStartFromOrigin =
    currentDraft && "newWorktreesStartFromOrigin" in currentDraft
      ? currentDraft.newWorktreesStartFromOrigin
      : (details?.settings.newWorktreesStartFromOrigin ?? null);
  const effectiveThreadEnvMode = projectThreadEnvMode ?? primarySettings.defaultThreadEnvMode;
  const actionEnvironment =
    currentDraft?.actionEnvironment ??
    details?.settings.actionEnvironment ??
    EMPTY_ACTION_ENVIRONMENT;
  const disabledProviderInstanceIds =
    currentDraft?.disabledProviderInstanceIds ??
    details?.settings.disabledProviderInstanceIds ??
    EMPTY_DISABLED_PROVIDER_INSTANCE_IDS;
  const projectProviderPolicy = useMemo(
    () =>
      resolveProjectProviderInstancePolicy(providerInstanceEntries, {
        disabledProviderInstanceIds,
      }),
    [disabledProviderInstanceIds, providerInstanceEntries],
  );
  const globallyEnabledProviderInstanceEntries = projectProviderPolicy.appEnabledEntries;
  const projectProviderInstanceEntries = projectProviderPolicy.projectEnabledEntries;
  const fallbackModelSelection = useMemo(() => {
    const entry =
      projectProviderInstanceEntries.find(
        (candidate) => candidate.enabled && candidate.isAvailable,
      ) ??
      projectProviderInstanceEntries[0] ??
      null;
    if (!entry) return DEFAULT_PROJECT_MODEL_SELECTION;
    const model =
      resolveAppModelSelectionForInstance(entry.instanceId, settings, serverProviders, null) ??
      entry.models[0]?.slug ??
      DEFAULT_MODEL;
    return {
      instanceId: entry.instanceId,
      model,
    } satisfies ModelSelection;
  }, [projectProviderInstanceEntries, serverProviders, settings]);
  const stageDraft = useCallback(
    (patch: Partial<Omit<ProjectSettingsDraft, "projectKey">>) => {
      if (!projectDraftKey) return;
      setDraft((current) => ({
        projectKey: projectDraftKey,
        ...(current?.projectKey === projectDraftKey ? current : {}),
        ...patch,
      }));
    },
    [projectDraftKey],
  );

  const showProjectSettingsError = useCallback((title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  const refreshProjectDetails = projectDetails.refresh;

  const clearDraftKeys = useCallback(
    (keys: Iterable<ProjectSettingsDraftKey>, expectedProjectKey: string | null) => {
      setDraft((current) => {
        if (!current || current.projectKey !== expectedProjectKey) return current;
        const next: Record<string, unknown> = { ...current };
        let changed = false;
        for (const key of keys) {
          if (key in next) {
            delete next[key];
            changed = true;
          }
        }
        if (!changed) return current;
        // Only projectKey left means nothing is staged anymore.
        return Object.keys(next).length <= 1 ? null : (next as unknown as ProjectSettingsDraft);
      });
    },
    [],
  );

  const detailsPending = projectDetails.isPending;
  const detailsError = projectDetails.error;
  useEffect(() => {
    setDraft((current) => (current?.projectKey === projectDraftKey ? current : null));
  }, [projectDraftKey]);

  // Only release optimistic fields confirmed by the latest successful
  // response. A stale or failed refresh must not reveal older server data.
  useEffect(() => {
    const state = commitStateRef.current;
    if (
      detailsPending ||
      detailsError ||
      !details ||
      !currentDraft ||
      state.projectKey !== projectDraftKey ||
      state.inFlight > 0 ||
      state.draftKeysAwaitingRefresh.size === 0
    ) {
      return;
    }
    const keys = confirmedProjectSettingsDraftKeys(
      currentDraft,
      details,
      state.draftKeysAwaitingRefresh,
    );
    for (const key of keys) {
      state.draftKeysAwaitingRefresh.delete(key);
    }
    clearDraftKeys(keys, projectDraftKey);
  }, [clearDraftKeys, currentDraft, details, detailsError, detailsPending, projectDraftKey]);

  const runCommit = useCallback(<T,>(task: (state: ProjectSettingsCommitState) => Promise<T>) => {
    const state = commitStateRef.current;
    state.inFlight += 1;
    const result = state.queue
      .catch(() => undefined)
      .then(() => task(state))
      .finally(() => {
        state.inFlight -= 1;
        if (commitStateRef.current === state) {
          bumpCommitSettledVersion((version) => version + 1);
        }
      });
    state.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);

  const handleCommitFailure = useCallback(
    (error: unknown, state: ProjectSettingsCommitState) => {
      if (commitStateRef.current !== state) return;
      // Drop the optimistic draft so the UI falls back to the persisted
      // values instead of showing the rejected edit as saved.
      setDraft((current) => (current?.projectKey === state.projectKey ? null : current));
      state.draftKeysAwaitingRefresh.clear();
      refreshProjectDetails();
      showProjectSettingsError("Failed to update project settings", error);
    },
    [refreshProjectDetails, showProjectSettingsError],
  );

  const commitProjectMeta = useCallback(
    (patch: ProjectMetaPatch) =>
      runCommit(async (state) => {
        if (!project || commitStateRef.current !== state) return false;
        const result = await updateProject({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            ...patch,
          },
        });
        if (commitStateRef.current !== state) return false;
        if (result._tag === "Failure") {
          handleCommitFailure(squashAtomCommandFailure(result), state);
          return false;
        }
        for (const key of draftKeysForMetaPatch(patch)) {
          state.draftKeysAwaitingRefresh.add(key);
        }
        refreshProjectDetails();
        return true;
      }),
    [handleCommitFailure, project, refreshProjectDetails, runCommit, updateProject],
  );

  const commitProjectSettings = useCallback(
    (patch: ProjectSettingsPatch) =>
      runCommit(async (state) => {
        if (!project || commitStateRef.current !== state) return false;
        const result = await updateProjectSettings({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            patch,
          },
        });
        if (commitStateRef.current !== state) return false;
        if (result._tag === "Failure") {
          handleCommitFailure(squashAtomCommandFailure(result), state);
          return false;
        }
        for (const key of draftKeysForSettingsPatch(patch)) {
          state.draftKeysAwaitingRefresh.add(key);
        }
        refreshProjectDetails();
        return true;
      }),
    [handleCommitFailure, project, refreshProjectDetails, runCommit, updateProjectSettings],
  );

  const persistRemoteOverrideIfValid = useCallback(
    (draft: RemoteOverrideDraft) => {
      const nextRemoteOverride = buildRemoteOverride(draft);
      if (draft.enabled && nextRemoteOverride === null) return;
      void commitProjectSettings({ remoteOverride: nextRemoteOverride });
    },
    [commitProjectSettings],
  );

  const updateProjectGroupingPreference = useCallback(
    (selection: SidebarProjectGroupingMode | "inherit") => {
      if (!project) return;
      const overrideKey = deriveProjectGroupingOverrideKey(project);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateClientSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [project, projectGroupingSettings.sidebarProjectGroupingOverrides, updateClientSettings],
  );

  const commitDefaultModelSelection = useCallback(
    (nextSelection: ModelSelection | null) => {
      if (isModelSelectionEqual(nextSelection, defaultModelSelection)) return;
      stageDraft({ defaultModelSelection: nextSelection });
      void commitProjectMeta({ defaultModelSelection: nextSelection });
    },
    [commitProjectMeta, defaultModelSelection, stageDraft],
  );

  const commitAutomaticGitFetchInterval = useCallback(
    (nextIntervalMs: number | null) => {
      if (nextIntervalMs === automaticGitFetchInterval) return;
      stageDraft({ automaticGitFetchInterval: nextIntervalMs });
      void commitProjectSettings({ automaticGitFetchInterval: nextIntervalMs });
    },
    [automaticGitFetchInterval, commitProjectSettings, stageDraft],
  );

  const commitDefaultThreadEnvMode = useCallback(
    (nextMode: ThreadEnvMode | null) => {
      if (nextMode === projectThreadEnvMode) return;
      stageDraft({ defaultThreadEnvMode: nextMode });
      void commitProjectSettings({ defaultThreadEnvMode: nextMode });
    },
    [commitProjectSettings, projectThreadEnvMode, stageDraft],
  );

  const commitNewWorktreesStartFromOrigin = useCallback(
    (nextStartFromOrigin: boolean | null) => {
      if (nextStartFromOrigin === projectNewWorktreesStartFromOrigin) return;
      stageDraft({ newWorktreesStartFromOrigin: nextStartFromOrigin });
      void commitProjectSettings({ newWorktreesStartFromOrigin: nextStartFromOrigin });
    },
    [commitProjectSettings, projectNewWorktreesStartFromOrigin, stageDraft],
  );

  const resetThreadWorkspaceDefaults = useCallback(() => {
    if (projectThreadEnvMode === null && projectNewWorktreesStartFromOrigin === null) return;
    stageDraft({ defaultThreadEnvMode: null, newWorktreesStartFromOrigin: null });
    void commitProjectSettings({
      defaultThreadEnvMode: null,
      newWorktreesStartFromOrigin: null,
    });
  }, [commitProjectSettings, projectNewWorktreesStartFromOrigin, projectThreadEnvMode, stageDraft]);

  const commitActionEnvironment = useCallback(
    (nextEnvironment: ProjectActionEnvironment) => {
      let normalized: ProjectActionEnvironment;
      try {
        normalized = normalizeActionEnvironment(nextEnvironment);
      } catch (error) {
        showProjectSettingsError(
          "Failed to update action environment",
          error instanceof Error ? error : new Error("Unable to update action environment."),
        );
        return;
      }
      const invalidKey = Object.keys(normalized).find((key) => !isValidActionEnvironmentKey(key));
      if (invalidKey) {
        showProjectSettingsError(
          "Failed to update action environment",
          new Error(`"${invalidKey}" is not a valid environment variable name.`),
        );
        return;
      }
      const reservedKey = Object.keys(normalized).find(isReservedActionEnvironmentKey);
      if (reservedKey) {
        showProjectSettingsError(
          "Failed to update action environment",
          new Error(`"${reservedKey}" is a reserved environment variable name.`),
        );
        return;
      }
      if (isStringRecordEqual(normalized, actionEnvironment)) return;
      // Stage only after validation passes, and stage the normalized form so
      // the UI matches what the server will persist.
      stageDraft({ actionEnvironment: normalized });
      void commitProjectSettings({ actionEnvironment: normalized });
    },
    [actionEnvironment, commitProjectSettings, showProjectSettingsError, stageDraft],
  );

  const commitProviderInstanceAllowed = useCallback(
    (instanceId: ProviderInstanceId, allowed: boolean) => {
      const current = disabledProviderInstanceIds;
      const currentSet = new Set(current);
      if (!allowed && !currentSet.has(instanceId) && projectProviderInstanceEntries.length <= 1) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "At least one provider is required",
            description: "Enable another provider before disabling this one.",
          }),
        );
        return;
      }
      if (allowed) {
        currentSet.delete(instanceId);
      } else {
        currentSet.add(instanceId);
      }
      const knownInstanceIds = new Set(
        globallyEnabledProviderInstanceEntries.map((entry) => entry.instanceId),
      );
      const nextDisabledProviderInstanceIds = globallyEnabledProviderInstanceEntries
        .map((entry) => entry.instanceId)
        .filter((id) => currentSet.has(id))
        .concat(current.filter((id) => !knownInstanceIds.has(id)));
      stageDraft({ disabledProviderInstanceIds: nextDisabledProviderInstanceIds });
      const commitProviderSettings = () =>
        commitProjectSettings({
          disabledProviderInstanceIds: nextDisabledProviderInstanceIds,
        });
      if (allowed || defaultModelSelection?.instanceId !== instanceId) {
        void commitProviderSettings();
        return;
      }
      // Clear the default only after its provider is confirmed disabled.
      void commitProviderSettingsThenDefaultModel(commitProviderSettings, () => {
        stageDraft({ defaultModelSelection: null });
        return commitProjectMeta({ defaultModelSelection: null });
      });
    },
    [
      commitProjectMeta,
      commitProjectSettings,
      defaultModelSelection,
      disabledProviderInstanceIds,
      globallyEnabledProviderInstanceEntries,
      projectProviderInstanceEntries.length,
      stageDraft,
    ],
  );

  const projectThreadCount = useMemo(
    () =>
      project
        ? threads.filter(
            (thread) =>
              thread.projectId === project.id && thread.environmentId === project.environmentId,
          ).length
        : 0,
    [project, threads],
  );
  const projectGroupThreadCount = useMemo(() => {
    const projectKeys = new Set(
      projectLocations.map((location) => `${location.environmentId}\0${location.id}`),
    );
    return threads.filter((thread) =>
      projectKeys.has(`${thread.environmentId}\0${thread.projectId}`),
    ).length;
  }, [projectLocations, threads]);
  const persistProjectScripts = async (input: {
    nextScripts: ProjectScript[];
    keybinding?: string | null;
    keybindingCommand: KeybindingCommand;
  }): Promise<ProjectScriptActionResult> => {
    if (!project) return projectScriptActionFailure("Project no longer available.");
    const updateResult = mapAtomCommandResult(
      await updateProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          scripts: input.nextScripts,
        },
      }),
      () => undefined,
    );
    if (updateResult._tag === "Failure") {
      return updateResult;
    }

    const keybindingResult = await settlePromise(() =>
      syncProjectScriptKeybinding({
        keybindings,
        keybinding: input.keybinding,
        command: input.keybindingCommand,
        server: {
          upsertKeybinding: (rule) =>
            throwOnAtomCommandFailure(
              upsertKeybinding({ environmentId: project.environmentId, input: rule }),
            ),
          removeKeybinding: (target) =>
            throwOnAtomCommandFailure(
              removeKeybinding({ environmentId: project.environmentId, input: target }),
            ),
        },
      }),
    );
    refreshProjectDetails();
    if (keybindingResult._tag === "Failure") {
      // The script list is already persisted at this point, so report the
      // shortcut failure separately instead of failing the whole save —
      // retrying the save against stale details would duplicate the script.
      showProjectSettingsError(
        "Script saved, but updating its keyboard shortcut failed",
        Cause.squash(keybindingResult.cause),
      );
    }
    return updateResult;
  };

  const saveProjectScript = async (
    input: NewProjectScriptInput,
  ): Promise<ProjectScriptActionResult> => {
    const details = projectDetails.data;
    if (!details) return projectScriptActionFailure("Project details are not loaded.");
    const nextId = nextProjectScriptId(
      input.name,
      details.scripts.map((script) => script.id),
    );
    const nextScript: ProjectScript = {
      id: nextId,
      name: input.name,
      command: input.command,
      icon: input.icon,
      runOnWorktreeCreate: input.runOnWorktreeCreate,
      ...projectScriptPreviewFields(input),
    };
    const nextScripts = input.runOnWorktreeCreate
      ? [
          ...details.scripts.map((script) =>
            script.runOnWorktreeCreate
              ? Object.assign({}, script, { runOnWorktreeCreate: false })
              : script,
          ),
          nextScript,
        ]
      : [...details.scripts, nextScript];
    return persistProjectScripts({
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(nextId),
    });
  };

  const updateProjectScript = async (
    scriptId: string,
    input: NewProjectScriptInput,
  ): Promise<ProjectScriptActionResult> => {
    const details = projectDetails.data;
    if (!details) return projectScriptActionFailure("Project details are not loaded.");
    const existingScript = details.scripts.find((script) => script.id === scriptId);
    if (!existingScript) {
      return projectScriptActionFailure("Action not found.");
    }
    const updatedScript: ProjectScript = {
      id: existingScript.id,
      name: input.name,
      command: input.command,
      icon: input.icon,
      runOnWorktreeCreate: input.runOnWorktreeCreate,
      ...projectScriptPreviewFields(input),
    };
    const nextScripts = details.scripts.map((script) =>
      script.id === scriptId
        ? updatedScript
        : input.runOnWorktreeCreate
          ? Object.assign({}, script, { runOnWorktreeCreate: false })
          : script,
    );
    return persistProjectScripts({
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(scriptId),
    });
  };

  const deleteProjectScript = async (scriptId: string): Promise<ProjectScriptActionResult> => {
    const details = projectDetails.data;
    if (!details) return projectScriptActionFailure("Project details are not loaded.");
    return persistProjectScripts({
      nextScripts: details.scripts.filter((script) => script.id !== scriptId),
      keybinding: null,
      keybindingCommand: commandForProjectScript(scriptId),
    });
  };

  const [removeProjectPending, setRemoveProjectPending] = useState(false);
  const [removeProjectEverywherePending, setRemoveProjectEverywherePending] = useState(false);
  const removeProject = useCallback(async () => {
    if (!project || removeProjectPending) return;
    setRemoveProjectPending(true);
    try {
      const willDeleteThreads = projectThreadCount > 0;
      const message = [
        willDeleteThreads
          ? `Remove project "${project.title}" and delete its ${projectThreadCount} thread${
              projectThreadCount === 1 ? "" : "s"
            }?`
          : `Remove project "${project.title}"?`,
        `Path: ${project.workspaceRoot}`,
        willDeleteThreads
          ? "This permanently clears conversation history for every related thread."
          : "This removes only this project entry.",
        "This action cannot be undone.",
      ].join("\n");
      const confirmed = await ensureLocalApi().dialogs.confirm(message);
      if (!confirmed) return;

      const result = await deleteProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          force: true,
        },
      });
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      toastManager.add({
        type: "success",
        title: "Project removed",
      });
      onClose();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to remove project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setRemoveProjectPending(false);
    }
  }, [deleteProject, onClose, project, projectThreadCount, removeProjectPending]);

  const removeProjectEverywhere = useCallback(async () => {
    if (!projectGroup || projectLocations.length < 2 || removeProjectEverywherePending) return;
    setRemoveProjectEverywherePending(true);
    try {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        [
          `Remove all ${projectLocations.length} grouped project entries?`,
          projectGroupThreadCount > 0
            ? `This permanently deletes ${projectGroupThreadCount} related thread${
                projectGroupThreadCount === 1 ? "" : "s"
              } and their conversation history.`
            : "No threads will be deleted.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) return;

      await removeProjectGroupMembersSequentially(
        projectLocations,
        async (location) => {
          const result = await deleteProject({
            environmentId: location.environmentId,
            input: {
              projectId: location.id,
              force: true,
            },
          });
          if (result._tag === "Failure") {
            throw squashAtomCommandFailure(result);
          }
        },
        (location) => {
          clearComposerDraftsForProjectGroupMember(
            scopeProjectRef(location.environmentId, location.id),
          );
        },
      );
      clearComposerDraftsForProjectGroup({
        logicalProjectKey: projectGroup.projectKey,
        projectRefs: projectLocations.map((location) =>
          scopeProjectRef(location.environmentId, location.id),
        ),
      });
      toastManager.add({
        type: "success",
        title: "Project removed from all environments",
      });
      onClose();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to remove grouped project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setRemoveProjectEverywherePending(false);
    }
  }, [
    deleteProject,
    onClose,
    projectGroup,
    projectGroupThreadCount,
    projectLocations,
    removeProjectEverywherePending,
  ]);

  const effectiveRemote = projectDetails.data?.effective.remote ?? null;
  const defaultModelSelectionAllowed =
    defaultModelSelection === null ||
    projectProviderInstanceEntries.some(
      (entry) => entry.instanceId === defaultModelSelection.instanceId,
    );
  const displayedModelSelection =
    defaultModelSelection && defaultModelSelectionAllowed
      ? defaultModelSelection
      : fallbackModelSelection;
  const displayedModelInstanceEntry =
    projectProviderInstanceEntries.find(
      (entry) => entry.instanceId === displayedModelSelection.instanceId,
    ) ?? null;

  const header = (
    <DialogHeader className="gap-1.5 p-5 pb-3 sm:p-6 sm:pb-3">
      {/* The close button is absolutely positioned at the popup's top-right, so
          the title row reserves space for it and every other control lives on
          the second row. */}
      <DialogTitle className="min-w-0 truncate pe-9 text-lg">
        {title || "Project settings"}
      </DialogTitle>
      <div className="flex min-w-0 items-center gap-2">
        <div
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={project?.workspaceRoot ?? ""}
        >
          {project?.workspaceRoot ?? ""}
        </div>
        {project && projectLocations.length > 1 ? (
          <Select
            value={`${project.environmentId}:${project.id}`}
            onValueChange={(value) => {
              const nextProject = projectLocations.find(
                (candidate) => `${candidate.environmentId}:${candidate.id}` === value,
              );
              if (!nextProject) return;
              openProjectSettingsDialog({
                environmentId: nextProject.environmentId,
                projectId: nextProject.id,
              });
            }}
          >
            <SelectTrigger
              variant="ghost"
              size="sm"
              className="h-7 w-auto max-w-[50%] shrink-0 px-2 text-xs font-medium"
              aria-label="Project environment"
            >
              <SelectValue>
                <span className="flex min-w-0 items-center gap-1.5">
                  <ServerIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{currentEnvironmentLabel}</span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {projectLocations.map((location) => (
                <SelectItem
                  key={`${location.environmentId}:${location.id}`}
                  value={`${location.environmentId}:${location.id}`}
                >
                  <span className="truncate">
                    {location.environmentLabel ?? "Current environment"}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ServerIcon className="size-3.5 shrink-0" />
            <span className="truncate">{currentEnvironmentLabel}</span>
          </div>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          aria-label="Refresh project settings"
          disabled={projectDetails.isPending}
          onClick={refreshProjectDetails}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
    </DialogHeader>
  );

  if (!project) {
    return (
      <>
        {header}
        <DialogBody>
          <ProjectNotice title="Project not found" description="This project is not loaded." />
        </DialogBody>
      </>
    );
  }

  if (projectDetails.isPending && !projectDetails.data) {
    return (
      <>
        {header}
        <DialogBody>
          <ProjectSettingsLoading />
        </DialogBody>
      </>
    );
  }

  if (projectDetails.error !== null) {
    return (
      <>
        {header}
        <DialogBody>
          <ProjectNotice title="Unable to load project" description={projectDetails.error} />
        </DialogBody>
      </>
    );
  }

  if (!projectDetails.data) {
    return (
      <>
        {header}
        <DialogBody>
          <ProjectSettingsLoading />
        </DialogBody>
      </>
    );
  }

  const loadedDetails = projectDetails.data;

  return (
    <>
      {header}
      <DialogBody className="space-y-1" contentRef={bodyContentRef} lockedHeight={lockedBodyHeight}>
        <DialogSettingsGroup>
          <ProjectSettingRow
            title="Grouping rule"
            description="How entries group in the sidebar."
            control={
              <Select
                value={projectGroupingSelection}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    updateProjectGroupingPreference(value);
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-64" aria-label="Project grouping rule">
                  <SelectValue>
                    {projectGroupingSelection === "inherit"
                      ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                      : PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="inherit">
                    Use global default
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <ProjectSettingRow
            title="New threads"
            description="Workspace mode for new threads."
            resetAction={
              loadedDetails.settings.defaultThreadEnvMode !== null ||
              loadedDetails.settings.newWorktreesStartFromOrigin !== null ? (
                <SettingResetButton label="new threads" onClick={resetThreadWorkspaceDefaults} />
              ) : null
            }
            control={
              <Select
                value={projectThreadEnvMode ?? "global"}
                onValueChange={(value) => {
                  if (value === "global") {
                    commitDefaultThreadEnvMode(null);
                    return;
                  }
                  if (value === "local" || value === "worktree") {
                    commitDefaultThreadEnvMode(value);
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-44" aria-label="New thread workspace mode">
                  <SelectValue>
                    {projectThreadEnvMode === null
                      ? `Global (${THREAD_ENV_MODE_LABELS[primarySettings.defaultThreadEnvMode]})`
                      : THREAD_ENV_MODE_LABELS[projectThreadEnvMode]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="global">
                    Global
                  </SelectItem>
                  <SelectItem hideIndicator value="local">
                    {THREAD_ENV_MODE_LABELS.local}
                  </SelectItem>
                  <SelectItem hideIndicator value="worktree">
                    {THREAD_ENV_MODE_LABELS.worktree}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          {effectiveThreadEnvMode === "worktree" ? (
            <ProjectSettingRow
              className="bg-muted/20 sm:pl-9"
              title="Start from origin"
              description="Branch worktrees off origin, not local."
              resetAction={
                loadedDetails.settings.newWorktreesStartFromOrigin !== null ? (
                  <SettingResetButton
                    label="start new worktrees from origin"
                    onClick={() => commitNewWorktreesStartFromOrigin(null)}
                  />
                ) : null
              }
              control={
                <Switch
                  checked={
                    projectNewWorktreesStartFromOrigin ??
                    primarySettings.newWorktreesStartFromOrigin
                  }
                  onCheckedChange={(checked) => commitNewWorktreesStartFromOrigin(Boolean(checked))}
                  aria-label="Start new worktrees from origin in this project"
                />
              }
            />
          ) : null}
          <ProjectSettingRow
            title="Default model"
            description="Used for new threads in this project."
            resetAction={
              loadedDetails.defaultModelSelection !== null ? (
                <SettingResetButton
                  label="project default model"
                  onClick={() => commitDefaultModelSelection(null)}
                />
              ) : null
            }
            control={
              <div className="flex min-w-0 flex-wrap items-center justify-start gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={displayedModelSelection.instanceId}
                  model={displayedModelSelection.model}
                  lockedProvider={null}
                  instanceEntries={projectProviderInstanceEntries}
                  keybindings={keybindings}
                  modelOptionsByInstance={modelOptionsByInstance}
                  terminalOpen={false}
                  triggerVariant="outline"
                  triggerClassName="max-w-48 sm:max-w-52"
                  disabled={projectProviderInstanceEntries.length === 0}
                  onInstanceModelChange={(instanceId, model) =>
                    commitDefaultModelSelection(createModelSelection(instanceId, model))
                  }
                />
                {displayedModelInstanceEntry ? (
                  <TraitsPicker
                    provider={displayedModelInstanceEntry.driverKind}
                    models={displayedModelInstanceEntry.models}
                    model={displayedModelSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={displayedModelSelection.options}
                    allowPromptInjectedEffort={false}
                    triggerVariant="outline"
                    triggerClassName="max-w-32 sm:max-w-36"
                    onModelOptionsChange={(nextOptions) =>
                      commitDefaultModelSelection(
                        createModelSelection(
                          displayedModelSelection.instanceId,
                          displayedModelSelection.model,
                          nextOptions,
                        ),
                      )
                    }
                  />
                ) : null}
              </div>
            }
          />
        </DialogSettingsGroup>

        <DialogSettingsGroup>
          {globallyEnabledProviderInstanceEntries.map((entry) => {
            const allowed = !disabledProviderInstanceIds.includes(entry.instanceId);
            const isLastAllowedProvider = allowed && projectProviderInstanceEntries.length <= 1;
            const duplicateDriverCount = globallyEnabledProviderInstanceEntries.filter(
              (candidate) => candidate.driverKind === entry.driverKind,
            ).length;
            return (
              <div
                key={entry.instanceId}
                className="flex min-h-14 min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-3 sm:px-4"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <ProviderInstanceIcon
                    driverKind={entry.driverKind}
                    displayName={entry.displayName}
                    accentColor={entry.accentColor}
                    showBadge={Boolean(entry.accentColor) || duplicateDriverCount > 1}
                    className="size-6"
                    iconClassName="size-5"
                    badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
                  />
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {entry.displayName}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {entry.instanceId}
                    </span>
                  </div>
                </div>
                <Switch
                  checked={allowed}
                  disabled={isLastAllowedProvider}
                  aria-label={`${allowed ? "Disable" : "Enable"} ${entry.displayName} for this project`}
                  title={
                    isLastAllowedProvider
                      ? "At least one provider must stay enabled for this project."
                      : undefined
                  }
                  onCheckedChange={(checked) =>
                    commitProviderInstanceAllowed(entry.instanceId, Boolean(checked))
                  }
                />
              </div>
            );
          })}
        </DialogSettingsGroup>

        {advancedOpen ? (
          <>
            <DialogSettingsGroup>
              <ProjectSettingRow
                title="Remote"
                description={
                  overrideEnabled ? undefined : (
                    <RemoteSettingDescription remote={effectiveRemote} />
                  )
                }
                align="start"
                resetAction={
                  loadedDetails.settings.remoteOverride !== null ? (
                    <SettingResetButton
                      label="custom remote"
                      onClick={() => {
                        stageDraft({ overrideEnabled: false });
                        void commitProjectSettings({ remoteOverride: null });
                      }}
                    />
                  ) : null
                }
                control={
                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <span>Custom</span>
                    <Switch
                      checked={overrideEnabled}
                      aria-label="Use custom remote"
                      onCheckedChange={(checked) => {
                        const enabled = Boolean(checked);
                        stageDraft({ overrideEnabled: enabled });
                        persistRemoteOverrideIfValid({
                          enabled,
                          provider,
                          remoteName,
                          remoteUrl,
                          webUrl,
                        });
                      }}
                    />
                  </div>
                }
              >
                {overrideEnabled ? (
                  <div className="grid gap-3 border-t border-border/60 pt-4 md:grid-cols-2">
                    <label className="grid gap-1.5 text-xs font-medium text-foreground">
                      Provider
                      <Select
                        value={provider}
                        onValueChange={(value) => {
                          const nextProvider = value as SourceControlProviderKind;
                          stageDraft({ provider: nextProvider });
                          persistRemoteOverrideIfValid({
                            enabled: overrideEnabled,
                            provider: nextProvider,
                            remoteName,
                            remoteUrl,
                            webUrl,
                          });
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label="Source control provider">
                          <SelectValue>{PROVIDER_LABELS[provider]}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="start">
                          {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </label>
                    <label className="grid gap-1.5 text-xs font-medium text-foreground">
                      Remote name
                      <DraftInput
                        className="w-full"
                        value={remoteName}
                        placeholder="origin"
                        onCommit={(nextRemoteName) => {
                          stageDraft({ remoteName: nextRemoteName });
                          persistRemoteOverrideIfValid({
                            enabled: overrideEnabled,
                            provider,
                            remoteName: nextRemoteName,
                            remoteUrl,
                            webUrl,
                          });
                        }}
                      />
                    </label>
                    <label className="grid gap-1.5 text-xs font-medium text-foreground">
                      Remote URL
                      <DraftInput
                        className="w-full"
                        value={remoteUrl}
                        placeholder="git@git.example.com:team/repo.git"
                        onCommit={(nextRemoteUrl) => {
                          stageDraft({ remoteUrl: nextRemoteUrl });
                          persistRemoteOverrideIfValid({
                            enabled: overrideEnabled,
                            provider,
                            remoteName,
                            remoteUrl: nextRemoteUrl,
                            webUrl,
                          });
                        }}
                      />
                    </label>
                    <label className="grid gap-1.5 text-xs font-medium text-foreground">
                      Web URL
                      <DraftInput
                        className="w-full"
                        value={webUrl}
                        placeholder="https://git.example.com/team/repo"
                        onCommit={(nextWebUrl) => {
                          stageDraft({ webUrl: nextWebUrl });
                          persistRemoteOverrideIfValid({
                            enabled: overrideEnabled,
                            provider,
                            remoteName,
                            remoteUrl,
                            webUrl: nextWebUrl,
                          });
                        }}
                      />
                    </label>
                    {buildRemoteOverride({
                      enabled: true,
                      provider,
                      remoteName,
                      remoteUrl,
                      webUrl,
                    }) === null ? (
                      <p className="text-xs font-normal text-muted-foreground md:col-span-2">
                        Not saved yet — enter a remote name and URL to apply this override.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </ProjectSettingRow>
              <ProjectSettingRow
                title="Git root"
                value={loadedDetails.detected.gitRoot ?? "No Git repository detected"}
              />
              <ProjectSettingRow
                title="Branch"
                value={
                  loadedDetails.detected.branch ?? (loadedDetails.detected.gitRoot ? "None" : "—")
                }
              />
              <ProjectSettingRow
                title="Fetch interval"
                description="Seconds between remote fetches."
                resetAction={
                  loadedDetails.settings.automaticGitFetchInterval !== null ? (
                    <SettingResetButton
                      label="fetch interval"
                      onClick={() => commitAutomaticGitFetchInterval(null)}
                    />
                  ) : null
                }
                control={
                  <NumberField
                    value={automaticGitFetchIntervalSeconds}
                    min={0}
                    step={GIT_FETCH_INTERVAL_STEP_SECONDS}
                    size="sm"
                    className="w-32"
                    onValueChange={(value) =>
                      commitAutomaticGitFetchInterval(
                        Duration.toMillis(Duration.seconds(normalizeFetchIntervalSeconds(value))),
                      )
                    }
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement aria-label="Decrease fetch interval" />
                      <NumberFieldInput aria-label="Automatic Git fetch interval in seconds" />
                      <NumberFieldIncrement aria-label="Increase fetch interval" />
                    </NumberFieldGroup>
                  </NumberField>
                }
              />
            </DialogSettingsGroup>

            <DialogSettingsGroup>
              <div className="min-w-0">
                <ProjectScriptsControl
                  variant="settings"
                  scripts={loadedDetails.scripts}
                  keybindings={keybindings}
                  onAddScript={saveProjectScript}
                  onUpdateScript={updateProjectScript}
                  onDeleteScript={deleteProjectScript}
                />
              </div>
              {Object.keys(actionEnvironment).length === 0 ? (
                <ActionEnvironmentEditor
                  environment={actionEnvironment}
                  onChange={commitActionEnvironment}
                />
              ) : (
                <ProjectSettingRow title="Variables" align="start">
                  <ActionEnvironmentEditor
                    environment={actionEnvironment}
                    onChange={commitActionEnvironment}
                  />
                </ProjectSettingRow>
              )}
            </DialogSettingsGroup>

            <DialogSettingsGroup variant="card">
              <T3ProjectFileSettings
                key={`${project.environmentId}\0${project.workspaceRoot}`}
                environmentId={project.environmentId}
                cwd={project.workspaceRoot}
                state={t3ProjectFile}
              />
            </DialogSettingsGroup>

            <DialogSettingsGroup>
              <div className="flex min-h-14 min-w-0 items-center justify-between gap-4 rounded-lg px-3 py-3 sm:px-4">
                <div className="min-w-0 truncate text-sm font-medium text-foreground">
                  Remove project
                </div>
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={removeProjectPending}
                  onClick={() => void removeProject()}
                >
                  <Trash2Icon className="size-3.5" />
                  Remove
                </Button>
              </div>
              {projectLocations.length > 1 ? (
                <div className="flex min-h-14 min-w-0 items-center justify-between gap-4 rounded-lg px-3 py-3 sm:px-4">
                  <div className="min-w-0 truncate text-sm font-medium text-foreground">
                    Remove project everywhere
                  </div>
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    disabled={removeProjectEverywherePending}
                    onClick={() => void removeProjectEverywhere()}
                  >
                    <Trash2Icon className="size-3.5" />
                    Remove all
                  </Button>
                </div>
              ) : null}
            </DialogSettingsGroup>
          </>
        ) : null}

        <div className="px-3 pt-2 sm:px-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full justify-center"
            aria-expanded={advancedOpen}
            onClick={toggleAdvanced}
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", advancedOpen && "rotate-180")}
            />
            {advancedOpen ? "Hide advanced settings" : "Advanced settings"}
          </Button>
        </div>
      </DialogBody>
    </>
  );
}

/**
 * Scrolling body of the dialog. Rows carry the same `px-3 sm:px-4` inset as the
 * shared settings controls, so the body pads to just under the header's inset
 * and every label lines up on one left edge.
 */
function DialogBody({
  children,
  className,
  lockedHeight,
  contentRef,
}: {
  children?: ReactNode;
  className?: string;
  lockedHeight?: number | null;
  contentRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <ScrollArea
      scrollFade
      className={cn("min-h-0", lockedHeight == null ? "flex-1" : "flex-none")}
      {...(lockedHeight == null ? {} : { style: { height: lockedHeight } })}
    >
      <div ref={contentRef} className={cn("px-2 pb-6", className)}>
        {children}
      </div>
    </ScrollArea>
  );
}

/**
 * Rows flow as one uniformly spaced list — no headings, no group separators —
 * so every option sits the same distance from its neighbours.
 */
function DialogSettingsGroup({
  children,
  variant = "plain",
}: {
  children: ReactNode;
  /** "card" rules off its own section (used for the t3.json block). */
  variant?: "plain" | "card";
}) {
  if (variant === "card") {
    return <section className="my-2 space-y-1 border-y border-border/60 py-2">{children}</section>;
  }
  return <>{children}</>;
}

function isModelSelectionEqual(left: ModelSelection | null, right: ModelSelection | null) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeActionEnvironment(
  environment: Readonly<Record<string, string>>,
): ProjectActionEnvironment {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(environment)) {
    const trimmed = key.trim();
    if (trimmed.length === 0) continue;
    if (normalized.has(trimmed)) {
      throw new Error(`Duplicate action environment key "${trimmed}".`);
    }
    normalized.set(trimmed, value);
  }
  return Object.fromEntries(
    [...normalized.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function isStringRecordEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) {
  return (
    JSON.stringify(normalizeActionEnvironment(left)) ===
    JSON.stringify(normalizeActionEnvironment(right))
  );
}

function ProjectSettingsLoading() {
  return (
    <div className="flex min-h-32 items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}

function RemoteSettingDescription({ remote }: { remote: ProjectEffectiveRemote | null }) {
  if (!remote) {
    return (
      <div className="grid gap-0.5">
        <span>No Git remote configured.</span>
        <span>Enable custom remote to set one manually.</span>
      </div>
    );
  }

  const remoteValue = formatEffectiveGitRemoteValue(remote);
  const openUrl = remote.webUrl;
  const content = (
    <span className="flex min-w-0 max-w-full items-center gap-2">
      <span className="shrink-0 text-muted-foreground">{remote.remoteName}:</span>
      <span
        className="truncate font-mono text-xs text-muted-foreground group-hover:underline"
        title={remoteValue}
      >
        {remoteValue}
      </span>
    </span>
  );

  if (!openUrl) return <div className="min-w-0">{content}</div>;

  return (
    <button
      type="button"
      className="group block min-w-0 max-w-full rounded-md text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={`Open ${openUrl}`}
      onClick={() => openExternalUrl(openUrl, "Unable to open remote")}
    >
      {content}
    </button>
  );
}

function formatEffectiveGitRemoteValue(remote: ProjectEffectiveRemote) {
  return remote.remoteUrl;
}

function ProjectSettingRow({
  title,
  description,
  value,
  control,
  resetAction,
  children,
  align = "center",
  className,
}: {
  title: string;
  description?: ReactNode;
  value?: string;
  control?: ReactNode;
  resetAction?: ReactNode;
  children?: ReactNode;
  align?: "center" | "start";
  className?: string;
}) {
  const hasChildren = Boolean(children);
  const alignStart = align === "start" || hasChildren || description !== undefined;
  return (
    <div className={cn("min-w-0 rounded-lg px-3 py-3 sm:px-4", className)}>
      <div
        className={cn(
          // min-h-8 keeps every row the same height whether its control is a
          // 32px select or a 28px button pair, so the list reads evenly spaced.
          "flex min-h-8 min-w-0 flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(9rem,auto)] sm:gap-6",
          alignStart ? "sm:items-start" : "sm:items-center",
        )}
      >
        <div
          className={cn(
            "min-w-0 flex-1 space-y-1 text-sm font-medium text-foreground",
            alignStart && "sm:pt-1",
          )}
        >
          <div className="flex min-h-5 items-center gap-1.5">
            <div className="tracking-[-0.005em]">{title}</div>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          {description ? (
            <div className="max-w-xl text-[13px] leading-[1.45] font-normal text-muted-foreground/80">
              {description}
            </div>
          ) : null}
        </div>
        <div className={cn("min-w-0 sm:flex-1", alignStart && control && "sm:self-stretch")}>
          {control ? (
            <div className="flex min-w-0 w-full items-center sm:h-full sm:w-auto sm:justify-end">
              {control}
            </div>
          ) : value !== undefined ? (
            <div
              className="min-w-0 truncate text-left text-sm text-muted-foreground sm:text-right"
              title={value}
            >
              {value}
            </div>
          ) : null}
        </div>
      </div>
      {children ? <div className="mt-4 min-w-0">{children}</div> : null}
    </div>
  );
}

function ActionEnvironmentEditor({
  environment,
  onChange,
}: {
  environment: ProjectActionEnvironment;
  onChange: (environment: ProjectActionEnvironment) => void;
}) {
  const entries = useMemo(
    () => Object.entries(environment).toSorted(([left], [right]) => left.localeCompare(right)),
    [environment],
  );

  const updateEntryKey = (previousKey: string, nextKey: string) => {
    const trimmedNextKey = nextKey.trim();
    // Clearing the name field is a no-op rather than a silent row drop:
    // normalizeActionEnvironment would discard an empty key on commit while
    // the row kept rendering as if it were saved.
    if (trimmedNextKey.length === 0 || trimmedNextKey === previousKey) return;
    const duplicateKey = Object.keys(environment).find(
      (key) => key !== previousKey && key.trim() === trimmedNextKey,
    );
    if (duplicateKey) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to update action environment",
          description: `"${trimmedNextKey}" is already configured.`,
        }),
      );
      return;
    }
    if (isReservedActionEnvironmentKey(trimmedNextKey)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to update action environment",
          description: `"${trimmedNextKey}" is a reserved environment variable name.`,
        }),
      );
      return;
    }

    const next = { ...environment };
    const value = next[previousKey] ?? "";
    delete next[previousKey];
    next[trimmedNextKey] = value;
    onChange(next);
  };

  const updateEntryValue = (key: string, value: string) => {
    onChange({ ...environment, [key]: value });
  };

  const removeEntry = (key: string) => {
    const next = { ...environment };
    delete next[key];
    onChange(next);
  };

  const addEntry = () => {
    let index = 1;
    let key = "VARIABLE";
    while (Object.prototype.hasOwnProperty.call(environment, key)) {
      index += 1;
      key = `VARIABLE_${index}`;
    }
    onChange({ ...environment, [key]: "" });
  };

  if (entries.length === 0) {
    return (
      <div className="flex h-full min-h-14 w-full min-w-0 items-center gap-3 px-3 py-3 sm:px-4">
        <div className="shrink-0 text-sm font-medium text-foreground">Variables</div>
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          No action variables configured.
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={addEntry}>
          <PlusIcon className="size-3.5" />
          Add variable
        </Button>
      </div>
    );
  }

  return (
    <div className="grid w-full min-w-0 gap-3">
      <div className="grid gap-2">
        {entries.map(([key, value]) => (
          <div key={key} className="grid gap-2 sm:grid-cols-[minmax(0,45fr)_minmax(0,60fr)_auto]">
            <DraftInput
              aria-label="Variable name"
              value={key}
              placeholder="DATABASE_URL"
              onCommit={(nextKey) => updateEntryKey(key, nextKey)}
            />
            <DraftInput
              aria-label={`${key} value`}
              value={value}
              placeholder="value"
              onCommit={(nextValue) => updateEntryValue(key, nextValue)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${key}`}
              onClick={() => removeEntry(key)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={addEntry}>
          <PlusIcon className="size-3.5" />
          Add variable
        </Button>
      </div>
    </div>
  );
}

function ProjectNotice({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 text-card-foreground">
      <div className="text-sm font-semibold">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function openExternalUrl(url: string, title: string) {
  const api = readLocalApi();
  void api?.shell.openExternal(url).catch((error) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}

export default ProjectSettingsDialog;
