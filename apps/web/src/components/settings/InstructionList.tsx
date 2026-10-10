import type { ClaudeInstructionValue } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useId, useMemo, useState, type MouseEvent } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SelectButton } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsGroup } from "./SettingsGroup";
import { AgentChip } from "./SkillAgentSwitch";
import { SkillAgents } from "./skillAgentIcon";
import {
  CLAUDE_OPTIONS,
  instructionChips,
  usage,
  usageNote,
  type ClaudeRow,
  type InstructionChip,
  type InstructionData,
  type InstructionItem,
  type InstructionPlan,
  type InstructionRow,
  type NestedFile,
} from "./InstructionsSettings.logic";
import type { SkillAgent, SkillsContext } from "./SkillsSettings.logic";

/** Keeps a click on a control inside a clickable row from also opening or closing the row. */
const stopRowClick = (event: MouseEvent) => event.stopPropagation();

const NO_PERMISSION = "You can't change instructions in this environment.";

const ROW_CLASS = "flex flex-wrap items-center gap-x-2 gap-y-1 py-2 pr-3 pl-3 sm:pr-4 sm:pl-4";

function Chevron({ open, className }: { open?: boolean; className?: string }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
        open && "rotate-90",
        className,
      )}
    />
  );
}

/** The file's path on hover, so the row itself carries none. */
function PathTooltip({ path, children }: { path: string; children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{children}</TooltipTrigger>
      <TooltipPopup>
        <span className="block font-mono break-all">{path}</span>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One agent's switch for a file, in the Global row's panel and under "Used by" in an open file. A
 * chip T3 Code can't switch, or a session that can't change instructions, says why when pointed at.
 */
export function InstructionAgentChip({
  chip,
  agents,
  busy,
  locked,
  onPlan,
}: {
  chip: InstructionChip;
  agents: readonly SkillAgent[];
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  /** The session can't change instructions. */
  locked: boolean;
  onPlan: (plan: InstructionPlan) => void;
}) {
  return (
    <AgentChip
      agent={chip.agent}
      agents={agents}
      on={chip.on}
      blocker={
        chip.locked || locked ? (
          <>
            {chip.lines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
            {locked && <span className="block">{NO_PERMISSION}</span>}
          </>
        ) : null
      }
      disabled={busy}
      onToggle={() => chip.plan && onPlan(chip.plan)}
    />
  );
}

/**
 * One file. Clicking it opens the file, except the Global file, which opens in place into one
 * switch per agent. Its second line is only a problem, with its fix beside the icons; below `sm`
 * the icons and the fix drop under the text, so a long problem doesn't squeeze the title.
 */
const InstructionRowView = memo(function InstructionRowView({
  row,
  ctx,
  data,
  busy,
  locked,
  onOpen,
  onPlan,
}: {
  row: InstructionRow;
  ctx: SkillsContext;
  data: InstructionData;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  /** The session can't change instructions. */
  locked: boolean;
  onOpen: (id: string) => void;
  /** Turns agents on or off, shares or moves a file; a plan with a confirmation asks first. */
  onPlan: (plan: InstructionPlan) => void;
}) {
  const { entry, attention } = row;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const used = useMemo(() => usage(entry, ctx), [entry, ctx]);
  const chips = useMemo(
    () => (row.expandable ? instructionChips(entry, ctx, data) : []),
    [row.expandable, entry, ctx, data],
  );
  const fix = row.missing
    ? { label: "Create", run: () => onOpen(row.id) }
    : attention?.fix
      ? { label: attention.fix.label, run: () => attention.fix && onPlan(attention.fix.plan) }
      : null;
  return (
    <li className={cn("min-w-0", open && "bg-muted/30")}>
      <div
        onClick={() => (row.expandable ? setOpen((value) => !value) : onOpen(row.id))}
        className={cn(ROW_CLASS, "cursor-pointer hover:bg-muted/40")}
      >
        <button
          type="button"
          aria-expanded={row.expandable ? open : undefined}
          aria-controls={row.expandable && open ? panelId : undefined}
          className="min-w-40 flex-1 cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="block truncate text-sm font-medium">
            <PathTooltip path={entry.path}>{row.title}</PathTooltip>
          </span>
          {attention && (
            <span className="block text-xs text-warning-foreground">{attention.detail}</span>
          )}
        </button>
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-2",
            fix && "order-3 max-sm:basis-full max-sm:justify-start sm:order-2",
          )}
        >
          {!row.missing && <SkillAgents value={used} ctx={ctx} label={usageNote(used)} />}
          {fix && (
            <span className="flex items-center" onClick={stopRowClick}>
              <Button size="xs" variant="outline" disabled={busy || locked} onClick={fix.run}>
                {fix.label}
              </Button>
            </span>
          )}
        </span>
        <Chevron open={open} className={cn(fix && "order-2 max-sm:ml-auto sm:order-3")} />
      </div>
      {open && (
        <div
          id={panelId}
          className="flex flex-wrap items-center gap-2 pr-3 pb-3 pl-3 sm:pr-4 sm:pl-4"
        >
          {chips.length === 0 ? (
            <p className="text-xs text-muted-foreground">No agents are installed.</p>
          ) : (
            chips.map((chip) => (
              <InstructionAgentChip
                key={chip.agent.instanceId}
                chip={chip}
                agents={ctx.installed}
                busy={busy}
                locked={locked}
                onPlan={onPlan}
              />
            ))
          )}
          <div className="ml-auto flex gap-2">
            <Button size="xs" variant="outline" onClick={() => onOpen(row.id)}>
              Edit
            </Button>
          </div>
        </div>
      )}
    </li>
  );
});

/** A heading in the card, such as Project or Global. It isn't a control. */
function GroupHeading({ label }: { label: string }) {
  return <li className="bg-muted/40 px-3 pt-2.5 pb-1.5 text-xs font-semibold sm:px-4">{label}</li>;
}

/**
 * The AGENTS.md and CLAUDE.md files below the project's top folder, in one quiet row that opens
 * in place into the list of folders.
 */
const SubfoldersRow = memo(function SubfoldersRow({
  files,
  onOpen,
}: {
  files: readonly NestedFile[];
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <li className={cn("min-w-0", open && "bg-muted/30")}>
      <div
        onClick={() => setOpen((value) => !value)}
        className={cn(ROW_CLASS, "cursor-pointer hover:bg-muted/40")}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          className="flex min-w-40 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate text-sm font-medium">In subfolders</span>
          <Badge variant="secondary" size="sm">
            {files.length}
          </Badge>
        </button>
        <Chevron open={open} />
      </div>
      {open && (
        <ul id={panelId} className="pb-1.5">
          {files.map((file) => (
            <li key={file.id}>
              <button
                type="button"
                onClick={() => onOpen(file.id)}
                className="flex w-full min-w-0 cursor-pointer items-center gap-2 py-1.5 pr-3 pl-6 text-left text-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:pr-4 sm:pl-7"
              >
                <span className="min-w-0 flex-1 truncate">{file.folder || "Top folder"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{file.file}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
});

/** Claude's "Project instructions" choice, which applies in every project. */
function ClaudeChoiceRow({
  row,
  busy,
  locked,
  onChange,
}: {
  row: ClaudeRow;
  busy: boolean;
  locked: boolean;
  onChange: (value: ClaudeInstructionValue) => void;
}) {
  const { control } = row;
  return (
    <li className={ROW_CLASS}>
      <span className="min-w-40 flex-1">
        <span className="block truncate text-sm font-medium">{row.title}</span>
        {row.note !== null && (
          <span className="block text-xs text-muted-foreground">{row.note}</span>
        )}
      </span>
      {control.kind === "text" ? (
        <span className="text-xs text-muted-foreground">{control.text}</span>
      ) : (
        <Menu>
          <MenuTrigger
            aria-label={`${row.title}: ${control.label}`}
            render={<SelectButton size="sm" />}
            className="w-auto min-w-0"
            disabled={busy || locked || control.disabled}
          >
            {control.label}
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuRadioGroup
              value={control.value}
              onValueChange={(value) => onChange(value as ClaudeInstructionValue)}
            >
              {CLAUDE_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} closeOnClick value={option.value}>
                  <span className="block">{option.label}</span>
                  {option.hint && (
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  )}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Applies in every project</p>
          </MenuPopup>
        </Menu>
      )}
      {/* The width of a row's chevron, so the choice lines up with the rows above. */}
      <span aria-hidden className="w-4 shrink-0" />
    </li>
  );
}

/**
 * The Instructions card at the top of the Skills page: the files agents read, with who uses each,
 * under a Project and a Global heading, and Claude's choice on when it reads AGENTS.md.
 */
export function InstructionSection({
  items,
  data,
  ctx,
  busy,
  locked,
  onOpen,
  onPlan,
  onClaudeChange,
}: {
  items: readonly InstructionItem[];
  data: InstructionData;
  ctx: SkillsContext;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  /** The session can't change instructions. */
  locked: boolean;
  onOpen: (id: string) => void;
  onPlan: (plan: InstructionPlan) => void;
  onClaudeChange: (row: ClaudeRow, value: ClaudeInstructionValue) => void;
}) {
  return (
    <section className="space-y-2.5">
      <h2 className="flex min-h-7 items-center px-3 text-sm font-normal text-foreground/70 sm:px-4">
        Instructions
      </h2>
      <SettingsGroup>
        <ul className="divide-y divide-border/50">
          {items.map((item) => {
            switch (item.kind) {
              case "group":
                return <GroupHeading key={`group:${item.group}`} label={item.label} />;
              case "file":
                return (
                  <InstructionRowView
                    key={item.row.id}
                    row={item.row}
                    ctx={ctx}
                    data={data}
                    busy={busy}
                    locked={locked}
                    onOpen={onOpen}
                    onPlan={onPlan}
                  />
                );
              case "subfolders":
                return <SubfoldersRow key="subfolders" files={item.files} onOpen={onOpen} />;
              case "claude":
                return (
                  <ClaudeChoiceRow
                    key={item.row.instanceId}
                    row={item.row}
                    busy={busy}
                    locked={locked}
                    onChange={(value) => onClaudeChange(item.row, value)}
                  />
                );
            }
          })}
        </ul>
      </SettingsGroup>
    </section>
  );
}
