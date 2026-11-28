import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import { SquareDashedIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";

import { contextMenuSourceOf } from "../contextMenuSource";
import { useBrowserDefaults } from "../browser/browserDefaults";
import {
  DraftProjectGroupLabel,
  DraftProjectRow,
  ProjectPickerRows,
  useProjectPickerModel,
  type ProjectPickerEntry,
  type ProjectPickerModel,
} from "../components/chat/DraftHeroHeadline";
import { PANE_BODY_UNDER_HEADER_CLASS, PANE_TAB_CLASS, PaneNotch } from "../components/PaneNotch";
import {
  SURFACE_LAUNCHER_ENTRIES,
  SurfaceLauncherGrid,
  useLauncherElement,
  useSurfaceLauncherKeys,
  type LauncherPullRequestRow,
  type SurfaceLauncherAction,
} from "../components/SurfaceLauncher";
import { isElectron } from "../env";
import { IssueGlyph } from "../components/issue/issuePresentation";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { useWorkflowEnvironmentIds } from "../components/workflows/useWorkflowEnvironmentIds";
import { WorkflowIcon } from "lucide-react";
import {
  COLLAPSED_SIDEBAR_INSET_EASE_CLASS,
  COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
} from "../workspaceTitlebar";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { useScrollingWorkspacesEnabled } from "../hooks/useSettings";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands } from "../shortcuts/dispatcher";
import { isModalDialogOpen } from "../lib/modalDialog";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { cn } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useThreadShell } from "../state/entities";
import { useIssuesSupported } from "../state/environments";
import type { ThreadRouteTarget } from "../threadRoutes";
import { useThreadSurfaceOpeners } from "../components/ThreadSurfaceTab";
import { ThreadContextChip } from "../components/ThreadContextChip";
import type { LauncherSurfaceKind } from "../components/SurfaceLauncher";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  isThreadlessHomeRef,
  isThreadlessSurfacesRef,
  threadlessSurfacesProjectRef,
} from "../threadlessSurfaces";
import { followLayoutCompanions, toggleThreadTerminalPane } from "./openRules";
import { requestLayoutSurfacePlacement } from "./surfaceSync";
import { LayoutLearningTips } from "./LayoutOnboarding";
import { beginLayoutTabDrag } from "./layoutDrag";
import { useLayoutPane } from "./layoutPaneContext";
import { handlePaneTabClick, useIsLayoutTabSelected } from "./paneTabSelection";
import { canCloseLayoutTab, selectLayoutWayBack, type LayoutPageContent } from "./layoutModel";
import { useOpenLayoutPage } from "./pageNavigation";
import { runInNewLayoutTab, useLayoutStore } from "./layoutStore";
import {
  LAYOUT_TAB_ICON_CLASS,
  LAYOUT_TAB_SLOT_CLASS,
  LayoutPaneTab,
  LayoutPaneTabStrip,
  LayoutNewTabButton,
  LayoutTabCloseButton,
  showLayoutTabMenu,
  useLayoutPaneSiblingTabs,
} from "./PaneTabs";

/**
 * The thread a launcher's surfaces open for: a server thread, or a draft's own
 * thread. Null with none, a threadless surface's launcher included.
 */
function useContextThreadRef(context: ThreadRouteTarget | null) {
  const draft = useComposerDraftStore((store) =>
    context?.kind === "draft" ? store.getDraftSession(context.draftId) : null,
  );
  const draftEnvironmentId = draft?.environmentId ?? null;
  const draftThreadId = draft?.threadId ?? null;
  const serverRef =
    context?.kind === "server" && !isThreadlessSurfacesRef(context.threadRef)
      ? context.threadRef
      : null;
  return (
    serverRef ??
    (draftEnvironmentId !== null && draftThreadId !== null
      ? scopeThreadRef(draftEnvironmentId, draftThreadId)
      : null)
  );
}

