import { createModelSelection } from "@workbench/shared/model";
import type {
  ProviderInteractionMode,
  ProviderKind,
  ProviderModelOptions,
  RuntimeMode,
  ServerProvider,
} from "@workbench/contracts";
import { scopedProjectKey, scopeProjectRef } from "@workbench/client-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowUpIcon,
  BotIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  WrenchIcon,
} from "lucide-react";

import { FolderPlusIcon } from "lucide-react";
import { ClaudeAI, CursorIcon, type Icon, OpenAI, OpenCodeIcon, PiIcon } from "./Icons";
import { DEFAULT_MODEL_BY_PROVIDER } from "@workbench/contracts";
import { toastManager } from "./ui/toast";
import { newCommandId, newProjectId } from "../lib/utils";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { readLocalApi } from "../localApi";
import { readEnvironmentApi } from "../environmentApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { usePendingAutoSubmitStore } from "../pendingAutoSubmitStore";
import { formatProviderDisplayLabel, describeProviderAvailability } from "../coworkShell";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "../providerModels";
import { useServerProviders } from "../rpc/serverState";
import { PROVIDER_OPTIONS } from "../session-logic";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import type { Project } from "../types";
import { cn } from "~/lib/utils";
import { orderItemsByPreferredIds } from "./Sidebar.logic";
import { TraitsPicker } from "./chat/TraitsPicker";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { SidebarInset, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Textarea } from "./ui/textarea";

type AnyProviderOptions = ProviderModelOptions[ProviderKind];

const ACCESS_MODE_COPY: Record<
  RuntimeMode,
  { label: string; description: string; Icon: typeof LockIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    Icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    Icon: PenLineIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    Icon: LockOpenIcon,
  },
};

const INTERACTION_MODE_COPY: Record<
  ProviderInteractionMode,
  { label: string; description: string }
> = {
  default: {
    label: "Build",
    description: "Work directly toward the task.",
  },
  plan: {
    label: "Plan",
    description: "Outline the approach before making changes.",
  },
};

const PROVIDER_MENU_ORDER: Record<ProviderKind, number> = {
  claudeAgent: 0,
  codex: 1,
  opencode: 2,
  cursor: 3,
  pi: 4,
};

/**
 * Provider-specific glyph for the Assistant chip. Mirrors the same mapping
 * ProviderModelPicker uses so the landing composer and the in-thread
 * composer always agree on the visual for a given backend.
 */
const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderKind, Icon>> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
  pi: PiIcon,
};

function providerIconFor(provider: ProviderKind): Icon | typeof BotIcon {
  return PROVIDER_ICON_BY_PROVIDER[provider] ?? BotIcon;
}

function projectKey(project: Project): string {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

function projectLabel(project: Project | null): string {
  if (!project) {
    return "Pick a folder";
  }
  return project.name.trim().length > 0 ? project.name : project.cwd;
}

function resolveAssistantOptions(providers: ReadonlyArray<ServerProvider>) {
  if (providers.length === 0) {
    return PROVIDER_OPTIONS.filter((provider) => provider.available).map((provider) => ({
      provider: provider.value,
      enabled: provider.available,
      installed: true,
      status: "ready" as const,
      models: [],
    }));
  }

  return [...providers].sort(
    (left, right) => PROVIDER_MENU_ORDER[left.provider] - PROVIDER_MENU_ORDER[right.provider],
  );
}

function LandingPillButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn(
        "h-10 rounded-full border border-border/60 bg-background/84 px-4 text-[15px] text-foreground shadow-[0_10px_30px_-24px_rgba(0,0,0,0.55)] backdrop-blur hover:bg-background/96",
        props.className,
      )}
      {...props}
    />
  );
}

