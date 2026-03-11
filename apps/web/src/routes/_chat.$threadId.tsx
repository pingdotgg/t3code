import { type ResolvedKeybindingsConfig, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Suspense,
  lazy,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
} from "react";

import ChatView from "../components/ChatView";
import {
  createBrowserTab,
  getBrowserTabLabel,
  normalizeBrowserDisplayUrl,
  parseSubmittedBrowserUrl,
} from "../browser";
import { selectThreadBrowserState, useBrowserStateStore } from "../browserStateStore";
import BrowserPanel from "../components/BrowserPanel";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import {
  selectThreadRightPanelState,
  useRightPanelStateStore,
  type RightPanelKind,
} from "../rightPanelStateStore";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const RIGHT_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function resolveSelectedSidePanel(search: DiffRouteSearch): RightPanelKind | null {
  if (search.diff === "1" || search.diffTurnId) {
    return "diff";
  }
  return null;
}

const RightPanelSheet = (props: {
  children: ReactNode;
  panelOpen: boolean;
  onClosePanel: () => void;
}) => {
  return (
    <Sheet
      open={props.panelOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onClosePanel();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const RightPanelLoadingFallback = (props: { inline: boolean; label: string }) => {
  if (props.inline) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
        {props.label}
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[560px] shrink-0 items-center justify-center border-l border-border bg-card px-4 text-center text-xs text-muted-foreground/70">
      {props.label}
    </aside>
  );
};

const RightPanelInlineSidebar = (props: {
  panelOpen: boolean;
  onClosePanel: () => void;
  onReopenPanel: () => void;
  children: ReactNode;
}) => {
  const { panelOpen, onClosePanel, onReopenPanel } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onReopenPanel();
        return;
      }
      onClosePanel();
    },
    [onClosePanel, onReopenPanel],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={panelOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: RIGHT_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {props.children}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const rightPanelState = useRightPanelStateStore((state) =>
    selectThreadRightPanelState(state.rightPanelStateByThreadId, threadId),
  );
  const setSelectedPanel = useRightPanelStateStore((state) => state.setSelectedPanel);
  const forcedSelectedPanel = resolveSelectedSidePanel(search);
  const selectedPanel = forcedSelectedPanel ?? rightPanelState.selectedPanel;
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const browserThreadState = useBrowserStateStore((state) =>
    selectThreadBrowserState(state.browserStateByThreadId, threadId),
  );
  const updateThreadBrowserState = useBrowserStateStore((state) => state.updateThreadBrowserState);
  const activeBrowserTab = useMemo(
    () => browserThreadState.tabs.find((tab) => tab.id === browserThreadState.activeTabId) ?? null,
    [browserThreadState.activeTabId, browserThreadState.tabs],
  );

  useEffect(() => {
    if (forcedSelectedPanel !== "diff") {
      return;
    }
    setSelectedPanel(threadId, "diff");
  }, [forcedSelectedPanel, setSelectedPanel, threadId]);

  useEffect(() => {
    if (selectedPanel === "browser" && browserThreadState.tabs.length === 0) {
      const initialTab = createBrowserTab();
      updateThreadBrowserState(threadId, (state) => ({
        ...state,
        activeTabId: initialTab.id,
        tabs: [initialTab],
        focusRequestId: state.focusRequestId + 1,
      }));
    }
  }, [browserThreadState.tabs.length, selectedPanel, threadId, updateThreadBrowserState]);

  useEffect(() => {
    const nextInputValue = normalizeBrowserDisplayUrl(activeBrowserTab?.url);
    updateThreadBrowserState(threadId, (state) =>
      state.inputValue === nextInputValue ? state : { ...state, inputValue: nextInputValue },
    );
  }, [activeBrowserTab?.id, activeBrowserTab?.url, threadId, updateThreadBrowserState]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, routeThreadExists, threadsHydrated]);

  const closePanel = useCallback(() => {
    setSelectedPanel(threadId, null);
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        return stripDiffSearchParams(previous);
      },
    });
  }, [navigate, setSelectedPanel, threadId]);
  const openPanel = useCallback(
    (panel: RightPanelKind) => {
      setSelectedPanel(threadId, panel);
      if (panel === "browser") {
        updateThreadBrowserState(threadId, (state) => ({
          ...state,
          focusRequestId: state.focusRequestId + 1,
        }));
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          return stripDiffSearchParams(previous);
        },
      });
    },
    [navigate, setSelectedPanel, threadId, updateThreadBrowserState],
  );
  const reopenPanel = useCallback(() => {
    openPanel(rightPanelState.lastSelectedPanel);
  }, [openPanel, rightPanelState.lastSelectedPanel]);
  const createTab = useCallback(() => {
    const nextTab = createBrowserTab();
    updateThreadBrowserState(threadId, (state) => ({
      ...state,
      activeTabId: nextTab.id,
      tabs: [...state.tabs, nextTab],
      inputValue: "",
      focusRequestId: state.focusRequestId + 1,
    }));
  }, [threadId, updateThreadBrowserState]);
  const activateTab = useCallback(
    (tabId: string) => {
      updateThreadBrowserState(threadId, (state) =>
        state.activeTabId === tabId ? state : { ...state, activeTabId: tabId },
      );
    },
    [threadId, updateThreadBrowserState],
  );
  const closeTab = useCallback(
    (tabId: string) => {
      updateThreadBrowserState(threadId, (state) => {
        const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
        if (closedIndex < 0) {
          return state;
        }
        const tabs = state.tabs.filter((tab) => tab.id !== tabId);
        const activeTabId =
          state.activeTabId === tabId
            ? (tabs[closedIndex]?.id ?? tabs[closedIndex - 1]?.id ?? null)
            : state.activeTabId;
        return { ...state, activeTabId, tabs };
      });
    },
    [threadId, updateThreadBrowserState],
  );
  const submitBrowserInput = useCallback(() => {
    const parsedUrl = parseSubmittedBrowserUrl(browserThreadState.inputValue);
    updateThreadBrowserState(threadId, (state) => {
      if (!parsedUrl.ok) {
        if (!state.activeTabId) {
          return {
            ...state,
            focusRequestId: state.focusRequestId + 1,
          };
        }
        return {
          ...state,
          focusRequestId: state.focusRequestId + 1,
          tabs: state.tabs.map((tab) =>
            tab.id === state.activeTabId ? { ...tab, lastError: parsedUrl.error } : tab,
          ),
        };
      }

      const nextInputValue = normalizeBrowserDisplayUrl(parsedUrl.url);
      if (!state.activeTabId) {
        const nextTab = createBrowserTab(parsedUrl.url);
        return {
          activeTabId: nextTab.id,
          tabs: [
            {
              ...nextTab,
              title:
                parsedUrl.url === "about:blank"
                  ? null
                  : getBrowserTabLabel({ title: null, url: parsedUrl.url }),
            },
          ],
          inputValue: nextInputValue,
          focusRequestId: state.focusRequestId,
        };
      }

      return {
        ...state,
        inputValue: nextInputValue,
        tabs: state.tabs.map((tab) =>
          tab.id === state.activeTabId
            ? {
                ...tab,
                url: parsedUrl.url,
                title:
                  parsedUrl.url === "about:blank"
                    ? null
                    : getBrowserTabLabel({ title: null, url: parsedUrl.url }),
                isLoading: false,
                canGoBack: false,
                canGoForward: false,
                lastError: null,
              }
            : tab,
        ),
      };
    });
  }, [browserThreadState.inputValue, threadId, updateThreadBrowserState]);
  const openActiveTabExternally = useCallback(() => {
    const url = activeBrowserTab?.url;
    const api = readNativeApi();
    if (!api || !url || url === "about:blank") {
      return;
    }
    void api.shell.openExternal(url).catch(() => undefined);
  }, [activeBrowserTab?.url]);
  const browserNewTabShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "browser.newTab"),
    [keybindings],
  );
  const browserCloseTabShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "browser.closeTab"),
    [keybindings],
  );

  useEffect(() => {
    const isTerminalFocused = (): boolean => {
      const activeElement = document.activeElement;
      if (!(activeElement instanceof HTMLElement)) return false;
      if (activeElement.classList.contains("xterm-helper-textarea")) return true;
      return activeElement.closest(".thread-terminal-drawer .xterm") !== null;
    };

    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: false,
        },
      });

      if (command === "browser.newTab") {
        event.preventDefault();
        event.stopPropagation();
        createTab();
        if (selectedPanel !== "browser") {
          openPanel("browser");
        }
        return;
      }

      if (command === "browser.closeTab") {
        if (selectedPanel !== "browser" || !activeBrowserTab) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeTab(activeBrowserTab.id);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeBrowserTab, closeTab, createTab, keybindings, openPanel, selectedPanel]);

  if (!threadsHydrated || !routeThreadExists) {
    return null;
  }

  const rightPanelContent =
    selectedPanel === null ? null : selectedPanel === "browser" ? (
      <BrowserPanel
        state={{
          activeTabId: browserThreadState.activeTabId,
          tabs: browserThreadState.tabs,
        }}
        activeTab={activeBrowserTab}
        inputValue={browserThreadState.inputValue}
        focusRequestId={browserThreadState.focusRequestId}
        newTabShortcutLabel={browserNewTabShortcutLabel}
        closeTabShortcutLabel={browserCloseTabShortcutLabel}
        onInputChange={(value) => {
          updateThreadBrowserState(threadId, (state) =>
            state.inputValue === value ? state : { ...state, inputValue: value },
          );
        }}
        onCreateTab={createTab}
        onActivateTab={activateTab}
        onCloseTab={closeTab}
        onSubmit={submitBrowserInput}
        onBack={() => undefined}
        onForward={() => undefined}
        onReload={() => undefined}
        onOpenExternal={openActiveTabExternally}
      />
    ) : (
      <Suspense fallback={<RightPanelLoadingFallback inline label="Loading diff viewer..." />}>
        <DiffPanel mode="sidebar" />
      </Suspense>
    );

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView key={threadId} threadId={threadId} />
        </SidebarInset>
        <RightPanelInlineSidebar
          panelOpen={selectedPanel !== null}
          onClosePanel={closePanel}
          onReopenPanel={reopenPanel}
        >
          {rightPanelContent}
        </RightPanelInlineSidebar>
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView key={threadId} threadId={threadId} />
      </SidebarInset>
      <RightPanelSheet panelOpen={selectedPanel !== null} onClosePanel={closePanel}>
        {selectedPanel === null ? null : selectedPanel === "browser" ? (
          <BrowserPanel
            state={{
              activeTabId: browserThreadState.activeTabId,
              tabs: browserThreadState.tabs,
            }}
            activeTab={activeBrowserTab}
            inputValue={browserThreadState.inputValue}
            focusRequestId={browserThreadState.focusRequestId}
            newTabShortcutLabel={browserNewTabShortcutLabel}
            closeTabShortcutLabel={browserCloseTabShortcutLabel}
            onInputChange={(value) => {
              updateThreadBrowserState(threadId, (state) =>
                state.inputValue === value ? state : { ...state, inputValue: value },
              );
            }}
            onCreateTab={createTab}
            onActivateTab={activateTab}
            onCloseTab={closeTab}
            onSubmit={submitBrowserInput}
            onBack={() => undefined}
            onForward={() => undefined}
            onReload={() => undefined}
            onOpenExternal={openActiveTabExternally}
          />
        ) : (
          <Suspense
            fallback={<RightPanelLoadingFallback inline={false} label="Loading diff viewer..." />}
          >
            <DiffPanel mode="sheet" />
          </Suspense>
        )}
      </RightPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