/** The project a launcher's thread (or threadless surface) is in, which its project rows lead with. */
function useContextProjectRef(context: ThreadRouteTarget | null) {
  const thread = useThreadShell(context?.kind === "server" ? context.threadRef : null);
  const draft = useComposerDraftStore((store) =>
    context?.kind === "draft" ? store.getDraftSession(context.draftId) : null,
  );
  const threadless = threadlessSurfacesProjectRef(
    context?.kind === "server" ? context.threadRef : null,
  );
  const environmentId =
    thread?.environmentId ?? draft?.environmentId ?? threadless?.environmentId ?? null;
  const projectId = thread?.projectId ?? draft?.projectId ?? threadless?.projectId ?? null;
  return environmentId === null || projectId === null
    ? null
    : scopeProjectRef(environmentId, projectId);
}

/** A launcher tab replaces itself with its chosen thread or surface. */
interface NewTabLauncherProps {
  /** The launcher's tab, or null for an empty workspace. */
  tabId: string | null;
  context: ThreadRouteTarget | null;
  /** Its pane has focus: it takes the keyboard. */
  active: boolean;
}

type SurfaceOpeners = ReturnType<typeof useThreadSurfaceOpeners>;

function NewTabLauncher(props: NewTabLauncherProps) {
  const contextThreadRef = useContextThreadRef(props.context);
  const contextProjectRef = useContextProjectRef(props.context);
  const model = useProjectPickerModel(contextProjectRef);
  const fromHome = props.context?.kind === "server" && isThreadlessHomeRef(props.context.threadRef);
  const firstEntry = model.pinnedEntries[0] ?? model.recentEntries[0] ?? null;
  const selectedProjectKey = fromHome
    ? null
    : (contextThreadRef === null
        ? model.activeProjectKey || firstEntry?.group.projectKey
        : model.activeProjectKey) || null;
  const body = {
    ...props,
    model,
    selectedProjectKey,
    scratchSelected: contextThreadRef === null && selectedProjectKey === null,
    contextProjectId: contextProjectRef?.projectId ?? null,
  };
  return contextThreadRef === null ? (
    <NewTabLauncherBody {...body} contextThreadRef={null} openers={null} />
  ) : (
    <NewTabLauncherWithSurfaces {...body} contextThreadRef={contextThreadRef} />
  );
}

interface NewTabLauncherBodyProps extends NewTabLauncherProps {
  model: ProjectPickerModel;
  selectedProjectKey: string | null;
  scratchSelected: boolean;
  /** The thread it was opened from, which its surfaces open for and which answers cmd+J. */
  contextThreadRef: ScopedThreadRef | null;
  contextProjectId: ProjectId | null;
  openers: SurfaceOpeners | null;
}

function NewTabLauncherWithSurfaces(
  props: Omit<NewTabLauncherBodyProps, "openers"> & { contextThreadRef: ScopedThreadRef },
) {
  const openers = useThreadSurfaceOpeners(props.contextThreadRef);
  return <NewTabLauncherBody {...props} openers={openers} />;
}

