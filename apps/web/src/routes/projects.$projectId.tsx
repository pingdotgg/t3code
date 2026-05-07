import { ArrowLeftIcon, ExternalLinkIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useCanGoBack, useNavigate } from "@tanstack/react-router";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { createDefaultModelSelection, createModelSelection } from "@t3tools/shared/model";
import type {
  KeybindingCommand,
  ModelSelection,
  ProjectActionEnvironment,
  ProjectDetectedRemote,
  ProjectEffectiveRemote,
  ProjectRemoteOverride,
  ProjectScript,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { DEFAULT_MODEL } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { ensureEnvironmentApi } from "../environmentApi";
import { cn, newCommandId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { Button } from "../components/ui/button";
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
import { projectDetailsQueryOptions, projectQueryKeys } from "../lib/projectReactQuery";
import { useServerKeybindings, useServerProviders } from "../rpc/serverState";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
} from "../components/ProjectScriptsControl";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  type Icon,
} from "../components/Icons";
import { commandForProjectScript, nextProjectScriptId } from "../projectScripts";
import { syncProjectScriptKeybinding } from "../lib/projectScriptKeybindings";
import { useSettings } from "../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
} from "../modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "../providerInstances";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";

const PROVIDER_LABELS: Record<SourceControlProviderKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  "azure-devops": "Azure DevOps",
  bitbucket: "Bitbucket",
  unknown: "Generic",
};

const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  "azure-devops": AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
};

const DEFAULT_PROJECT_MODEL_SELECTION = createDefaultModelSelection();

