import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import {
  CHAT_PROJECT_ID,
  isChatProject,
  resolveEnvironmentMachineKind,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { FolderPlusIcon, MessageCircleIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

interface DraftProjectPickerProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftProjectPicker({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftProjectPickerProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const [chatAnchor, setChatAnchor] = useState<{
    draftId: DraftId | null;
    width: number;
    offset: number;
  } | null>(null);
  const chatOffset = chatAnchor?.draftId === draftId ? chatAnchor.offset : null;
  useEffect(() => {
    const title = titleRef.current;
    if (!title || !chatAnchor) return;
    const observer = new ResizeObserver(() => {
      if (title.getBoundingClientRect().width !== chatAnchor.width) {
        setChatAnchor(null);
      }
    });
    observer.observe(title);
    return () => observer.disconnect();
  }, [chatAnchor]);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
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
  const isChat = activeProjectRef?.projectId === CHAT_PROJECT_ID;
  const activeProject = projects.find(
    (project) =>
      project.id === activeProjectRef?.projectId &&
      project.environmentId === activeProjectRef.environmentId,
  );
  const activeProjectDisplayName = isChat ? "Chat" : activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;

  const selectProject = (value: string) => {
    const entry = projectEntryByKey.get(value);
    if (!entry || value === activeProjectKey) {
      return;
    }
    const project = entry.targetProject;
    if (!draftId) {
      return;
    }
    // Project selection changes the target of the open draft in
    // place. The prompt stays in the same composer session, so the
    // sidebar only gets a draft row if the user later navigates away.
    const currentDraft = getComposerDraft(draftId);
    setLogicalProjectDraftThreadId(
      entry.group.projectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentSettings = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig?.settings;
      const defaultModelSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  const chatEntry = projectPickerEntries.find(
    ({ targetProject }) =>
      isChatProject(targetProject) &&
      targetProject.environmentId === activeProjectRef?.environmentId,
  );

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label={!isChat && hasResolvedProject ? "Change project" : "Add project"}
              className={
                isChat
                  ? "inline-flex min-w-0 items-baseline rounded-xl text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  : "inline-flex min-w-0 max-w-64 items-baseline gap-2 rounded-r-xl px-2 py-1 text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              }
            />
          }
        >
          {isChat ? (
            <span className="pointer-events-none ms-1 flex size-9 shrink-0 items-center justify-center self-center">
              <MessageCircleIcon className="size-5" />
            </span>
          ) : null}
          <span className={isChat ? "truncate ps-1 pe-3 py-1" : "truncate"}>
            {activeProjectDisplayName ?? "Add project"}
          </span>
        </TooltipTrigger>
        {activeProjectDisplayName ? (
          <TooltipPopup side="top" className="max-w-80">
            {activeProjectDisplayName}
          </TooltipPopup>
        ) : null}
      </Tooltip>
      <MenuPopup align="center" className="max-h-80 min-w-40! w-max max-w-64 overflow-y-auto">
        <MenuRadioGroup
          value={activeProjectKey}
          onValueChange={(value) => selectProject(value as string)}
        >
          {projectPickerEntries
            .filter(({ targetProject }) => !isChatProject(targetProject))
            .map(({ group, targetProject }) => {
              return (
                <MenuRadioItem
                  key={group.projectKey}
                  value={group.projectKey}
                  closeOnClick
                  className="[&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                >
                  <ProjectFavicon project={group} className="size-4 shrink-0" />
                  <Tooltip>
                    <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
                      {targetProject.title}
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="max-w-80">
                      {group.displayName}
                    </TooltipPopup>
                  </Tooltip>
                  {showProjectEnvironments ? (
                    <ProjectEnvironmentBadge
                      group={group}
                      primaryEnvironmentId={primaryEnvironmentId}
                      machineByEnvironmentId={environmentMachineById}
                    />
                  ) : null}
                </MenuRadioItem>
              );
            })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          New project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="inline-flex h-8 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PlusIcon className="size-3.5" />
      Add project
    </button>
  );

  const chip = (
    <span
      ref={chipRef}
      className="inline-flex max-w-full items-baseline rounded-xl bg-muted/70 align-baseline"
    >
      {!isChat && chatEntry && activeProject ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Remove project"
                onClick={() => {
                  const titleBounds = titleRef.current?.getBoundingClientRect();
                  const chipBounds = chipRef.current?.getBoundingClientRect();
                  if (titleBounds && chipBounds) {
                    setChatAnchor({
                      draftId,
                      width: titleBounds.width,
                      offset: chipBounds.left - titleBounds.left - titleBounds.width / 2,
                    });
                  }
                  selectProject(chatEntry.group.projectKey);
                }}
                className="group/project-icon relative ms-1 flex size-9 shrink-0 items-center justify-center self-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <span className="group-hover/project-icon:opacity-0 group-focus-visible/project-icon:opacity-0">
              <ProjectFavicon project={activeProject} className="size-6" />
            </span>
            <XIcon className="absolute size-5 opacity-0 group-hover/project-icon:opacity-100 group-focus-visible/project-icon:opacity-100" />
          </TooltipTrigger>
          <TooltipPopup>Enter chat mode</TooltipPopup>
        </Tooltip>
      ) : !isChat || !shouldShowProjectMenu ? (
        <span className="ms-1 flex size-9 shrink-0 items-center justify-center self-center">
          <MessageCircleIcon className="size-5" />
        </span>
      ) : null}
      {projectSelector}
    </span>
  );

  return (
    <h1
      ref={titleRef}
      className={
        isChat && chatOffset !== null
          ? "mx-auto grid w-full grid-cols-1 items-end gap-y-2 font-normal text-2xl text-foreground tracking-tight sm:grid-cols-[var(--chat-context-start)_minmax(0,1fr)] sm:text-3xl sm:[align-items:last_baseline]"
          : "mx-auto w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
      }
      style={
        isChat && chatOffset !== null
          ? ({ "--chat-context-start": `calc(50% + ${chatOffset}px)` } as CSSProperties)
          : undefined
      }
    >
      {isChat && chatOffset !== null ? (
        <>
          <span className="text-center sm:pe-2 sm:text-end">What would you like to</span>
          <span className="ms-[var(--chat-context-start)] flex min-w-0 items-baseline gap-x-2 text-start sm:ms-0">
            {chip}
            <span className="shrink-0">about?</span>
          </span>
        </>
      ) : isChat ? (
        <>What would you like to {chip} about?</>
      ) : (
        <>What should we build in {chip}?</>
      )}
    </h1>
  );
}
