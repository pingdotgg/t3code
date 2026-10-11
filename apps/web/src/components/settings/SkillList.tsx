import { ChevronRightIcon } from "lucide-react";
import { memo, useState, type MouseEvent } from "react";

import { cn } from "../../lib/utils";
import { GitHubIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsGroup } from "./SettingsGroup";
import { SkillAgents } from "./SkillAgents";
import {
  SOURCE_GROUP_PREVIEW,
  skillAttention,
  skillAvailability,
  type SkillAgent,
  type SkillRow,
  type SkillRowDetails,
} from "./toolsSettings.logic";

/*
 * The Skills list: dense one-line rows grouped by section and by the source a
 * pack was installed from. Adapted from the skills list in #17513.
 */

/** Keeps a click on a control inside a clickable row from also opening the row. */
const stopRowClick = (event: MouseEvent) => event.stopPropagation();

export interface SkillListRow {
  readonly row: SkillRow;
  readonly details: SkillRowDetails;
  /** The skill is off here, by this scope's settings. */
  readonly disabled: boolean;
  /** The project switch differs from the environment's. */
  readonly overridden: boolean;
}

interface RowHandlers {
  readonly agents: ReadonlyArray<SkillAgent>;
  readonly canWrite: boolean;
  readonly onToggle: (rows: ReadonlyArray<SkillRow>, enabled: boolean) => void;
  readonly onOpen: (name: string) => void;
}

const SkillListItem = memo(function SkillListItem({
  item,
  nested,
  agents,
  canWrite,
  onToggle,
  onOpen,
}: RowHandlers & { item: SkillListRow; nested: boolean }) {
  const { row, details, disabled, overridden } = item;
  const lockedOff = row.disabledByProvider;
  const warning = skillAttention(row, details, agents);
  return (
    <li className="min-w-0">
      <div
        onClick={() => onOpen(row.name)}
        className={cn(
          "flex cursor-pointer items-center gap-3 py-2 pr-3 hover:bg-muted/40 sm:pr-4",
          nested ? "pl-9 sm:pl-10" : "pl-3 sm:pl-4",
        )}
      >
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={cn(
              "block truncate text-sm font-medium",
              (disabled || lockedOff) && "text-muted-foreground",
            )}
          >
            {row.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {lockedOff
              ? "Turned off in the agent's own settings."
              : row.description || "No description yet."}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-2">
          {overridden ? (
            <Badge variant="info" size="sm">
              This project
            </Badge>
          ) : null}
          {warning?.kind === "conflict" ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="warning" size="sm">
                  Conflict
                </Badge>
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-sm">
                {warning.detail}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <span className="hidden sm:contents">
            <SkillAgents value={skillAvailability(row, agents)} agents={agents} />
          </span>
          <span className="flex items-center" onClick={stopRowClick}>
            <Switch
              aria-label={`${row.name} skill`}
              checked={!disabled && !lockedOff}
              disabled={!canWrite || lockedOff}
              onCheckedChange={(enabled) => onToggle([row], enabled)}
            />
          </span>
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </span>
      </div>
    </li>
  );
});

/** A pack's heading row and its skills: the first few, and a row that reveals the rest. */
function SourceGroup({
  source,
  items,
  ...handlers
}: RowHandlers & { source: string; items: ReadonlyArray<SkillListRow> }) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const allOff = items.every((item) => item.disabled || item.row.disabledByProvider);
  const shown = showAll ? items : items.slice(0, SOURCE_GROUP_PREVIEW);
  const hidden = items.length - shown.length;
  const github = /^[\w.-]+\/[\w.-]+$/.test(source) || source.includes("github.com");
  return (
    <>
      <li>
        <div
          onClick={() => setOpen((value) => !value)}
          className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/40 sm:px-4"
        >
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
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {github ? (
              <GitHubIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="min-w-0 truncate text-sm font-medium">From {source}</span>
            <Badge variant="secondary" size="sm">
              {items.length}
            </Badge>
          </button>
          <span className="flex items-center" onClick={stopRowClick}>
            <Switch
              aria-label={`Skills from ${source}`}
              checked={!allOff}
              disabled={!handlers.canWrite}
              onCheckedChange={(enabled) =>
                handlers.onToggle(
                  items.map((item) => item.row),
                  enabled,
                )
              }
            />
          </span>
          {/* The width of a row's chevron, so this switch sits over the rows' switches. */}
          <span aria-hidden className="w-4 shrink-0" />
        </div>
      </li>
      {open
        ? shown.map((item) => (
            <SkillListItem key={item.row.name} item={item} nested {...handlers} />
          ))
        : null}
      {open && items.length > SOURCE_GROUP_PREVIEW ? (
        <li className="py-1 pr-3 pl-9 sm:pr-4 sm:pl-10">
          <Button size="xs" variant="ghost-muted" onClick={() => setShowAll((value) => !value)}>
            {hidden > 0 ? `${hidden} more` : "Show fewer"}
          </Button>
        </li>
      ) : null}
    </>
  );
}

/** One section: its name and count, then its packs and loose skills. */
export function SkillListSection({
  title,
  hint,
  total,
  groups,
  emptyText,
  ...handlers
}: RowHandlers & {
  title: string;
  /** A short muted phrase beside the name, in plain words. */
  hint: string;
  /** Every skill in the section before the search narrows it. */
  total: number;
  groups: ReadonlyArray<{
    readonly source: string | null;
    readonly rows: ReadonlyArray<SkillListRow>;
  }>;
  emptyText: string;
}) {
  return (
    <section className="space-y-2.5">
      <h2 className="flex min-h-7 items-baseline gap-2 px-3 text-sm font-normal text-foreground/70 sm:px-4">
        <span className="shrink-0">
          {title} · {total}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{hint}</span>
      </h2>
      <SettingsGroup>
        {groups.length === 0 ? (
          <p className="px-3 py-5 text-sm text-muted-foreground sm:px-4">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {groups.map(({ source, rows }) =>
              source === null ? (
                rows.map((item) => (
                  <SkillListItem key={item.row.name} item={item} nested={false} {...handlers} />
                ))
              ) : (
                <SourceGroup key={`source:${source}`} source={source} items={rows} {...handlers} />
              ),
            )}
          </ul>
        )}
      </SettingsGroup>
    </section>
  );
}
