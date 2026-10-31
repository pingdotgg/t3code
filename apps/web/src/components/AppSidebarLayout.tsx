import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useRouter, type AnyRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";

import { moveWorkspaceFocus, workspaceAreaProps } from "../lib/workspaceFocus";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import {
  releaseThreadUndoShortcut,
  threadUndoClaimsShortcut,
  undoLatestThreadAction,
} from "../hooks/showThreadUndoNotice";
import { getLocalStorageItem, removeLocalStorageItem } from "../hooks/useLocalStorage";
import {
  isRichTextBoldShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import {
  navigateHistory,
  useCanNavigateHistory,
  type HistoryDirection,
} from "../navigationHistory";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  useEnvironmentIdentificationMode,
  useHideWindowControlsWhenSidebarCollapsed,
} from "../hooks/useSettings";
import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "../panelAnimations";
import { BackgroundThreadAnnouncer } from "./BackgroundThreadAnnouncer";
import { HistorySwipeNavigation } from "./HistorySwipeNavigation";
import ThreadSidebar from "./Sidebar";
import { isAppModalPage } from "./sidebar/mainAppLocation";
import type { SidebarRouteReveal } from "./sidebar/routeReveal";
import { ChromeChannelArt, useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  createSidebarOpenStore,
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { resolveThreadRouteRef } from "../threadRoutes";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 97px)";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

// Cache the synchronous fullscreen IPC read until subscription.
let windowFullscreenSnapshot: boolean | null = null;

function macosDesktopBridge() {
  if (!isElectron || !isMacPlatform(navigator.platform)) return null;
  return window.desktopBridge ?? null;
}

function subscribeToWindowFullscreen(onChange: () => void): () => void {
  const bridge = macosDesktopBridge();
  if (
    typeof bridge?.getWindowFullscreenState !== "function" ||
    typeof bridge.onWindowFullscreenStateChange !== "function"
  ) {
    return () => {};
  }
  const unsubscribe = bridge.onWindowFullscreenStateChange((fullscreen) => {
    windowFullscreenSnapshot = fullscreen;
    onChange();
  });
  // The window may have changed state between the first render and this subscription.
  windowFullscreenSnapshot = bridge.getWindowFullscreenState();
  return () => {
    unsubscribe();
    windowFullscreenSnapshot = null;
  };
}

function readWindowFullscreen(): boolean {
  if (windowFullscreenSnapshot === null) {
    const getWindowFullscreenState = macosDesktopBridge()?.getWindowFullscreenState;
    windowFullscreenSnapshot =
      typeof getWindowFullscreenState === "function" ? getWindowFullscreenState() : false;
  }
  return windowFullscreenSnapshot;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function readUsagePageOpen(router: AnyRouter) {
  return router.state.location.pathname === "/usage";
}

function isKeybindingCaptureTarget(event: KeyboardEvent) {
  return event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]");
}

function readRoutePanelsOpen(router: AnyRouter) {
  const routeThreadRef = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
  if (!routeThreadRef) return { terminalOpen: false, previewOpen: false };
  return {
    terminalOpen: selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      routeThreadRef,
    ).terminalOpen,
    previewOpen:
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
      "preview",
  };
}

