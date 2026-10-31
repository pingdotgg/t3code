import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChartNoAxesColumnIcon, PlusIcon, SettingsIcon, SquareDashedIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

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
  SurfaceLauncherRows,
  useLauncherElement,
  useSurfaceLauncherKeys,
  type SurfaceLauncherAction,
} from "../components/SurfaceLauncher";
import { isElectron } from "../env";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands } from "../shortcuts/dispatcher";
import { isModalDialogOpen } from "../lib/modalDialog";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { cn } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useThreadShell } from "../state/entities";
import type { ThreadRouteTarget } from "../threadRoutes";
import { useThreadSurfaceOpeners } from "../components/ThreadSurfaceTab";
import type { LauncherSurfaceKind } from "../components/SurfaceLauncher";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  isThreadlessHomeRef,
  isThreadlessSurfacesRef,
  threadlessSurfacesProjectRef,
  threadlessSurfacesRef,
} from "../threadlessSurfaces";
import { toggleThreadTerminalPane } from "./openRules";
import { requestLayoutSurfacePlacement } from "./surfaceSync";
import { openLayoutNewTab } from "./layoutActions";
import { LayoutLearningTips } from "./LayoutOnboarding";
import { beginLayoutTabDrag } from "./layoutDrag";
import { useLayoutPane } from "./layoutPaneContext";
import type { LayoutPageContent } from "./layoutModel";
import { useOpenLayoutPage } from "./pageNavigation";
import { runInNewLayoutTab, useLayoutStore } from "./layoutStore";
import {
  LAYOUT_TAB_ICON_CLASS,
  LAYOUT_TAB_SLOT_CLASS,
  LayoutPaneTab,
  LayoutPaneTabStrip,
  LayoutTabCloseButton,
  showLayoutTabMenu,
  useLayoutPaneSiblingTabs,
} from "./PaneTabs";

const SURFACE_SHORTCUTS: Record<LauncherSurfaceKind, string> = {
  browser: "B",
  terminal: "T",
  files: "F",
  diff: "D",
  "pull-request": "P",
  "pull-requests": "L",
  device: "M",
  "side-chat": "S",
};
const SURFACE_KINDS = Object.keys(SURFACE_SHORTCUTS) as LauncherSurfaceKind[];

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

/** A launcher tab replaces itself with its chosen thread or surface. Without a thread, surfaces use
 * the selected project through threadlessSurfaces.ts. */
interface NewTabLauncherProps {
  /** The launcher's tab, or null for an empty workspace. */
  tabId: string | null;
  context: ThreadRouteTarget | null;
  /** Its pane has focus: it takes the keyboard. */
  active: boolean;
}

type SurfaceOpeners = ReturnType<typeof useThreadSurfaceOpeners>;

/** No environment to open surfaces in: every surface row says why. */
const NO_OPENERS: SurfaceOpeners = {
  available: {
    browser: false,
    terminal: false,
    files: false,
    diff: false,
    "pull-request": false,
    "pull-requests": false,
    device: false,
    "side-chat": false,
  },
  browserUnavailableReason: "No environment is connected yet.",
  open: () => undefined,
  runShellCommand: () => undefined,
};

function NewTabLauncher(props: NewTabLauncherProps) {
  const contextThreadRef = useContextThreadRef(props.context);
  const model = useProjectPickerModel(useContextProjectRef(props.context));
  // Its context's project leads: Enter starts the next thread there. Without
  // a thread, the project row the keyboard is on leads and holds its
  // surfaces (null on "No project": the server's home); before one is, the
  // context's (none from a home surface), else the first offered.
  const [focusedProjectKey, setFocusedProjectKey] = useState<string | null>();
  const fromHome = props.context?.kind === "server" && isThreadlessHomeRef(props.context.threadRef);
  const firstEntry = model.pinnedEntries[0] ?? model.recentEntries[0] ?? null;
  const selectedProjectKey =
    contextThreadRef === null && (focusedProjectKey !== undefined || fromHome)
      ? (focusedProjectKey ?? null)
      : (contextThreadRef === null
          ? model.activeProjectKey || firstEntry?.group.projectKey
          : model.activeProjectKey) || null;
  const selectedEntry = model.menuEntries.find(
    (entry) => entry.group.projectKey === selectedProjectKey,
  );
  const environmentId =
    selectedEntry?.targetProject.environmentId ??
    model.primaryEnvironmentId ??
    model.environments[0]?.environmentId ??
    null;
  const projectId = selectedEntry?.targetProject.id ?? null;
  const surfacesRef =
    contextThreadRef ??
    (environmentId === null ? null : threadlessSurfacesRef(environmentId, projectId));
  const body = {
    ...props,
    model,
    selectedProjectKey,
    onFocusProjectKey: contextThreadRef === null ? setFocusedProjectKey : undefined,
    contextThreadRef,
  };
  return surfacesRef === null ? (
    <NewTabLauncherBody {...body} surfacesRef={null} openers={NO_OPENERS} />
  ) : (
    <NewTabLauncherWithSurfaces {...body} surfacesRef={surfacesRef} />
  );
}

