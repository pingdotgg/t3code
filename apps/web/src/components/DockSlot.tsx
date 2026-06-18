import {
  IconBrowser,
  IconFolder,
  IconGitCompare,
  IconListCheck,
  IconMessage,
  IconPlus,
  IconTerminal2,
  IconX,
} from "@tabler/icons-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { isElectron } from "../env";
import type { PanelContentKind, PanelSlot, PanelTab } from "../panelLayoutStore";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface KindMeta {
  label: string;
  description: string;
  Icon: (props: { className?: string }) => ReactNode;
  disabled?: boolean;
}

const KIND_META: Record<PanelContentKind, KindMeta> = {
  terminal: {
    label: "Terminal",
    description: "Start an interactive shell",
    Icon: (props) => <IconTerminal2 {...props} />,
  },
  browser: {
    label: "Browser",
    description: "Preview a local web app",
    Icon: (props) => <IconBrowser {...props} />,
  },
  diff: {
    label: "Diff",
    description: "View code changes",
    Icon: (props) => <IconGitCompare {...props} />,
  },
  tasks: {
    label: "Tasks",
    description: "Plan and live task steps",
    Icon: (props) => <IconListCheck {...props} />,
  },
  chat: {
    label: "Side chat",
    description: "Start a side conversation",
    Icon: (props) => <IconMessage {...props} />,
    disabled: true,
  },
  files: {
    label: "Files",
    description: "Browse project files",
    Icon: (props) => <IconFolder {...props} />,
    disabled: true,
  },
};

// Order shown in the launcher and the (+) add menu.
const KIND_ORDER: ReadonlyArray<PanelContentKind> = [
  "terminal",
  "browser",
  "diff",
  "tasks",
  "chat",
  "files",
];

// Kinds limited to one tab per slot; adding again just refocuses the existing
// tab, so they are hidden from the add menu once present.
const SINGLETON_KINDS: ReadonlySet<PanelContentKind> = new Set(["browser", "diff", "tasks"]);

function tabTitle(tab: PanelTab, terminalLabel?: string): string {
  if (tab.kind === "terminal") {
    return terminalLabel ?? "Terminal";
  }
  return KIND_META[tab.kind].label;
}

/**
 * Generic tabbed dock container hosted inside a react-resizable-panels Panel.
 * Shows a tab bar with a (+) add-content dropdown and a panel close button. An
 * empty slot renders a launcher of content kinds. Each tab's body is rendered
 * (kept mounted) by `renderTab`; only the active tab is visible.
 *
 * `tabBarTrailing` renders extra controls at the right end of the tab bar
 * (e.g. the dock panel toggles, so the right slot's tab bar reads as the
 * panel's own top bar with the toggles attached).
 */
