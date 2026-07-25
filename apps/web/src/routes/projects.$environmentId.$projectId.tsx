import { ArrowLeftIcon, PlusIcon, RefreshCwIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { createFileRoute, redirect, useCanGoBack, useNavigate } from "@tanstack/react-router";
import type { AuthGateBeforeLoadArgs } from "./-authGateRouteContext";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createDefaultModelSelection, createModelSelection } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
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
} from "@t3tools/contracts";
import { DEFAULT_MODEL } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { ensureLocalApi, readLocalApi } from "../localApi";
import { Button } from "../components/ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../components/ui/number-field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { Switch } from "../components/ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { toastManager, stackedThreadToast } from "../components/ui/toast";
import { DraftInput } from "../components/ui/draft-input";
import { isElectron } from "../env";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../components/ProjectScriptsControl";
import { commandForProjectScript, nextProjectScriptId } from "../projectScripts";
import { syncProjectScriptKeybinding } from "../lib/projectScriptKeybindings";
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
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import {
  EMPTY_SERVER_PROVIDERS,
  primaryServerKeybindingsAtom,
  primaryServerProvidersAtom,
} from "../state/server";
import { deriveProjectGroupingOverrideKey, selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";

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
  return key.startsWith(ACTION_ENVIRONMENT_RESERVED_PREFIX);
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

function ProjectRouteView() {
  const { environmentId, projectId } = Route.useParams();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
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
  const projectServerConfig = project?.environmentId
    ? (serverConfigs.get(project.environmentId) ?? null)
    : null;
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
  const title = currentDraft?.title ?? details?.title ?? "";
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

  const commitTitle = useCallback(
    (nextTitle: string) => {
      const trimmed = nextTitle.trim();
      if (!details) return;
      if (trimmed.length === 0) {
        clearDraftKeys(["title"], projectDraftKey);
        showProjectSettingsError(
          "Failed to update project settings",
          new Error("Project name cannot be empty."),
        );
        return;
      }
      // Compare against the displayed (draft-aware) value, not the possibly
      // stale server snapshot, so a revert of an in-flight edit still commits.
      if (trimmed === title) return;
      stageDraft({ title: trimmed });
      void commitProjectMeta({ title: trimmed });
    },
    [
      clearDraftKeys,
      commitProjectMeta,
      details,
      projectDraftKey,
      showProjectSettingsError,
      stageDraft,
      title,
    ],
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
          new Error(`"${reservedKey}" is reserved for T3Code runtime variables.`),
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

  const navigateBackWithinApp = () => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  };

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
        server: readLocalApi()?.server,
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
      void navigate({ to: "/" });
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
  }, [deleteProject, navigate, project, projectThreadCount, removeProjectPending]);

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
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3 sm:px-5">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <Button
            size="icon-xs"
            variant="ghost"
            className={isElectron ? "drag-region-none" : ""}
            aria-label="Back"
            onClick={navigateBackWithinApp}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">Project settings</div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={projectDetails.isPending}
            onClick={refreshProjectDetails}
          >
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
        </header>

        {project && projectDetails.isPending && !projectDetails.data ? (
          <ProjectSettingsLoading />
        ) : (
          <SettingsPageContainer compact className="max-w-7xl gap-5">
            {!project ? (
              <ProjectNotice title="Project not found" description="This project is not loaded." />
            ) : projectDetails.error !== null ? (
              <ProjectNotice title="Unable to load project" description={projectDetails.error} />
            ) : projectDetails.data ? (
              <>
                <section className="px-4 sm:px-5">
                  <div className="flex min-h-9 min-w-0 items-center justify-between gap-4">
                    <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold leading-none tracking-tight">
                      {title}
                    </h1>
                    {projectLocations.length > 1 ? (
                      <Select
                        value={`${project.environmentId}:${project.id}`}
                        onValueChange={(value) => {
                          const nextProject = projectLocations.find(
                            (candidate) => `${candidate.environmentId}:${candidate.id}` === value,
                          );
                          if (!nextProject) return;
                          void navigate({
                            to: "/projects/$environmentId/$projectId",
                            params: {
                              environmentId: nextProject.environmentId,
                              projectId: nextProject.id,
                            },
                          });
                        }}
                      >
                        <SelectTrigger
                          variant="ghost"
                          size="sm"
                          className="h-8 w-auto max-w-full px-2 font-medium"
                          aria-label="Project environment"
                        >
                          <SelectValue>
                            <span className="flex min-w-0 items-center gap-1.5">
                              <ServerIcon className="size-3.5 shrink-0" />
                              <span className="truncate">{currentEnvironmentLabel}</span>
                            </span>
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="start" alignItemWithTrigger={false}>
                          {projectLocations.map((location) => (
                            <SelectItem
                              key={`${location.environmentId}:${location.id}`}
                              value={`${location.environmentId}:${location.id}`}
                            >
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate">
                                  {location.environmentLabel ?? "Current environment"}
                                </span>
                                <span className="truncate font-mono text-xs text-muted-foreground">
                                  {location.workspaceRoot}
                                </span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    ) : (
                      <div className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 text-sm font-medium text-muted-foreground">
                        <ServerIcon className="size-3.5 shrink-0" />
                        <span className="truncate">{currentEnvironmentLabel}</span>
                      </div>
                    )}
                  </div>
                </section>

                <div className="grid min-w-0 gap-x-6 gap-y-4 xl:grid-cols-2 xl:items-start">
                  <div className="min-w-0">
                    <SettingsSection title="General" className="space-y-1.5">
                      <div className="mx-3 rounded-xl p-1 sm:mx-4">
                        <ProjectSettingRow
                          title="Name"
                          control={
                            <DraftInput className="max-w-md" value={title} onCommit={commitTitle} />
                          }
                        />
                        <ProjectSettingRow
                          title="Grouping rule"
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
                              <SelectTrigger
                                className="w-full max-w-md"
                                aria-label="Project grouping rule"
                              >
                                <SelectValue>
                                  {projectGroupingSelection === "inherit"
                                    ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                                    : PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection]}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectPopup align="start" alignItemWithTrigger={false}>
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
                          title="Default model"
                          resetAction={
                            projectDetails.data.defaultModelSelection !== null ? (
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
                                  commitDefaultModelSelection(
                                    createModelSelection(instanceId, model),
                                  )
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
                        <ProjectSettingRow
                          title="Path"
                          control={<ProjectPathLink path={projectDetails.data.workspaceRoot} />}
                        />
                      </div>
                    </SettingsSection>
                  </div>

                  <div className="min-w-0">
                    <SettingsSection title="Git info" className="space-y-1.5">
                      <div className="mx-3 rounded-xl p-1 sm:mx-4">
                        <ProjectSettingRow
                          title="Remote"
                          description={
                            overrideEnabled ? undefined : (
                              <RemoteSettingDescription remote={effectiveRemote} />
                            )
                          }
                          align="start"
                          resetAction={
                            projectDetails.data.settings.remoteOverride !== null ? (
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
                            <div className="grid w-full min-w-0 gap-4">
                              <div className="flex w-full justify-start">
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
                              </div>
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
                                      <SelectTrigger aria-label="Source control provider">
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
                                      Not saved yet — enter a remote name and URL to apply this
                                      override.
                                    </p>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          }
                        />
                        <ProjectSettingRow
                          title="Git root"
                          value={
                            projectDetails.data.detected.gitRoot ?? "No Git repository detected"
                          }
                        />
                        <ProjectSettingRow
                          title="Branch"
                          value={
                            projectDetails.data.detected.branch ??
                            (projectDetails.data.detected.gitRoot ? "None" : "—")
                          }
                        />
                        <ProjectSettingRow
                          title="Fetch interval"
                          resetAction={
                            projectDetails.data.settings.automaticGitFetchInterval !== null ? (
                              <SettingResetButton
                                label="fetch interval"
                                onClick={() => commitAutomaticGitFetchInterval(null)}
                              />
                            ) : null
                          }
                          control={
                            <div className="flex shrink-0 items-center gap-2">
                              <NumberField
                                value={automaticGitFetchIntervalSeconds}
                                min={0}
                                step={GIT_FETCH_INTERVAL_STEP_SECONDS}
                                size="sm"
                                className="w-32"
                                onValueChange={(value) =>
                                  commitAutomaticGitFetchInterval(
                                    Duration.toMillis(
                                      Duration.seconds(normalizeFetchIntervalSeconds(value)),
                                    ),
                                  )
                                }
                              >
                                <NumberFieldGroup>
                                  <NumberFieldDecrement aria-label="Decrease fetch interval" />
                                  <NumberFieldInput aria-label="Automatic Git fetch interval in seconds" />
                                  <NumberFieldIncrement aria-label="Increase fetch interval" />
                                </NumberFieldGroup>
                              </NumberField>
                              <span className="text-xs text-muted-foreground">seconds</span>
                            </div>
                          }
                        />
                      </div>
                    </SettingsSection>
                  </div>

                  <SettingsSection title="Providers" className="space-y-1.5 xl:col-span-2">
                    <div className="mx-3 grid gap-1 rounded-xl p-1 sm:mx-4 sm:grid-cols-2 xl:grid-cols-4">
                      {globallyEnabledProviderInstanceEntries.map((entry) => {
                        const allowed = !disabledProviderInstanceIds.includes(entry.instanceId);
                        const isLastAllowedProvider =
                          allowed && projectProviderInstanceEntries.length <= 1;
                        const duplicateDriverCount = globallyEnabledProviderInstanceEntries.filter(
                          (candidate) => candidate.driverKind === entry.driverKind,
                        ).length;
                        return (
                          <div
                            key={entry.instanceId}
                            className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-2"
                          >
                            <div className="flex min-w-0 items-center gap-2.5">
                              <ProviderInstanceIcon
                                driverKind={entry.driverKind}
                                displayName={entry.displayName}
                                accentColor={entry.accentColor}
                                showBadge={Boolean(entry.accentColor) || duplicateDriverCount > 1}
                                className={duplicateDriverCount > 1 ? "size-5" : "size-4"}
                                iconClassName="size-4"
                                badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
                              />
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-foreground">
                                  {entry.displayName}
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {entry.instanceId}
                                </div>
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
                    </div>
                  </SettingsSection>

                  <SettingsSection title="Automation" className="space-y-1.5 xl:col-span-2">
                    <div className="mx-3 grid min-w-0 gap-1 rounded-xl p-1 sm:mx-4 lg:grid-cols-2">
                      <ProjectScriptsControl
                        variant="settings"
                        scripts={projectDetails.data.scripts}
                        keybindings={keybindings}
                        onAddScript={saveProjectScript}
                        onUpdateScript={updateProjectScript}
                        onDeleteScript={deleteProjectScript}
                      />
                      <ProjectSettingRow
                        title="Variables"
                        align="start"
                        control={
                          <ActionEnvironmentEditor
                            environment={actionEnvironment}
                            onChange={commitActionEnvironment}
                          />
                        }
                      />
                    </div>
                  </SettingsSection>

                  <div className="mx-4 flex min-w-0 items-center justify-between gap-4 rounded-lg px-3 py-2 xl:col-span-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">Remove project</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {projectThreadCount > 0
                          ? "All project threads will be deleted."
                          : "No threads will be deleted."}
                      </div>
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
                </div>
              </>
            ) : null}
          </SettingsPageContainer>
        )}
      </div>
    </SidebarInset>
  );
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

function ProjectPathLink({ path }: { path: string }) {
  const openPath = () => {
    const api = readLocalApi();
    void api?.shell.openInEditor(path, "file-manager").catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open project folder",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };

  return (
    <button
      type="button"
      className="min-w-0 max-w-full cursor-pointer truncate text-left text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      title={path}
      aria-label="Open project folder"
      onClick={openPath}
    >
      {path}
    </button>
  );
}

function ProjectSettingsLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
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
        className="truncate font-mono text-[11px] text-muted-foreground group-hover:underline"
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
}: {
  title: string;
  description?: ReactNode;
  value?: string;
  control?: ReactNode;
  resetAction?: ReactNode;
  children?: ReactNode;
  align?: "center" | "start";
}) {
  const hasChildren = Boolean(children);
  const alignStart = align === "start" || hasChildren || description !== undefined;
  return (
    <div className="rounded-lg px-3 py-2.5 sm:px-4">
      <div
        className={cn(
          "flex min-w-0 flex-col gap-2 sm:grid sm:grid-cols-[minmax(8rem,0.7fr)_minmax(12rem,1.3fr)] sm:gap-4",
          alignStart ? "sm:items-start" : "sm:items-center",
        )}
      >
        <div className={cn("min-w-0 text-sm font-medium text-foreground", alignStart && "sm:pt-1")}>
          <div className="flex min-h-5 items-center gap-1.5">
            <div>{title}</div>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          {description ? (
            <div className="mt-1 max-w-sm text-xs font-normal leading-4 text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
        <div className={cn("min-w-0 sm:flex-1", alignStart && control && "sm:self-stretch")}>
          {control ? (
            <div className="flex min-w-0 w-full items-center sm:h-full sm:justify-start">
              {control}
            </div>
          ) : value !== undefined ? (
            <div className="min-w-0 truncate text-left text-sm text-muted-foreground" title={value}>
              {value}
            </div>
          ) : null}
          {children ? <div className="mt-4 min-w-0">{children}</div> : null}
        </div>
      </div>
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
          description: `"${trimmedNextKey}" is reserved for T3Code runtime variables.`,
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
      <div className="flex w-full min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-muted-foreground">No action variables configured.</p>
        <Button type="button" variant="outline" size="sm" onClick={addEntry}>
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
          <div key={key} className="grid gap-2 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]">
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
    <div className="rounded-2xl border border-border bg-card p-6 text-card-foreground">
      <h1 className="text-lg font-semibold">{title}</h1>
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

export const Route = createFileRoute("/projects/$environmentId/$projectId")({
  beforeLoad: async ({ context }: AuthGateBeforeLoadArgs) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ProjectRouteView,
});
