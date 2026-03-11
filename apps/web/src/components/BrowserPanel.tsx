"use client";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { getBrowserTabLabel, type BrowserTab } from "../browser";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface BrowserPanelProps {
  state: { activeTabId: string | null; tabs: BrowserTab[] };
  activeTab: BrowserTab | null;
  inputValue: string;
  focusRequestId: number;
  newTabShortcutLabel?: string | null;
  closeTabShortcutLabel?: string | null;
  onInputChange: (value: string) => void;
  onCreateTab: () => void;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
  viewportRef?: (el: HTMLDivElement | null) => void;
}

type TabIconProps = {
  tab: BrowserTab;
};

type ToolbarIconButtonProps = {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tooltip: string;
};

const TAB_SCROLLBAR_CLASS = "browser-panel-tab-strip";

const BrowserTabIcon = memo(function BrowserTabIcon({ tab }: TabIconProps) {
  const [faviconFailed, setFaviconFailed] = useState(false);

  useEffect(() => {
    setFaviconFailed(false);
  }, [tab.faviconUrl]);

  if (tab.isLoading) {
    return <RefreshCwIcon className="size-3.5 animate-spin text-muted-foreground/80" />;
  }

  if (tab.faviconUrl && !faviconFailed) {
    return (
      <img
        src={tab.faviconUrl}
        alt=""
        className="size-3.5 rounded-[4px] object-cover"
        onError={() => {
          setFaviconFailed(true);
        }}
      />
    );
  }

  return <GlobeIcon className="size-3.5 text-muted-foreground/80" />;
});