function NewTabLauncherBody({
  tabId,
  active,
  model,
  selectedProjectKey,
  scratchSelected,
  contextThreadRef,
  contextProjectId,
  openers,
}: NewTabLauncherBodyProps) {
  const gt = useGT();
  const { paneId } = useLayoutPane();
  const handleNewThread = useNewThreadHandler();
  const { startScratchThread } = useScratchProject();
  const browserProfiles = useBrowserDefaults().profiles;
  const focusedWorkspaceId = useLayoutStore((state) => state.layout.focusedWorkspaceId);
  const openLayoutPage = useOpenLayoutPage();
  const issuesSupported = useIssuesSupported();
  const workflowsReachable = useWorkflowEnvironmentIds().length > 0;
  const openPage = (kind: LayoutPageContent["kind"]) =>
    void openLayoutPage(
      kind,
      paneId !== null
        ? { kind: "pane", paneId }
        : { kind: "column", workspaceId: focusedWorkspaceId, index: 0 },
      tabId ?? undefined,
    );

  // The thread opens in this tab's place; from an empty workspace it fills it.
  const start = (action: () => Promise<unknown>) =>
    void (tabId === null ? action() : runInNewLayoutTab(action, { replaceTabId: tabId }));
  const chooseEntry = (entry: ProjectPickerEntry) =>
    start(() =>
      handleNewThread(scopeProjectRef(entry.targetProject.environmentId, entry.targetProject.id)),
    );
  const startWithoutProject = () => {
    const environmentId = model.scratchTargetEnvironmentId;
    if (environmentId !== null) start(() => startScratchThread(environmentId));
  };

  // A surface opens as a tab of this pane in this launcher's place; from an
  // empty workspace, as its first column.
  const openSurface = (kind: LauncherSurfaceKind, browserProfileId?: string) => {
    if (contextThreadRef === null || !openers?.available[kind]) return;
    requestLayoutSurfacePlacement(
      contextThreadRef,
      tabId !== null && paneId !== null
        ? { kind: "pane", paneId, replaceTabId: tabId }
        : { kind: "workspace", workspaceId: focusedWorkspaceId },
    );
    openers.open(kind, browserProfileId);
  };
  const { actions, pullRequest } =
    openers === null
      ? { actions: [], pullRequest: null }
      : launcherSurfaceActions(openers, openSurface);

  const activeRef = useRef(active);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish committed focus ownership to the callback ref and native key listeners.
  useLayoutEffect(() => {
    activeRef.current = active;
  });
  const [launcherRef, attachLauncher] = useLauncherElement(activeRef, true);
  useSurfaceLauncherKeys({
    launcherRef,
    activeRef,
    actions,
    onClose: tabId === null ? undefined : () => useLayoutStore.getState().closeTabByUser(tabId),
  });
  // The launcher answers its thread's keys as a surface of it does: cmd+J
  // toggles the thread's terminal.
  const threadKeyAction = useEffectEvent((command: string | null) => {
    if (command === "terminal.toggle" && contextThreadRef !== null) {
      return () =>
        toggleThreadTerminalPane(contextThreadRef, () =>
          useTerminalUiStateStore.getState().setTerminalOpen(contextThreadRef, true),
        );
    }
    return null;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register the focused launcher terminal scope for its mounted lifetime.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!activeRef.current || event.defaultPrevented || isModalDialogOpen()) return;
      const action = threadKeyAction(
        resolveShortcutCommand(event, appAtomRegistry.get(primaryServerKeybindingsAtom)),
      );
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) action();
    };
    return registerCommands(
      {},
      {
        capture: true,
        onKeyDown: (event) => {
          handler(event);
          return event.defaultPrevented;
        },
      },
    );
  }, []);

  return (
    <div
      ref={attachLauncher}
      {...workspaceAreaProps("launcher", 1, gt("New tab"))}
      data-new-tab-launcher=""
      data-surface-reaches-under-header=""
      className={cn(
        "scrollbar-gutter-both flex min-h-0 flex-1 items-center-safe justify-center overflow-y-auto px-4 pt-under-header pb-(--workspace-topbar-height) outline-none",
        PANE_BODY_UNDER_HEADER_CLASS,
      )}
    >
      <div
        role="list"
        aria-label={gt("New tab")}
        className="flex w-full max-w-110 flex-col gap-0.5 py-6"
      >
        <DraftProjectGroupLabel>{gt("Start a thread in")}</DraftProjectGroupLabel>
        <ProjectPickerRows
          model={model}
          groupLabels={false}
          concise
          selectedProjectKey={selectedProjectKey}
          scratchSelected={scratchSelected}
          onChooseEntry={chooseEntry}
          onNoProject={startWithoutProject}
        />
        {contextThreadRef !== null && actions.some((action) => action.available) ? (
          <>
            <div aria-hidden className="h-2 shrink-0" />
            <LauncherThreadLabel threadRef={contextThreadRef} projectId={contextProjectId} />
            <SurfaceLauncherGrid
              actions={actions}
              pullRequest={pullRequest}
              browserProfiles={browserProfiles}
              onAddBrowserInProfile={(profileId) => openSurface("browser", profileId)}
            />
          </>
        ) : null}
        <div aria-hidden className="mx-2.5 my-1 h-px bg-border" />
        <DraftProjectRow
          icon={<PullRequestGlyph.pullRequest className="size-4 shrink-0 text-muted-foreground" />}
          label={gt("All pull requests")}
          detail=""
          onSelect={() => openPage("pull-requests")}
        />
        {issuesSupported ? (
          <DraftProjectRow
            icon={<IssueGlyph.issue className="size-4 shrink-0 text-muted-foreground" />}
            label={gt("All issues")}
            detail=""
            onSelect={() => openPage("issues")}
          />
        ) : null}
        {workflowsReachable ? (
          <DraftProjectRow
            icon={<WorkflowIcon className="size-4 shrink-0 text-muted-foreground" />}
            label={gt("Workflows")}
            detail=""
            onSelect={() => openPage("workflows")}
          />
        ) : null}
        <LayoutLearningTips />
      </div>
    </div>
  );
}

