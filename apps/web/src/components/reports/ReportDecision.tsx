/**
 * The report's one ask, and the controls that answer it. Both report surfaces
 * mount this: the triage card, where it closes a card being skimmed, and the
 * detail page, where it closes the document.
 *
 * The verbs come from what the report is actually asking. A report that needs
 * a person's call gets a field to answer in, not a button that opens a chat —
 * the decision is made here, not somewhere the reader has to navigate to.
 */
import type { PostHogReport } from "@t3tools/contracts";
import {
  ArchiveXIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  MessagesSquareIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  deriveReportDecision,
  type ReportActionKind,
  type ReportVerdictTone,
} from "./reportVerdict";
import { reportBranchName } from "./useReportThreadContext";

const TONE_CLASS: Readonly<Record<ReportVerdictTone, string>> = {
  decision: "border-primary/30 bg-primary/[0.06]",
  danger: "border-destructive/30 bg-destructive/[0.06]",
  progress: "border-border bg-muted/40",
  info: "border-border bg-muted/40",
};

const ACTION_ICON: Partial<Record<ReportActionKind, typeof WrenchIcon>> = {
  implement: WrenchIcon,
  "review-pr": FileDiffIcon,
  "open-pr-external": ExternalLinkIcon,
  continue: MessagesSquareIcon,
  ask: MessagesSquareIcon,
  archive: ArchiveXIcon,
};

export interface ReportDecisionHandlers {
  /** `direction` is whatever the reader typed before committing, if anything. */
  readonly onImplement: (direction: string) => void;
  readonly onAnswer: (answer: string) => void;
  readonly onAsk: () => void;
  readonly onContinue: () => void;
  /** Opens the change request in the app, with its diff and review controls. */
  readonly onReviewPullRequest: () => void;
  readonly onOpenPullRequestExternally: () => void;
  readonly onArchive: () => void;
}

export function ReportDecision({
  report,
  hasExistingPr,
  busy = false,
  className,
  reasoning = null,
  repository = null,
  handlers,
}: {
  readonly report: PostHogReport;
  readonly hasExistingPr: boolean;
  readonly busy?: boolean;
  readonly className?: string;
  /**
   * The agent's own justification for the judgment this verdict rests on.
   * Shown inline where the verdict makes a claim the reader would otherwise
   * have to go and verify — "already handled" being the obvious one.
   */
  readonly reasoning?: string | null;
  /** The repository the agent's selection step chose, when it chose one. */
  readonly repository?: string | null;
  readonly handlers: ReportDecisionHandlers;
}) {
  const decision = deriveReportDecision(report, { hasExistingPr });
  const [text, setText] = useState("");

  const run = (kind: ReportActionKind) => {
    switch (kind) {
      case "implement":
        handlers.onImplement(text.trim());
        return;
      case "answer":
        handlers.onAnswer(text.trim());
        return;
      case "ask":
        handlers.onAsk();
        return;
      case "continue":
        handlers.onContinue();
        return;
      case "review-pr":
        handlers.onReviewPullRequest();
        return;
      case "open-pr-external":
        handlers.onOpenPullRequestExternally();
        return;
      case "archive":
        handlers.onArchive();
        return;
    }
  };

  const { primary, secondary, verdict } = decision;
  // Answering is the decision, so the field is the control: the button stays
  // disabled until there is an answer to send.
  const answering = primary?.kind === "answer";
  const body = decision.showsReasoning && reasoning?.trim() ? reasoning.trim() : verdict.body;
  const PrimaryIcon = primary ? ACTION_ICON[primary.kind] : undefined;

  return (
    <div className={cn("rounded-lg border p-3.5", TONE_CLASS[verdict.tone], className)}>
      <p className="text-sm leading-relaxed">
        <span className="font-medium">{verdict.title}.</span>{" "}
        <span className="text-muted-foreground">{body}</span>
      </p>

      {/* What "implement" costs, before it is spent: the repository the agent
          chose and the branch it will cut. */}
      {primary?.kind === "implement" && repository ? (
        <p className="mt-1.5 font-mono text-xs text-muted-foreground">
          {repository}
          <span className="mx-1.5 opacity-50">·</span>
          {reportBranchName(report.id)}
        </p>
      ) : null}

      {answering ? (
        <Textarea
          value={text}
          rows={3}
          autoFocus
          aria-label="Your answer"
          placeholder="Optional: tell the agent what you decided or did…"
          className="mt-3 bg-background"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              run("answer");
            }
          }}
        />
      ) : null}

      {primary || secondary.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {primary ? (
            <Button size="sm" disabled={busy} onClick={() => run(primary.kind)}>
              {PrimaryIcon ? <PrimaryIcon className="size-3.5" /> : null}
              {primary.label}
            </Button>
          ) : null}
          {secondary.map((action) => {
            const Icon = ACTION_ICON[action.kind];
            return (
              <Button
                key={action.kind}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run(action.kind)}
              >
                {Icon ? <Icon className="size-3.5" /> : null}
                {action.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
