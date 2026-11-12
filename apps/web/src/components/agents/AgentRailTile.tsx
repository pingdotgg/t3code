import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import type { McpGatewayProfile } from "@t3tools/contracts";
import { normalizeAgentTags } from "@t3tools/client-runtime/state/agentIdentity";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentIcon } from "./AgentIcon";

/** Every rail tile (New, All, each agent, Scheduled) is this exact size, so the column lines up. */
export const agentRailTileClass =
  "relative flex h-16 w-full shrink-0 flex-col items-center justify-center gap-1 rounded-lg px-1 text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 data-popup-open:bg-accent/60 aria-[current]:bg-accent";

/** A tile's body: a 28px icon slot, a one-line label, and the count pinned top-right. */
export function AgentRailTileBody({
  icon,
  label,
  count,
}: {
  icon: ReactNode;
  label: string;
  count: number;
}) {
  return (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center" aria-hidden="true">
        {icon}
      </span>
      <span className="w-full truncate text-center text-xs leading-4">{label}</span>
      {count > 0 && (
        <span
          className="absolute top-1 right-1.5 text-2xs leading-4 tabular-nums text-muted-foreground"
          aria-hidden="true"
        >
          {count}
        </span>
      )}
    </>
  );
}

export interface AgentRailTileActions {
  readonly editDisabled: boolean;
  /** Null where this connection has no scheduled tasks. */
  readonly scheduleDisabled: boolean | null;
  readonly moveUpDisabled: boolean;
  readonly moveDownDisabled: boolean;
  readonly onEdit: () => void;
  readonly onSchedule: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onDelete: () => void;
}

/** Named machines once each; ids this client can't resolve collapse into one count. */
function machineSummary(ids: readonly string[], labels: ReadonlyMap<string, string>): string {
  if (ids.length === 0) return "Any machine";
  const known = [...new Set(ids.flatMap((id) => labels.get(id) ?? []))];
  const unknown = ids.filter((id) => !labels.has(id)).length;
  if (unknown > 0)
    known.push(unknown === 1 ? "1 unavailable machine" : `${unknown} unavailable machines`);
  return known.join(", ");
}

/**
 * One agent in the rail: icon, name, active count. Click or Enter filters; the details card
 * opens on hover, on tap, and on ArrowDown, which focuses its actions. Tab moves tile to tile.
 */
export function AgentRailTile({
  profile,
  color,
  activeCount,
  selected,
  machineLabels,
  onSelect,
  actions,
}: {
  profile: McpGatewayProfile;
  color: string;
  activeCount: number;
  selected: boolean;
  machineLabels: ReadonlyMap<string, string>;
  onSelect: () => void;
  actions: AgentRailTileActions;
}) {
  const [open, setOpen] = useState(false);
  const [openedByKey, setOpenedByKey] = useState(false);
  const lastPointer = useRef("mouse");
  const tags = normalizeAgentTags(profile.tags ?? []);
  const model =
    profile.providerLabel && profile.modelLabel
      ? `${profile.providerLabel} · ${profile.modelLabel}`
      : (profile.providerLabel ?? profile.modelLabel);
  const skills = profile.skillIds?.length ?? 0;
  const machines = machineSummary(profile.environmentIds ?? [], machineLabels);
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const colorStyle = { "--agent-color": color } as CSSProperties;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpenedByKey(false);
        setOpen(next);
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={400}
        closeDelay={120}
        render={
          <button
            type="button"
            className={agentRailTileClass}
            aria-current={selected ? "true" : undefined}
            aria-keyshortcuts="ArrowDown"
            aria-label={`${profile.name}${activeCount ? `, ${activeCount} active` : ""}`}
            style={colorStyle}
          />
        }
        onPointerDown={(event) => {
          lastPointer.current = event.pointerType;
        }}
        onKeyDown={(event) => {
          lastPointer.current = "keyboard";
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpenedByKey(true);
          setOpen(true);
        }}
        onClick={(event) => {
          // The tile filters; the card opens on hover or ArrowDown, and on touch the tap opens it instead.
          (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
          if (lastPointer.current === "touch") setOpen((current) => !current);
          else onSelect();
        }}
      >
        <AgentRailTileBody
          icon={<AgentIcon icon={profile.icon} iconId={profile.iconId} />}
          label={profile.name}
          count={activeCount}
        />
      </PopoverTrigger>
      <PopoverPopup
        side="right"
        align="start"
        width="sm"
        padding="compact"
        initialFocus={openedByKey}
        aria-label={`${profile.name} details`}
      >
        <div className="flex flex-col gap-3 text-xs" style={colorStyle}>
          <header className="flex items-center gap-2">
            <AgentIcon icon={profile.icon} iconId={profile.iconId} />
            <div className="min-w-0">
              <strong className="block text-sm font-semibold wrap-anywhere">{profile.name}</strong>
              {model && (
                <p className="font-mono text-2xs text-muted-foreground wrap-anywhere">{model}</p>
              )}
            </div>
          </header>
          {profile.description && (
            <p className="leading-relaxed text-muted-foreground wrap-anywhere">
              {profile.description}
            </p>
          )}
          {tags.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="Roles">
              {tags.map((tag) => (
                <li key={tag}>
                  <Badge variant="secondary">{tag}</Badge>
                </li>
              ))}
            </ul>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Skills</dt>
            <dd>
              {skills === 0 ? "None assigned" : `${skills} ${skills === 1 ? "skill" : "skills"}`}
            </dd>
            <dt className="text-muted-foreground">Machines</dt>
            <dd className="wrap-anywhere">{machines}</dd>
          </dl>
          <div className="flex flex-col gap-2 border-t pt-3">
            <div className="flex flex-wrap gap-1">
              <Button variant="outline" size="xs" onClick={run(onSelect)}>
                Show chats
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={actions.editDisabled}
                onClick={run(actions.onEdit)}
              >
                Edit
              </Button>
              {actions.scheduleDisabled !== null && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={actions.scheduleDisabled}
                  onClick={run(actions.onSchedule)}
                >
                  Schedule
                </Button>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon-xs" aria-label="Move up" />}
                  disabled={actions.moveUpDisabled}
                  onClick={actions.onMoveUp}
                >
                  <ArrowUpIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Move up</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon-xs" aria-label="Move down" />}
                  disabled={actions.moveDownDisabled}
                  onClick={actions.onMoveDown}
                >
                  <ArrowDownIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Move down</TooltipPopup>
              </Tooltip>
              <Button
                variant="ghost-destructive"
                size="xs"
                className="ms-auto"
                disabled={actions.editDisabled}
                onClick={run(actions.onDelete)}
              >
                <Trash2Icon />
                Delete
              </Button>
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
