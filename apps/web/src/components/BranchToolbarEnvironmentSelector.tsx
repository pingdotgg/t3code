import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { cn } from "../lib/utils";
import { useEnvironments } from "../state/environments";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  /**
   * Offered once the thread is locked to its environment. Picking a device
   * here moves the thread rather than changing where a draft will start, so it
   * is a separate group with its own label instead of a silently different
   * meaning for the same rows.
   */
  onMoveThread?: (environmentId: EnvironmentId) => void;
  /** Where this thread ran before it was moved here. */
  movedFromLabel?: string;
  displayMode?: "toolbar" | "panel";
}

const MOVE_VALUE_PREFIX = "move:";

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onMoveThread,
  movedFromLabel,
  displayMode = "toolbar",
}: BranchToolbarEnvironmentSelectorProps) {
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  // A move only works against a device that is reachable right now and speaks
  // the handoff protocol, so offering the others would only produce a dialog
  // that fails at the first step.
  const { environments } = useEnvironments();
  const moveTargets = useMemo(
    () =>
      availableEnvironments.filter((env) => {
        if (env.environmentId === environmentId) return false;
        const presentation = environments.find(
          (candidate) => candidate.environmentId === env.environmentId,
        );
        return (
          presentation?.connection.phase === "connected" &&
          presentation.serverConfig?.environment.capabilities.threadHandoff === true
        );
      }),
    [availableEnvironments, environmentId, environments],
  );

  const environmentItems = useMemo(
    () => [
      ...availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
      ...(onMoveThread === undefined
        ? []
        : moveTargets.map((env) => ({
            value: `${MOVE_VALUE_PREFIX}${env.environmentId}`,
            label: env.label,
          }))),
    ],
    [availableEnvironments, moveTargets, onMoveThread],
  );

  const handleValueChange = (value: EnvironmentId | null) => {
    if (value === null) return;
    // An environment id could itself start with the prefix, so a value only
    // means "move" when it names one of the offered targets.
    const moved = value.slice(MOVE_VALUE_PREFIX.length) as EnvironmentId;
    if (
      value.startsWith(MOVE_VALUE_PREFIX) &&
      moveTargets.some((env) => env.environmentId === moved)
    ) {
      onMoveThread?.(moved);
      return;
    }
    onEnvironmentChange?.(value);
  };

  // A thread that is locked to its environment can still be moved to another
  // one, so the control stays interactive instead of collapsing to a label —
  // it just offers a different verb.
  if (envLocked && onMoveThread !== undefined) {
    return (
      <Select
        modal={false}
        value={environmentId}
        onValueChange={handleValueChange}
        items={environmentItems}
      >
        <SelectTrigger
          variant="ghost"
          size={displayMode === "panel" ? "default" : "xs"}
          className={cn(
            "min-w-0 max-w-full font-medium",
            displayMode === "panel" && THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
          )}
          aria-label="Run on"
        >
          {activeEnvironment?.isPrimary ? (
            <MonitorIcon
              className={
                displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
              }
            />
          ) : (
            <CloudIcon
              className={
                displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
              }
            />
          )}
          <span
            data-composer-label
            className={cn(
              "min-w-0 max-w-[240px] truncate transition-[max-width,opacity] duration-300 ease-out group-data-[compact]/composer-context:max-w-0 group-data-[compact]/composer-context:opacity-0",
              // Panel rows push their chevron and divider to the right edge,
              // like every other panel row; the label absorbs the slack.
              displayMode === "panel" && "flex-1 text-left",
            )}
          >
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectPopup
          {...(displayMode === "panel"
            ? {
                alignItemWithTrigger: false,
                popupClassName: THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
              }
            : {})}
        >
          <SelectGroup>
            <SelectGroupLabel>
              {movedFromLabel === undefined
                ? "Running on"
                : `Running on · moved from ${movedFromLabel}`}
            </SelectGroupLabel>
            <SelectItem value={environmentId}>
              <span className="inline-flex items-center gap-1.5">
                {activeEnvironment?.isPrimary ? (
                  <MonitorIcon className="size-3" />
                ) : (
                  <CloudIcon className="size-3" />
                )}
                {activeEnvironment?.label ?? "This device"}
              </span>
            </SelectItem>
          </SelectGroup>
          {moveTargets.length === 0 ? null : (
            <SelectGroup>
              <SelectGroupLabel>Move thread to</SelectGroupLabel>
              {moveTargets.map((env) => (
                <SelectItem
                  key={env.environmentId}
                  value={`${MOVE_VALUE_PREFIX}${env.environmentId}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {env.isPrimary ? (
                      <MonitorIcon className="size-3" />
                    ) : (
                      <CloudIcon className="size-3" />
                    )}
                    {env.label}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectPopup>
      </Select>
    );
  }

  if (envLocked || onEnvironmentChange === undefined) {
    return (
      <span
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
      >
        {activeEnvironment?.isPrimary ? (
          <MonitorIcon
            className={
              displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
            }
          />
        ) : (
          <CloudIcon
            className={
              displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
            }
          />
        )}
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] truncate transition-[max-width,opacity] duration-300 ease-out group-data-[compact]/composer-context:max-w-0 group-data-[compact]/composer-context:opacity-0"
        >
          {activeEnvironment?.label ?? "Run on"}
        </span>
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={environmentId}
      onValueChange={handleValueChange}
      items={environmentItems}
    >
      <SelectTrigger
        variant="ghost"
        size={displayMode === "panel" ? "default" : "xs"}
        className={cn(
          "min-w-0 max-w-full font-medium",
          displayMode === "panel" && THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
        )}
        aria-label="Run on"
      >
        {activeEnvironment?.isPrimary ? (
          <MonitorIcon
            className={
              displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
            }
          />
        ) : (
          <CloudIcon
            className={
              displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
            }
          />
        )}
        <span
          data-composer-label
          className={cn(
            "min-w-0 max-w-[240px] truncate transition-[max-width,opacity] duration-300 ease-out group-data-[compact]/composer-context:max-w-0 group-data-[compact]/composer-context:opacity-0",
            // Panel rows push their chevron and divider to the right edge,
            // like every other panel row; the label absorbs the slack.
            displayMode === "panel" && "flex-1 text-left",
          )}
        >
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectPopup
        {...(displayMode === "panel"
          ? {
              alignItemWithTrigger: false,
              popupClassName: THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
            }
          : {})}
      >
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                {env.isPrimary ? (
                  <MonitorIcon className="size-3" />
                ) : (
                  <CloudIcon className="size-3" />
                )}
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