export function registerNavigationHistoryCommands(router: AnyRouter): () => void {
  return registerCommands(
    {
      "navigation.back": (event) => {
        if (!navigateHistory("back")) return false;
        event.preventDefault();
        event.stopPropagation();
      },
      "navigation.forward": (event) => {
        if (!navigateHistory("forward")) return false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
    {
      when: (event) => !isKeybindingCaptureTarget(event),
      context: () => ({
        ...readRoutePanelsOpen(router),
        usagePageOpen: readUsagePageOpen(router),
      }),
    },
  );
}

// Capture phase, so F6 also leaves widgets that swallow keys, such as the terminal.
function registerWorkspaceFocusCommands(router: AnyRouter): () => void {
  const move = (direction: 1 | -1) => (event: KeyboardEvent) => {
    if (event.isComposing) return false;
    // Inside a dialog the move is refused, but the key is still consumed.
    event.preventDefault();
    event.stopPropagation();
    moveWorkspaceFocus(direction);
  };
  const disposers = [
    registerCommands(
      { "workspace.focusNext": move(1), "workspace.focusPrevious": move(-1) },
      {
        capture: true,
        when: (event) => !isKeybindingCaptureTarget(event),
        context: () => readRoutePanelsOpen(router),
      },
    ),
    // A focused desktop browser forwards the keys; its renderer focus is stale.
    registerMenuAction("workspace.focusNext", () => moveWorkspaceFocus(1, "panel")),
    registerMenuAction("workspace.focusPrevious", () => moveWorkspaceFocus(-1, "panel")),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

// Escape leaves the pull requests page when no scope (a selection, a dialog,
// a drag) claimed it, so it observes after every other scope.
function registerPullRequestsEscapeCommand(router: AnyRouter): () => void {
  return registerCommands(
    {},
    {
      observe: (event, consumed) => {
        if (consumed || event.repeat || event.isComposing || event.key !== "Escape") return;
        if (router.state.location.pathname !== "/pull-requests") return;
        event.preventDefault();
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) activeElement.blur();
        if (router.state.location.state.__TSR_index !== 0) {
          window.history.back();
          return;
        }
        void router.navigate({ to: "/" });
      },
    },
  );
}

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

// A held key undoes once. Module state: undoing an archive navigates, and the
// hold must survive whatever that re-renders.
let heldUndoKey: string | null = null;

// Undoes the thread actions in the sidebar's notice. Settings and Usage own
// mod+z while open. Captured so mod+z reaches it before the composer's own
// undo handler consumes the key.
function registerThreadUndoCommands(
  router: AnyRouter,
  readSidebarVisible: () => boolean,
): () => void {
  const threadSidebarShown = () => !isAppModalPage(router.state.location.pathname);
  const unregister = registerCommands(
    {},
    {
      capture: true,
      when: threadSidebarShown,
      onKeyDown: (event) => {
        // Cancel a held key's repeats so they cannot fall through to the
        // editor's own undo, even after the last notice is gone.
        if (event.repeat) {
          if (event.code !== heldUndoKey) return false;
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        // A modifier tapped mid-hold leaves the held key repeating.
        if (!MODIFIER_KEYS.has(event.key)) heldUndoKey = null;
        const command = resolveShortcutCommand(
          event,
          appAtomRegistry.get(primaryServerKeybindingsAtom),
          {
            context: {
              terminalFocus: isTerminalFocused(),
              previewFocus: isPreviewFocused(),
              ...readRoutePanelsOpen(router),
              // A collapsed sidebar hides the notice, so text fields keep their own undo.
              editableFocus:
                isEditableFocused(event.target) &&
                !(readSidebarVisible() && threadUndoClaimsShortcut()),
              modelPickerOpen: isModelPickerOpen(),
            },
          },
        );
        if (command !== "thread.undo") {
          if (!MODIFIER_KEYS.has(event.key)) releaseThreadUndoShortcut();
          return false;
        }
        if (isCommandPaletteOpen() || isModelPickerOpen()) return false;
        if (!undoLatestThreadAction()) return false;
        heldUndoKey = event.code;
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
    },
  );
  // Pastes from a menu, dictation and drops edit text without a keypress.
  const onInput = () => {
    if (threadSidebarShown()) releaseThreadUndoShortcut();
  };
  window.addEventListener("input", onInput, true);
  return () => {
    unregister();
    window.removeEventListener("input", onInput, true);
  };
}

/** Keyboard and menu commands that live as long as the app shell. */
function registerAppShellCommands(router: AnyRouter, shellElement: Element): () => void {
  // The provider mirrors the visibility it renders onto its wrapper, so the
  // committed state is readable when a key arrives.
  const readSidebarVisible = () =>
    shellElement.closest('[data-slot="sidebar-wrapper"]')?.getAttribute("data-sidebar-state") ===
    "expanded";
  const disposers = [
    registerThreadUndoCommands(router, readSidebarVisible),
    registerNavigationHistoryCommands(router),
    registerWorkspaceFocusCommands(router),
    registerPullRequestsEscapeCommand(router),
    registerMenuAction("open-settings", () => {
      if (!/^\/settings(\/|$)/.test(router.state.location.pathname))
        void router.navigate({ to: "/settings" });
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

function SidebarControl() {
  const router = useRouter();
  const usagePageOpen = useLocation({ select: (location) => location.pathname === "/usage" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar, isMobile, mobileSheetMounted } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(environmentIdentificationMode);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen },
  });
  const onStageBackdrop = isSidebarVisible && stageBackdropVariant !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener that toggles the sidebar on its shortcut
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (
        isRichTextBoldShortcut(event, window.getSelection()) &&
        event.target instanceof HTMLElement &&
        event.target.closest('[data-composer-rich-text="true"]')
      ) {
        // The rich-text composer claims Mod+B only to bold selected text;
        // the toggle stays available everywhere else.
        return;
      }
      if (
        resolveShortcutCommand(event, keybindings, { context: { usagePageOpen } }) !==
        "sidebar.toggle"
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown, true);
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "sidebar.toggle") toggleSidebar();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, [keybindings, toggleSidebar, usagePageOpen]);

  // The control lives as long as the shell, so it carries the shell's commands. Created
  // once so re-renders never re-register them.
  const [appShellCommandsRef] = useState(
    () => (node: HTMLDivElement | null) =>
      node === null ? undefined : registerAppShellCommands(router, node),
  );

  return (
    // Align the toggle glyph to the sidebar icon column.
    <div
      ref={appShellCommandsRef}
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center",
        isMobile && mobileSheetMounted && "hidden",
      )}
      // Sits on the window chrome, so it takes the black chrome tokens too.
      data-chrome-scope=""
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              variant={isSidebarVisible && stageBackdropVariant ? "media-navigation" : "ghost"}
              className={cn(
                "pointer-events-auto",
                isSidebarVisible && stageBackdropVariant && "relative top-auto translate-y-0",
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      {/* Phones keep the header for the page; the system back gesture covers them. */}
      <div className="pointer-events-auto hidden items-center [-webkit-app-region:no-drag] md:flex">
        <NavigationHistoryButton direction="back" onStageBackdrop={onStageBackdrop} />
        <NavigationHistoryButton direction="forward" onStageBackdrop={onStageBackdrop} />
      </div>
    </div>
  );
}

const NAVIGATION_HISTORY_BUTTONS = {
  back: { label: "Back", command: "navigation.back", Icon: ArrowLeftIcon },
  forward: { label: "Forward", command: "navigation.forward", Icon: ArrowRightIcon },
} as const;

// Next to the sidebar toggle on the chrome row (pen fiPPG, iZJUf). On the web
// they share the tab's history with the browser's own buttons, but stop at the
// app's first and last entries, so they never leave the app.
function NavigationHistoryButton({
  direction,
  onStageBackdrop,
}: {
  direction: HistoryDirection;
  onStageBackdrop: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const canNavigate = useCanNavigateHistory(direction);
  const { label, command, Icon } = NAVIGATION_HISTORY_BUTTONS[direction];
  const shortcutLabel = shortcutLabelForCommand(keybindings, command);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            // The trigger beside it switches to the media variant over the stage artwork.
            variant={onStageBackdrop ? "media-navigation" : "ghost"}
            size="icon-sm"
            className={cn(onStageBackdrop && "relative top-auto translate-y-0")}
            aria-label={label}
            disabled={!canNavigate}
            onClick={() => navigateHistory(direction)}
          />
        }
      >
        {/* The pen strokes these 16px glyphs at 1.5px: 2.25 on lucide's 24px grid. */}
        <Icon className="size-4 text-sidebar-toggle" strokeWidth={2.25} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const sidebarArea = workspaceAreaProps("sidebar", 0, "Threads");
  const [sidebarRouteReveal] = useState<SidebarRouteReveal>(() => ({
    observedKey: null,
    pendingKey: null,
  }));
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const pathname = useLocation({ select: (location) => location.pathname });
  const panelAnimationsSuppressed = usePanelNavigationSuppression(pathname);
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // A clamped drag may not change width, so viewport changes need a separate subscription.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMinimumWidth = THREAD_SIDEBAR_MIN_WIDTH;
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth, sidebarMinimumWidth);
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setSidebarWidth(resolveInitialThreadSidebarWidth(null, viewportWidth));
  };
  const [sidebarOpenStore] = useState(() => createSidebarOpenStore(true));
  const { open: isSidebarOpen } = useSyncExternalStore(
    sidebarOpenStore.subscribe,
    sidebarOpenStore.getSnapshot,
    sidebarOpenStore.getSnapshot,
  );
  const isMobileLayout = useMediaQuery({
    max: "md",
  });
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const chromeArtVariant = useSidebarStageBackdropVariant(environmentIdentificationMode);
  const hideWindowControlsWhenSidebarCollapsed = useHideWindowControlsWhenSidebarCollapsed();
  const isWindowFullscreen = useSyncExternalStore(
    subscribeToWindowFullscreen,
    readWindowFullscreen,
  );
  // Fullscreen owns the traffic lights, and the mobile sheet leaves the chrome row alone.
  const windowControlsHidden =
    isMacosDesktop &&
    !isWindowFullscreen &&
    !isMobileLayout &&
    !isSidebarOpen &&
    hideWindowControlsWhenSidebarCollapsed;
  const windowControlsInsetStyle = (
    isMacosDesktop && !isWindowFullscreen && !windowControlsHidden
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}
  ) as CSSProperties;
  const sidebarProviderStyle = {
    "--sidebar-width": `${clampThreadSidebarWidth(sidebarWidth, sidebarMinimumWidth, sidebarMaximumWidth)}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
    ...windowControlsInsetStyle,
  } as CSSProperties;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps native traffic-light visibility in step with the committed shell layout and restores it on unmount
  useEffect(() => {
    const setWindowButtonsVisible = window.desktopBridge?.setWindowButtonsVisible;
    if (!isMacosDesktop || typeof setWindowButtonsVisible !== "function") return;
    void setWindowButtonsVisible(!windowControlsHidden);
    if (!windowControlsHidden) return;
    return () => {
      void setWindowButtonsVisible(true);
    };
  }, [isMacosDesktop, windowControlsHidden]);

  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      <SidebarProvider
        className="h-dvh! min-h-0!"
        data-chrome-art={chromeArtVariant ?? undefined}
        data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
        store={sidebarOpenStore}
        style={sidebarProviderStyle}
      >
        {chromeArtVariant ? <ChromeChannelArt variant={chromeArtVariant} /> : null}
        <Sidebar
          side="left"
          collapsible="offcanvas"
          variant="inset"
          data-app-sidebar=""
          {...sidebarArea}
          role="navigation"
          aria-label="Threads"
          // Light, black chrome paints the sidebar with the dark tokens (index.css).
          data-chrome-scope=""
          resizable={{
            maxWidth: sidebarMaximumWidth,
            minWidth: sidebarMinimumWidth,
            shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
              nextWidth <= currentWidth ||
              wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
            storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
            onResize: setSidebarWidth,
          }}
          style={windowControlsInsetStyle}
        >
          <ThreadSidebar routeReveal={sidebarRouteReveal} />
          <SidebarRail onDoubleClick={resetSidebarWidth} />
        </Sidebar>
        {children}
        <BackgroundThreadAnnouncer />
        {isElectron ? (
          // The chrome strip above the inset pane moves the window like the
          // header rows on either side of it.
          <div
            aria-hidden
            className="drag-region fixed inset-x-0 top-0 hidden h-(--workspace-pane-inset-top) md:block"
          />
        ) : null}
        <SidebarControl />
        {isElectron ? <HistorySwipeNavigation /> : null}
      </SidebarProvider>
    </PanelAnimationSuppressionProvider>
  );
}
