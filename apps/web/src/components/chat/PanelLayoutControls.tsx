import {
  ArrowRightIcon,
  BotIcon,
  Columns2Icon,
  FileDiffIcon,
  FileIcon,
  FilesIcon,
  FolderIcon,
  GitPullRequestArrowIcon,
  GitPullRequestIcon,
  Globe2Icon,
  LayoutTemplateIcon,
  Maximize2Icon,
  MessageSquareTextIcon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelRightIcon,
  SmartphoneIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { memo } from "react";

import type { RightPanelSurface } from "../../rightPanelStore";
import { calculatePaneTreeLayout } from "../../splitPaneTree";
import type { ThreadWorkspaceDefault } from "../../threadWorkspaceDefaults";
import type { ThreadWorkspaceTab } from "../../threadWorkspaceTabs";
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
    readonly canSaveGlobal: boolean;
    readonly canSaveProject: boolean;
    readonly current: ThreadWorkspaceDefault;
    readonly global: ThreadWorkspaceDefault | null;
    readonly project: ThreadWorkspaceDefault | null;
    readonly projectTitle: string;
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

function WorkspaceTabTypeIcon({
  surface,
  tab,
}: {
  readonly surface: RightPanelSurface | null;
  readonly tab: ThreadWorkspaceTab | undefined;
}) {
  if (!tab) return null;
  if (tab._tag === "Thread") return <MessageSquareTextIcon className="size-2.5" />;
  if (!surface) return null;

  switch (surface.kind) {
    case "diff":
      return <FileDiffIcon className="size-2.5" />;
    case "files":
      return <FilesIcon className="size-2.5" />;
    case "file":
      return <FileIcon className="size-2.5" />;
    case "preview":
      return <Globe2Icon className="size-2.5" />;
    case "device":
      return <SmartphoneIcon className="size-2.5" />;
    case "terminal":
      return <TerminalSquareIcon className="size-2.5" />;
    case "pull-request":
      return <GitPullRequestIcon className="size-2.5" />;
    case "pull-requests":
      return <GitPullRequestArrowIcon className="size-2.5" />;
    case "agents":
      return <BotIcon className="size-2.5" />;
  }
}

function WorkspaceMiniatureTab({
  active,
  surface,
  tab,
}: {
  readonly active: boolean;
  readonly surface: RightPanelSurface | null;
  readonly tab: ThreadWorkspaceTab | undefined;
}) {
  return (
    <span
      className={`flex size-3 shrink-0 items-center justify-center rounded-[3px] ${
        active ? "bg-foreground/8 text-foreground/65" : "text-foreground/25"
      }`}
    >
      <WorkspaceTabTypeIcon tab={tab} surface={surface} />
    </span>
  );
}

function workspaceTabSurface(
  tab: ThreadWorkspaceTab | undefined,
  surfacesById: ReadonlyMap<string, RightPanelSurface>,
): RightPanelSurface | null {
  return tab?._tag === "Surface" ? (surfacesById.get(tab.surfaceId) ?? null) : null;
}

function WorkspaceLayoutMiniature({ template }: { readonly template: ThreadWorkspaceDefault }) {
  const layout = calculatePaneTreeLayout(template.layout.paneTree.root);
  const surfacesById = new Map(
    template.rightPanel.surfaces.map((surface) => [surface.id, surface]),
  );
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
            <div className="flex h-4 shrink-0 items-center gap-0.5 overflow-hidden bg-muted/70 px-1">
              {group.tabIds.slice(0, 3).map((tabId) => (
                <WorkspaceMiniatureTab
                  key={tabId}
                  active={tabId === group.activeTabId}
                  tab={template.layout.tabsById[tabId]}
                  surface={workspaceTabSurface(template.layout.tabsById[tabId], surfacesById)}
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
  template,
}: {
  readonly label?: string;
  readonly template: ThreadWorkspaceDefault;
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
        <WorkspaceLayoutMiniature template={template} />
      </div>
    </div>
  );
}

function WorkspaceDefaultPreview({
  current,
  globalDefault,
  kind,
  projectTitle,
  projectDefault,
}: {
  readonly current: ThreadWorkspaceDefault;
  readonly globalDefault: ThreadWorkspaceDefault | null;
  readonly kind: "global" | "project";
  readonly projectTitle: string;
  readonly projectDefault: ThreadWorkspaceDefault | null;
}) {
  const global = kind === "global";
  const Icon = global ? Globe2Icon : FolderIcon;
  const previousDefault = global ? globalDefault : (projectDefault ?? globalDefault);
  const previousLabel = global
    ? "Current global"
    : projectDefault
      ? "Current project"
      : "Inherited global";
  return (
    <div
      className={`${previousDefault ? "w-[30rem]" : "w-64"} flex flex-col gap-2.5 p-1.5 text-left`}
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
      {previousDefault ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
          <WorkspaceLayoutPreviewFrame label={previousLabel} template={previousDefault} />
          <ArrowRightIcon className="mt-4 size-3.5 shrink-0 text-muted-foreground" />
          <WorkspaceLayoutPreviewFrame
            label={global ? "New global" : "New project"}
            template={current}
          />
        </div>
      ) : (
        <WorkspaceLayoutPreviewFrame template={current} />
      )}
      <p className="text-[10px] text-muted-foreground">Existing threads won’t change.</p>
    </div>
  );
}

function WorkspaceDefaultSaveMenuItem({
  current,
  disabled,
  globalDefault,
  kind,
  label,
  onSave,
  projectDefault,
  projectTitle,
}: {
  readonly current: ThreadWorkspaceDefault;
  readonly disabled: boolean;
  readonly globalDefault: ThreadWorkspaceDefault | null;
  readonly kind: "global" | "project";
  readonly label: string;
  readonly onSave: () => void;
  readonly projectDefault: ThreadWorkspaceDefault | null;
  readonly projectTitle: string;
}) {
  if (disabled) return <MenuItem disabled>{label}</MenuItem>;

  return (
    <Tooltip>
      <TooltipTrigger delay={0} render={<MenuItem onClick={onSave}>{label}</MenuItem>} />
      <TooltipPopup align="start" side="left" sideOffset={8} variant="glass" className="rounded-xl">
        <WorkspaceDefaultPreview
          current={current}
          globalDefault={globalDefault}
          kind={kind}
          projectDefault={projectDefault}
          projectTitle={projectTitle}
        />
      </TooltipPopup>
    </Tooltip>
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
            <WorkspaceDefaultSaveMenuItem
              current={workspaceDefaults.current}
              disabled={!workspaceDefaults.canSaveGlobal}
              globalDefault={workspaceDefaults.global}
              kind="global"
              label="Save as global default"
              onSave={workspaceDefaults.onSaveGlobal}
              projectDefault={workspaceDefaults.project}
              projectTitle={workspaceDefaults.projectTitle}
            />
            <WorkspaceDefaultSaveMenuItem
              current={workspaceDefaults.current}
              disabled={!workspaceDefaults.canSaveProject}
              globalDefault={workspaceDefaults.global}
              kind="project"
              label="Save for this project"
              onSave={workspaceDefaults.onSaveProject}
              projectDefault={workspaceDefaults.project}
              projectTitle={workspaceDefaults.projectTitle}
            />
            <MenuSeparator />
            <MenuItem
              onClick={workspaceDefaults.onClearProject}
              disabled={workspaceDefaults.project === null}
            >
              Use global default for this project
            </MenuItem>
            <MenuItem
              onClick={workspaceDefaults.onClearGlobal}
              disabled={workspaceDefaults.global === null}
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
