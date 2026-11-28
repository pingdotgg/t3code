import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useGT, useMessages } from "gt-react";
import {
  FolderPlusIcon,
  FoldersIcon,
  MessageSquareDashedIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type ComponentProps, type KeyboardEventHandler, type ReactNode, useRef } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { moveDraftToProject } from "~/lib/moveDraftToProject";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import {
  groupIconFallbacks,
  pickableProjectGroups,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectPickerEntries,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { isProjectPinShortcut } from "../ProjectPinButton";
import { ProjectFavicon } from "../ProjectFavicon";
import { useSortedProjectGroups } from "../CommandPaletteLookups";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { MiddleTruncate } from "../ui/middle-truncate";
import { DraftProjectName } from "./DraftProjectName";
import { TriageDraftHero } from "./TriageDraftHero";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

/**
 * The projects a new thread can start in, as the draft hero and the new tab
 * launcher list them (pen fsQuY): pinned projects, the most recent others, a
 * way to every project, then the no-project and add-project rows.
 */
export function useProjectPickerModel(
  activeProjectRef: ScopedProjectRef | null,
  draftId: DraftId | null = null,
) {
  const messages = useMessages();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openAddProject = () => openCommandPalette({ open: "add-project", draftId });
  const openAllProjects = () => openCommandPalette({ open: "new-thread-in" });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, scratchUnavailableReason } =
    useScratchProject();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = useSortedProjectGroups(environmentLabelById);
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
  // The project that hosts threads without a project appears once, as the
  // "No project" item, not as a project row.
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    activeProjectRef?.environmentId ?? primaryEnvironmentId,
  );
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const scratchOffReason = scratchUnavailableReason(
    activeProjectRef?.environmentId ?? primaryEnvironmentId,
    messages,
  );

  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();
  const pinnedKeySet = new Set(
    menuEntries.filter(({ group }) => group.pinned).map(({ group }) => group.projectKey),
  );
  const pinnedEntries = menuEntries.filter(({ group }) => pinnedKeySet.has(group.projectKey));
  const unpinnedEntries = menuEntries.filter(({ group }) => !pinnedKeySet.has(group.projectKey));
  // The active project always shows, so the selection never hides behind "All projects".
  const recentEntries = unpinnedEntries.filter(
    ({ group }, index) => index < RECENT_PROJECT_LIMIT || group.projectKey === activeProjectKey,
  );
  const hiddenProjectCount = menuEntries.length - pinnedEntries.length - recentEntries.length;
  return {
    projects,
    primaryEnvironmentId,
    environments,
    activeProjectGroup,
    activeProjectKey,
    canChooseProject: projectPickerEntries.length > 0,
    menuEntries,
    pinnedEntries,
    recentEntries,
    hiddenProjectCount,
    pinnedKeySet,
    canPinProjectGroup,
    toggleProjectGroupPin,
    showProjectEnvironments,
    environmentMachineById,
    scratchTargetEnvironmentId,
    scratchWorkspaceRoot,
    scratchOffReason,
    noProjectShortcut: shortcutLabelForCommand(keybindings, "chat.newWithoutProject"),
    openAddProject,
    openAllProjects,
  };
}

export type ProjectPickerModel = ReturnType<typeof useProjectPickerModel>;
export type ProjectPickerEntry = ProjectPickerModel["menuEntries"][number];

/**
 * The picker's rows. `groupLabels` names the pinned and recent groups, as
 * the draft hero does; a list with its own heading leaves them out.
 */
