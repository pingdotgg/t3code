import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@pathwayos/contracts";
import { scopedProjectKey, scopeProjectRef } from "@pathwayos/client-runtime/environment";
import {
  createModelSelection,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeModelSlug,
} from "@pathwayos/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CloudIcon,
  FolderIcon,
  MailIcon,
  MicIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";

import {
  useComposerDraftStore,
  type DraftId,
  type DraftThreadEnvMode,
} from "../composerDraftStore";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import type { EnvMode } from "./BranchToolbar.logic";
import { ComposerFooterModeControls } from "./chat/ComposerFooterModeControls";
import { usePrimarySettings } from "../hooks/useSettings";
import { newDraftId, newThreadId } from "../lib/utils";
import {
  type AppModelOption,
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { useProjects } from "../state/entities";
import { primaryServerProvidersAtom } from "../state/server";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { getComposerProviderState } from "./chat/composerProviderState";
import { shouldRenderTraitsControls, TraitsPicker } from "./chat/TraitsPicker";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Separator } from "./ui/separator";
import { SidebarInset } from "./ui/sidebar";
import { useOpenAddProjectCommandPalette } from "../commandPaletteContext";
import { ProjectFavicon } from "./ProjectFavicon";

const pendingConnectionCards = [
  {
    title: "Connect messaging",
    description: "Get context from recent team discussions",
    icon: SparklesIcon,
    iconClassName: "text-[#36c5f0]",
    connected: true,
    muted: true,
  },
  {
    title: "Connect email",
    description: "Summarize stakeholder asks from email",
    icon: MailIcon,
    iconClassName: "text-[#ea4335]",
    connected: true,
    muted: true,
  },
  {
    title: "Connect files",
    description: "Review results, research, and plans",
    icon: CloudIcon,
    iconClassName: "text-[#4285f4]",
    connected: false,
    muted: false,
  },
] as const;

const FALLBACK_PENDING_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.5",
);

const fallbackModelOptions = [
  { label: "5.5", value: "gpt-5.5" },
  { label: "5.4", value: "gpt-5.4" },
  { label: "5.3", value: "gpt-5.3" },
] as const;

const fallbackEffortOptions = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
] as const;

interface PendingDraftIds {
  readonly draftId: DraftId;
  readonly threadId: ReturnType<typeof newThreadId>;
}

function formatFallbackModelLabel(model: string): string {
  const option = fallbackModelOptions.find((candidate) => candidate.value === model);
  return option?.label ?? model.replace(/^gpt-/, "");
}