function launcherSurfaceActions(
  openers: SurfaceOpeners,
  openSurface: (kind: LauncherSurfaceKind) => void,
): { actions: SurfaceLauncherAction[]; pullRequest: LauncherPullRequestRow | null } {
  const pullRequest: LauncherPullRequestRow | null =
    openers.available["pull-requests"] && openers.linkedPullRequestCount > 1
      ? {
          kind: "several",
          count: openers.linkedPullRequestCount,
          onClick: () => openSurface("pull-requests"),
        }
      : openers.available["pull-request"] && openers.pullRequestNumber !== null
        ? {
            kind: "one",
            number: openers.pullRequestNumber,
            onClick: () => openSurface("pull-request"),
          }
        : null;
  const actions = SURFACE_LAUNCHER_ENTRIES.flatMap<SurfaceLauncherAction>(({ kind, shortcut }) =>
    kind === "pull-requests" || kind === "side-chat"
      ? []
      : kind === "pull-request"
        ? pullRequest
          ? [{ kind, shortcut, available: true, onClick: pullRequest.onClick }]
          : []
        : [
            {
              kind,
              shortcut,
              available: openers.available[kind],
              onClick: () => openSurface(kind),
            },
          ],
  );
  return { actions, pullRequest };
}

function LauncherThreadLabel({
  threadRef,
  projectId,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId | null;
}) {
  const gt = useGT();
  const thread = useThreadShell(threadRef);
  return (
    <div
      role="listitem"
      className="flex min-w-0 items-baseline gap-1 px-2.5 pt-2 pb-1 text-caption text-dim-foreground"
    >
      <span className="shrink-0">
        {gt("Open for", { $context: "followed by the thread that new tools open for" })}
      </span>
      <span className="flex min-w-0">
        <ThreadContextChip
          record={{ ...threadRef, title: thread?.title ?? gt("New thread") }}
          projectId={projectId}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            followLayoutCompanions(() =>
              useLayoutStore.getState().focusChat({ kind: "server", threadRef }),
            );
          }}
        />
      </span>
    </div>
  );
}

/**
 * A launcher tab in its pane (pen tmkl7's tab, as Settings wears it): its
 * notch lists the pane's other tabs around it, with its close button and the
 * notch's "+", then the launcher fills the pane.
 */
