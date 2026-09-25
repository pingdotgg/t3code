import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { findChatProject } from "@t3tools/client-runtime/operations/projects";
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useChatProject } from "~/hooks/useChatProject";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
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
import { Button, InlineButton } from "../ui/button";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

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
  const { canStartChatIn, chatEnvironmentId, chatWorkspaceRootFor, ensureChatProject } =
    useChatProject();

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
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const chatTargetEnvironmentId =
    activeProjectRef?.environmentId ?? chatEnvironmentId(primaryEnvironmentId);
  const chatWorkspaceRoot = chatWorkspaceRootFor(chatTargetEnvironmentId);
  const chatProject =
    chatTargetEnvironmentId !== null && chatWorkspaceRoot !== null
      ? findChatProject({ projects, environmentId: chatTargetEnvironmentId, chatWorkspaceRoot })
      : null;
  const isChatDraft =
    activeProject !== null &&
    chatProject !== null &&
    chatProject.environmentId === activeProject.environmentId &&
    chatProject.id === activeProject.id;
  // On a chat draft the heading already says "chat", so its menu lists
  // repositories only. Every other state keeps Chats as a way in.
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isChatDraft ||
      chatProject === null ||
      targetProject.environmentId !== chatProject.environmentId ||
      targetProject.id !== chatProject.id,
  );
  const canJustChat = canStartChatIn(chatTargetEnvironmentId) && !isChatDraft;

  // The picker can change the draft's target while "Just chat" is still
  // creating its project; a stale continuation must not retarget it again.
  const latestTargetRef = useRef({ draftId, activeProjectKey, chatTargetEnvironmentId });
  useEffect(() => {
    latestTargetRef.current = { draftId, activeProjectKey, chatTargetEnvironmentId };
  }, [activeProjectKey, chatTargetEnvironmentId, draftId]);
  // Project selection changes the target of the open draft in place. The
  // prompt stays in the same composer session, so the sidebar only gets a
  // draft row if the user later navigates away.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    latestTargetRef.current = {
      draftId,
      activeProjectKey: logicalProjectKey,
      chatTargetEnvironmentId: project.environmentId,
    };
    const currentDraft = getComposerDraft(draftId);
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
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
  const startChat = async (): Promise<boolean> => {
    if (chatTargetEnvironmentId === null || isChatDraft) {
      return false;
    }
    const requested = { draftId, activeProjectKey, chatTargetEnvironmentId };
    const project = await ensureChatProject(chatTargetEnvironmentId);
    const latest = latestTargetRef.current;
    if (
      !project ||
      latest.draftId !== requested.draftId ||
      latest.activeProjectKey !== requested.activeProjectKey ||
      latest.chatTargetEnvironmentId !== requested.chatTargetEnvironmentId
    ) {
      return false;
    }
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            // The trigger's accessible name comes from its visible text (the
            // project title) so the hero sentence reads naturally: an
            // aria-label here would replace the title with an action phrase
            // mid-sentence and baffle screen-reader users.
            <MenuTrigger
              render={<InlineButton tone="picker" />}
              data-draft-project-trigger=""
              className="pointer-events-auto max-w-64 align-baseline"
            />
          }
        >
          <span className="min-w-0 truncate">
            {isChatDraft ? "chat" : (activeProjectDisplayName ?? "Choose a project")}
          </span>
        </TooltipTrigger>
        {activeProjectDisplayName && !isChatDraft ? (
          <TooltipPopup side="top">{activeProjectDisplayName}</TooltipPopup>
        ) : null}
      </Tooltip>
      <MenuPopup align="center" className="max-h-80 overflow-y-auto">
        <MenuRadioGroup
          value={activeProjectKey}
          onValueChange={(value) => {
            const entry = projectEntryByKey.get(value as string);
            if (!entry || value === activeProjectKey) {
              return;
            }
            selectProject(entry.targetProject, entry.group.projectKey);
          }}
        >
          {menuEntries.map(({ group }) => {
            return (
              <MenuRadioItem key={group.projectKey} value={group.projectKey} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <ProjectFavicon project={group} className="size-4 shrink-0" />
                  <Tooltip>
                    <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
                      {group.displayName}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{group.displayName}</TooltipPopup>
                  </Tooltip>
                  {showProjectEnvironments ? (
                    <ProjectEnvironmentBadge
                      group={group}
                      primaryEnvironmentId={primaryEnvironmentId}
                      machineByEnvironmentId={environmentMachineById}
                    />
                  ) : null}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        {menuEntries.length > 0 ? <MenuSeparator /> : null}
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
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a project"}
    </button>
  );

  // The composer hero is a sentence, so the heading's accessible name must be
  // a complete sentence too. The project picker is a control rendered inline
  // in the h1; without an explicit label its widget state bleeds into the
  // announced phrase.
  const headingLabel = hasResolvedProject
    ? isChatDraft
      ? "What should we chat about?"
      : `What should we build in ${activeProjectDisplayName}?`
    : canChooseProject
      ? `${activeProjectDisplayName ?? "Choose a project"} to start`
      : "Add a project to start";

  // One click into chat, phrased as the alternative to the question above it.
  // Focus moves to the mode word once this line has gone.
  const orJustChat =
    canJustChat && (hasResolvedProject || canChooseProject) ? (
      <Button
        variant="link-muted"
        size="sm"
        className="pointer-events-auto"
        onClick={() =>
          void startChat().then((started) => {
            if (started) {
              document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
            }
          })
        }
      >
        or just chat
      </Button>
    ) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1
        aria-label={headingLabel}
        className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
      >
        {hasResolvedProject ? (
          isChatDraft ? (
            <>What should we {projectSelector} about?</>
          ) : (
            <>What should we build in {projectSelector}?</>
          )
        ) : canChooseProject ? (
          <>{projectSelector} to start</>
        ) : (
          <>Add a project to start</>
        )}
      </h1>
      {/* Always reserved so the heading does not move when the line goes. */}
      <div className="mt-2 flex h-8 items-center sm:h-7">{orJustChat}</div>
    </div>
  );
}
