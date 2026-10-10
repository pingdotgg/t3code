import { ChevronRightIcon, InfoIcon } from "lucide-react";
import { memo, useId, useMemo, useState, type MouseEvent } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { GitHubIcon } from "../Icons";
import { SettingsGroup } from "./SettingsGroup";
import { AgentSwitchChip } from "./SkillAgentSwitch";
import { SkillAgents } from "./skillAgentIcon";
import { UseInPopover, type PlaceOptions } from "./SkillUseIn";
import {
  GROUP_PREVIEW,
  attention,
  availability,
  checkState,
  groupAvailability,
  groupBySource,
  listSwitchOn,
  planFix,
  planListSwitch,
  planRowSwitch,
  planToggle,
  projectsBadge,
  rowSwitchOn,
  type Skill,
  type SkillGroup,
  type SkillPlan,
  type SkillsContext,
} from "./SkillsSettings.logic";

/** Keeps a click on a control inside a clickable row from also opening or closing the row. */
const stopRowClick = (event: MouseEvent) => event.stopPropagation();

const SkillRow = memo(function SkillRow({
  skill,
  ctx,
  nested = false,
  places,
  selecting,
  selected,
  showFix,
  busy,
  onSelect,
  onPlan,
  onOpen,
}: {
  skill: Skill;
  ctx: SkillsContext;
  places: PlaceOptions;
  /** The row sits under a group's row, so it is indented. */
  nested?: boolean;
  /** Rows have a checkbox instead of a switch, and a click ticks them. */
  selecting: boolean;
  selected: boolean;
  /** Offer the one-click fix for a skill some agent lacks; only the Needs attention list does. */
  showFix: boolean;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  onSelect: (ids: readonly string[], checked: boolean) => void;
  /** Turns agents on or off for skills; a plan with a confirmation asks first. */
  onPlan: (plan: SkillPlan) => void;
  /** Opens the skill itself, with its files. */
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const derived = useMemo(() => {
    const warning = attention(skill, ctx);
    return {
      conflict: warning?.kind === "conflict" ? warning.detail : null,
      fix: showFix && warning?.kind === "missing" ? planFix(skill, ctx) : null,
      availability: availability(skill, ctx),
      on: rowSwitchOn(skill, ctx),
      projects: projectsBadge(skill),
    };
  }, [skill, ctx, showFix]);
  const { fix } = derived;
  const own = useMemo(() => [skill], [skill]);
  const panelId = useId();
  return (
    <li className={cn("min-w-0", selected ? "bg-muted/60" : open && !selecting && "bg-muted/30")}>
      <div
        onClick={() => (selecting ? onSelect([skill.id], !selected) : setOpen((value) => !value))}
        className={cn(
          "flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 py-2 pr-3 hover:bg-muted/40 sm:pr-4",
          nested ? "pl-9 sm:pl-10" : "pl-3 sm:pl-4",
        )}
      >
        {selecting && (
          <span className="flex items-center" onClick={stopRowClick}>
            <Checkbox
              aria-label={`Select ${skill.name}`}
              checked={selected}
              onCheckedChange={(checked) => onSelect([skill.id], checked)}
            />
          </span>
        )}
        <button
          type="button"
          aria-expanded={selecting ? undefined : open}
          aria-controls={open && !selecting ? panelId : undefined}
          className="min-w-40 flex-1 cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="block truncate text-sm font-medium">{skill.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {skill.description || "No description yet."}
          </span>
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {derived.conflict && (
            <Badge variant="warning" size="sm" title={derived.conflict}>
              Conflict
            </Badge>
          )}
          {derived.projects && (
            <Badge variant="outline" size="sm">
              {derived.projects}
            </Badge>
          )}
          <SkillAgents value={derived.availability} ctx={ctx} />
          {!selecting && (
            <>
              <span className="flex items-center gap-2" onClick={stopRowClick}>
                {fix && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onPlan(fix.plan)}
                  >
                    {fix.label}
                  </Button>
                )}
                <Switch
                  aria-label={skill.name}
                  checked={derived.on}
                  disabled={busy || ctx.installed.length === 0}
                  onCheckedChange={() => {
                    const plan = planRowSwitch(skill, ctx);
                    if (plan) onPlan(plan);
                  }}
                />
              </span>
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                  open && "rotate-90",
                )}
              />
            </>
          )}
        </span>
      </div>
      {open && !selecting && (
        <div
          id={panelId}
          className={cn(
            "flex flex-wrap items-center gap-2 pr-3 pb-3 sm:pr-4",
            nested ? "pl-9 sm:pl-10" : "pl-3 sm:pl-4",
          )}
        >
          {ctx.installed.length === 0 ? (
            <p className="text-xs text-muted-foreground">No agents are installed.</p>
          ) : (
            ctx.installed.map((agent) => (
              <AgentSwitchChip
                key={agent.instanceId}
                skill={skill}
                agent={agent}
                ctx={ctx}
                busy={busy}
                onToggle={() => {
                  const plan = planToggle(skill, agent, ctx);
                  if (plan) onPlan(plan);
                }}
              />
            ))
          )}
          <div className="ml-auto flex gap-2">
            <UseInPopover skills={own} places={places} busy={busy} onPlan={onPlan} />
            <Button size="xs" variant="outline" onClick={() => onOpen(skill.id)}>
              Edit skill
            </Button>
          </div>
        </div>
      )}
    </li>
  );
});

