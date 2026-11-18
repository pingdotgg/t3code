import {
  formatAdditionCharacters,
  type AgentAdditionChip,
  type AgentAdditionGroup,
} from "@t3tools/client-runtime/work-log/agent-additions";
import { turnItemHasDetail } from "@t3tools/client-runtime/work-log/item-detail";
import { useGT } from "gt-react";
import { ChevronDownIcon, TextIcon } from "lucide-react";
import { use, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { InlineButton } from "../ui/button";
import type { AgentAdditionEntry } from "./MessagesTimeline.logic";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { V2ItemInspector } from "./V2ItemInspector";
import { WorkLogDetails } from "./WorkLog";

type ChipLabels = Record<AgentAdditionChip["kind"], (value: number) => string>;

const signedCount = (characters: number) =>
  `${characters < 0 ? "−" : characters > 0 ? "+" : ""}${Math.abs(characters).toLocaleString()}`;

/** One closed-by-default panel for adjacent rows that reached, or were kept from, the agent. */
export function AgentAdditionsTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "agent-additions" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const [viewing, setViewing] = useState<ReadonlySet<string>>(() => new Set());
  const chipLabels: ChipLabels = {
    harness: (value) =>
      gt("Claude Code {characters}", { characters: formatAdditionCharacters(value) }),
    t3: (value) => gt("T3 Code {characters}", { characters: formatAdditionCharacters(value) }),
    rules: (value) =>
      gt("Your rules {characters}", { characters: formatAdditionCharacters(value) }),
    held: (value) => gt("{count} held back", { count: value }),
    blocked: (value) => gt("{count} blocked", { count: value }),
    failed: (value) => gt("{count} failed", { count: value }),
  };
  const groupTitles: Record<AgentAdditionGroup, string> = {
    harness: gt("Added by Claude Code"),
    t3: gt("Added by T3 Code"),
    rules: gt("Changed by your rules"),
    held: gt("Held back by your settings"),
    blocked: gt("Blocked"),
  };
  const title = gt("What reached the agent");
  const toggleView = (id: string) =>
    setViewing((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const viewButton = (entry: AgentAdditionEntry) =>
    turnItemHasDetail(entry.item) ? (
      <InlineButton
        tone="muted"
        aria-expanded={viewing.has(entry.item.id)}
        onClick={() => toggleView(entry.item.id)}
      >
        {viewing.has(entry.item.id) ? gt("Hide") : gt("View")}
      </InlineButton>
    ) : null;

  const renderEntry = (entry: AgentAdditionEntry, group: AgentAdditionGroup) => {
    const { item } = entry;
    const warn = group === "blocked" || item.outcome === "failed";
    const signed = group === "rules";
    const lines: ReadonlyArray<{
      readonly label: string;
      readonly note?: string | undefined;
      readonly characters?: number | undefined;
    }> = item.addition.items?.length
      ? item.addition.items
      : [{ label: item.summary, characters: item.addition.characters }];
    return (
      <li key={item.id}>
        {lines.map((line, index) => (
          <AdditionLine
            key={`${line.label}:${line.note}:${line.characters}`}
            label={line.label}
            note={line.note}
            characters={
              line.characters === undefined
                ? undefined
                : signed
                  ? signedCount(line.characters)
                  : line.characters.toLocaleString()
            }
            tone={warn ? "warning" : signed ? "info" : "default"}
            action={index === 0 ? viewButton(entry) : null}
          />
        ))}
        {viewing.has(item.id) && entry.entry.projectedItem ? (
          <WorkLogDetails kind="panel">
            <V2ItemInspector
              projectedItem={entry.entry.projectedItem}
              environmentId={ctx.activeThreadEnvironmentId}
              cwd={ctx.markdownCwd}
              workspaceRoot={ctx.workspaceRoot}
              onOpenToolDiff={ctx.onOpenToolDiff}
              onImageExpand={ctx.onImageExpand}
              source={ctx.turnItemSource}
            />
          </WorkLogDetails>
        ) : null}
      </li>
    );
  };

  return (
    <section className="rounded-lg border border-border" aria-label={title}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
        aria-expanded={row.expanded}
        onClick={() => ctx.onToggleWorkGroup(row.id, row.id)}
      >
        <TextIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
        <span className="shrink-0 text-sm font-medium text-foreground">{title}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {row.summary.chips.map((chip) => (
            <Badge
              key={chip.kind}
              size="sm"
              variant={
                chip.kind === "blocked" || chip.kind === "failed"
                  ? "warning"
                  : chip.kind === "rules"
                    ? "info"
                    : "secondary"
              }
            >
              {chipLabels[chip.kind](chip.value)}
            </Badge>
          ))}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-icon-muted transition-transform duration-200",
            row.expanded && "rotate-180",
          )}
        />
      </button>
      {row.expanded ? (
        <div className="space-y-3 border-t border-border px-3 pt-2 pb-3">
          {row.summary.groups.map(({ group, rows }) => (
            <div key={group}>
              <h4
                className={cn(
                  "mb-1 text-2xs font-medium tracking-wide uppercase",
                  group === "blocked" ? "text-warning" : "text-muted-foreground",
                )}
              >
                {groupTitles[group]}
              </h4>
              <ul className="divide-y divide-border/60">
                {rows.map((entry) => renderEntry(entry, group))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AdditionLine(props: {
  label: string;
  note: string | undefined;
  characters: string | undefined;
  tone: "default" | "info" | "warning";
  action: ReactNode;
}) {
  return (
    <div className="flex min-h-7 min-w-0 items-baseline gap-3 py-1 text-sm">
      <span
        className={cn(
          "min-w-0 flex-1 break-words",
          props.tone === "warning" ? "text-warning" : "text-foreground/85",
        )}
      >
        {props.label}
        {props.note ? <span className="text-muted-foreground"> · {props.note}</span> : null}
      </span>
      <span
        className={cn(
          "w-20 shrink-0 text-right font-mono text-xs tabular-nums",
          props.tone === "info" ? "text-info" : "text-muted-foreground",
        )}
      >
        {props.characters}
      </span>
      <span className="flex w-10 shrink-0 justify-end">{props.action}</span>
    </div>
  );
}
