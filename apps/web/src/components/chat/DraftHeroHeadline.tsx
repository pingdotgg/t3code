import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { FolderPlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "~/hooks/useStartTriage";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  useEnvironmentProviders,
} from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { isProjectPinShortcut, ProjectPinButton } from "../ProjectPinButton";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { DraftProjectName } from "./DraftProjectName";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";
import { TriageDraftHero } from "./TriageDraftHero";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

const ADD_PROJECT_VALUE = "add-project";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = () => openCommandPalette({ open: "add-project" });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  const highlightedPickerValueRef = useRef<string | null>(null);
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = sortLogicalProjectsForSidebar(
    buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
    }),
    threads,
    projectSortOrder,
  );
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = new Map(
    environments.map(
      (environment) =>
        [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ] as const,
    ),
  );
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = new Map(
    projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const),
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(activeProjectRef?.environmentId ?? null);
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));

  // Pinning from a row keeps rows in place while the picker is open.
  const pickerItems: readonly PickerItem[] = useOrderWhileOpen(
    [
      ...menuEntries.map(({ group }) => ({ value: group.projectKey, label: group.displayName })),
      { value: ADD_PROJECT_VALUE, label: "Add project" },
    ],
    (item) => item.value,
    pickerOpen,
  );
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter(
          (item) =>
            item.value !== ADD_PROJECT_VALUE &&
            pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedPickerItem = pickerItems.find((item) => item.value === activeProjectKey) ?? null;

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again. Picking
  // a project clears the pending request, and the draft session is compared
  // against the store when the scratch project arrives.
  const pendingScratchRef = useRef<symbol | null>(null);
  const draftTargetKey = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return session
      ? `${session.environmentId}:${session.projectId}:${session.logicalProjectKey}`
      : null;
  };
  // Retargeting an empty draft would overwrite the project's draft and strand browser tabs.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    pendingScratchRef.current = null;
    const currentDraft = getComposerDraft(draftId);
    if (!composerDraftHasUserContent(currentDraft)) {
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
      return;
    }
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentConfig = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig;
      const environmentSettings = environmentConfig?.settings;
      const defaultSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      const fallbackResolution = resolveNewThreadModelSelection({
        defaultSelection:
          defaultSelection ??
          (useComposerDraftStore.getState().stickyActiveProvider !== null || !environmentSettings
            ? null
            : resolveProjectDefaultProviderModelSelection(
                providersByEnvironment.get(project.environmentId) ?? [],
                environmentSettings,
                project.id,
              )),
        fallbackSelection: environmentSettings?.fallbackModelSelection ?? null,
        providers: providersByEnvironment.get(project.environmentId) ?? [],
        ...(environmentSettings ? { settings: environmentSettings } : {}),
        projectId: project.id,
        now: Date.now(),
      });
      const defaultModelSelection = fallbackResolution.fallback
        ? fallbackResolution.selection
        : defaultSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const request = Symbol("scratch");
    pendingScratchRef.current = request;
    const requestedTarget = draftTargetKey();
    const project = await openScratchProject(scratchTargetEnvironmentId);
    if (!project || pendingScratchRef.current !== request || draftTargetKey() !== requestedTarget) {
      return false;
    }
    pendingScratchRef.current = null;
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const projectSelector = shouldShowProjectMenu ? (
    <Combobox
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onItemHighlighted={(item) => {
        highlightedPickerValueRef.current = item?.value ?? null;
      }}
      onOpenChange={(open) => {
        setPickerOpen(open);
        setPickerQuery("");
      }}
      value={selectedPickerItem}
      onValueChange={(item) => {
        if (!item) return;
        setPickerOpen(false);
        if (item.value === ADD_PROJECT_VALUE) {
          openAddProject();
          return;
        }
        const entry = projectEntryByKey.get(item.value);
        if (!entry || item.value === activeProjectKey) {
          return;
        }
        selectProject(entry.targetProject, entry.group.projectKey);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={<InlineButton tone="picker" />}
              data-draft-project-trigger=""
              className="pointer-events-auto min-w-0 max-w-full align-baseline"
            />
          }
        >
          <DraftProjectName
            value={isScratchDraft ? "No project" : (activeProjectDisplayName ?? "Choose a project")}
            singleLine
          />
        </TooltipTrigger>
        {activeProjectDisplayName && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectDisplayName}</TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup align="center" className="w-72 overflow-hidden">
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          onKeyDown={(event) => {
            const highlighted = highlightedPickerValueRef.current;
            const group = highlighted ? projectEntryByKey.get(highlighted)?.group : undefined;
            if (!group || !canPinProjectGroup(group) || !isProjectPinShortcut(event, keybindings)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            toggleProjectGroupPin(group);
          }}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = projectEntryByKey.get(item.value);
            return (
              <ComboboxItem key={item.value} hideIndicator value={item}>
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 text-sm" />}>
                    <DraftProjectName value={item.label} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{item.label}</TooltipPopup>
                </Tooltip>
                {entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
                {entry && canPinProjectGroup(entry.group) ? (
                  <ProjectPinButton
                    name={entry.group.displayName}
                    pinned={entry.group.pinned}
                    shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                    onToggle={() => toggleProjectGroupPin(entry.group)}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline min-w-0 max-w-full cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <DraftProjectName value={activeProjectTitle ?? "Add a project"} singleLine />
    </button>
  );

  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          or start without a project
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  if (isScratchDraft && isTriageDraftPrompt) {
    const environment = environments.find(
      (entry) => entry.environmentId === activeProject.environmentId,
    );
    return (
      <TriageDraftHero
        machineLabel={environment?.label ?? null}
        serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      {hasResolvedProject && !isScratchDraft ? (
        <DraftHeroProjectHeading projectName={activeProjectDisplayName ?? "Choose a project"}>
          {projectSelector}
        </DraftHeroProjectHeading>
      ) : (
        <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
          {isScratchDraft ? (
            <>What should we work on?</>
          ) : canChooseProject ? (
            <>{projectSelector} to start</>
          ) : (
            <>Add a project to start</>
          )}
        </h1>
      )}
      {scratchWorkspaceRoot === null ? null : (
        <p className="mt-2 flex h-6 w-full items-center justify-center text-sm">
          {isScratchDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
}
