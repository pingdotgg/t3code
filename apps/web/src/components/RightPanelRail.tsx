import { msg, useGT, useMessages } from "gt-react";
import { FileDiff, Files, Globe2, MessagesSquare, Smartphone, TerminalSquare } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Kbd } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";

import type { RightPanelRailGroup, RightPanelToolGroup } from "./RightPanelTabs.logic";

export const RIGHT_PANEL_GROUP_LABELS = {
  changes: msg("Changes"),
  browser: msg("Browser"),
  files: msg("Files"),
  reviews: msg("PRs and issues"),
  devices: msg("Devices"),
  threads: msg("Threads"),
  terminal: msg("Terminal"),
} as const satisfies Record<RightPanelRailGroup, unknown>;

const RIGHT_PANEL_GROUP_ICONS = {
  changes: FileDiff,
  browser: Globe2,
  files: Files,
  reviews: PullRequestGlyph.pullRequest,
  devices: Smartphone,
  threads: MessagesSquare,
  terminal: TerminalSquare,
} as const satisfies Record<RightPanelRailGroup, ComponentType<{ className?: string }>>;

export interface RightPanelRailProps {
  groups: readonly RightPanelToolGroup[];
  activeGroup: RightPanelToolGroup | null;
  dots: ReadonlySet<RightPanelRailGroup>;
  /** Why a group with nothing open cannot create a surface here; absent when it can. */
  unavailable: Partial<Record<RightPanelToolGroup, string>>;
  terminalOpen: boolean;
  shortcutLabels: Partial<Record<RightPanelRailGroup, string | undefined>>;
  onSelectGroup: (group: RightPanelToolGroup) => void;
  onToggleTerminal: () => void;
  /** The `rightPanel.new` launcher, anchored at the top of the rail. */
  newMenu: ReactNode;
}

function RailButton(props: {
  group: RightPanelRailGroup;
  pressed: boolean;
  dot: boolean;
  disabledReason: string | undefined;
  shortcutLabel: string | undefined;
  onClick: () => void;
}) {
  const messages = useMessages();
  const Icon = RIGHT_PANEL_GROUP_ICONS[props.group];
  const label = messages(RIGHT_PANEL_GROUP_LABELS[props.group]);
  const disabled = props.disabledReason !== undefined;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-rail-group={props.group}
            aria-label={label}
            aria-pressed={props.pressed}
            aria-disabled={disabled || undefined}
            onClick={disabled ? undefined : props.onClick}
            className={cn(
              "relative flex size-8 shrink-0 items-center justify-center rounded-md",
              disabled
                ? "cursor-not-allowed text-muted-foreground/50"
                : props.pressed
                  ? "cursor-pointer bg-accent text-foreground"
                  : "cursor-pointer text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          />
        }
      >
        <Icon className="size-4" />
        {props.dot && !props.pressed ? (
          <span
            aria-hidden
            data-rail-dot
            className="absolute top-1 right-1 size-[7px] rounded-full bg-primary"
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="left">
        <span className="flex items-center gap-2">
          {disabled ? props.disabledReason : label}
          {!disabled && props.shortcutLabel ? <Kbd>{props.shortcutLabel}</Kbd> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** One icon per tool group on the panel's right edge, and the terminal drawer toggle at its foot. */
export function RightPanelRail(props: RightPanelRailProps) {
  const gt = useGT();
  return (
    <nav
      aria-label={gt("Panel tools")}
      data-right-panel-rail
      className="relative flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border/80 py-1.5"
    >
      {props.newMenu}
      {props.groups.map((group) => (
        <RailButton
          key={group}
          group={group}
          pressed={props.activeGroup === group}
          dot={props.dots.has(group)}
          disabledReason={props.unavailable[group]}
          shortcutLabel={props.shortcutLabels[group]}
          onClick={() => props.onSelectGroup(group)}
        />
      ))}
      <div className="flex-1" />
      <RailButton
        group="terminal"
        pressed={props.terminalOpen}
        dot={props.dots.has("terminal")}
        disabledReason={undefined}
        shortcutLabel={props.shortcutLabels.terminal}
        onClick={props.onToggleTerminal}
      />
    </nav>
  );
}