/** A group's row and its skills: the first few, and a row that reveals the rest. */
const SkillGroupRows = memo(function SkillGroupRows({
  group,
  ctx,
  places,
  selecting,
  selected,
  showFix,
  busy,
  onSelect,
  onPlan,
  onOpen,
}: {
  group: SkillGroup;
  ctx: SkillsContext;
  places: PlaceOptions;
  selecting: boolean;
  /** The ids of the ticked rows, across the page. */
  selected: ReadonlySet<string>;
  showFix: boolean;
  busy: boolean;
  onSelect: (ids: readonly string[], checked: boolean) => void;
  onPlan: (plan: SkillPlan) => void;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const derived = useMemo(
    () => ({
      on: listSwitchOn(group.skills, ctx),
      availability: groupAvailability(group.skills, ctx),
    }),
    [group.skills, ctx],
  );
  const ids = useMemo(() => group.skills.map((skill) => skill.id), [group.skills]);
  const ticks = selecting ? checkState(ids, selected) : null;
  const shown = showAll ? group.skills : group.skills.slice(0, GROUP_PREVIEW);
  const hidden = group.skills.length - shown.length;
  return (
    <>
      <li className={cn(ticks?.checked && "bg-muted/60")}>
        <div
          onClick={() => setOpen((value) => !value)}
          className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/40 sm:px-4"
        >
          {ticks && (
            <span className="flex items-center" onClick={stopRowClick}>
              <Checkbox
                aria-label={`Select all from ${group.source}`}
                checked={ticks.checked}
                indeterminate={ticks.indeterminate}
                onCheckedChange={(checked) => onSelect(ids, checked)}
              />
            </span>
          )}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <button
            type="button"
            aria-expanded={open}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <GitHubIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm font-medium">From {group.source}</span>
            <Badge variant="secondary" size="sm">
              {group.skills.length}
            </Badge>
          </button>
          <span className="hidden sm:contents">
            <SkillAgents value={derived.availability} ctx={ctx} />
          </span>
          {!selecting && (
            <>
              <span className="flex items-center" onClick={stopRowClick}>
                <Switch
                  aria-label={`All skills from ${group.source}`}
                  checked={derived.on}
                  disabled={busy || ctx.installed.length === 0}
                  onCheckedChange={() => {
                    const plan = planListSwitch(group.skills, ctx);
                    if (plan) onPlan(plan);
                  }}
                />
              </span>
              {/* The width of a row's chevron, so this switch sits over the rows' switches. */}
              <span aria-hidden className="w-4 shrink-0" />
            </>
          )}
        </div>
      </li>
      {open &&
        shown.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            ctx={ctx}
            places={places}
            nested
            selecting={selecting}
            selected={selected.has(skill.id)}
            showFix={showFix}
            busy={busy}
            onSelect={onSelect}
            onPlan={onPlan}
            onOpen={onOpen}
          />
        ))}
      {open && group.skills.length > GROUP_PREVIEW && (
        <li className="py-1 pr-3 pl-9 sm:pr-4 sm:pl-10">
          <Button size="xs" variant="ghost-muted" onClick={() => setShowAll((value) => !value)}>
            {hidden > 0 ? `${hidden} more` : "Show fewer"}
          </Button>
        </li>
      )}
    </>
  );
});

/** Small info button beside the page heading: where project and global skills live. */
export function StandardInfo() {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label="Where skills live" />}
      >
        <InfoIcon />
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <p className="text-xs leading-relaxed">
          Project skills live in the repo, so anyone who clones it gets them. Global skills are
          yours, and work in every project or just the ones you choose.
        </p>
      </PopoverPopup>
    </Popover>
  );
}

export function SkillSection({
  title,
  visible,
  ctx,
  places,
  emptyText,
  flat,
  selecting,
  selected,
  showFix,
  busy,
  onSelect,
  onPlan,
  onOpen,
}: {
  title: string;
  /** The skills that match the search and filters. */
  visible: readonly Skill[];
  ctx: SkillsContext;
  places: PlaceOptions;
  emptyText: string;
  /** List the skills without groups, as a search does. */
  flat: boolean;
  selecting: boolean;
  /** The ids of the ticked rows, across both sections. */
  selected: ReadonlySet<string>;
  showFix: boolean;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  onSelect: (ids: readonly string[], checked: boolean) => void;
  onPlan: (plan: SkillPlan) => void;
  onOpen: (id: string) => void;
}) {
  const on = useMemo(() => listSwitchOn(visible, ctx), [visible, ctx]);
  const { groups, loose } = useMemo(
    () => (flat ? { groups: [], loose: visible } : groupBySource(visible)),
    [visible, flat],
  );
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 items-center gap-2 px-3 sm:px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-normal text-foreground/70">{title}</h2>
        {!selecting && (
          <>
            <Switch
              aria-label={`All skills in ${title}`}
              checked={on}
              disabled={busy || visible.length === 0 || ctx.installed.length === 0}
              onCheckedChange={() => {
                const plan = planListSwitch(visible, ctx);
                if (plan) onPlan(plan);
              }}
            />
            {/* The width of a row's chevron, so this switch sits over the rows' switches. */}
            <span aria-hidden className="w-4 shrink-0" />
          </>
        )}
      </div>
      <SettingsGroup>
        {visible.length === 0 ? (
          <p className="px-3 py-5 text-sm text-muted-foreground sm:px-4">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {groups.map((group) => (
              <SkillGroupRows
                key={group.source}
                group={group}
                ctx={ctx}
                places={places}
                selecting={selecting}
                selected={selected}
                showFix={showFix}
                busy={busy}
                onSelect={onSelect}
                onPlan={onPlan}
                onOpen={onOpen}
              />
            ))}
            {loose.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                ctx={ctx}
                places={places}
                selecting={selecting}
                selected={selected.has(skill.id)}
                showFix={showFix}
                busy={busy}
                onSelect={onSelect}
                onPlan={onPlan}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
      </SettingsGroup>
    </section>
  );
}
