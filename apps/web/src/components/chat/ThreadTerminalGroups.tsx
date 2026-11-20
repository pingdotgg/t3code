import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import type { TerminalSummary } from "@t3tools/contracts";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabelsCopy";
import { useGT, useMessages } from "gt-react";
import { Bot, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import {
  groupThreadTerminals,
  terminalFailed,
  terminalGroupLabel,
  terminalStatusLabel,
} from "./terminalGroups.logic";

function TerminalGroup({
  group,
  terminals,
  failedCount,
  onOpenTerminal,
}: {
  group: "running" | "settled";
  terminals: ReadonlyArray<TerminalSummary>;
  failedCount: number;
  onOpenTerminal: (terminalId: string) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-2xs text-muted-foreground hover:bg-accent/60"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3 shrink-0", open && "rotate-90")}
        />
        {group === "running" && (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-info" />
        )}
        {terminalGroupLabel(group, terminals.length, messages)}
        {failedCount > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />
            <span className="sr-only">,</span>
            {gt("{count} failed", { count: failedCount, $context: "number of failed terminals" })}
          </>
        )}
      </button>
      {open && (
        <ul aria-label={group === "running" ? gt("Running terminals") : gt("Settled terminals")}>
          {terminals.map((terminal) => {
            const failed = terminalFailed(terminal);
            return (
              <li key={terminal.terminalId}>
                <button
                  type="button"
                  onClick={() => onOpenTerminal(terminal.terminalId)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent",
                    failed && "bg-destructive/8",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      group === "running"
                        ? "bg-info"
                        : failed
                          ? "bg-destructive"
                          : "bg-muted-foreground/50",
                    )}
                  />
                  {terminal.controller === "agent" && (
                    <Bot aria-label={gt("Agent has control")} className="size-3 shrink-0" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      group === "settled" ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {resolveTerminalSessionLabel(terminal.terminalId, terminal, messages)}
                  </span>
                  <span className="shrink-0 text-3xs uppercase tracking-wide text-muted-foreground">
                    {terminalStatusLabel(terminal, messages)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Running and settled terminals collapse into separate groups so the composer keeps its space. */
export function ThreadTerminalGroups({
  sessions,
  onOpenTerminal,
}: {
  sessions: ReadonlyArray<KnownTerminalSession>;
  onOpenTerminal: (terminalId: string) => void;
}) {
  const summaries = sessions.flatMap((session) =>
    session.state.summary ? [session.state.summary] : [],
  );
  const { running, settled, failedCount } = groupThreadTerminals(summaries);
  if (running.length === 0 && settled.length === 0) return null;
  return (
    <div className="mb-1.5 max-h-48 overflow-y-auto rounded-lg border border-border/70 bg-card p-1 shadow-xs">
      {running.length > 0 && (
        <TerminalGroup
          group="running"
          terminals={running}
          failedCount={0}
          onOpenTerminal={onOpenTerminal}
        />
      )}
      {settled.length > 0 && (
        <TerminalGroup
          group="settled"
          terminals={settled}
          failedCount={failedCount}
          onOpenTerminal={onOpenTerminal}
        />
      )}
    </div>
  );
}
