import type {
  ElectronicsValidationIssue,
  ElectronicsValidationReport,
  ElectronicsValidationSeverity,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  InfoIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";

export interface ValidationPanelProps {
  readonly report: ElectronicsValidationReport | null;
  readonly running: boolean;
  readonly onRunValidate: () => void;
  readonly onFocusIssue: (issue: ElectronicsValidationIssue) => void;
}

export function ValidationPanel(props: ValidationPanelProps) {
  const { report, running, onRunValidate, onFocusIssue } = props;
  const gt = useGT();
  const [filter, setFilter] = useState<"all" | ElectronicsValidationSeverity>("all");

  const filteredIssues = !report
    ? []
    : filter === "all"
      ? report.issues
      : report.issues.filter((i) => i.severity === filter);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {report ? (
            <>
              {report.passed ? (
                <span className="flex items-center gap-1 font-medium text-success">
                  <CheckCircle2Icon className="size-4" />
                  <T>All error checks passed</T>
                </span>
              ) : (
                <span className="flex items-center gap-1 font-medium text-destructive">
                  <AlertCircleIcon className="size-4" />
                  {gt("{count} error(s) found", { count: report.errorCount })}
                </span>
              )}
              <span className="text-muted-foreground">
                · {gt("{count} warnings", { count: report.warningCount })} ·{" "}
                {gt("{count} info", { count: report.infoCount })}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              <T>Run ERC/DRC and static circuit validation to inspect electrical rules.</T>
            </span>
          )}
        </div>

        <Button size="xs" disabled={running} onClick={onRunValidate}>
          <RefreshCwIcon className={running ? "mr-1 size-3.5 animate-spin" : "mr-1 size-3.5"} />
          {running ? <T>Checking…</T> : <T>Run Checks</T>}
        </Button>
      </div>

      {report && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {(["all", "error", "warning", "info"] as const).map((sev) => (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setFilter(sev)}
                  className={
                    filter === sev
                      ? "rounded-md bg-primary/15 px-2 py-0.5 font-medium text-primary"
                      : "rounded-md px-2 py-0.5 text-muted-foreground hover:bg-muted"
                  }
                >
                  {sev === "all"
                    ? gt("All ({count})", { count: report.issues.length })
                    : sev === "error"
                      ? gt("Errors ({count})", { count: report.errorCount })
                      : sev === "warning"
                        ? gt("Warnings ({count})", { count: report.warningCount })
                        : gt("Info ({count})", { count: report.infoCount })}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {report.enginesUsed.map((eng) => (
                <span
                  key={eng}
                  className="rounded-full border border-border bg-muted/60 px-2 py-0.5 font-mono text-3xs text-muted-foreground"
                >
                  {eng === "builtin"
                    ? gt("Built-in")
                    : eng === "kicad_erc"
                      ? gt("KiCad ERC")
                      : gt("KiCad DRC")}
                </span>
              ))}
            </div>
          </div>

          {filteredIssues.length === 0 ? (
            <div className="rounded-lg border border-border/70 bg-card/40 p-4 text-center text-muted-foreground">
              <T>No diagnostics match the selected filter.</T>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {filteredIssues.map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  onClick={() => onFocusIssue(issue)}
                  className="flex items-start gap-2 rounded-md border border-border/80 bg-card/50 p-2.5 text-left transition-colors hover:border-primary/60 hover:bg-card"
                >
                  {issue.severity === "error" ? (
                    <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                  ) : issue.severity === "warning" ? (
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                  ) : (
                    <InfoIcon className="mt-0.5 size-4 shrink-0 text-info" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-3xs font-semibold uppercase text-muted-foreground">
                        {issue.code}
                      </span>
                      {issue.net && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-3xs text-primary">
                          {issue.net}
                        </span>
                      )}
                      {issue.refs.slice(0, 4).map((r) => (
                        <span
                          key={r}
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-foreground"
                        >
                          {r}
                        </span>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-foreground">{issue.message}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {report.notes.length > 0 && (
            <div className="rounded-md bg-muted/40 px-2.5 py-2 text-2xs text-muted-foreground">
              {report.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