function BrowserTabDivider({ visible }: { visible: boolean }) {
  return (
    <div className="flex w-2 shrink-0 items-center justify-center">
      <div
        className={cn(
          "mb-2.5 h-4 w-px rounded-full bg-border/80 transition-opacity",
          visible ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function ToolbarIconButton({
  ariaLabel,
  children,
  disabled = false,
  onClick,
  tooltip,
}: ToolbarIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="size-7 shrink-0 rounded-md"
              aria-label={ariaLabel}
              disabled={disabled}
              onClick={onClick}
            >
              {children}
            </Button>
          </span>
        }
      />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export default function BrowserPanel({
  state,
  activeTab,
  inputValue,
  focusRequestId,
  newTabShortcutLabel,
  closeTabShortcutLabel,
  onInputChange,
  onCreateTab,
  onActivateTab,
  onCloseTab,
  onSubmit,
  onBack,
  onForward,
  onReload,
  onOpenExternal,
  viewportRef,
}: BrowserPanelProps) {
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useLayoutEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) {
      return;
    }

    const updateOverflow = () => {
      setIsOverflowing(strip.scrollWidth > strip.clientWidth + 1);
    };

    updateOverflow();

    const observer = new ResizeObserver(() => {
      updateOverflow();
    });

    observer.observe(strip);
    return () => {
      observer.disconnect();
    };
  }, [state.tabs.length]);

  useLayoutEffect(() => {
    const strip = tabStripRef.current;
    const activeButton = activeTabRef.current;
    if (!strip || !activeButton) {
      return;
    }

    const stripRect = strip.getBoundingClientRect();
    const activeRect = activeButton.getBoundingClientRect();
    const isFullyVisible = activeRect.left >= stripRect.left && activeRect.right <= stripRect.right;

    if (!isFullyVisible) {
      activeButton.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [state.activeTabId, state.tabs.length]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, [focusRequestId]);

  const closeTooltip = closeTabShortcutLabel ? `Close tab (${closeTabShortcutLabel})` : "Close tab";
  const newTabTooltip = newTabShortcutLabel ? `New tab (${newTabShortcutLabel})` : "New tab";
  const lastError = activeTab?.lastError?.trim() || null;
  const showEmptyState = !activeTab || activeTab.url === "about:blank";
  const topBarClassName = cn(
    "relative flex h-[52px] min-h-[52px] items-end bg-background/70 px-3",
    isElectron && "drag-region",
  );
  const controlsClassName = cn(
    "flex h-full min-w-0 flex-1 items-end pt-2",
    isElectron && "[-webkit-app-region:no-drag]",
  );
  const navRowClassName = cn(
    "flex h-11 min-h-11 items-center gap-1.5 border-border/80 border-b bg-card/94 px-2.5",
    isElectron && "[-webkit-app-region:no-drag]",
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-card text-foreground">
      <div className={topBarClassName}>
        <div aria-hidden className="absolute right-0 bottom-0 left-0 h-px bg-border/90" />
        <div className={controlsClassName}>
          <div className="relative flex min-w-0 flex-1 items-center">
            <div
              ref={tabStripRef}
              className={cn(
                TAB_SCROLLBAR_CLASS,
                "flex min-w-0 flex-1 items-end overflow-x-auto overflow-y-hidden pr-1",
              )}
            >
              {state.tabs.map((tab, index) => {
                const previousTab = index > 0 ? (state.tabs[index - 1] ?? null) : null;
                const isActive = tab.id === state.activeTabId;
                const showDivider =
                  previousTab !== null &&
                  previousTab.id !== state.activeTabId &&
                  tab.id !== state.activeTabId;

                return (
                  <div key={tab.id} className="flex shrink-0 items-end">
                    {index > 0 ? <BrowserTabDivider visible={showDivider} /> : null}
                    <div
                      className={cn(
                        "group relative -mb-px translate-y-px flex h-10 min-w-32 max-w-48 shrink-0 items-center rounded-t-xl border pl-3 pr-2 transition-colors",
                        isActive
                          ? "z-10 border-border border-b-background bg-card text-foreground"
                          : "z-0 border-transparent bg-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <button
                        ref={isActive ? activeTabRef : undefined}
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => {
                          onActivateTab(tab.id);
                        }}
                        title={getBrowserTabLabel(tab)}
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          <BrowserTabIcon tab={tab} />
                        </span>
                        <span className="truncate text-[12px] font-medium">
                          {getBrowserTabLabel(tab)}
                        </span>
                      </button>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="ml-1 size-6 shrink-0 rounded-md opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[active=true]:opacity-100"
                              aria-label={closeTooltip}
                              data-active={isActive}
                              onClick={(event) => {
                                event.stopPropagation();
                                onCloseTab(tab.id);
                              }}
                            >
                              <XIcon className="size-3.5" />
                            </Button>
                          }
                        />
                        <TooltipPopup side="bottom">{closeTooltip}</TooltipPopup>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
              {!isOverflowing ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="ml-2 mb-1.5 shrink-0 self-end rounded-md border border-border/70 bg-background/70"
                        aria-label={newTabTooltip}
                        onClick={onCreateTab}
                      >
                        <PlusIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">{newTabTooltip}</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
            {isOverflowing ? (
              <div className="sticky right-0 ml-2 flex h-10 shrink-0 items-end gap-2 self-end">
                <div className="mb-2.5 h-4 w-px rounded-full bg-border/80" />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="mb-1.5 shrink-0 self-end rounded-md border border-border/70 bg-background/90"
                        aria-label={newTabTooltip}
                        onClick={onCreateTab}
                      >
                        <PlusIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">{newTabTooltip}</TooltipPopup>
                </Tooltip>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <form
        className={navRowClassName}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <ToolbarIconButton
          ariaLabel="Go back"
          disabled={!activeTab?.canGoBack}
          onClick={onBack}
          tooltip="Back"
        >
          <ArrowLeftIcon className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          ariaLabel="Go forward"
          disabled={!activeTab?.canGoForward}
          onClick={onForward}
          tooltip="Forward"
        >
          <ArrowRightIcon className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          ariaLabel="Reload page"
          disabled={!activeTab}
          onClick={onReload}
          tooltip="Reload"
        >
          <RefreshCwIcon className={cn("size-3.5", activeTab?.isLoading ? "animate-spin" : "")} />
        </ToolbarIconButton>
        <div className="min-w-0 flex-1">
          <Input
            ref={inputRef}
            size="sm"
            value={inputValue}
            onChange={(event) => {
              onInputChange(event.target.value);
            }}
            placeholder="http://localhost:3000"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            nativeInput
          />
        </div>
        <ToolbarIconButton
          ariaLabel="Open in browser"
          disabled={!activeTab || activeTab.url === "about:blank"}
          onClick={onOpenExternal}
          tooltip="Open in browser"
        >
          <ExternalLinkIcon className="size-3.5" />
        </ToolbarIconButton>
      </form>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-linear-to-b from-background via-background to-muted/10">
        <div ref={viewportRef} className="absolute inset-0" />
        {showEmptyState ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground/78">
            Enter a URL to preview a local app or external site.
          </div>
        ) : null}
        {lastError ? (
          <div className="pointer-events-none absolute right-4 bottom-4 left-4 rounded-xl border border-red-500/22 bg-red-500/8 px-3 py-2 text-[12px] text-red-700 shadow-lg/10 dark:text-red-300/92">
            {lastError}
          </div>
        ) : null}
      </div>
    </section>
  );
}
