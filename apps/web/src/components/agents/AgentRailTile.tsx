import { useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarClockIcon,
  ListFilterIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import type { McpGatewayProfile } from "@t3tools/contracts";
import { normalizeAgentTags } from "@t3tools/client-runtime/state/agentIdentity";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentIcon } from "./AgentIcon";

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

/**
 * One agent in the rail: icon over name. Click filters; the details card opens on
 * hover, on keyboard focus (Tab moves into its actions, Escape closes), and on tap.
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
  const lastPointer = useRef("mouse");
  // Escape returns focus to the tile; that focus must not reopen the card.
  const skipFocusOpen = useRef(false);
  const tags = normalizeAgentTags(profile.tags ?? []);
  const model =
    profile.providerLabel && profile.modelLabel
      ? `${profile.providerLabel} · ${profile.modelLabel}`
      : (profile.providerLabel ?? profile.modelLabel);
  const skills = profile.skillIds?.length ?? 0;
  const machines = profile.environmentIds?.length
    ? profile.environmentIds.map((id) => machineLabels.get(id) ?? "Unavailable machine").join(", ")
    : "Any machine";
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key") skipFocusOpen.current = true;
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
            className="agent-tile"
            aria-pressed={selected}
            aria-label={`${profile.name}${activeCount ? `, ${activeCount} active` : ""}`}
            style={{ "--agent-color": color } as CSSProperties}
          />
        }
        onPointerDown={(event) => {
          lastPointer.current = event.pointerType;
        }}
        onKeyDown={() => {
          lastPointer.current = "keyboard";
        }}
        onFocus={(event) => {
          if (skipFocusOpen.current) {
            skipFocusOpen.current = false;
            return;
          }
          if (event.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
        onBlur={() => {
          skipFocusOpen.current = false;
        }}
        onClick={(event) => {
          // The tile filters; the card opens on hover or focus, and on touch the tap opens it instead.
          (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
          if (lastPointer.current === "touch") setOpen((current) => !current);
          else onSelect();
        }}
      >
        <AgentIcon icon={profile.icon} iconId={profile.iconId} />
        <span className="agent-tile-name">{profile.name}</span>
        {activeCount > 0 && (
          <span className="agent-tile-count" aria-hidden="true">
            {activeCount}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        side="right"
        align="start"
        width="sm"
        padding="compact"
        initialFocus={false}
        aria-label={`${profile.name} details`}
      >
        <div className="agent-card" style={{ "--agent-color": color } as CSSProperties}>
          <header>
            <AgentIcon icon={profile.icon} iconId={profile.iconId} />
            <div className="min-w-0">
              <strong>{profile.name}</strong>
              {model && <p className="agent-card-model">{model}</p>}
            </div>
          </header>
          {profile.description && <p>{profile.description}</p>}
          {tags.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="Roles">
              {tags.map((tag) => (
                <li key={tag}>
                  <Badge variant="secondary">{tag}</Badge>
                </li>
              ))}
            </ul>
          )}
          <dl>
            <dt>Skills</dt>
            <dd>
              {skills === 0 ? "None assigned" : `${skills} ${skills === 1 ? "skill" : "skills"}`}
            </dd>
            <dt>Machines</dt>
            <dd>{machines}</dd>
          </dl>
          <div className="grid grid-cols-2 gap-1">
            <Button variant="ghost" size="xs" onClick={run(onSelect)}>
              <ListFilterIcon />
              Show chats
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={actions.editDisabled}
              onClick={run(actions.onEdit)}
            >
              <PencilIcon />
              Edit agent
            </Button>
            {actions.scheduleDisabled !== null && (
              <Button
                variant="ghost"
                size="xs"
                disabled={actions.scheduleDisabled}
                onClick={run(actions.onSchedule)}
              >
                <CalendarClockIcon />
                Schedule task
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              disabled={actions.moveUpDisabled}
              onClick={actions.onMoveUp}
            >
              <ArrowLeftIcon />
              Move up
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={actions.moveDownDisabled}
              onClick={actions.onMoveDown}
            >
              <ArrowRightIcon />
              Move down
            </Button>
            <Button
              variant="ghost-destructive"
              size="xs"
              disabled={actions.editDisabled}
              onClick={run(actions.onDelete)}
            >
              <Trash2Icon />
              Delete agent
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