export function LayoutLauncherPane({
  tabId,
  context,
}: {
  /** Null for a workspace drawn after it closed, which looks the same but has no tab to close or move. */
  tabId: string | null;
  context: ThreadRouteTarget | null;
}) {
  const { focused, leadingEdge } = useLayoutPane();
  return (
    <div className="pane-mobile-chrome flex min-h-0 flex-1 flex-col md:bg-background">
      {/* A chat pane's header, so the notches of panes side by side line up. */}
      <header
        data-pane-header=""
        data-floating-pane-header=""
        className={cn(
          "relative z-10 flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pr-(--workspace-gutter-end) pl-(--workspace-gutter-start) md:pl-0",
          COLLAPSED_SIDEBAR_INSET_EASE_CLASS,
          isElectron && "drag-region",
          leadingEdge && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <LauncherTabNotch tabId={tabId} />
      </header>
      <NewTabLauncher tabId={tabId} context={context} active={focused} />
      <WorkspaceWayBackHint />
    </div>
  );
}

function WorkspaceWayBackHint() {
  const gt = useGT();
  const { paneId } = useLayoutPane();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const scrollingWorkspaces = useScrollingWorkspacesEnabled();
  const way = useLayoutStore((state) =>
    scrollingWorkspaces && paneId !== null ? selectLayoutWayBack(state.layout, paneId) : null,
  );
  if (way === null) return null;
  const back = shortcutLabelForCommand(
    keybindings,
    way === "up" ? "layout.focusWorkspaceUp" : "layout.focusWorkspaceDown",
  );
  const overview = shortcutLabelForCommand(keybindings, "layout.overview");
  if (!back && !overview) return null;
  return (
    <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-meta text-dim-foreground">
      {back
        ? way === "up"
          ? gt("{shortcut} goes back up.", { shortcut: back })
          : gt("{shortcut} goes back down.", { shortcut: back })
        : null}
      {back && overview ? " " : null}
      {overview ? gt("{shortcut} shows every workspace.", { shortcut: overview }) : null}
    </p>
  );
}

function LauncherTabNotch({ tabId }: { tabId: string | null }) {
  const gt = useGT();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { paneId } = useLayoutPane();
  const selected = useIsLayoutTabSelected(paneId, tabId);
  const siblingTabs = useLayoutPaneSiblingTabs();
  const closable = useLayoutStore(
    (state) => tabId !== null && canCloseLayoutTab(state.layout, tabId),
  );
  const icon = <SquareDashedIcon aria-hidden className="size-3.5 shrink-0" />;
  return (
    <PaneNotch>
      <LayoutPaneTabStrip>
        {siblingTabs.before.map((tab) => (
          <LayoutPaneTab key={tab.id} tab={tab} />
        ))}
        <span className={LAYOUT_TAB_SLOT_CLASS}>
          <div
            className={PANE_TAB_CLASS}
            data-layout-launcher-tab=""
            data-layout-pane-tab={tabId ?? undefined}
            data-selected-tab={selected ? "" : undefined}
            onClick={(event) => {
              if (tabId !== null) handlePaneTabClick(event, tabId, { active: true });
            }}
            onPointerDown={tabId === null ? undefined : (event) => beginLayoutTabDrag(event, tabId)}
            onContextMenu={(event) => {
              if (tabId === null) return;
              event.preventDefault();
              void showLayoutTabMenu(
                tabId,
                { x: event.clientX, y: event.clientY },
                keybindings,
                undefined,
                contextMenuSourceOf(event),
              );
            }}
          >
            {closable ? <span className={LAYOUT_TAB_ICON_CLASS}>{icon}</span> : icon}
            <span className="truncate">
              <T>New tab</T>
            </span>
          </div>
          {closable && tabId !== null ? (
            <LayoutTabCloseButton tabId={tabId} title={gt("New tab")} />
          ) : null}
        </span>
        {siblingTabs.after.map((tab) => (
          <LayoutPaneTab key={tab.id} tab={tab} />
        ))}
      </LayoutPaneTabStrip>
      <LayoutNewTabButton tabId={tabId} />
    </PaneNotch>
  );
}
