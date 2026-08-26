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
import { useImperativeHandle, useRef, useState, type Ref } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ClampedBlock } from "./ClampedBlock";
import {
  deriveReportDecision,
  type ReportActionKind,
  type ReportVerdictTone,
} from "./reportVerdict";

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

/**
 * The card's controls, reachable from a key handler that owns the whole
 * screen. Each returns whether there was anything to do, so the caller knows
 * whether to swallow the key or leave it to the browser.
 */
export interface ReportDecisionControls {
  /** Focus the reply field, on the reports that have one. */
  readonly focusInput: () => boolean;
  /** Commit the one thing this report is asking for. */
  readonly runPrimary: () => boolean;
  /** Archive, wherever archiving sits among this report's controls. */
  readonly runArchive: () => boolean;
}

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
  controls,
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
  /** Lets a surface that owns the keyboard drive these controls. */
  readonly controls?: Ref<ReportDecisionControls | null>;
}) {
  const decision = deriveReportDecision(report, { hasExistingPr });
  const [text, setText] = useState("");
  const fieldRef = useRef<HTMLDivElement | null>(null);

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
  const reasons = decision.showsReasoning && Boolean(reasoning?.trim());
  const body = reasons && reasoning ? reasoning.trim() : verdict.body;
  const PrimaryIcon = primary ? ACTION_ICON[primary.kind] : undefined;
  const archivable =
    primary?.kind === "archive" ? primary : (secondary.find((a) => a.kind === "archive") ?? null);

  useImperativeHandle(
    controls,
    () => ({
      focusInput: () => {
        // Base UI's field owns the control's ref, so the element is reached
        // through the wrapper rather than by holding a second ref to it.
        const input = fieldRef.current?.querySelector("textarea");
        if (!input) return false;
        input.focus();
        return true;
      },
      runPrimary: () => {
        if (primary === null || busy) return false;
        run(primary.kind);
        return true;
      },
      runArchive: () => {
        if (archivable === null || busy) return false;
        run("archive");
        return true;
      },
    }),
    // `run` closes over the draft text, so the handle is rebuilt as it is
    // typed — committing must send what is in the field right now.
    [archivable, busy, primary, run],
  );

  return (
    <div className={cn("rounded-lg border p-3.5", TONE_CLASS[verdict.tone], className)}>
      {/* The state line is never clipped — it is the sentence the reader is
          scanning for. Only the agent's account of it folds, and only when it
          runs past the card. */}
      <ClampedBlock
        lines={4}
        className="text-sm leading-relaxed"
        expandLabel={reasons ? "Show the agent's full reasoning" : "Show more"}
      >
        <p>
          <span className="font-medium">{verdict.title}.</span>{" "}
          <span className="text-muted-foreground">{body}</span>
        </p>
      </ClampedBlock>

      {/* Where "implement" will land, before it is spent. */}
      {primary?.kind === "implement" && repository ? (
        <p className="mt-1.5 truncate font-mono text-xs text-muted-foreground">{repository}</p>
      ) : null}

      {/* Deliberately not autofocused. This card is read before it is answered,
          and a field that grabs the caret on arrival turns every shortcut on
          the surface into a letter. The surface offers a key to focus it. */}
      {answering ? (
        <div ref={fieldRef}>
          <Textarea
            value={text}
            rows={3}
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
        </div>
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
