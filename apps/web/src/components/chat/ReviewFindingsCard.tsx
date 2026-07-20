import type { ReviewResult } from "@t3tools/contracts";
import { AlertCircleIcon, MessageSquareTextIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const PRIORITY_LABELS = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
} as const;

function priorityVariant(priority: keyof typeof PRIORITY_LABELS) {
  return priority === "critical" || priority === "high" ? "error" : "warning";
}

export function ReviewFindingsCard({
  result,
  onSelectFinding,
}: {
  readonly result: ReviewResult;
  readonly onSelectFinding: (findingId: string) => void;
}) {
  if (result.status === "invalid-output") {
    return (
      <div className="mt-4 rounded-xl border border-warning/40 bg-warning/8 p-3 text-[length:var(--app-chat-font-size)] text-warning-foreground">
        <div className="flex items-center gap-2 font-medium">
          <AlertCircleIcon className="size-4 shrink-0" />
          Review output could not be mapped to the diff
        </div>
        <p className="mt-1 text-xs opacity-80">{result.issues[0] ?? "Invalid review output."}</p>
      </div>
    );
  }

  return (
    <section className="relative mt-4 rounded-xl bg-card/40 shadow-xs/5 after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:border after:border-input">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-[length:var(--app-chat-font-size)] font-medium">
          <MessageSquareTextIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {result.findings.length} {result.findings.length === 1 ? "comment" : "comments"}
          </span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {result.verdict.replace("-", " ")}
        </span>
      </div>
      <p className="px-3 pb-2 pt-2 text-[length:var(--app-chat-font-size)] text-muted-foreground">
        {result.summary}
      </p>
      {result.findings.length > 0 && (
        <div className="border-t border-border/60">
          {result.findings.map((finding) => (
            <Button
              key={finding.id}
              variant="ghost"
              className="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-left hover:bg-accent/50"
              onClick={() => onSelectFinding(finding.id)}
            >
              <Badge size="sm" variant={priorityVariant(finding.priority)}>
                {PRIORITY_LABELS[finding.priority]}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-[length:var(--app-chat-font-size)]">
                {finding.title}
              </span>
              <span
                className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-xs text-muted-foreground"
                title={`${finding.location.path}:${finding.location.startLine}`}
              >
                {finding.location.path.split("/").pop()}:{finding.location.startLine}
              </span>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
