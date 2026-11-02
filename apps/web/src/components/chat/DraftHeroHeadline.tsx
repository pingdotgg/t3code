import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  FolderPlusIcon,
  FoldersIcon,
  MessageSquareDashedIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useRef } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useNowMinute } from "~/hooks/useNowMinute";
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
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { MiddleTruncate } from "../ui/middle-truncate";
import { DraftProjectName } from "./DraftProjectName";
import { TriageDraftHero } from "./TriageDraftHero";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

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
  const openAllProjects = () => openCommandPalette({ open: "new-thread-in" });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const nowMinute = useNowMinute();

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
  // The project that hosts threads without a project appears once, as the
  // "No project" item, not as a project row.
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
        now: Date.parse(`${nowMinute}:00Z`),
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

  // The pen's draft hero (fsQuY): pinned projects, the most recent others,
  // a way to every project, then the no-project and add-project rows.
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();
  const pinnedEntries = menuEntries.filter(({ group }) => group.pinned);
  const unpinnedEntries = menuEntries.filter(({ group }) => !group.pinned);
  // The active project always shows, so the selection never hides behind "All projects".
  const recentEntries = unpinnedEntries.filter(
    ({ group }, index) => index < RECENT_PROJECT_LIMIT || group.projectKey === activeProjectKey,
  );
  const hiddenProjectCount = menuEntries.length - pinnedEntries.length - recentEntries.length;
  const chooseEntry = (entry: (typeof menuEntries)[number]) => {
    if (entry.group.projectKey === activeProjectKey && !isScratchDraft) return;
    selectProject(entry.targetProject, entry.group.projectKey);
  };
  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");

  const renderProjectRow = (entry: (typeof menuEntries)[number]) => {
    const { group, targetProject } = entry;
    const pinned = group.pinned;
    return (
      <DraftProjectRow
        key={group.projectKey}
        selected={!isScratchDraft && group.projectKey === activeProjectKey}
        icon={<ProjectFavicon project={group} className="size-4 shrink-0" />}
        label={group.displayName}
        badge={
          showProjectEnvironments ? (
            <ProjectEnvironmentBadge
              group={group}
              primaryEnvironmentId={primaryEnvironmentId}
              machineByEnvironmentId={environmentMachineById}
            />
          ) : null
        }
        detail={formatProjectRootForDisplay(targetProject.workspaceRoot)}
        detailIsPath
        onSelect={() => chooseEntry(entry)}
        action={
          canPinProjectGroup(group) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-micro"
                    aria-label={pinned ? `Unpin ${group.displayName}` : `Pin ${group.displayName}`}
                    aria-pressed={pinned}
                    onClick={() => toggleProjectGroupPin(group)}
                  />
                }
              >
                {pinned ? <PinOffIcon /> : <PinIcon />}
              </TooltipTrigger>
              <TooltipPopup side="top">{pinned ? "Unpin" : "Pin"}</TooltipPopup>
            </Tooltip>
          ) : null
        }
      />
    );
  };

  // The hero used to be a sentence; screen readers still get one.
  const headingLabel = isScratchDraft
    ? "What should we work on?"
    : hasResolvedProject
      ? `What should we build in ${activeProjectDisplayName}?`
      : canChooseProject
        ? "Choose a project to start"
        : "Add a project to start";

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
    <div className="mx-auto flex max-h-full min-h-0 w-full max-w-110 flex-col">
      <h1 className="sr-only">{headingLabel}</h1>
      <div
        role="list"
        aria-label="Projects"
        className="flex min-h-0 flex-col gap-0.5 overflow-y-auto"
      >
        {pinnedEntries.length > 0 ? (
          <>
            <DraftProjectGroupLabel>Pinned</DraftProjectGroupLabel>
            {pinnedEntries.map(renderProjectRow)}
          </>
        ) : null}
        {recentEntries.length > 0 ? (
          <>
            <DraftProjectGroupLabel>Recent</DraftProjectGroupLabel>
            {recentEntries.map(renderProjectRow)}
          </>
        ) : null}
        {hiddenProjectCount > 0 ? (
          <DraftProjectRow
            icon={<FoldersIcon className="size-4 shrink-0 text-muted-foreground" />}
            label="All projects…"
            detail={String(menuEntries.length)}
            onSelect={openAllProjects}
          />
        ) : null}
        {menuEntries.length > 0 ? <div aria-hidden className="mx-2.5 my-1 h-px bg-border" /> : null}
        {scratchWorkspaceRoot === null ? null : (
          <DraftProjectRow
            selected={isScratchDraft}
            icon={<MessageSquareDashedIcon className="size-4 shrink-0 text-muted-foreground" />}
            label="No project"
            detail="Its own folder, no git"
            shortcut={noProjectShortcut}
            onSelect={() => void startScratch()}
          />
        )}
        <DraftProjectRow
          icon={<FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" />}
          label="Add project…"
          detail="Open a folder or clone a repository"
          onSelect={openAddProject}
        />
      </div>
    </div>
  );
}

// Recent rows shown before the rest fold into "All projects…".
const RECENT_PROJECT_LIMIT = 3;

/** Home-relative like a shell prompt: /Users/me/src/app reads as ~/src/app. */
function formatProjectRootForDisplay(workspaceRoot: string): string {
  return workspaceRoot.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, "~");
}

export function DraftProjectGroupLabel({ children }: { readonly children: string }) {
  return (
    <div
      role="presentation"
      className="px-2.5 pt-2 pb-1 text-caption font-medium text-dim-foreground"
    >
      {children}
    </div>
  );
}

export function DraftProjectRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly badge?: ReactNode;
  readonly detail: string;
  readonly detailIsPath?: boolean;
  readonly shortcut?: string | null;
  readonly selected?: boolean;
  readonly action?: ReactNode;
  readonly onSelect: () => void;
}) {
  return (
    <div
      role="listitem"
      data-selected={props.selected ? "" : undefined}
      className="group/row relative flex h-8.5 shrink-0 items-center rounded-item hover:surface-ghost-hover has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-inset has-[>button:focus-visible]:ring-ring data-selected:surface-selected-soft"
    >
      <button
        type="button"
        aria-current={props.selected ? "true" : undefined}
        onClick={props.onSelect}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-item px-2.5 text-left outline-none"
      >
        {props.icon}
        <span className="min-w-0 shrink truncate font-medium text-label text-foreground group-data-selected/row:text-strong-foreground">
          <DraftProjectName value={props.label} singleLine />
        </span>
        {props.badge}
        {/* Paths keep their folder name; the rest of the row's width goes to it. */}
        <span className="flex min-w-0 flex-1 justify-end text-dim-foreground text-meta">
          {props.detailIsPath ? (
            <MiddleTruncate value={props.detail} />
          ) : (
            <span className="min-w-0 truncate">{props.detail}</span>
          )}
        </span>
        {props.shortcut ? <Kbd>{props.shortcut}</Kbd> : null}
      </button>
      {props.action ? (
        // Hidden, it takes no width, so the detail ends on the same line as
        // rows without an action.
        <div className="flex w-0 shrink-0 justify-end overflow-hidden opacity-0 group-focus-within/row:-ml-1 group-focus-within/row:w-7 group-focus-within/row:pe-2 group-focus-within/row:opacity-100 group-hover/row:-ml-1 group-hover/row:w-7 group-hover/row:pe-2 group-hover/row:opacity-100">
          {props.action}
        </div>
      ) : null}
    </div>
  );
}
