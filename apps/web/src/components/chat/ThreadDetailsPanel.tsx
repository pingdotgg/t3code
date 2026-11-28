import type {
  EditorId,
  EnvironmentId,
  ProjectId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import type { ComposerThreadTarget, DraftId } from "../../composerDraftStore";
import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar, type BranchToolbarHandle } from "../BranchToolbar";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, { type ProjectScriptActionResult } from "../ProjectScriptsControl";
import { T, useGT } from "gt-react";
import { useImperativeHandle, useRef, useState, type ComponentProps, type Ref } from "react";
import { flushSync } from "react-dom";
import {
  selectActiveRightPanelSurface,
  selectThreadPanelOpen,
  useRightPanelStore,
} from "../../rightPanelStore";
import { requestWorkspaceFocus } from "../../lib/workspaceFocus";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsMachineLoad } from "./ThreadDetailsMachineLoad";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadRepositorySections } from "./ThreadRepositorySections";
import { ThreadServersPanel } from "./ThreadServersPanel";
import {
  ThreadDetailsContext,
  ThreadDetailsUsage,
  type ThreadDetailsUsageInput,
} from "./ThreadDetailsUsage";
import { ThreadDetailsTasks } from "./ThreadDetailsTasks";
import type { TaskListPlan } from "../../session-logic";
import { ThreadDetailsItemsMenuItems } from "./ThreadDetailsItemsMenu";
import { resolveThreadDetailsVisibility } from "./threadDetailsItems";
import { useClientSettings } from "../../hooks/useSettings";
import { useProject, useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadDetailsThreadPrRows } from "./ThreadDetailsPrRows";
import { SlidersHorizontalIcon } from "lucide-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { Menu, MenuItemLabel, MenuPopup } from "../ui/menu";

export interface ThreadDetailsPanelHandle {
  openBranch: (presentation: "inline" | "popover") => void;
}

interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle"
> {
  ref?: Ref<ThreadDetailsPanelHandle>;
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  draftId?: DraftId;
  composerDraftTarget: ComposerThreadTarget;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  workspaceMutationId: string | null;
  isGitRepo: boolean;
  /** Whether the panel's git control listens for the commit and push shortcut; see onGitShortcutHostChange. */
  gitShortcutListening?: boolean;
  onGitShortcutHostChange?: (hosting: boolean) => void;
  /** False when no worktree can come from this folder, so it offers no workspace modes. */
  offersWorkspaceModes: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: ComponentProps<typeof ProjectScriptsControl>["onAddScript"];
  onUpdateProjectScript: ComponentProps<typeof ProjectScriptsControl>["onUpdateScript"];
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  usage: ThreadDetailsUsageInput;
  onCompactContext?: () => void;
  compactUnavailableReason?: string | null;
  taskList: TaskListPlan | null;
}