export function NoActiveThreadState() {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const providers = useServerProviders();
  const { handleNewThread } = useNewThreadHandler();
  const { state: leftSidebarState } = useSidebar();
  const isLeftSidebarCollapsed = leftSidebarState === "collapsed";
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: (project) => projectKey(project),
      }),
    [projectOrder, projects],
  );
  const assistantOptions = useMemo(() => resolveAssistantOptions(providers), [providers]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [requestedProvider, setRequestedProvider] = useState<ProviderKind>("claudeAgent");
  const [prompt, setPrompt] = useState("");
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("default");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("full-access");
  const [modelOptionsByProvider, setModelOptionsByProvider] = useState<
    Partial<Record<ProviderKind, AnyProviderOptions | undefined>>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      const hasMatch = orderedProjects.some((project) => projectKey(project) === selectedProjectId);
      if (hasMatch) {
        return;
      }
    }

    const fallbackProject = orderedProjects[0];
    setSelectedProjectId(fallbackProject ? projectKey(fallbackProject) : null);
  }, [orderedProjects, selectedProjectId]);

  const selectedProject =
    orderedProjects.find((project) => projectKey(project) === selectedProjectId) ??
    orderedProjects[0] ??
    null;
  const selectedProvider = useMemo(
    () => resolveSelectableProvider(providers, requestedProvider),
    [providers, requestedProvider],
  );
  const selectedModel = useMemo(
    () => getDefaultServerModel(providers, selectedProvider),
    [providers, selectedProvider],
  );
  const selectedProviderModels = useMemo(
    () => getProviderModels(providers, selectedProvider),
    [providers, selectedProvider],
  );
  const selectedModelOptions = modelOptionsByProvider[selectedProvider];
  const accessModeCopy = ACCESS_MODE_COPY[runtimeMode];

  /**
   * Launches the OS folder picker, turns the chosen directory into a new
   * project in the current environment, and selects it as the active
   * folder. The folder picker lives on the desktop `LocalApi`; the
   * project-create dispatch goes through the thread's environment API.
   *
   * Falls back with a helpful toast on web (no desktop bridge) or when
   * there's no existing environment to attach the new project to.
   */
  const handleBrowseForFolder = useCallback(async () => {
    const targetEnvironmentId = orderedProjects[0]?.environmentId ?? undefined;
    if (!targetEnvironmentId) {
      toastManager.add({
        type: "info",
        title: "Add a project first",
        description: "Use the command palette (\u2318K) to create your first console.",
      });
      return;
    }
    const localApi = readLocalApi();
    if (!localApi?.dialogs?.pickFolder) {
      toastManager.add({
        type: "info",
        title: "Folder picker unavailable",
        description: "Install the desktop app to browse folders directly.",
      });
      return;
    }
    let pickedPath: string | null = null;
    try {
      pickedPath = await localApi.dialogs.pickFolder();
    } catch {
      return;
    }
    if (!pickedPath) return;
    const existing = orderedProjects.find(
      (project) => project.environmentId === targetEnvironmentId && project.cwd === pickedPath,
    );
    if (existing) {
      setSelectedProjectId(projectKey(existing));
      return;
    }
    const envApi = readEnvironmentApi(targetEnvironmentId);
    if (!envApi) {
      toastManager.add({
        type: "error",
        title: "Couldn't reach that environment",
        description: "Try refreshing the page.",
      });
      return;
    }
    try {
      const projectId = newProjectId();
      await envApi.orchestration.dispatchCommand({
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        title: inferProjectTitleFromPath(pickedPath),
        workspaceRoot: pickedPath,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        createdAt: new Date().toISOString(),
      });
      setSelectedProjectId(scopedProjectKey(scopeProjectRef(targetEnvironmentId, projectId)));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to add folder",
        description: error instanceof Error ? error.message : "Could not create that project.",
      });
    }
  }, [orderedProjects]);

  const handleSubmit = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!selectedProject) {
      setErrorMessage("Pick a folder first.");
      return;
    }
    if (trimmedPrompt.length === 0) {
      setErrorMessage("Describe a task to continue.");
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const projectRef = scopeProjectRef(selectedProject.environmentId, selectedProject.id);
      await handleNewThread(projectRef, { envMode: "local" });

      const draftStore = useComposerDraftStore.getState();
      const draftSession = draftStore.getDraftSessionByLogicalProjectKey(
        deriveLogicalProjectKeyFromSettings(selectedProject, projectGroupingSettings),
      );
      if (!draftSession) {
        throw new Error("Could not open the selected folder.");
      }

      const modelSelection = createModelSelection(
        selectedProvider,
        selectedModel,
        selectedModelOptions,
      );

      draftStore.setDraftThreadContext(draftSession.draftId, {
        runtimeMode,
        interactionMode,
      });
      draftStore.setModelSelection(draftSession.draftId, modelSelection);
      draftStore.setStickyModelSelection(modelSelection);
      draftStore.setPrompt(draftSession.draftId, trimmedPrompt);
      // Mark the draft for auto-submit so the new ChatView fires onSend on
      // mount instead of leaving the user staring at their pre-populated
      // prompt waiting for a second Enter.
      usePendingAutoSubmitStore.getState().request(draftSession.draftId);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not open a task draft right now.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    handleNewThread,
    interactionMode,
    projectGroupingSettings,
    prompt,
    runtimeMode,
    selectedModel,
    selectedModelOptions,
    selectedProject,
    selectedProvider,
  ]);

  return (
    <SidebarInset className="cowork-shell h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-transparent">
        <header
          className={cn(
            "border-b border-border pr-3 sm:pr-5",
            // Match ChatView: when the left sidebar is open, the sidebar's own
            // chrome header provides the macOS traffic-light inset. When it's
            // collapsed, this header runs to the viewport edge — so we host
            // the trigger here at the same x-position.
            isLeftSidebarCollapsed && isElectron
              ? "pl-[80px] wco:pl-[calc(env(titlebar-area-x)+1em)]"
              : "pl-3 sm:pl-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isLeftSidebarCollapsed ? (
            <SidebarTrigger className="mr-2 size-7 shrink-0 text-muted-foreground/70 hover:text-foreground" />
          ) : null}
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              Start a task
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                Start a task
              </span>
            </div>
          )}
        </header>

        <Empty className="relative flex-1 overflow-y-auto">
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute left-1/2 top-16 h-64 w-64 -translate-x-[140%] rounded-full bg-[#cfdcff]/28 blur-3xl" />
            <div className="absolute right-[12%] top-24 h-72 w-72 rounded-full bg-[#fff4dd]/55 blur-3xl" />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-[min(56rem,100%)] flex-col px-3 py-6 sm:px-6 sm:py-12">
            <h1 className="cowork-display text-center leading-[1.05] text-foreground text-[clamp(2rem,6vw,3.75rem)]">
              What are you working on today?
            </h1>

            <form
              ref={formRef}
              className="mt-6 w-full sm:mt-8"
              onSubmit={(event) => {
                event.preventDefault();
                if (isSubmitting) {
                  return;
                }
                void handleSubmit();
              }}
            >
              <div className="rounded-[28px] border border-border/55 bg-card/80 p-2 shadow-[0_28px_80px_-46px_rgba(0,0,0,0.55)] backdrop-blur-xl">
                <div className="rounded-[22px] bg-background/88">
                  <div className="relative">
                    <Textarea
                      ref={textareaRef}
                      value={prompt}
                      onChange={(event) => {
                        setPrompt(event.target.value);
                        if (errorMessage) {
                          setErrorMessage(null);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.shiftKey ||
                          event.nativeEvent.isComposing
                        ) {
                          return;
                        }
                        event.preventDefault();
                        formRef.current?.requestSubmit();
                      }}
                      placeholder="Describe a task, or type / for shortcuts"
                      unstyled
                      style={{ minHeight: "140px", maxHeight: "40vh" }}
                      className="w-full rounded-[22px] border-0 bg-transparent shadow-none before:shadow-none focus-visible:border-0 focus-visible:ring-0 [&_textarea]:overflow-y-auto [&_textarea]:px-5 [&_textarea]:py-5 [&_textarea]:pr-16 [&_textarea]:text-foreground [&_textarea]:leading-7 [&_textarea]:text-[clamp(0.95rem,1.6vw,1.125rem)] sm:[&_textarea]:px-7 sm:[&_textarea]:py-6 sm:[&_textarea]:pr-20"
                    />

                    <Button
                      type="submit"
                      size="icon"
                      className="absolute bottom-3 right-3 size-10 rounded-full shadow-[0_20px_40px_-20px_rgba(37,99,235,0.95)] sm:bottom-5 sm:right-5 sm:size-11"
                      disabled={isSubmitting || prompt.trim().length === 0 || !selectedProject}
                    >
                      <ArrowUpIcon className="size-4.5" />
                    </Button>
                  </div>

                    <div className="border-t border-border/55 px-4 py-3 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <Menu>
                          <MenuTrigger
                            render={
                              <LandingPillButton
                                type="button"
                                disabled={orderedProjects.length === 0}
                                className="justify-start"
                              />
                            }
                          >
                            <FolderOpenIcon aria-hidden="true" className="size-4 opacity-75" />
                            <span className="truncate">
                              Folder: {projectLabel(selectedProject)}
                            </span>
                            <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-55" />
                          </MenuTrigger>
                          <MenuPopup align="start" className="w-[min(28rem,calc(100vw-2rem))]">
                            {orderedProjects.length === 0 ? (
                              <MenuItem disabled>No folders available</MenuItem>
                            ) : (
                              <MenuRadioGroup
                                value={selectedProject ? projectKey(selectedProject) : ""}
                                onValueChange={(value) => setSelectedProjectId(value)}
                              >
                                {orderedProjects.map((project) => (
                                  <MenuRadioItem
                                    key={projectKey(project)}
                                    value={projectKey(project)}
                                  >
                                    <div className="min-w-0">
                                      <div className="truncate font-medium">{project.name}</div>
                                      <div className="truncate text-xs text-muted-foreground/80">
                                        {project.cwd}
                                      </div>
                                    </div>
                                  </MenuRadioItem>
                                ))}
                              </MenuRadioGroup>
                            )}
                            <MenuSeparator />
                            <MenuItem onClick={() => void handleBrowseForFolder()}>
                              <FolderPlusIcon aria-hidden="true" className="size-4 opacity-75" />
                              <span>Open a folder…</span>
                            </MenuItem>
                          </MenuPopup>
                        </Menu>

                        <TraitsPicker
                          provider={selectedProvider}
                          models={selectedProviderModels}
                          model={selectedModel}
                          prompt={prompt}
                          onPromptChange={setPrompt}
                          modelOptions={selectedModelOptions}
                          onModelOptionsChange={(nextOptions) => {
                            setModelOptionsByProvider((current) => ({
                              ...current,
                              [selectedProvider]: nextOptions,
                            }));
                          }}
                          triggerVariant="ghost"
                          triggerClassName="h-10 rounded-full border border-border/60 bg-background/84 px-4 text-[15px] text-foreground shadow-[0_10px_30px_-24px_rgba(0,0,0,0.55)] hover:bg-background/96"
                        />

                        <Menu>
                          <MenuTrigger
                            render={<LandingPillButton type="button" className="justify-start" />}
                          >
                            <WrenchIcon aria-hidden="true" className="size-4 opacity-75" />
                            <span>{INTERACTION_MODE_COPY[interactionMode].label}</span>
                            <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-55" />
                          </MenuTrigger>
                          <MenuPopup align="start">
                            <MenuRadioGroup
                              value={interactionMode}
                              onValueChange={(value) =>
                                setInteractionMode(value as ProviderInteractionMode)
                              }
                            >
                              {(
                                Object.keys(INTERACTION_MODE_COPY) as ProviderInteractionMode[]
                              ).map((mode) => (
                                <MenuRadioItem key={mode} value={mode}>
                                  <div className="min-w-0">
                                    <div className="font-medium">
                                      {INTERACTION_MODE_COPY[mode].label}
                                    </div>
                                    <div className="text-xs text-muted-foreground/80">
                                      {INTERACTION_MODE_COPY[mode].description}
                                    </div>
                                  </div>
                                </MenuRadioItem>
                              ))}
                            </MenuRadioGroup>
                          </MenuPopup>
                        </Menu>

                        <Menu>
                          <MenuTrigger
                            render={<LandingPillButton type="button" className="justify-start" />}
                          >
                            <accessModeCopy.Icon aria-hidden="true" className="size-4 opacity-75" />
                            <span>{accessModeCopy.label}</span>
                            <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-55" />
                          </MenuTrigger>
                          <MenuPopup align="start" className="w-[min(22rem,calc(100vw-2rem))]">
                            <MenuRadioGroup
                              value={runtimeMode}
                              onValueChange={(value) => setRuntimeMode(value as RuntimeMode)}
                            >
                              {(Object.keys(ACCESS_MODE_COPY) as RuntimeMode[]).map((mode) => {
                                const option = ACCESS_MODE_COPY[mode];
                                return (
                                  <MenuRadioItem key={mode} value={mode}>
                                    <div className="min-w-0">
                                      <div className="inline-flex items-center gap-2 font-medium">
                                        <option.Icon className="size-3.5 text-muted-foreground" />
                                        {option.label}
                                      </div>
                                      <div className="text-xs text-muted-foreground/80">
                                        {option.description}
                                      </div>
                                    </div>
                                  </MenuRadioItem>
                                );
                              })}
                            </MenuRadioGroup>
                          </MenuPopup>
                        </Menu>

                        {/*
                         * Assistant chip lives at the far right of the
                         * composer footer, with the provider's own glyph
                         * inside so the chip matches what the in-thread
                         * composer ProviderModelPicker shows. `ms-auto`
                         * pushes it to the right without breaking wrapping
                         * on narrow widths.
                         */}
                        <Menu>
                          <MenuTrigger
                            render={
                              <LandingPillButton type="button" className="ms-auto justify-start" />
                            }
                          >
                            {(() => {
                              const AssistantIcon = providerIconFor(selectedProvider);
                              return (
                                <AssistantIcon aria-hidden="true" className="size-4 opacity-85" />
                              );
                            })()}
                            <span className="truncate">
                              Assistant: {formatProviderDisplayLabel(selectedProvider)}
                            </span>
                            <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-55" />
                          </MenuTrigger>
                          <MenuPopup align="start" className="w-[min(22rem,calc(100vw-2rem))]">
                            <MenuGroup>
                              {assistantOptions.map((provider) => {
                                const isReady =
                                  provider.enabled &&
                                  provider.installed &&
                                  provider.status === "ready";
                                const OptionIcon = providerIconFor(provider.provider);
                                return (
                                  <MenuItem
                                    key={provider.provider}
                                    disabled={!isReady}
                                    onClick={() => {
                                      if (!isReady) return;
                                      setRequestedProvider(provider.provider);
                                    }}
                                  >
                                    <OptionIcon
                                      aria-hidden="true"
                                      className="size-4 shrink-0 opacity-85"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="font-medium">
                                        {formatProviderDisplayLabel(provider.provider)}
                                      </div>
                                      {!isReady ? (
                                        <div className="truncate text-xs text-muted-foreground/80">
                                          {describeProviderAvailability(provider)}
                                        </div>
                                      ) : null}
                                    </div>
                                    {provider.provider === selectedProvider ? (
                                      <span className="text-xs text-muted-foreground/75">
                                        Selected
                                      </span>
                                    ) : null}
                                  </MenuItem>
                                );
                              })}
                            </MenuGroup>
                          </MenuPopup>
                        </Menu>
                      </div>
                    </div>
                  </div>
                </div>

                {errorMessage ? (
                  <p role="alert" className="mt-3 text-sm text-foreground/72">
                    {errorMessage}
                  </p>
                ) : null}
              </form>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
