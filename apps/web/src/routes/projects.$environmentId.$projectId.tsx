import { ArrowLeftIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { createFileRoute, redirect, useCanGoBack, useNavigate } from "@tanstack/react-router";
import type { AuthGateBeforeLoadArgs } from "./-authGateRouteContext";
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
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { DEFAULT_MODEL } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

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
import { usePrimarySettings } from "../hooks/useSettings";
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
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";

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

interface ProjectSettingsDraft {
  readonly projectKey: string;
  readonly title?: string;
  readonly overrideEnabled?: boolean;
  readonly provider?: SourceControlProviderKind;
  readonly remoteName?: string;
  readonly remoteUrl?: string;
  readonly webUrl?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly automaticGitFetchInterval?: number | null;
  readonly actionEnvironment?: ProjectActionEnvironment;
  readonly disabledProviderInstanceIds?: ProviderInstanceId[];
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
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
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
      ? (projectServerConfig?.providers ?? primaryProviders)
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
  const details = projectDetails.data;
  const projectDraftKey = project && details ? `${project.environmentId}:${details.id}` : null;
  const currentDraft = draft?.projectKey === projectDraftKey ? draft : null;
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

  const settingsCommitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const refreshProjectDetails = projectDetails.refresh;

  const commitProjectMeta = useCallback(
    async (patch: { title?: string; defaultModelSelection?: ModelSelection | null }) => {
      if (!project) return;
      const result = await updateProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          ...patch,
        },
      });
      if (result._tag === "Failure") {
        showProjectSettingsError(
          "Failed to update project settings",
          squashAtomCommandFailure(result),
        );
        return;
      }
      refreshProjectDetails();
    },
    [project, refreshProjectDetails, showProjectSettingsError, updateProject],
  );

  const commitProjectSettings = useCallback(
    (patch: ProjectSettingsPatch) => {
      const nextCommit = settingsCommitQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (!project) return;
          const result = await updateProjectSettings({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              patch,
            },
          });
          if (result._tag === "Failure") {
            showProjectSettingsError(
              "Failed to update project settings",
              squashAtomCommandFailure(result),
            );
            return;
          }
          refreshProjectDetails();
        });
      settingsCommitQueueRef.current = nextCommit.catch(() => undefined);
      return nextCommit;
    },
    [project, refreshProjectDetails, showProjectSettingsError, updateProjectSettings],
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
      if (!projectDetails.data) return;
      if (trimmed.length === 0) {
        stageDraft({ title: projectDetails.data.title });
        showProjectSettingsError(
          "Failed to update project settings",
          new Error("Project name cannot be empty."),
        );
        return;
      }
      stageDraft({ title: trimmed });
      if (trimmed !== projectDetails.data.title) {
        void commitProjectMeta({ title: trimmed });
      }
    },
    [commitProjectMeta, projectDetails.data, showProjectSettingsError, stageDraft],
  );

  const commitDefaultModelSelection = useCallback(
    (nextSelection: ModelSelection | null) => {
      stageDraft({ defaultModelSelection: nextSelection });
      if (
        !isModelSelectionEqual(nextSelection, projectDetails.data?.defaultModelSelection ?? null)
      ) {
        void commitProjectMeta({ defaultModelSelection: nextSelection });
      }
    },
    [commitProjectMeta, projectDetails.data?.defaultModelSelection, stageDraft],
  );

  const commitAutomaticGitFetchInterval = useCallback(
    (nextIntervalMs: number | null) => {
      stageDraft({ automaticGitFetchInterval: nextIntervalMs });
      const currentIntervalMs = projectDetails.data?.settings.automaticGitFetchInterval ?? null;
      if (nextIntervalMs === currentIntervalMs) {
        return;
      }
      void commitProjectSettings({ automaticGitFetchInterval: nextIntervalMs });
    },
    [commitProjectSettings, projectDetails.data?.settings.automaticGitFetchInterval, stageDraft],
  );

  const commitActionEnvironment = useCallback(
    (nextEnvironment: ProjectActionEnvironment) => {
      stageDraft({ actionEnvironment: nextEnvironment });
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
      if (!isStringRecordEqual(normalized, projectDetails.data?.settings.actionEnvironment ?? {})) {
        void commitProjectSettings({ actionEnvironment: normalized });
      }
    },
    [
      commitProjectSettings,
      projectDetails.data?.settings.actionEnvironment,
      showProjectSettingsError,
      stageDraft,
    ],
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
      void commitProjectSettings({
        disabledProviderInstanceIds: nextDisabledProviderInstanceIds,
      });
    },
    [
      commitProjectSettings,
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
    if (keybindingResult._tag === "Failure") {
      return keybindingResult;
    }
    refreshProjectDetails();
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
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
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
          <SettingsPageContainer>
            {!project ? (
              <ProjectNotice title="Project not found" description="This project is not loaded." />
            ) : projectDetails.error !== null ? (
              <ProjectNotice title="Unable to load project" description={projectDetails.error} />
            ) : projectDetails.data ? (
              <>
                <section className="space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h1 className="truncate text-2xl font-semibold tracking-tight">
                        {projectDetails.data.effective.title}
                      </h1>
                    </div>
                  </div>
                </section>

                <SettingsSection title="General">
                  <ProjectSettingRow
                    title="Name"
                    control={
                      <DraftInput className="max-w-md" value={title} onCommit={commitTitle} />
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
                      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                        <ProviderModelPicker
                          activeInstanceId={displayedModelSelection.instanceId}
                          model={displayedModelSelection.model}
                          lockedProvider={null}
                          instanceEntries={projectProviderInstanceEntries}
                          keybindings={keybindings}
                          modelOptionsByInstance={modelOptionsByInstance}
                          terminalOpen={false}
                          triggerVariant="outline"
                          triggerClassName="max-w-md"
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
                            triggerClassName="max-w-md"
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
                </SettingsSection>

                <SettingsSection title="Providers">
                  <div className="grid">
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
                          className="flex min-w-0 items-center justify-between gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5"
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

                <SettingsSection title="Git info">
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
                        <div className="flex w-full justify-end">
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
                          </div>
                        ) : null}
                      </div>
                    }
                  />
                  <ProjectSettingRow
                    title="Fetch interval"
                    description="Refresh remote branch status in the background. Set this to 0 seconds to only fetch during explicit Git actions."
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
                </SettingsSection>

                <SettingsSection title="Actions">
                  <ProjectScriptsControl
                    variant="settings"
                    scripts={projectDetails.data.scripts}
                    keybindings={keybindings}
                    onAddScript={saveProjectScript}
                    onUpdateScript={updateProjectScript}
                    onDeleteScript={deleteProjectScript}
                  />
                </SettingsSection>

                <SettingsSection title="Action environment">
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
                </SettingsSection>

                <SettingsSection title="Danger zone">
                  <ProjectSettingRow
                    title="Remove project"
                    description={
                      projectThreadCount > 0
                        ? "All project threads will be deleted."
                        : "No threads will be deleted."
                    }
                    control={
                      <Button
                        variant="destructive-outline"
                        size="sm"
                        disabled={removeProjectPending}
                        onClick={() => void removeProject()}
                      >
                        <Trash2Icon className="size-3.5" />
                        Remove
                      </Button>
                    }
                  />
                </SettingsSection>
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
      className="min-w-0 max-w-full cursor-pointer truncate text-left text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-right"
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
    <div className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div
        className={cn(
          "flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-between sm:gap-6",
          alignStart ? "sm:items-start" : "sm:items-center",
        )}
      >
        <div
          className={cn(
            "shrink-0 text-sm font-medium text-foreground sm:min-w-48",
            alignStart && "sm:pt-1.5",
          )}
        >
          <div className="flex min-h-5 items-center gap-1.5">
            <div>{title}</div>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          {description ? (
            <div className="mt-2 max-w-sm text-xs font-normal leading-5 text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
        <div className={cn("min-w-0 sm:flex-1", alignStart && control && "sm:self-stretch")}>
          {control ? (
            <div className="flex min-w-0 w-full items-center sm:h-full sm:justify-end">
              {control}
            </div>
          ) : value !== undefined ? (
            <div
              className="min-w-0 truncate text-sm text-muted-foreground sm:text-right"
              title={value}
            >
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
    const duplicateKey = Object.keys(environment).find(
      (key) => key !== previousKey && key.trim() === trimmedNextKey,
    );
    if (trimmedNextKey.length > 0 && duplicateKey) {
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
    next[nextKey] = value;
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
      <div className="flex w-full min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-end">
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
