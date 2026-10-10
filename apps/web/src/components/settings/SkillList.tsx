import { InfoIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsGroup } from "./SettingsGroup";
import { SkillAgents } from "./skillAgentIcon";
import { attention, type Skill, type SkillsContext } from "./SkillsSettings.logic";

function SkillRow({
  skill,
  ctx,
  onOpen,
}: {
  skill: Skill;
  ctx: SkillsContext;
  onOpen: () => void;
}) {
  const warning = attention(skill, ctx);
  return (
    <li className="min-w-0 hover:bg-muted/40">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 cursor-pointer items-center gap-3 py-2 pr-3 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:pr-4 sm:pl-4"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{skill.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {skill.description || "No description yet."}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {warning?.kind === "conflict" && (
            <Badge variant="warning" size="sm" title={warning.detail}>
              Conflict
            </Badge>
          )}
          <SkillAgents skill={skill} ctx={ctx} />
        </span>
      </button>
    </li>
  );
}

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
          yours and work in all your projects.
        </p>
      </PopoverPopup>
    </Popover>
  );
}

export function SkillSection({
  title,
  hint,
  detail,
  folder,
  all,
  visible,
  ctx,
  emptyText,
  onOpen,
}: {
  title: string;
  /** A short muted phrase beside the name, in plain words. */
  hint: string;
  /** What the tooltip on the name adds, before the folder. */
  detail?: string;
  /** The section's folder, shown in a tooltip on its name. */
  folder: string;
  /** Every skill in the section, before search narrows it. */
  all: readonly Skill[];
  /** The skills that match the search and filters. */
  visible: readonly Skill[];
  ctx: SkillsContext;
  emptyText: string;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 items-center gap-2 px-3 sm:px-4">
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-normal text-foreground/70">
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} className="shrink-0 cursor-default" />}>
              {title} · {all.length}
            </TooltipTrigger>
            <TooltipPopup>
              {detail && <span className="block">{detail}</span>}
              <span className="block font-mono">{folder}</span>
            </TooltipPopup>
          </Tooltip>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{hint}</span>
        </h2>
      </div>
      <SettingsGroup>
        {visible.length === 0 ? (
          <p className="px-3 py-5 text-sm text-muted-foreground sm:px-4">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {visible.map((skill) => (
              <SkillRow key={skill.id} skill={skill} ctx={ctx} onOpen={() => onOpen(skill.id)} />
            ))}
          </ul>
        )}
      </SettingsGroup>
    </section>
  );
}