function PendingComposerModelControls() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();
  const stickyActiveProvider = useComposerDraftStore((store) => store.stickyActiveProvider);
  const stickyModelSelectionByProvider = useComposerDraftStore(
    (store) => store.stickyModelSelectionByProvider,
  );
  const setStickyModelSelection = useComposerDraftStore((store) => store.setStickyModelSelection);
  const [localSelection, setLocalSelection] = useState<ModelSelection | null>(null);
  const [prompt, setPrompt] = useState("");
  const stickySelection = stickyActiveProvider
    ? stickyModelSelectionByProvider[stickyActiveProvider]
    : null;
  const providerInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const preferredSelection =
    localSelection ?? stickySelection ?? settings.textGenerationModelSelection ?? null;
  const selectedEntry = preferredSelection
    ? providerInstanceEntries.find(
        (entry) => entry.instanceId === preferredSelection.instanceId && entry.enabled,
      )
    : undefined;
  const activeEntry =
    selectedEntry ??
    providerInstanceEntries.find((entry) => entry.enabled && entry.isAvailable) ??
    providerInstanceEntries.find((entry) => entry.enabled) ??
    providerInstanceEntries[0] ??
    null;

  const commitSelection = (
    instanceId: ProviderInstanceId,
    model: string,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => {
    const nextSelection = createModelSelection(instanceId, model, options);
    setLocalSelection(nextSelection);
    setStickyModelSelection(nextSelection);
  };

  if (activeEntry === null) {
    const fallbackSelection = preferredSelection ?? FALLBACK_PENDING_MODEL_SELECTION;
    const fallbackModel = fallbackSelection.model || FALLBACK_PENDING_MODEL_SELECTION.model;
    const fallbackEffort =
      getProviderOptionStringSelectionValue(fallbackSelection.options, "reasoningEffort") ??
      "medium";
    const fallbackFastMode =
      getProviderOptionBooleanSelectionValue(fallbackSelection.options, "fastMode") ?? false;
    const fallbackOptions = [
      { id: "reasoningEffort", value: fallbackEffort },
      { id: "fastMode", value: fallbackFastMode },
    ] satisfies ReadonlyArray<ProviderOptionSelection>;

    return (
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="hidden h-7 max-w-36 cursor-pointer items-center gap-1 rounded-md px-2 text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground sm:flex"
            />
          }
        >
          <span className="font-medium text-foreground/80">
            {formatFallbackModelLabel(fallbackModel)}
          </span>
          <span>
            {fallbackEffortOptions.find((option) => option.value === fallbackEffort)?.label}
          </span>
          {fallbackFastMode ? <span>Fast</span> : null}
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-[31rem] overflow-hidden p-0">
          <div className="grid min-h-72 grid-cols-[3rem_minmax(0,1fr)_10rem]">
            <div className="flex flex-col items-center gap-1 border-r border-border/70 bg-muted/35 p-1.5">
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-md bg-accent text-foreground"
                aria-label="Codex models"
              >
                <SparklesIcon className="size-4" />
              </button>
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground/75 transition-colors hover:bg-accent/70 hover:text-foreground"
                aria-label="Claude models"
              >
                <span className="font-medium text-xs">C</span>
              </button>
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground/75 transition-colors hover:bg-accent/70 hover:text-foreground"
                aria-label="OpenAI models"
              >
                <span className="font-medium text-xs">O</span>
              </button>
            </div>

            <div className="min-w-0 border-r border-border/70 p-2">
              <div className="flex h-9 items-center border-b border-primary/80 px-1.5 text-muted-foreground/70 text-sm">
                Search models...
              </div>
              <MenuRadioGroup
                value={fallbackModel}
                onValueChange={(model) => {
                  commitSelection(
                    FALLBACK_PENDING_MODEL_SELECTION.instanceId,
                    model,
                    fallbackOptions,
                  );
                }}
              >
                {fallbackModelOptions.map((option) => (
                  <MenuRadioItem
                    key={option.value}
                    value={option.value}
                    className="min-h-14 pe-2 ps-2"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium text-foreground">GPT-{option.label}</span>
                      <span className="mt-0.5 text-muted-foreground text-xs">Codex</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </div>

            <div className="p-2">
              <MenuGroup>
                <MenuGroupLabel>Effort</MenuGroupLabel>
                <MenuRadioGroup
                  value={fallbackEffort}
                  onValueChange={(effort) => {
                    commitSelection(FALLBACK_PENDING_MODEL_SELECTION.instanceId, fallbackModel, [
                      { id: "reasoningEffort", value: effort },
                      { id: "fastMode", value: fallbackFastMode },
                    ]);
                  }}
                >
                  {fallbackEffortOptions.map((option) => (
                    <MenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
              <MenuDivider />
              <MenuGroup>
                <MenuGroupLabel>Speed</MenuGroupLabel>
                <MenuRadioGroup
                  value={fallbackFastMode ? "fast" : "normal"}
                  onValueChange={(speed) => {
                    commitSelection(FALLBACK_PENDING_MODEL_SELECTION.instanceId, fallbackModel, [
                      { id: "reasoningEffort", value: fallbackEffort },
                      { id: "fastMode", value: speed === "fast" },
                    ]);
                  }}
                >
                  <MenuRadioItem value="normal">Normal</MenuRadioItem>
                  <MenuRadioItem value="fast">Fast</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            </div>
          </div>
        </MenuPopup>
      </Menu>
    );
  }

  const selectedModel =
    preferredSelection?.instanceId === activeEntry.instanceId
      ? (resolveAppModelSelectionForInstance(
          activeEntry.instanceId,
          settings,
          providers,
          preferredSelection.model,
        ) ?? activeEntry.models[0]?.slug)
      : (resolveAppModelSelectionForInstance(activeEntry.instanceId, settings, providers, null) ??
        activeEntry.models[0]?.slug);
  const selectedModelOptions =
    preferredSelection?.instanceId === activeEntry.instanceId ? preferredSelection.options : null;
  const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
  for (const entry of providerInstanceEntries) {
    modelOptionsByInstance.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
  }
  const selectedProviderModels = activeEntry.models as ReadonlyArray<ServerProviderModel>;
  const composerProviderState = getComposerProviderState({
    provider: activeEntry.driverKind,
    model: selectedModel ?? "",
    models: selectedProviderModels,
    modelOptions: selectedModelOptions,
  });
  const shouldRenderTraitsPicker = shouldRenderTraitsControls({
    provider: activeEntry.driverKind,
    models: selectedProviderModels,
    model: selectedModel,
    modelOptions: composerProviderState.modelOptionsForDispatch,
    prompt,
  });
  const selectedModelForPicker =
    selectedModelOptions === null
      ? (selectedModel ?? FALLBACK_PENDING_MODEL_SELECTION.model)
      : createModelSelection(activeEntry.instanceId, selectedModel ?? "", selectedModelOptions)
          .model;
  const selectedModelForPickerWithCustomFallback = (() => {
    const currentOptions = modelOptionsByInstance.get(activeEntry.instanceId) ?? [];
    if (currentOptions.some((option) => option.slug === selectedModelForPicker)) {
      return selectedModelForPicker;
    }
    return (
      normalizeModelSlug(selectedModelForPicker, activeEntry.driverKind) ?? selectedModelForPicker
    );
  })();

  return (
    <>
      <ProviderModelPicker
        compact
        activeInstanceId={activeEntry.instanceId}
        model={selectedModelForPickerWithCustomFallback}
        lockedProvider={null}
        instanceEntries={providerInstanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerClassName="h-7 max-w-36"
        {...(composerProviderState.modelPickerIconClassName
          ? { activeProviderIconClassName: composerProviderState.modelPickerIconClassName }
          : {})}
        onInstanceModelChange={(instanceId, model) => {
          const entry = providerInstanceEntries.find(
            (candidate) => candidate.instanceId === instanceId,
          );
          const nextModel =
            resolveAppModelSelectionForInstance(instanceId, settings, providers, model) ?? model;
          const { modelOptionsForDispatch } = getComposerProviderState({
            provider: entry?.driverKind ?? ProviderDriverKind.make("codex"),
            model: nextModel,
            models: entry?.models ?? [],
            modelOptions: undefined,
          });
          commitSelection(instanceId, nextModel, modelOptionsForDispatch);
        }}
      />
      {shouldRenderTraitsPicker ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <TraitsPicker
            provider={activeEntry.driverKind}
            instanceId={activeEntry.instanceId}
            models={selectedProviderModels}
            model={selectedModel}
            modelOptions={composerProviderState.modelOptionsForDispatch}
            prompt={prompt}
            triggerClassName="h-7 max-w-36 px-2"
            onPromptChange={setPrompt}
            onModelOptionsChange={(nextOptions) => {
              commitSelection(
                activeEntry.instanceId,
                selectedModel ?? FALLBACK_PENDING_MODEL_SELECTION.model,
                nextOptions,
              );
            }}
          />
        </>
      ) : null}
    </>
  );
}

function PendingComposerAccessControl() {
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);

  return (
    <ComposerFooterModeControls
      showInteractionModeToggle={false}
      interactionMode="default"
      runtimeMode={runtimeMode}
      showPlanToggle={false}
      planSidebarLabel="Plan"
      planSidebarOpen={false}
      showLeadingSeparator={false}
      runtimeModeTriggerClassName="h-7 px-2 text-[#f25c2b] hover:bg-[#f25c2b]/10 hover:text-[#f25c2b] data-[popup-open]:bg-[#f25c2b]/10 data-[popup-open]:text-[#f25c2b]"
      onToggleInteractionMode={() => {}}
      onRuntimeModeChange={setRuntimeMode}
      onTogglePlanSidebar={() => {}}
    />
  );
}

function PendingComposerWorkspaceControls() {
  const projects = useProjects();
  const openAddProject = useOpenAddProjectCommandPalette();
  const [activeProjectKey, setActiveProjectKey] = useState<string | null>(null);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [envMode, setEnvMode] = useState<EnvMode>("local");
  const [startFromOrigin, setStartFromOrigin] = useState(false);
  const [{ draftId, threadId }] = useState<PendingDraftIds>(() => ({
    draftId: newDraftId(),
    threadId: newThreadId(),
  }));
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const draftThread = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        project,
        ref: scopeProjectRef(project.environmentId, project.id),
      })),
    [projects],
  );
  const activeProjectOption = activeProjectKey
    ? (projectOptions.find((option) => scopedProjectKey(option.ref) === activeProjectKey) ?? null)
    : null;
  const activeProject = activeProjectOption?.project ?? null;
  const projectRef = useMemo(
    () => (activeProject ? scopeProjectRef(activeProject.environmentId, activeProject.id) : null),
    [activeProject],
  );
  const logicalProjectKey = useMemo(
    () => (projectRef ? scopedProjectKey(projectRef) : null),
    [projectRef],
  );
  const normalizedProjectSearchQuery = projectSearchQuery.trim().toLocaleLowerCase();
  const filteredProjectOptions = normalizedProjectSearchQuery
    ? projectOptions.filter(({ project }) =>
        project.title.toLocaleLowerCase().includes(normalizedProjectSearchQuery),
      )
    : projectOptions;

  useEffect(() => {
    if (
      activeProjectKey &&
      !projectOptions.some((option) => scopedProjectKey(option.ref) === activeProjectKey)
    ) {
      setActiveProjectKey(null);
    }
  }, [activeProjectKey, projectOptions]);

  useEffect(() => {
    if (!projectRef || !logicalProjectKey) {
      return;
    }
    setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
      threadId,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: "default",
      envMode,
      startFromOrigin,
    });
  }, [
    draftId,
    envMode,
    logicalProjectKey,
    projectRef,
    setLogicalProjectDraftThreadId,
    startFromOrigin,
    threadId,
  ]);

  const handleEnvModeChange = (mode: EnvMode) => {
    setEnvMode(mode);
    setDraftThreadContext(draftId, { envMode: mode as DraftThreadEnvMode });
  };

  return (
    <>
      {activeProject && projectRef ? (
        <>
          <span className="group/project-clear flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-accent hover:text-foreground">
            <button
              type="button"
              className="relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Clear selected project"
              onClick={() => setActiveProjectKey(null)}
            >
              <ProjectFavicon
                environmentId={activeProject.environmentId}
                cwd={activeProject.workspaceRoot}
                className="size-4 rounded-full group-hover/project-clear:opacity-0 group-focus-visible/project-clear:opacity-0"
              />
              <XIcon className="pointer-events-none absolute size-3.5 opacity-0 transition-opacity group-hover/project-clear:opacity-100 group-focus-visible/project-clear:opacity-100" />
            </button>
            <span className="truncate">{activeProject.title}</span>
          </span>
          <BranchToolbarEnvModeSelector
            envLocked={false}
            effectiveEnvMode={draftThread?.envMode ?? envMode}
            activeWorktreePath={draftThread?.worktreePath ?? null}
            onEnvModeChange={handleEnvModeChange}
          />
          <BranchToolbarBranchSelector
            className="hidden sm:flex"
            environmentId={projectRef.environmentId}
            threadId={threadId}
            draftId={draftId}
            envLocked={false}
            effectiveEnvModeOverride={draftThread?.envMode ?? envMode}
            startFromOrigin={draftThread?.startFromOrigin ?? startFromOrigin}
            onStartFromOriginChange={(nextStartFromOrigin) => {
              setStartFromOrigin(nextStartFromOrigin);
              setDraftThreadContext(draftId, { startFromOrigin: nextStartFromOrigin });
            }}
          />
        </>
      ) : (
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className="flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
                aria-label="Choose project"
              />
            }
          >
            <FolderIcon className="size-4 shrink-0" />
            <span className="truncate">Choose project</span>
          </MenuTrigger>
          <MenuPopup align="start" className="w-64">
            <div className="flex h-9 items-center gap-2 border-b border-border/80 px-2 text-muted-foreground">
              <SearchIcon className="size-4 shrink-0" />
              <input
                type="search"
                value={projectSearchQuery}
                onChange={(event) => setProjectSearchQuery(event.currentTarget.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder="Search projects"
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
              />
            </div>
            <div className="py-1">
              {filteredProjectOptions.length > 0 ? (
                filteredProjectOptions.map(({ project, ref }) => (
                  <MenuItem
                    key={scopedProjectKey(ref)}
                    className="cursor-pointer"
                    onClick={() => {
                      setActiveProjectKey(scopedProjectKey(ref));
                      setProjectSearchQuery("");
                    }}
                  >
                    <ProjectFavicon
                      environmentId={project.environmentId}
                      cwd={project.workspaceRoot}
                      className="size-4"
                    />
                    <span className="truncate">{project.title}</span>
                  </MenuItem>
                ))
              ) : (
                <div className="px-2 py-2 text-muted-foreground text-sm">No projects found</div>
              )}
            </div>
            <MenuDivider />
            <MenuSub>
              <MenuSubTrigger className="cursor-pointer">
                <PlusIcon className="size-4" />
                <span>New project</span>
              </MenuSubTrigger>
              <MenuSubPopup className="w-48">
                <MenuItem className="cursor-pointer" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  <span>Start from scratch</span>
                </MenuItem>
                <MenuItem className="cursor-pointer" onClick={openAddProject}>
                  <FolderIcon className="size-4" />
                  <span>Use an existing folder</span>
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
          </MenuPopup>
        </Menu>
      )}
    </>
  );
}

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1 px-6">
          <div className="w-full max-w-[46rem]">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-balance text-center text-2xl font-medium tracking-tight text-foreground sm:text-[28px]">
                What should we build today?
              </EmptyTitle>
              <EmptyDescription className="sr-only">
                Start a new chat once a project is available.
              </EmptyDescription>
            </EmptyHeader>

            <div className="mt-11 rounded-[22px] bg-muted/58 pb-4 shadow-[0_18px_45px_hsl(var(--foreground)/0.08)]">
              <div className="rounded-[18px] border border-border/70 bg-background shadow-[0_12px_32px_hsl(var(--foreground)/0.12)]">
                <div className="min-h-18 rounded-t-[18px] px-4 pt-4 text-left text-sm text-muted-foreground/42">
                  Do anything
                </div>
                <div className="flex items-center gap-2 px-3 pb-2.5">
                  <button
                    type="button"
                    className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/65 transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="Add context"
                  >
                    <PlusIcon className="size-4" />
                  </button>

                  <div className="flex items-center text-[#f25c2b] text-sm">
                    <PendingComposerAccessControl />
                  </div>

                  <div className="ml-auto flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                    <div className="hidden min-w-0 items-center gap-1 sm:flex">
                      <PendingComposerModelControls />
                    </div>
                    <button
                      type="button"
                      className="flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground"
                      aria-label="Voice input"
                    >
                      <MicIcon className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-muted-foreground/70 text-background shadow-sm transition-colors hover:bg-foreground"
                      aria-label="Send message"
                    >
                      <ArrowUpIcon className="size-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex min-w-0 items-center gap-4 px-4 pt-3 text-sm text-muted-foreground">
                <PendingComposerWorkspaceControls />
              </div>
            </div>

            <div className="mx-auto mt-8 grid max-w-[41.5rem] gap-3 sm:grid-cols-3">
              {pendingConnectionCards.map((card) => {
                const Icon = card.icon;
                return (
                  <button
                    key={card.title}
                    type="button"
                    className={[
                      "relative min-h-[7.125rem] cursor-pointer rounded-xl border border-border/70 bg-background p-3 text-left shadow-xs transition-colors hover:bg-accent/35",
                      card.muted ? "opacity-38" : "",
                    ].join(" ")}
                  >
                    <Icon className={`size-4 ${card.iconClassName}`} />
                    {card.connected ? (
                      <CheckCircle2Icon className="absolute right-3 top-3 size-4 fill-emerald-500 text-background" />
                    ) : null}
                    <div className="mt-4 text-sm font-medium text-foreground">{card.title}</div>
                    <div className="mt-1 text-sm leading-snug text-muted-foreground">
                      {card.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
