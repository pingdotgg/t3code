import type { ProjectId } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useRef, useState, type KeyboardEvent } from "react";
import {
  useBrowserPanelStore,
  selectProjectBrowserState,
  type BrowserTab,
} from "../browserPanelStore";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

interface BrowserPanelProps {
  projectId: ProjectId;
}

function BrowserTabButton({
  tab,
  isActive,
  onSelect,
  onClose,
}: {
  tab: BrowserTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const displayTitle = tab.title || tab.url || "New Tab";
  const shortTitle = displayTitle.length > 24 ? `${displayTitle.slice(0, 24)}...` : displayTitle;

  return (
    <button
      type="button"
      className={cn(
        "flex min-w-0 max-w-[160px] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      onClick={onSelect}
      title={tab.url}
    >
      <span className="min-w-0 truncate">{shortTitle}</span>
      <button
        type="button"
        className="ml-0.5 shrink-0 rounded-sm p-0.5 opacity-60 hover:bg-background/50 hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close tab"
      >
        <XIcon className="size-2.5" />
      </button>
    </button>
  );
}

function BrowserUrlBar({
  url,
  onNavigate,
  onOpenExternal,
  iframeRef,
}: {
  url: string;
  onNavigate: (url: string) => void;
  onOpenExternal: () => void;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}) {
  const [inputValue, setInputValue] = useState(url);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep input in sync when url prop changes (tab switch, programmatic nav)
  const lastUrlRef = useRef(url);
  if (url !== lastUrlRef.current) {
    lastUrlRef.current = url;
    setInputValue(url);
  }

  const handleSubmit = useCallback(() => {
    let normalized = inputValue.trim();
    if (normalized.length === 0) return;
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `http://${normalized}`;
    }
    onNavigate(normalized);
  }, [inputValue, onNavigate]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleRefresh = useCallback(() => {
    const iframe = iframeRef.current;
    if (iframe) {
      iframe.src = iframe.src;
    }
  }, [iframeRef]);

  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <button
        type="button"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={handleRefresh}
        aria-label="Refresh"
      >
        <RefreshCwIcon className="size-3" />
      </button>
      <input
        ref={inputRef}
        type="text"
        className="min-w-0 flex-1 rounded bg-muted/50 px-2 py-0.5 text-xs text-foreground outline-none ring-1 ring-border focus:ring-ring"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleSubmit}
        placeholder="Enter URL..."
        spellCheck={false}
      />
      <button
        type="button"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onOpenExternal}
        aria-label="Open in external browser"
        title="Open in external browser"
      >
        <ExternalLinkIcon className="size-3" />
      </button>
    </div>
  );
}

const BrowserPanel = memo(function BrowserPanel({ projectId }: BrowserPanelProps) {
  const browserState = useBrowserPanelStore((store) =>
    selectProjectBrowserState(store.browserStateByProjectId, projectId),
  );
  const addTab = useBrowserPanelStore((store) => store.addTab);
  const closeTab = useBrowserPanelStore((store) => store.closeTab);
  const setActiveTab = useBrowserPanelStore((store) => store.setActiveTab);
  const navigateTab = useBrowserPanelStore((store) => store.navigateTab);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const activeTab = browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ?? null;

  const handleNavigate = useCallback(
    (url: string) => {
      if (activeTab) {
        navigateTab(projectId, activeTab.id, url);
      } else {
        addTab(projectId, url);
      }
    },
    [activeTab, addTab, navigateTab, projectId],
  );

  const handleOpenExternal = useCallback(() => {
    if (!activeTab) return;
    const api = readNativeApi();
    if (!api) return;
    void api.shell.openExternal(activeTab.url).catch(() => undefined);
  }, [activeTab]);

  if (browserState.tabs.length === 0) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <span className="text-xs font-medium text-muted-foreground">Browser</span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => addTab(projectId, "")}
            aria-label="New tab"
          >
            <PlusIcon className="size-3" />
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <p className="text-sm">No browser tabs open</p>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            onClick={() => addTab(projectId, "")}
          >
            Open a new tab
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 border-b border-border px-1 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {browserState.tabs.map((tab) => (
            <BrowserTabButton
              key={tab.id}
              tab={tab}
              isActive={tab.id === browserState.activeTabId}
              onSelect={() => setActiveTab(projectId, tab.id)}
              onClose={() => closeTab(projectId, tab.id)}
            />
          ))}
        </div>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => addTab(projectId, "")}
          aria-label="New tab"
        >
          <PlusIcon className="size-3" />
        </button>
      </div>

      {/* URL bar */}
      {activeTab && (
        <BrowserUrlBar
          url={activeTab.url}
          onNavigate={handleNavigate}
          onOpenExternal={handleOpenExternal}
          iframeRef={iframeRef}
        />
      )}

      {/* iframe area */}
      <div className="relative min-h-0 flex-1">
        {browserState.tabs.map((tab) => (
          <iframe
            key={tab.id}
            ref={tab.id === browserState.activeTabId ? iframeRef : undefined}
            src={tab.url || undefined}
            title={tab.title || tab.url}
            className={cn(
              "absolute inset-0 h-full w-full border-none bg-white",
              tab.id === browserState.activeTabId ? "block" : "hidden",
            )}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ))}
      </div>
    </div>
  );
});

export default BrowserPanel;
