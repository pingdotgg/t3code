import {
  ArrowRightIcon,
  Columns2Icon,
  FolderIcon,
  Globe2Icon,
  LayoutTemplateIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelRightIcon,
} from "lucide-react";
import { memo } from "react";

import { calculatePaneTreeLayout, type PaneTree } from "../../splitPaneTree";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PanelLayoutControlsProps {
  showTerminalControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
  workspaceSplit?: {
    readonly available: boolean;
    readonly shortcutLabel: string | null;
    readonly onSplitRight: () => void;
  };
  workspaceDefaults?: {
    readonly hasGlobalDefault: boolean;
    readonly hasProjectDefault: boolean;
    readonly currentLayout: PaneTree;
    readonly projectTitle: string;
    readonly savedGlobalLayout: PaneTree | null;
    readonly savedProjectLayout: PaneTree | null;
    readonly onSaveGlobal: () => void;
    readonly onSaveProject: () => void;
    readonly onClearGlobal: () => void;
    readonly onClearProject: () => void;
  };
  /** Running + waiting subagents in this thread; badges the right panel toggle. */
  liveAgentCount: number;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}

function WorkspaceLayoutMiniature({ tree }: { readonly tree: PaneTree }) {
  const layout = calculatePaneTreeLayout(tree.root);
  return (
    <div className="relative size-full">
      {layout.groups.map(({ bounds, group }) => (
        <div
          key={group.id}
          className="absolute p-0.5"
          style={{
            top: `${bounds.top * 100}%`,
            left: `${bounds.left * 100}%`,
            width: `${(bounds.right - bounds.left) * 100}%`,
            height: `${(bounds.bottom - bounds.top) * 100}%`,
          }}
        >
          <div className="flex size-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md bg-background shadow-[0_0_0_1px_--theme(--color-foreground/10%),0_1px_2px_--theme(--color-black/5%)] dark:shadow-[0_0_0_1px_--theme(--color-white/10%)]">
            <div className="flex h-3 shrink-0 items-center gap-0.5 bg-muted/70 px-1">
              {group.tabIds.slice(0, 3).map((tabId) => (
                <span
                  key={tabId}
                  className={
                    tabId === group.activeTabId
                      ? "h-1 w-3 rounded-full bg-foreground/45"
                      : "size-1 rounded-full bg-foreground/18"
                  }
                />
              ))}
            </div>
            <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 px-2">
              <span className="h-1 w-3/4 rounded-full bg-foreground/10" />
              <span className="h-1 w-1/2 rounded-full bg-foreground/7" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkspaceLayoutPreviewFrame({
  label,
  tree,
}: {
  readonly label?: string;
  readonly tree: PaneTree;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      {label ? (
        <div className="truncate text-[10px] font-medium text-muted-foreground">{label}</div>
      ) : null}
      <div
        aria-hidden
        className="h-28 rounded-lg bg-muted/45 p-1.5 shadow-[inset_0_0_0_1px_--theme(--color-foreground/8%)] dark:shadow-[inset_0_0_0_1px_--theme(--color-white/8%)]"
      >
        <WorkspaceLayoutMiniature tree={tree} />
      </div>
    </div>
  );
}

function WorkspaceDefaultPreview({
  kind,
  projectTitle,
  savedGlobalLayout,
  savedProjectLayout,
  tree,
}: {
  readonly kind: "global" | "project";
  readonly projectTitle: string;
  readonly savedGlobalLayout: PaneTree | null;
  readonly savedProjectLayout: PaneTree | null;
  readonly tree: PaneTree;
}) {
  const global = kind === "global";
  const Icon = global ? Globe2Icon : FolderIcon;
  const previousLayout = global ? savedGlobalLayout : (savedProjectLayout ?? savedGlobalLayout);
  const previousLabel = global
    ? "Current global"
    : savedProjectLayout
      ? "Current project"
      : "Inherited global";
  return (
    <div
      className={`${previousLayout ? "w-[30rem]" : "w-64"} flex flex-col gap-2.5 p-1.5 text-left`}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-foreground">
            {global ? "Global workspace default" : `Project default · ${projectTitle}`}
          </div>
          <p className="mt-0.5 text-pretty text-[11px] leading-4 text-muted-foreground">
            {global
              ? "Used for every new thread unless that project has its own default."
              : "Used for every new thread in this project and overrides the global default."}
          </p>
        </div>
      </div>
      {previousLayout ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
          <WorkspaceLayoutPreviewFrame label={previousLabel} tree={previousLayout} />
          <ArrowRightIcon className="mt-4 size-3.5 shrink-0 text-muted-foreground" />
          <WorkspaceLayoutPreviewFrame label={global ? "New global" : "New project"} tree={tree} />
        </div>
      ) : (
        <WorkspaceLayoutPreviewFrame tree={tree} />
      )}
      <p className="text-[10px] text-muted-foreground">Existing threads won’t change.</p>
    </div>
  );
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showTerminalControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel = "Right panel is unavailable",
  workspaceSplit,
  workspaceDefaults,
  liveAgentCount,
  onToggleTerminal,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {workspaceSplit ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className="shrink-0 [-webkit-app-region:no-drag]"
                onClick={workspaceSplit.onSplitRight}
                aria-label="Split editor right"
                variant="ghost"
                size="icon-sm"
                disabled={!workspaceSplit.available}
              >
                <Columns2Icon className="size-4" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {workspaceSplit.available
              ? `Split editor right${workspaceSplit.shortcutLabel ? ` (${workspaceSplit.shortcutLabel})` : ""}`
              : "Restore the workspace before splitting"}
          </TooltipPopup>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={rightPanelOpen}
              onPressedChange={onToggleRightPanel}
              aria-label={
                liveAgentCount > 0
                  ? `Toggle right panel, ${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
                  : "Toggle right panel"
              }
              variant="ghost"
              size="sm"
              disabled={!rightPanelAvailable}
            >
              <PanelRightIcon className="size-4" />
              {liveAgentCount > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
                >
                  {liveAgentCount}
                </span>
              ) : null}
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {rightPanelAvailable
              ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}${
                  liveAgentCount > 0
                    ? ` · ${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
                    : ""
                }`
              : rightPanelUnavailableLabel}
          </TooltipPopup>
        </Tooltip>
      )}
      {workspaceDefaults ? (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      className="shrink-0 [-webkit-app-region:no-drag]"
                      aria-label="Workspace defaults"
                      variant="ghost"
                      size="icon-sm"
                    />
                  }
                />
              }
            >
              <LayoutTemplateIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Workspace defaults</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end" className="min-w-56">
            <Tooltip>
              <TooltipTrigger
                delay={0}
                render={
                  <MenuItem onClick={workspaceDefaults.onSaveGlobal}>
                    Save as global default
                  </MenuItem>
                }
              />
              <TooltipPopup
                align="start"
                side="left"
                sideOffset={8}
                variant="glass"
                className="rounded-xl"
              >
                <WorkspaceDefaultPreview
                  kind="global"
                  projectTitle={workspaceDefaults.projectTitle}
                  savedGlobalLayout={workspaceDefaults.savedGlobalLayout}
                  savedProjectLayout={workspaceDefaults.savedProjectLayout}
                  tree={workspaceDefaults.currentLayout}
                />
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                delay={0}
                render={
                  <MenuItem onClick={workspaceDefaults.onSaveProject}>
                    Save for this project
                  </MenuItem>
                }
              />
              <TooltipPopup
                align="start"
                side="left"
                sideOffset={8}
                variant="glass"
                className="rounded-xl"
              >
                <WorkspaceDefaultPreview
                  kind="project"
                  projectTitle={workspaceDefaults.projectTitle}
                  savedGlobalLayout={workspaceDefaults.savedGlobalLayout}
                  savedProjectLayout={workspaceDefaults.savedProjectLayout}
                  tree={workspaceDefaults.currentLayout}
                />
              </TooltipPopup>
            </Tooltip>
            <MenuSeparator />
            <MenuItem
              onClick={workspaceDefaults.onClearProject}
              disabled={!workspaceDefaults.hasProjectDefault}
            >
              Use global default for this project
            </MenuItem>
            <MenuItem
              onClick={workspaceDefaults.onClearGlobal}
              disabled={!workspaceDefaults.hasGlobalDefault}
            >
              Clear global default
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