export function ThreadDetailsPanel({ ref, ...props }: ThreadDetailsPanelProps) {
  const visible = useClientSettings(resolveThreadDetailsVisibility);
  const companionFileActive = useRightPanelStore((state) => {
    if (!props.openInShortcutEnabled) return false;
    const surface = selectActiveRightPanelSurface(state.byThreadKey, {
      environmentId: props.environmentId,
      threadId: props.threadId,
    });
    return surface?.kind === "file" && surface.attachment === undefined;
  });
  const openInShortcutEnabled = props.openInShortcutEnabled && !companionFileActive;
  const gt = useGT();
  const branchToolbarRef = useRef<BranchToolbarHandle>(null);
  const focusBranchOnOpen = useRef(false);
  const focusBranch = () => {
    if (props.isGitRepo) branchToolbarRef.current?.focusBranchPicker();
    else requestWorkspaceFocus({ area: "details" });
  };
  useImperativeHandle(ref, () => ({
    openBranch: (presentation) => {
      focusBranchOnOpen.current =
        presentation === "popover" &&
        !selectThreadPanelOpen(
          useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
          { environmentId: props.environmentId, threadId: props.threadId },
          presentation,
        );
      flushSync(() => {
        useRightPanelStore
          .getState()
          .setThreadPanelOpen(
            { environmentId: props.environmentId, threadId: props.threadId },
            presentation,
            true,
          );
      });
      focusBranch();
    },
  }));
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const t3File = useT3ProjectFileState(
    props.environmentId,
    props.activeProjectScripts && visible.scripts ? props.gitCwd : null,
  );
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  const serverConfig = useServerConfigs().get(props.environmentId);
  const tracksFolders = (project?.trackedFolders?.length ?? 0) > 0;
  // A worktree thread reaches tracked repositories only through its own task folder.
  const taskFolderQuery = useEnvironmentQuery(
    // Asked whatever the project tracks now: a thread keeps its task folder when that changes.
    props.isServerThread && props.worktreePath !== null
      ? filesystemEnvironment.taskFolder({
          environmentId: props.environmentId,
          input: { worktreePath: props.worktreePath },
        })
      : null,
  );
  const taskFolder = taskFolderQuery.data?.taskFolder ?? null;
  // A task folder's plain project directory can sit inside someone else's repository.
  const folderIsRepo = props.isGitRepo && taskFolder?.projectIsWorktree !== false;
  // A No project thread's folder sits inside the shared scratch root, so it must never get git.
  // Until the config and project load, a No project thread looks like any other folder.
  const offersGit =
    props.gitCwd !== null &&
    serverConfig !== undefined &&
    project !== null &&
    !isScratchProject(project, serverConfig.scratchWorkspaceRoot);
  // The branch picker owns PR state and portals its rows into the git group.
  const [prRowsContainer, setPrRowsContainer] = useState<HTMLDivElement | null>(null);
  const branchToolbarProps = {
    showGitControls: folderIsRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
    worktreePath: props.worktreePath,
    isServerThread: props.isServerThread,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      onFocusRequest={() => {
        if (!focusBranchOnOpen.current) return false;
        focusBranchOnOpen.current = false;
        focusBranch();
        return true;
      }}
      onContextMenu={(event) => {
        // Popups the card opens bubble here through React; they, fields, links, and selected text
        // keep their own menus.
        const target = event.target;
        const selection = window.getSelection();
        if (
          !(target instanceof Element) ||
          !event.currentTarget.contains(target) ||
          target.closest("input, textarea, [contenteditable], a[href]") ||
          (selection &&
            !selection.isCollapsed &&
            (event.currentTarget.contains(selection.anchorNode) ||
              event.currentTarget.contains(selection.focusNode)))
        )
          return;
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {({ cut, reveal }) => {
        const show = {
          environment: visible.environment,
          openIn: visible.openIn && props.showOpenInPicker,
          scripts: visible.scripts && props.activeProjectScripts !== undefined,
          branch: offersGit && folderIsRepo && visible.branch,
          // Without a branch selector, linked pull requests still need somewhere to show.
          pullRequests: !(offersGit && folderIsRepo) && visible.branch,
          // A plain folder that tracks repositories is not asked to become one itself.
          git:
            offersGit &&
            props.activeProjectName !== undefined &&
            (folderIsRepo || (!tracksFolders && taskFolder === null)) &&
            (visible.gitActions || (visible.changes && folderIsRepo)),
          // Also for a project that tracks nothing: a thread can change a submodule.
          repositories: offersGit && visible.gitActions,
        };
        const workspaceShown =
          Object.values(show).some(Boolean) ||
          visible.usage ||
          visible.context ||
          visible.machineLoad;
        return (
          <>
            <div className="group/details-items thread-details-stack flex flex-col gap-1">
              {workspaceShown ? (
                <section
                  aria-label={gt("Workspace")}
                  data-thread-details-card
                  className="surface-tray rounded-pane p-1"
                >
                  <div className="surface-composer rounded-lg p-0.5">
                    {show.environment ? (
                      <div className="flex min-w-0 items-center">
                        <div className="min-w-0 flex-1">
                          <BranchToolbar
                            layout="panel"
                            panelSection="workspace"
                            availableEnvironments={props.availableEnvironments}
                            {...(props.onEnvironmentChange
                              ? { onEnvironmentChange: props.onEnvironmentChange }
                              : {})}
                            autoEnvironmentLabel={props.autoEnvironmentLabel}
                            onAutoEnvironment={props.onAutoEnvironment}
                            panelEnvironmentActions={
                              show.openIn ? (
                                <OpenInPicker
                                  keybindings={props.keybindings}
                                  environmentId={props.environmentId}
                                  availableEditors={props.availableEditors}
                                  openInCwd={props.gitCwd}
                                  enableShortcut={openInShortcutEnabled}
                                  presentation="menu"
                                />
                              ) : undefined
                            }
                            {...branchToolbarProps}
                            // Workspace modes follow the composer's rule, not this folder's own status.
                            showGitControls={props.offersWorkspaceModes}
                          />
                        </div>
                      </div>
                    ) : show.openIn ? (
                      <OpenInPicker
                        keybindings={props.keybindings}
                        environmentId={props.environmentId}
                        availableEditors={props.availableEditors}
                        openInCwd={props.gitCwd}
                        enableShortcut={openInShortcutEnabled}
                        displayMode="panel"
                      />
                    ) : null}
                    {show.branch || show.git ? (
                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center">
                        {show.branch ? (
                          <div className="min-w-0 flex-1">
                            <BranchToolbar
                              layout="panel"
                              panelSection="branch"
                              ref={branchToolbarRef}
                              panelPrRowsContainer={prRowsContainer}
                              {...branchToolbarProps}
                            />
                          </div>
                        ) : null}
                        {show.git && props.gitCwd ? (
                          <GitActionsControl
                            keybindings={props.keybindings}
                            displayMode="panel"
                            showActions={visible.gitActions}
                            showChanges={visible.changes}
                            gitCwd={props.gitCwd}
                            name={props.activeProjectName ?? ""}
                            workspaceMutationId={props.workspaceMutationId}
                            listenForShortcuts={props.gitShortcutListening ?? false}
                            {...(props.onGitShortcutHostChange
                              ? { onShortcutHostChange: props.onGitShortcutHostChange }
                              : {})}
                            activeThreadRef={activeThreadRef}
                            {...(props.draftId ? { draftId: props.draftId } : {})}
                            {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                          />
                        ) : null}
                      </div>
                    ) : null}
                    <div
                      ref={setPrRowsContainer}
                      data-thread-details-unit="pullRequests"
                      hidden={cut.has("pullRequests")}
                    />
                    {show.pullRequests ? (
                      <div data-thread-details-unit="pullRequests" hidden={cut.has("pullRequests")}>
                        <ThreadDetailsThreadPrRows
                          threadRef={activeThreadRef}
                          project={project}
                          composerTarget={props.composerDraftTarget}
                        />
                      </div>
                    ) : null}
                    {show.repositories ? (
                      <div data-thread-details-unit="repositories" hidden={cut.has("repositories")}>
                        <ThreadRepositorySections
                          environmentId={props.environmentId}
                          threadId={props.threadId}
                          projectId={props.projectId}
                          isServerThread={props.isServerThread}
                          threadCwd={props.gitCwd}
                          taskFolder={taskFolder}
                          reachesTracked={
                            props.worktreePath === null ? tracksFolders : taskFolder !== null
                          }
                          onTaskFolderChange={taskFolderQuery.refresh}
                          explainsEmpty={!folderIsRepo}
                          showActions={visible.gitActions}
                        />
                      </div>
                    ) : null}
                    {show.scripts && props.activeProjectScripts ? (
                      <div data-thread-details-unit="scripts" hidden={cut.has("scripts")}>
                        <ProjectScriptsControl
                          environmentId={props.environmentId}
                          displayMode="panel"
                          scripts={props.activeProjectScripts}
                          fileScripts={t3File.scripts}
                          onActionsMenuOpen={t3File.refresh}
                          preferredScriptId={props.preferredScriptId}
                          threadId={props.threadId}
                          onRunScript={props.onRunProjectScript}
                          onAddScript={props.onAddProjectScript}
                          onUpdateScript={props.onUpdateProjectScript}
                          onDeleteScript={props.onDeleteProjectScript}
                        />
                      </div>
                    ) : null}
                  </div>
                  {visible.usage || visible.context || visible.machineLoad ? (
                    <div
                      className="flex flex-col gap-1.5 px-0.5 pt-1.5 pb-0.5"
                      data-thread-details-unit="usage"
                      hidden={cut.has("usage")}
                    >
                      {visible.usage ? (
                        <ThreadDetailsUsage {...props.usage} environmentId={props.environmentId} />
                      ) : null}
                      {visible.context ? (
                        <div
                          className={visible.usage ? "border-t border-divider pt-1.5" : undefined}
                        >
                          <ThreadDetailsContext
                            usage={props.usage.contextWindow}
                            onCompact={props.onCompactContext}
                            compactUnavailableReason={props.compactUnavailableReason}
                          />
                        </div>
                      ) : null}
                      {visible.machineLoad ? (
                        <div
                          className={
                            visible.usage || visible.context
                              ? "border-t border-divider pt-1.5"
                              : undefined
                          }
                        >
                          <ThreadDetailsMachineLoad environmentId={props.environmentId} />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {reveal}
                </section>
              ) : null}

              {/* Cut as one: the reveal row lives in the workspace tray, so no card may outlast a cut. */}
              <div
                className="contents"
                data-thread-details-unit={workspaceShown ? "cards" : undefined}
                hidden={workspaceShown && cut.has("cards")}
              >
                {!props.draftId && visible.servers ? (
                  <ThreadServersPanel
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                  />
                ) : null}
                {!props.draftId && visible.automations ? (
                  <ThreadAutomationsPanel
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                  />
                ) : null}

                {!props.draftId && (visible.lineage || visible.sideChats) ? (
                  <ThreadRelationshipsPanel
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    showLineage={visible.lineage}
                    showSideChats={visible.sideChats}
                  />
                ) : null}
                {visible.tasks && props.taskList ? (
                  <ThreadDetailsTasks plan={props.taskList} compact={false} />
                ) : null}
              </div>

              {/* Shown only when no section above has content, so an emptied card can be refilled. */}
              <div className="p-1 group-has-[section]/details-items:hidden">
                <ThreadDetailsControl
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenuPosition({ x: rect.left, y: rect.bottom });
                  }}
                >
                  <SlidersHorizontalIcon aria-hidden />
                  <MenuItemLabel>
                    <T>Choose what to show</T>
                  </MenuItemLabel>
                </ThreadDetailsControl>
              </div>
            </div>

            <Menu
              open={menuPosition !== null}
              onOpenChange={(open) => !open && setMenuPosition(null)}
            >
              <MenuPopup
                anchor={
                  menuPosition
                    ? {
                        getBoundingClientRect: () =>
                          new DOMRect(menuPosition.x, menuPosition.y, 0, 0),
                      }
                    : undefined
                }
                align="start"
                side="bottom"
              >
                <ThreadDetailsItemsMenuItems />
              </MenuPopup>
            </Menu>
          </>
        );
      }}
    </ThreadDetailsCard>
  );
}
