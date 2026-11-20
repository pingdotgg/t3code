import { T, msg, useMessages } from "gt-react";
import { pipe } from "effect/Function";
import {
  feedbackCardPreview,
  feedbackConversationHint,
  feedbackPreviewFields,
  feedbackRequestDisplay,
  feedbackRequestFailureMessage,
  type FeedbackRequestItem,
  feedbackTraceLines,
  feedbackTraceSummary,
} from "@t3tools/client-runtime/feedback-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AgentFeedbackPreview,
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, LockIcon, MessageSquareIcon, MinusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import { WorkLogRow } from "./WorkLog";

const TITLE = msg("Feedback for the T3 team");

export function FeedbackRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: FeedbackRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const m = useMessages();
  const { item } = props;
  const display = feedbackRequestDisplay(item, props.visibility, m);
  if (display.kind !== "pending") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "sent"
          ? CheckIcon
          : MinusIcon;
    return (
      <Collapsible data-v2-item-type={item.type}>
        <CollapsibleTrigger
          render={
            <WorkLogRow
              icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
              label={
                <>
                  {m(TITLE)} · {display.label}
                </>
              }
              trailing={<ChevronDownIcon className="size-3.5 text-icon-muted" aria-hidden />}
            />
          }
        />
        <CollapsiblePanel>
          <div className="pt-2 pb-1 pl-5">
            <FeedbackPreview preview={item.preview} />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    );
  }
  return <PendingFeedbackRequest environmentId={props.environmentId} item={item} />;
}

function PendingFeedbackRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly item: FeedbackRequestItem;
}) {
  const m = useMessages();
  const answer = useAtomCommand(serverEnvironment.answerFeedbackRequest, {
    label: "answer feedback request",
    reportFailure: false,
  });
  const canAnswer = useAtomValue(
    serverEnvironment.answerFeedbackRequest.permissionAtom(props.environmentId),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeConversation, setIncludeConversation] = useState(false);
  // Two clicks can land before a render.
  const inFlight = useRef(false);

  const send = async (reply: "send" | "decline") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: {
        threadId: props.item.threadId,
        turnItemId: props.item.id,
        answer: reply,
        includeConversation,
      },
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    pipe(
      squashAtomCommandFailure(result),
      (failure) => feedbackRequestFailureMessage(failure, m),
      setError,
    );
  };
  const disabled = submitting || !canAnswer;

  return (
    <section
      data-v2-item-type={props.item.type}
      aria-label={m(TITLE)}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <MessageSquareIcon className="size-3.5 shrink-0 text-icon-muted" aria-hidden />
          <T>Send this report to the T3 team?</T>
        </h3>
        <p className="text-xs text-muted-foreground">
          <T>This is everything that leaves your machine. Nothing is sent unless you press Send.</T>
        </p>
      </div>
      {props.item.conversationTrace !== undefined ? (
        <label className="flex min-w-0 items-center justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="text-sm text-foreground">
              <T>Include the conversation</T>
            </span>
            <span className="text-xs text-muted-foreground">
              {feedbackConversationHint(props.item.conversationTrace, m)}
            </span>
          </span>
          <Switch
            size="sm"
            checked={includeConversation}
            onCheckedChange={setIncludeConversation}
            disabled={disabled}
          />
        </label>
      ) : null}
      <FeedbackPreview preview={feedbackCardPreview(props.item, includeConversation)} />
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : !canAnswer ? (
        <p className="text-xs text-muted-foreground">
          <T>Only someone who can run agents on this machine can send or decline it.</T>
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => void send("decline")}
        >
          <T>Don't send</T>
        </Button>
        <Button type="button" size="sm" disabled={disabled} onClick={() => void send("send")}>
          <T>Send</T>
        </Button>
      </div>
    </section>
  );
}

function FeedbackPreview({ preview }: { readonly preview: AgentFeedbackPreview }) {
  const m = useMessages();

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {feedbackPreviewFields(preview, m).map((field) => (
          <div key={field.label} className="contents">
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 wrap-anywhere text-foreground">{field.value}</dd>
          </div>
        ))}
      </dl>
      {preview.trace !== null ? (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className="size-3.5" aria-hidden />
            {feedbackTraceSummary(preview.trace, m)}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ol className="mt-2 flex max-h-80 min-w-0 flex-col gap-1 overflow-y-auto font-mono text-xs">
              {feedbackTraceLines(preview.trace, m).map((entry) => (
                <li key={entry.key} className="min-w-0">
                  <span className="text-muted-foreground">{entry.line}</span>
                  {entry.text !== undefined ? (
                    <p className="mt-0.5 mb-1 whitespace-pre-wrap wrap-anywhere text-foreground">
                      {entry.text}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}
