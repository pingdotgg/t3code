import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";

import ChatView from "../components/ChatView";
import { useComposerDraftStore } from "../composerDraftStore";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import {
  parseBrowserRouteSearch,
  saveBrowserOpenState,
  stripBrowserSearchParams,
} from "../browserRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useStore } from "../store";
import { readBrowserUrl } from "../components/BrowserPanel";
import ScopedTerminalDrawer from "../components/ScopedTerminalDrawer";
import { detectDevServerUrl, setDetectedBrowserUrl } from "../lib/devServerDetection";
import { readNativeApi } from "../nativeApi";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const BrowserPanel = lazy(() => import("../components/BrowserPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const BROWSER_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_browser_sidebar_width";
const BROWSER_INLINE_DEFAULT_WIDTH = "clamp(24rem,40vw,40rem)";
const BROWSER_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;

const DiffPanelSheet = (props: {
  children: ReactNode;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  return (
    <Sheet
      open={props.diffOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseDiff();
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

const DiffLoadingFallback = (props: { inline: boolean }) => {
  if (props.inline) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
        Loading diff viewer...
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[560px] shrink-0 items-center justify-center border-l border-border bg-card px-4 text-center text-xs text-muted-foreground/70">
      Loading diff viewer...
    </aside>
  );
};

const BrowserLoadingFallback = (props: { inline: boolean }) => {
  if (props.inline) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
        Loading browser...
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[560px] shrink-0 items-center justify-center border-l border-border bg-card px-4 text-center text-xs text-muted-foreground/70">
      Loading browser...
    </aside>
  );
};

const BrowserPanelSheet = (props: {
  children: ReactNode;
  browserOpen: boolean;
  onCloseBrowser: () => void;
  projectId?: string | undefined;
}) => {
  return (
    <Sheet
      open={props.browserOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseBrowser();
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

const BrowserPanelInlineSidebar = (props: {
  browserOpen: boolean;
  onCloseBrowser: () => void;
  onOpenBrowser: () => void;
  projectId?: string | undefined;
}) => {
  const { browserOpen, onCloseBrowser, onOpenBrowser, projectId } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenBrowser();
        return;
      }
      onCloseBrowser();
    },
    [onCloseBrowser, onOpenBrowser],
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
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={browserOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": BROWSER_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: BROWSER_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: BROWSER_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <Suspense fallback={<BrowserLoadingFallback inline />}>
          <BrowserPanel mode="sidebar" projectId={projectId} />
        </Suspense>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

const DiffPanelInlineSidebar = (props: {
  diffOpen: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
}) => {
  const { diffOpen, onCloseDiff, onOpenDiff } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      onCloseDiff();
    },
    [onCloseDiff, onOpenDiff],
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
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={diffOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <Suspense fallback={<DiffLoadingFallback inline />}>
          <DiffPanel mode="sidebar" />
        </Suspense>
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
  const draftThreadExists = useComposerDraftStore(
    (store) => Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );

  // Project terminal: persists across thread switches within the same project
  const serverProjectId = useStore(
    (store) => store.threads.find((t) => t.id === threadId)?.projectId ?? null,
  );
  const draftProjectId = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId]?.projectId ?? null,
  );
  const projectId = serverProjectId ?? draftProjectId;
  const activeProjectCwd = useStore(
    (store) => (projectId ? (store.projects.find((p) => p.id === projectId)?.cwd ?? null) : null),
  );
  const projectTerminalThreadId = useMemo(
    () => (projectId !== null ? (`project:${String(projectId)}` as ThreadId) : null),
    [projectId],
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const diffOpen = search.diff === "1";
  const browserOpen = search.browser === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        return stripDiffSearchParams(previous);
      },
    });
  }, [navigate, threadId]);
  const openDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [navigate, threadId]);
  const closeBrowser = useCallback(() => {
    saveBrowserOpenState(false);
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        return stripBrowserSearchParams(previous);
      },
    });
  }, [navigate, threadId]);
  const openBrowser = useCallback(() => {
    saveBrowserOpenState(true);
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        const rest = stripBrowserSearchParams(previous);
        return { ...rest, browser: "1" };
      },
    });
  }, [navigate, threadId]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [navigate, routeThreadExists, threadsHydrated, threadId]);

  // Auto-detect dev server URLs from terminal output and set the browser URL
  const openBrowserRef = useRef(openBrowser);
  openBrowserRef.current = openBrowser;
  const browserOpenRef = useRef(browserOpen);
  browserOpenRef.current = browserOpen;

  useEffect(() => {
    if (!projectId) return;
    const api = readNativeApi();
    if (!api) return;

    const unsubscribe = api.terminal.onEvent((event) => {
      // Match events from either the thread terminal or the project terminal
      if (event.threadId !== threadId && event.threadId !== projectTerminalThreadId) return;
      if (event.type !== "output") return;
      const url = detectDevServerUrl(event.data);
      if (!url) return;
      // Skip if this exact URL is already set for the project
      const current = readBrowserUrl(projectId);
      if (current === url) return;
      setDetectedBrowserUrl(projectId, url);
      if (!browserOpenRef.current) {
        openBrowserRef.current();
      }
    });
    return unsubscribe;
  }, [threadId, projectId, projectTerminalThreadId]);

  // When a localhost URL is Cmd/Ctrl+clicked in the terminal, open it in the browser panel
  useEffect(() => {
    if (!projectId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ url: string; threadId: string }>).detail;
      // Match clicks from either the thread terminal or the project terminal
      if (detail.threadId !== threadId && detail.threadId !== projectTerminalThreadId) return;
      setDetectedBrowserUrl(projectId, detail.url);
      if (!browserOpenRef.current) {
        openBrowserRef.current();
      }
    };
    window.addEventListener("t3code:terminal-localhost-link", handler);
    return () => window.removeEventListener("t3code:terminal-localhost-link", handler);
  }, [threadId, projectId, projectTerminalThreadId]);

  if (!threadsHydrated || !routeThreadExists) {
    return null;
  }

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView key={threadId} threadId={threadId} />
          {projectTerminalThreadId && activeProjectCwd && (
            <ScopedTerminalDrawer
              key={`project-terminal-${String(projectId)}`}
              threadId={projectTerminalThreadId}
              cwd={activeProjectCwd}
              label="Project"
            />
          )}
        </SidebarInset>
        <DiffPanelInlineSidebar diffOpen={diffOpen} onCloseDiff={closeDiff} onOpenDiff={openDiff} />
        <BrowserPanelInlineSidebar
          browserOpen={browserOpen}
          onCloseBrowser={closeBrowser}
          onOpenBrowser={openBrowser}
          projectId={projectId ?? undefined}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView key={threadId} threadId={threadId} />
        {projectTerminalThreadId && activeProjectCwd && (
          <ScopedTerminalDrawer
            key={`project-terminal-${String(projectId)}`}
            threadId={projectTerminalThreadId}
            cwd={activeProjectCwd}
          />
        )}
      </SidebarInset>
      <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeDiff}>
        <Suspense fallback={<DiffLoadingFallback inline={false} />}>
          <DiffPanel mode="sheet" />
        </Suspense>
      </DiffPanelSheet>
      <BrowserPanelSheet browserOpen={browserOpen} onCloseBrowser={closeBrowser} projectId={projectId ?? undefined}>
        <Suspense fallback={<BrowserLoadingFallback inline={false} />}>
          <BrowserPanel mode="sheet" projectId={projectId ?? undefined} />
        </Suspense>
      </BrowserPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => ({
    ...parseDiffRouteSearch(search),
    ...parseBrowserRouteSearch(search),
  }),
  component: ChatThreadRouteView,
});