interface NewTabLauncherBodyProps extends NewTabLauncherProps {
  model: ProjectPickerModel;
  selectedProjectKey: string | null;
  /** Set while threadless: the project row the keyboard is on (null for "No project"), which its surfaces follow. */
  onFocusProjectKey: ((projectKey: string | null) => void) | undefined;
  /** The thread it was opened from, which answers cmd+J; null when threadless. */
  contextThreadRef: ScopedThreadRef | null;
  /** What its surfaces open for: `contextThreadRef`, or a threadless ref. */
  surfacesRef: ScopedThreadRef | null;
  openers: SurfaceOpeners;
}

function NewTabLauncherWithSurfaces(
  props: Omit<NewTabLauncherBodyProps, "openers"> & { surfacesRef: ScopedThreadRef },
) {
  const openers = useThreadSurfaceOpeners(props.surfacesRef);
  return <NewTabLauncherBody {...props} openers={openers} />;
}

function NewTabLauncherBody({
  tabId,
  active,
  model,
  selectedProjectKey,
  onFocusProjectKey,
  contextThreadRef,
  surfacesRef,
  openers,
}: NewTabLauncherBodyProps) {
  const { paneId } = useLayoutPane();
  const handleNewThread = useNewThreadHandler();
  const { startScratchThread } = useScratchProject();
  const browserProfiles = useBrowserDefaults().profiles;
  const focusedWorkspaceId = useLayoutStore((state) => state.layout.focusedWorkspaceId);
  const openLayoutPage = useOpenLayoutPage();
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
    if (surfacesRef === null || !openers.available[kind]) return;
    requestLayoutSurfacePlacement(
      surfacesRef,
      tabId !== null && paneId !== null
        ? { kind: "pane", paneId, replaceTabId: tabId }
        : { kind: "workspace", workspaceId: focusedWorkspaceId },
    );
    openers.open(kind, browserProfileId);
  };
  // A thread's linked pull requests need the thread.
  const threadless = contextThreadRef === null;
  const actions: SurfaceLauncherAction[] = SURFACE_KINDS.map((kind) => ({
    kind,
    shortcut: SURFACE_SHORTCUTS[kind],
    available: openers.available[kind],
    ...(kind === "browser" && openers.browserUnavailableReason !== null
      ? { disabledReason: openers.browserUnavailableReason }
      : {}),
    ...(threadless && kind === "pull-requests" ? { disabledReason: "Open a thread first." } : {}),
    onClick: () => openSurface(kind),
  }));

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
      {...workspaceAreaProps("launcher", 1, "New tab")}
      data-new-tab-launcher=""
      data-surface-reaches-under-header=""
      className={cn(
        "scrollbar-gutter-both flex min-h-0 flex-1 items-center-safe justify-center overflow-y-auto px-4 pt-under-header pb-(--workspace-topbar-height) outline-none",
        PANE_BODY_UNDER_HEADER_CLASS,
      )}
    >
      <div role="list" aria-label="New tab" className="flex w-full max-w-110 flex-col gap-0.5 py-6">
        <DraftProjectGroupLabel>Start a thread in</DraftProjectGroupLabel>
        <ProjectPickerRows
          model={model}
          groupLabels={false}
          concise
          selectedProjectKey={selectedProjectKey}
          scratchSelected={onFocusProjectKey !== undefined && selectedProjectKey === null}
          onChooseEntry={chooseEntry}
          {...(onFocusProjectKey
            ? {
                onFocusEntry: (entry: ProjectPickerEntry) =>
                  onFocusProjectKey(entry.group.projectKey),
                onFocusNoProject: () => onFocusProjectKey(null),
              }
            : {})}
          onNoProject={startWithoutProject}
        />
        {actions.some((action) => action.available) ? (
          <>
            <div aria-hidden className="h-2 shrink-0" />
            <SurfaceLauncherRows
              actions={actions.filter((action) => action.available)}
              browserProfiles={browserProfiles}
              onAddBrowserInProfile={(profileId) => openSurface("browser", profileId)}
            />
          </>
        ) : null}
        <div aria-hidden className="h-2 shrink-0" />
        <DraftProjectGroupLabel>Open a page</DraftProjectGroupLabel>
        <DraftProjectRow
          icon={<SettingsIcon className="size-4 shrink-0 text-muted-foreground" />}
          label="Settings"
          detail=""
          onSelect={() => openPage("settings")}
        />
        <DraftProjectRow
          icon={<ChartNoAxesColumnIcon className="size-4 shrink-0 text-muted-foreground" />}
          label="Usage"
          detail=""
          onSelect={() => openPage("usage")}
        />
        <DraftProjectRow
          icon={<PullRequestGlyph.pullRequest className="size-4 shrink-0 text-muted-foreground" />}
          label="Pull requests"
          detail=""
          onSelect={() => openPage("pull-requests")}
        />
        <LayoutLearningTips />
      </div>
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
  footer,
}: {
  /** Null for an empty workspace, which looks the same but has no tab to close or move. */
  tabId: string | null;
  context: ThreadRouteTarget | null;
  footer?: React.ReactNode;
}) {
  const { focused, leadingEdge } = useLayoutPane();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* A chat pane's header, so the notches of panes side by side line up. */}
      <header
        data-pane-header=""
        data-floating-pane-header=""
        className={cn(
          "relative z-10 flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pr-(--workspace-gutter-end) pl-(--workspace-gutter-start) md:pl-0",
          isElectron && "drag-region",
          leadingEdge && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <LauncherTabNotch tabId={tabId} />
      </header>
      <NewTabLauncher tabId={tabId} context={context} active={focused} />
      {footer}
    </div>
  );
}

function LauncherTabNotch({ tabId }: { tabId: string | null }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "tab.new");
  const siblingTabs = useLayoutPaneSiblingTabs();
  return (
    <PaneNotch>
      <LayoutPaneTabStrip>
        {siblingTabs.before.map((tab) => (
          <LayoutPaneTab key={tab.id} tab={tab} />
        ))}
        <span className={cn(LAYOUT_TAB_SLOT_CLASS, "min-w-15")}>
          <div
            className={PANE_TAB_CLASS}
            data-layout-launcher-tab=""
            data-layout-pane-tab={tabId ?? undefined}
            onPointerDown={tabId === null ? undefined : (event) => beginLayoutTabDrag(event, tabId)}
            onContextMenu={(event) => {
              if (tabId === null) return;
              event.preventDefault();
              void showLayoutTabMenu(tabId, { x: event.clientX, y: event.clientY }, keybindings);
            }}
          >
            <span className={LAYOUT_TAB_ICON_CLASS}>
              <SquareDashedIcon aria-hidden className="size-3.5 shrink-0" />
            </span>
            <span className="truncate">New tab</span>
          </div>
          {tabId === null ? null : <LayoutTabCloseButton tabId={tabId} title="New tab" />}
        </span>
        {siblingTabs.after.map((tab) => (
          <LayoutPaneTab key={tab.id} tab={tab} />
        ))}
      </LayoutPaneTabStrip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="bare"
              size="icon-xs"
              data-pane-notch-add=""
              aria-label="New tab"
              onClick={() => {
                if (tabId !== null) useLayoutStore.getState().focusTab(tabId);
                openLayoutNewTab();
              }}
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New tab{shortcut ? ` (${shortcut})` : ""}</TooltipPopup>
      </Tooltip>
    </PaneNotch>
  );
}