export function ProjectPickerRows({
  model,
  groupLabels,
  selectedProjectKey,
  scratchSelected,
  onChooseEntry,
  onFocusEntry,
  onFocusNoProject,
  onNoProject,
  onAllProjects,
  concise = false,
}: {
  readonly model: ProjectPickerModel;
  readonly groupLabels: boolean;
  readonly selectedProjectKey: string | null;
  readonly scratchSelected: boolean;
  readonly onChooseEntry: (entry: ProjectPickerEntry) => void;
  /** A project row took the keyboard (arrows, Tab). */
  readonly onFocusEntry?: (entry: ProjectPickerEntry) => void;
  /** "No project" took the keyboard. */
  readonly onFocusNoProject?: () => void;
  readonly onNoProject: () => void;
  readonly onAllProjects?: () => void;
  /** The launcher offers usable actions without explanatory copy. */
  readonly concise?: boolean;
}) {
  const gt = useGT();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const renderProjectRow = (entry: ProjectPickerEntry) => {
    const { group, targetProject } = entry;
    const pinned = model.pinnedKeySet.has(group.projectKey);
    return (
      <DraftProjectRow
        key={group.projectKey}
        selected={group.projectKey === selectedProjectKey}
        icon={
          <ProjectFavicon
            project={targetProject}
            fallbackProjects={groupIconFallbacks(group.memberProjects, targetProject)}
            className="size-4 shrink-0"
          />
        }
        label={targetProject.title}
        badge={
          model.showProjectEnvironments ? (
            <ProjectEnvironmentBadge
              group={group}
              primaryEnvironmentId={model.primaryEnvironmentId}
              machineByEnvironmentId={model.environmentMachineById}
            />
          ) : null
        }
        detail={formatProjectRootForDisplay(targetProject.workspaceRoot)}
        detailIsPath
        onSelect={() => onChooseEntry(entry)}
        onKeyDown={(event) => {
          if (!model.canPinProjectGroup(group) || !isProjectPinShortcut(event, keybindings)) return;
          event.preventDefault();
          event.stopPropagation();
          model.toggleProjectGroupPin(group);
        }}
        {...(onFocusEntry ? { onFocus: () => onFocusEntry(entry) } : {})}
        action={
          model.canPinProjectGroup(group) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-micro"
                    aria-label={
                      pinned
                        ? gt("Unpin {name}", { name: group.displayName })
                        : gt("Pin {name}", { name: group.displayName })
                    }
                    aria-pressed={pinned}
                    onClick={() => model.toggleProjectGroupPin(group)}
                  />
                }
              >
                {pinned ? <PinOffIcon /> : <PinIcon />}
              </TooltipTrigger>
              <TooltipPopup side="top">{pinned ? gt("Unpin") : gt("Pin")}</TooltipPopup>
            </Tooltip>
          ) : null
        }
      />
    );
  };
  return (
    <>
      {model.pinnedEntries.length > 0 ? (
        <>
          {groupLabels ? <DraftProjectGroupLabel>{gt("Pinned")}</DraftProjectGroupLabel> : null}
          {model.pinnedEntries.map(renderProjectRow)}
        </>
      ) : null}
      {model.recentEntries.length > 0 ? (
        <>
          {groupLabels ? (
            <DraftProjectGroupLabel>
              {gt("Recent", { $context: "recently used projects" })}
            </DraftProjectGroupLabel>
          ) : null}
          {model.recentEntries.map(renderProjectRow)}
        </>
      ) : null}
      {model.menuEntries.length > 0 ? (
        <DraftProjectRow
          icon={<FoldersIcon className="size-4 shrink-0 text-muted-foreground" />}
          label={gt("All projects…")}
          detail={String(model.menuEntries.length)}
          onSelect={onAllProjects ?? model.openAllProjects}
        />
      ) : null}
      {model.menuEntries.length > 0 ? (
        <div aria-hidden className="mx-2.5 my-1 h-px bg-border" />
      ) : null}
      {model.scratchWorkspaceRoot !== null ? (
        <DraftProjectRow
          selected={scratchSelected}
          icon={<MessageSquareDashedIcon className="size-4 shrink-0 text-muted-foreground" />}
          label={gt("No project")}
          detail={concise ? "" : gt("Its own folder, no git")}
          shortcut={model.noProjectShortcut}
          onSelect={onNoProject}
          {...(onFocusNoProject ? { onFocus: onFocusNoProject } : {})}
        />
      ) : null}
      <DraftProjectRow
        icon={<FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" />}
        label={gt("Add project…")}
        detail={concise ? "" : gt("Open a folder or clone a repository")}
        onSelect={model.openAddProject}
      />
    </>
  );
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const gt = useGT();
  const model = useProjectPickerModel(activeProjectRef, draftId);
  const { projects, environments, activeProjectKey, scratchTargetEnvironmentId } = model;
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const { openScratchProject, scratchWorkspaceRootFor } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const hasResolvedProject = activeProjectTitle !== null;
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
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
  const selectProject = (project: (typeof projects)[number]) => {
    if (!draftId) {
      return;
    }
    pendingScratchRef.current = null;
    if (!moveDraftToProject(draftId, project)) {
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
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
    selectProject(project);
    return true;
  };
  const chooseEntry = (entry: ProjectPickerEntry) => {
    if (entry.group.projectKey === activeProjectKey && !isScratchDraft) return;
    selectProject(entry.targetProject);
  };

  // The hero used to be a sentence; screen readers still get one.
  const headingLabel = isScratchDraft
    ? gt("What should we work on?")
    : hasResolvedProject
      ? gt("What should we build in {project}?", { project: activeProjectTitle })
      : model.canChooseProject
        ? gt("Choose a project to start")
        : gt("Add a project to start");

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
        aria-label={gt("Projects")}
        className="flex min-h-0 flex-col gap-0.5 overflow-y-auto"
      >
        <ProjectPickerRows
          model={model}
          groupLabels
          selectedProjectKey={isScratchDraft ? null : activeProjectKey}
          scratchSelected={isScratchDraft}
          onChooseEntry={chooseEntry}
          onAllProjects={() =>
            openCommandPalette({
              open: "new-thread-in",
              onSelectProject: (project) => selectProject(project),
            })
          }
          onNoProject={() => void startScratch()}
        />
      </div>
    </div>
  );
}