export function DockSlot(props: {
  slot: PanelSlot;
  tabs: ReadonlyArray<PanelTab>;
  activeTabId: string;
  terminalLabelByTabId?: ReadonlyMap<string, string>;
  isKindAvailable: (kind: PanelContentKind) => boolean;
  onAddTab: (kind: PanelContentKind) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onClose: () => void;
  renderTab: (tab: PanelTab, visible: boolean) => ReactNode;
  hideTabBar?: boolean;
  reserveToggleSpace?: boolean;
  reserveLeadingInset?: boolean;
}) {
  const {
    slot,
    tabs,
    activeTabId,
    terminalLabelByTabId,
    isKindAvailable,
    onAddTab,
    onSelectTab,
    onCloseTab,
    onClose,
    renderTab,
    hideTabBar,
    reserveToggleSpace,
    reserveLeadingInset,
  } = props;

  if (tabs.length === 0) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
        {hideTabBar ? null : (
          <DockSlotTabBar
            slot={slot}
            tabs={tabs}
            activeTabId={activeTabId}
            terminalLabelByTabId={terminalLabelByTabId}
            isKindAvailable={isKindAvailable}
            onAddTab={onAddTab}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onClose={onClose}
            reserveToggleSpace={reserveToggleSpace}
            reserveLeadingInset={reserveLeadingInset}
          />
        )}
        <DockLauncher isKindAvailable={isKindAvailable} onAddTab={onAddTab} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {hideTabBar ? null : (
        <DockSlotTabBar
          slot={slot}
          tabs={tabs}
          activeTabId={activeTabId}
          terminalLabelByTabId={terminalLabelByTabId}
          isKindAvailable={isKindAvailable}
          onAddTab={onAddTab}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onClose={onClose}
          reserveToggleSpace={reserveToggleSpace}
          reserveLeadingInset={reserveLeadingInset}
        />
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "absolute inset-0 flex min-h-0 min-w-0 flex-col",
              tab.id === activeTabId ? "" : "hidden",
            )}
          >
            {renderTab(tab, tab.id === activeTabId)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The dock slot's tab bar row: rounded-button tab chips, the (+) add menu, and
 * (via `trailing`) extra controls at the right end such as the dock toggles.
 * Rendered as the top row of the slot's panel.
 */
export function DockSlotTabBar(props: {
  slot: PanelSlot;
  tabs: ReadonlyArray<PanelTab>;
  activeTabId: string;
  terminalLabelByTabId?: ReadonlyMap<string, string> | undefined;
  isKindAvailable: (kind: PanelContentKind) => boolean;
  onAddTab: (kind: PanelContentKind) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onClose: () => void;
  trailing?: ReactNode;
  /** Bare mode: no own height/border/padding or close button, for header use. */
  bare?: boolean;
  /**
   * Reserve right padding for externally-positioned controls (the fixed dock
   * toggles) and hide the slot's own close button, since the toggle closes it.
   */
  reserveToggleSpace?: boolean | undefined;
  /**
   * Reserve left padding to clear the fixed project-sidebar toggle, used when
   * the dock is expanded to full width and its tab bar reaches the app's left
   * edge.
   */
  reserveLeadingInset?: boolean | undefined;
}) {
  const {
    slot,
    tabs,
    activeTabId,
    terminalLabelByTabId,
    isKindAvailable,
    onAddTab,
    onSelectTab,
    onCloseTab,
    onClose,
    trailing,
    bare,
    reserveToggleSpace,
    reserveLeadingInset,
  } = props;
  const useDragRegion = !bare && isElectron && slot === "right";

  const addMenu = (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="no-drag-region inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring" />
          }
        >
          <IconPlus className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New tab</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="bottom" className="min-w-44">
        {KIND_ORDER.map((kind) => {
          const meta = KIND_META[kind];
          // Diff is a singleton per slot — hide it from the add menu once the
          // slot already has a diff tab (adding again would just refocus it).
          if (SINGLETON_KINDS.has(kind) && tabs.some((tab) => tab.kind === kind)) {
            return null;
          }
          const disabled = meta.disabled || !isKindAvailable(kind);
          return (
            <MenuItem key={kind} disabled={disabled} onClick={() => onAddTab(kind)}>
              <meta.Icon className="size-4" />
              <span>{meta.label}</span>
              {meta.disabled ? (
                <span className="ml-auto text-[10px] text-muted-foreground/60">Soon</span>
              ) : null}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );

  const closeButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Close panel"
            className="no-drag-region inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onClose}
          >
            <IconX className="size-4" />
          </button>
        }
      />
      <TooltipPopup side="bottom">Close panel</TooltipPopup>
    </Tooltip>
  );

  return (
    <div
      className={cn(
        "flex items-center gap-1",
        bare ? "min-w-0 flex-1" : "h-11 shrink-0 border-b border-border px-2",
        reserveToggleSpace && "pr-16",
        reserveLeadingInset && "pl-12",
        useDragRegion &&
          "drag-region wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+0.5rem)]",
      )}
    >
      <div className="no-drag-region flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const meta = KIND_META[tab.kind];
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={cn(
                "group/dock-tab flex min-w-0 max-w-44 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                isActive
                  ? "border-border bg-foreground/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <button
                type="button"
                aria-label={`Close ${tabTitle(tab, terminalLabelByTabId?.get(tab.id))}`}
                className="relative inline-flex size-3.5 shrink-0 items-center justify-center"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <meta.Icon className="size-3.5 shrink-0 transition-opacity group-hover/dock-tab:opacity-0" />
                <IconX className="absolute inset-0 m-auto size-3.5 opacity-0 transition-opacity hover:text-foreground group-hover/dock-tab:opacity-100" />
              </button>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => onSelectTab(tab.id)}
              >
                {tabTitle(tab, terminalLabelByTabId?.get(tab.id))}
              </button>
            </div>
          );
        })}
        <div className="no-drag-region flex items-center">{addMenu}</div>
      </div>
      <div className="no-drag-region flex shrink-0 items-center gap-1">
        {trailing}
        {bare || reserveToggleSpace ? null : closeButton}
      </div>
    </div>
  );
}

function DockLauncher(props: {
  isKindAvailable: (kind: PanelContentKind) => boolean;
  onAddTab: (kind: PanelContentKind) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <div className="grid w-full max-w-xs grid-cols-1 gap-2">
        {KIND_ORDER.map((kind) => {
          const meta = KIND_META[kind];
          const disabled = meta.disabled || !props.isKindAvailable(kind);
          return (
            <button
              key={kind}
              type="button"
              disabled={disabled}
              className={cn(
                "flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3 text-left transition-colors",
                disabled
                  ? "cursor-not-allowed opacity-40"
                  : "hover:border-border hover:bg-accent/40",
              )}
              onClick={() => {
                if (disabled) return;
                props.onAddTab(kind);
              }}
            >
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/50 text-foreground/80">
                <meta.Icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  {meta.label}
                  {meta.disabled ? (
                    <span className="rounded-full bg-muted/60 px-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                      Soon
                    </span>
                  ) : null}
                </span>
                <span className="truncate text-xs text-muted-foreground/70">
                  {meta.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