const EMPTY_ACTION_ENVIRONMENT: ProjectActionEnvironment = {};
const ACTION_ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface RemoteOverrideDraft {
  readonly enabled: boolean;
  readonly provider: SourceControlProviderKind;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly webUrl: string;
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

function formatGitRemoteRepositoryLabel(remote: ProjectDetectedRemote) {
  const segments = normalizeGitRemoteUrl(remote.url).split("/").slice(1).filter(Boolean);
  const azureGitMarkerIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
  const azureProject = segments[azureGitMarkerIndex - 1];
  const azureRepo = segments[azureGitMarkerIndex + 1];

  if (azureGitMarkerIndex > 0 && azureProject && azureRepo) {
    return `${azureProject}/${azureRepo}`;
  }

  if (segments.length >= 2) {
    return segments.slice(-2).join("/");
  }

  return segments[0] ?? remote.name;
}

function remoteProviderIcon(remote: ProjectDetectedRemote | null): Icon {
  if (!remote?.provider) return GitIcon;
  return SOURCE_CONTROL_PROVIDER_ICONS[remote.provider.kind] ?? GitIcon;
}

function isValidActionEnvironmentKey(key: string): boolean {
  return ACTION_ENVIRONMENT_KEY_PATTERN.test(key) && key.length <= 128;
}

function ProjectRouteView() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const queryClient = useQueryClient();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadsAcrossEnvironments));
  const project = projects.find((candidate) => candidate.id === projectId);
  const queryKey = projectQueryKeys.details(project?.environmentId ?? null, project?.id ?? null);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryProviders = useServerProviders();
  const keybindings = useServerKeybindings();
  const primarySettings = useSettings();
  const remoteRuntimeState = useSavedEnvironmentRuntimeStore((state) =>
    project?.environmentId ? state.byId[project.environmentId] : null,
  );
  const settings = useMemo(
    () =>
      project?.environmentId && project.environmentId !== primaryEnvironmentId
        ? {
            ...primarySettings,
            ...remoteRuntimeState?.serverConfig?.settings,
          }
        : primarySettings,
    [
      primaryEnvironmentId,
      primarySettings,
      project?.environmentId,
      remoteRuntimeState?.serverConfig?.settings,
    ],
  );
  const serverProviders =
    project?.environmentId && project.environmentId !== primaryEnvironmentId
      ? (remoteRuntimeState?.serverConfig?.providers ?? primaryProviders)
      : primaryProviders;
  const providerInstanceEntries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(serverProviders)),
    [serverProviders],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const fallbackModelSelection = useMemo(() => {
    const entry =
      providerInstanceEntries.find((candidate) => candidate.enabled && candidate.isAvailable) ??
      providerInstanceEntries[0] ??
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
  }, [providerInstanceEntries, serverProviders, settings]);

  const projectDetails = useQuery(
    projectDetailsQueryOptions({
      environmentId: project?.environmentId ?? null,
      projectId: project?.id ?? null,
      enabled: project !== undefined,
    }),
  );

  const [title, setTitle] = useState("");
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [provider, setProvider] = useState<SourceControlProviderKind>("gitlab");
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [defaultModelSelection, setDefaultModelSelection] = useState<ModelSelection | null>(null);
  const [actionEnvironment, setActionEnvironment] =
    useState<ProjectActionEnvironment>(EMPTY_ACTION_ENVIRONMENT);

  useEffect(() => {
    const details = projectDetails.data;
    if (!details) return;
    const override = details.settings.remoteOverride;
    setTitle(details.title);
    setOverrideEnabled(Boolean(override));
    setProvider(override?.provider ?? details.detected.primaryRemote?.provider?.kind ?? "gitlab");
    setRemoteName(override?.remoteName ?? details.detected.primaryRemote?.name ?? "origin");
    setRemoteUrl(override?.remoteUrl ?? details.detected.primaryRemote?.url ?? "");
    setWebUrl(override?.webUrl ?? details.detected.primaryRemote?.provider?.baseUrl ?? "");
    setDefaultModelSelection(details.defaultModelSelection);
    setActionEnvironment(details.settings.actionEnvironment);
  }, [projectDetails.data]);

  const showProjectSettingsError = useCallback((title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  const invalidateProjectDetails = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  const commitProjectMeta = useCallback(
    async (patch: { title?: string; defaultModelSelection?: ModelSelection | null }) => {
      if (!project) return;
      const api = ensureEnvironmentApi(project.environmentId);
      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: project.id,
          ...patch,
        });
        await invalidateProjectDetails();
      } catch (error) {
        showProjectSettingsError("Failed to update project settings", error);
      }
    },
    [invalidateProjectDetails, project, showProjectSettingsError],
  );

  const commitProjectSettings = useCallback(
    async (patch: {
      remoteOverride?: ProjectRemoteOverride | null;
      actionEnvironment?: ProjectActionEnvironment;
    }) => {
      if (!project) return;
      const api = ensureEnvironmentApi(project.environmentId);
      try {
        await api.projects.updateSettings({
          projectId: project.id,
          patch,
        });
        await invalidateProjectDetails();
      } catch (error) {
        showProjectSettingsError("Failed to update project settings", error);
      }
    },
    [invalidateProjectDetails, project, showProjectSettingsError],
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
        setTitle(projectDetails.data.title);
        showProjectSettingsError(
          "Failed to update project settings",
          new Error("Project name cannot be empty."),
        );
        return;
      }
      setTitle(trimmed);
      if (trimmed !== projectDetails.data.title) {
        void commitProjectMeta({ title: trimmed });
      }
    },
    [commitProjectMeta, projectDetails.data, showProjectSettingsError],
  );

  const commitDefaultModelSelection = useCallback(
    (nextSelection: ModelSelection | null) => {
      setDefaultModelSelection(nextSelection);
      if (
        !isModelSelectionEqual(nextSelection, projectDetails.data?.defaultModelSelection ?? null)
      ) {
        void commitProjectMeta({ defaultModelSelection: nextSelection });
      }
    },
    [commitProjectMeta, projectDetails.data?.defaultModelSelection],
  );

  const commitActionEnvironment = useCallback(
    (nextEnvironment: ProjectActionEnvironment) => {
      setActionEnvironment(nextEnvironment);
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
      if (!isStringRecordEqual(normalized, projectDetails.data?.settings.actionEnvironment ?? {})) {
        void commitProjectSettings({ actionEnvironment: normalized });
      }
    },
    [
      commitProjectSettings,
      projectDetails.data?.settings.actionEnvironment,
      showProjectSettingsError,
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
  }) => {
    if (!project) return;
    const api = ensureEnvironmentApi(project.environmentId);
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: newCommandId(),
      projectId: project.id,
      scripts: input.nextScripts,
    });

    await syncProjectScriptKeybinding({
      keybindings,
      keybinding: input.keybinding,
      command: input.keybindingCommand,
      server: readLocalApi()?.server,
    });
    await queryClient.invalidateQueries({ queryKey });
  };

  const saveProjectScript = async (input: NewProjectScriptInput) => {
    const details = projectDetails.data;
    if (!details) return;
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
    await persistProjectScripts({
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(nextId),
    });
  };

  const updateProjectScript = async (scriptId: string, input: NewProjectScriptInput) => {
    const details = projectDetails.data;
    if (!details) return;
    const existingScript = details.scripts.find((script) => script.id === scriptId);
    if (!existingScript) {
      throw new Error("Action not found.");
    }
    const updatedScript: ProjectScript = {
      ...existingScript,
      name: input.name,
      command: input.command,
      icon: input.icon,
      runOnWorktreeCreate: input.runOnWorktreeCreate,
    };
    const nextScripts = details.scripts.map((script) =>
      script.id === scriptId
        ? updatedScript
        : input.runOnWorktreeCreate
          ? Object.assign({}, script, { runOnWorktreeCreate: false })
          : script,
    );
    await persistProjectScripts({
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(scriptId),
    });
  };

  const deleteProjectScript = async (scriptId: string) => {
    const details = projectDetails.data;
    if (!details) return;
    await persistProjectScripts({
      nextScripts: details.scripts.filter((script) => script.id !== scriptId),
      keybinding: null,
      keybindingCommand: commandForProjectScript(scriptId),
    });
  };

  const removeProjectMutation = useMutation({
    mutationFn: async () => {
      if (!project) {
        throw new Error("Project no longer available.");
      }
      const willDeleteThreads = projectThreadCount > 0;
      const message = [
        willDeleteThreads
          ? `Remove project "${project.name}" and delete its ${projectThreadCount} thread${
              projectThreadCount === 1 ? "" : "s"
            }?`
          : `Remove project "${project.name}"?`,
        `Path: ${project.cwd}`,
        willDeleteThreads
          ? "This permanently clears conversation history for every related thread."
          : "This removes only this project entry.",
        "This action cannot be undone.",
      ].join("\n");
      const confirmed = await readLocalApi()?.dialogs.confirm(message);
      if (!confirmed) return false;

      await ensureEnvironmentApi(project.environmentId).orchestration.dispatchCommand({
        type: "project.delete",
        commandId: newCommandId(),
        projectId: project.id,
        force: true,
      });
      return true;
    },
    onSuccess: (removed) => {
      if (!removed) return;
      toastManager.add({
        type: "success",
        title: "Project removed",
      });
      void navigate({ to: "/" });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to remove project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const effectiveRemote = projectDetails.data?.effective.remote ?? null;
  const detectedRemote =
    projectDetails.data?.detected.primaryRemote ?? projectDetails.data?.detected.remotes[0] ?? null;
  const displayedModelSelection = defaultModelSelection ?? fallbackModelSelection;
  const displayedModelInstanceEntry =
    providerInstanceEntries.find(
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
            disabled={projectDetails.isFetching}
            onClick={() => void projectDetails.refetch()}
          >
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
        </header>

        {project && projectDetails.isLoading ? (
          <ProjectSettingsLoading />
        ) : (
          <SettingsPageContainer>
            {!project ? (
              <ProjectNotice title="Project not found" description="This project is not loaded." />
            ) : projectDetails.isError ? (
              <ProjectNotice
                title="Unable to load project"
                description={
                  projectDetails.error instanceof Error
                    ? projectDetails.error.message
                    : "Project details could not be loaded."
                }
              />
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

                <SettingsSection title="Project">
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
                          instanceEntries={providerInstanceEntries}
                          keybindings={keybindings}
                          modelOptionsByInstance={modelOptionsByInstance}
                          terminalOpen={false}
                          triggerVariant="outline"
                          triggerClassName="max-w-md"
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

                <SettingsSection
                  title="Git info"
                  headerAction={
                    effectiveRemote?.webUrl ? <OpenRemoteButton remote={effectiveRemote} /> : null
                  }
                >
                  <ProjectSettingRow
                    title="Remote"
                    align={overrideEnabled ? "start" : "center"}
                    resetAction={
                      projectDetails.data.settings.remoteOverride !== null ? (
                        <SettingResetButton
                          label="custom remote"
                          onClick={() => {
                            setOverrideEnabled(false);
                            void commitProjectSettings({ remoteOverride: null });
                          }}
                        />
                      ) : null
                    }
                    control={
                      <div className="grid w-full min-w-0 gap-4">
                        <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          {overrideEnabled ? (
                            <div className="min-w-0 text-sm text-muted-foreground">
                              Custom remote
                            </div>
                          ) : (
                            <DetectedRemoteSummary remote={detectedRemote} />
                          )}
                          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                            <span>Custom</span>
                            <Switch
                              checked={overrideEnabled}
                              aria-label="Use custom remote"
                              onCheckedChange={(checked) => {
                                const enabled = Boolean(checked);
                                setOverrideEnabled(enabled);
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
                                  setProvider(nextProvider);
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
                                  setRemoteName(nextRemoteName);
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
                                  setRemoteUrl(nextRemoteUrl);
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
                                  setWebUrl(nextWebUrl);
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
                        disabled={removeProjectMutation.isPending}
                        onClick={() => removeProjectMutation.mutate()}
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
  return JSON.stringify(left) === JSON.stringify(normalizeActionEnvironment(right));
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

function DetectedRemoteSummary({ remote }: { remote: ProjectDetectedRemote | null }) {
  const Icon = remoteProviderIcon(remote);

  if (!remote) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-3 py-1 text-left">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            No Git remote configured.
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Enable custom remote to set one manually.
          </div>
        </div>
      </div>
    );
  }

  const remoteValue = formatGitRemoteValue(remote);
  const providerLabel = remote.provider?.name ?? "Git remote";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 py-1 text-left">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground" title={remoteValue}>
          {formatGitRemoteRepositoryLabel(remote)}
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="truncate">{providerLabel}</span>
          <span aria-hidden>-</span>
          <span className="truncate">{remote.name}</span>
        </div>
      </div>
    </div>
  );
}

function formatGitRemoteValue(remote: ProjectDetectedRemote) {
  return remote.pushUrl && remote.pushUrl !== remote.url
    ? `${remote.url} (push: ${remote.pushUrl})`
    : remote.url;
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
            <p className="mt-2 max-w-sm text-xs font-normal leading-5 text-muted-foreground">
              {description}
            </p>
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

function OpenRemoteButton({ remote }: { remote: ProjectEffectiveRemote }) {
  const openRemote = () => {
    const url = remote.webUrl ?? remote.providerInfo?.baseUrl;
    if (!url) return;
    const api = readLocalApi();
    void api?.shell.openExternal(url).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open remote",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };
  return (
    <Button size="xs" variant="ghost" onClick={openRemote}>
      <ExternalLinkIcon className="size-3.5" />
      Open
    </Button>
  );
}

export const Route = createFileRoute("/projects/$projectId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ProjectRouteView,
});