// Recent rows shown before the rest fold into "All projects…".
const RECENT_PROJECT_LIMIT = 3;

/** Home-relative like a shell prompt: /Users/me/src/app reads as ~/src/app. */
export function formatProjectRootForDisplay(workspaceRoot: string): string {
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

const DRAFT_PROJECT_ROW_CLASS =
  "group/row relative flex h-8.5 shrink-0 items-center rounded-item not-data-disabled:hover:surface-ghost-hover has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-inset has-[>button:focus-visible]:ring-ring data-selected:surface-selected-soft";
const DRAFT_PROJECT_ROW_BUTTON_CLASS =
  "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-item px-2.5 text-left outline-none disabled:cursor-default disabled:opacity-64";
const DRAFT_PROJECT_ROW_LABEL_CLASS =
  "min-w-0 shrink truncate font-medium text-label text-foreground group-data-selected/row:text-strong-foreground";
const DRAFT_PROJECT_ROW_ACTION_CLASS =
  "flex w-0 shrink-0 justify-end overflow-hidden opacity-0 group-hover/row:-ml-1 group-hover/row:w-7 group-hover/row:pe-2 group-hover/row:opacity-100 group-has-focus-visible/row:-ml-1 group-has-focus-visible/row:w-7 group-has-focus-visible/row:pe-2 group-has-focus-visible/row:opacity-100 has-data-popup-open:-ml-1 has-data-popup-open:w-7 has-data-popup-open:pe-2 has-data-popup-open:opacity-100";

function DraftProjectRowRoot(props: Omit<ComponentProps<"div">, "className" | "role">) {
  return <div role="listitem" {...props} className={DRAFT_PROJECT_ROW_CLASS} />;
}

function DraftProjectRowButton(props: Omit<ComponentProps<"button">, "className" | "type">) {
  return <button type="button" {...props} className={DRAFT_PROJECT_ROW_BUTTON_CLASS} />;
}

function DraftProjectRowLabel(props: { readonly children: ReactNode }) {
  return <span className={DRAFT_PROJECT_ROW_LABEL_CLASS}>{props.children}</span>;
}

function DraftProjectRowAction(props: { readonly children: ReactNode }) {
  return <div className={DRAFT_PROJECT_ROW_ACTION_CLASS}>{props.children}</div>;
}

export const DraftProjectRowSlots = {
  Root: DraftProjectRowRoot,
  Button: DraftProjectRowButton,
  Label: DraftProjectRowLabel,
  Action: DraftProjectRowAction,
};

export function DraftProjectRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly badge?: ReactNode;
  readonly detail: string;
  readonly detailIsPath?: boolean;
  readonly shortcut?: string | null;
  readonly selected?: boolean;
  /** Shown but inert; the detail says why. */
  readonly disabled?: boolean;
  readonly action?: ReactNode;
  readonly onSelect: () => void;
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly onFocus?: () => void;
}) {
  return (
    <DraftProjectRowRoot
      onKeyDown={props.onKeyDown}
      data-selected={props.selected ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
    >
      <DraftProjectRowButton
        aria-current={props.selected ? "true" : undefined}
        disabled={props.disabled}
        onClick={props.onSelect}
        onFocus={props.onFocus}
      >
        {props.icon}
        <DraftProjectRowLabel>
          <DraftProjectName value={props.label} singleLine />
        </DraftProjectRowLabel>
        {/* Paths keep their folder name; the rest of the row's width goes to it. */}
        <span className="flex min-w-0 flex-1 justify-end text-dim-foreground text-meta">
          {props.detailIsPath ? (
            <MiddleTruncate value={props.detail} />
          ) : (
            <span className="min-w-0 truncate">{props.detail}</span>
          )}
        </span>
        {props.badge}
        {props.shortcut ? <Kbd>{props.shortcut}</Kbd> : null}
      </DraftProjectRowButton>
      {props.action ? (
        // Hidden, it takes no width, so the detail ends on the same line as
        // rows without an action.
        <DraftProjectRowAction>{props.action}</DraftProjectRowAction>
      ) : null}
    </DraftProjectRowRoot>
  );
}
