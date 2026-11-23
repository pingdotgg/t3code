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
              wrapLabel
              label={
                <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-foreground">{m(TITLE)}</span>
                  <span className="text-muted-foreground">{display.label}</span>
                </span>
              }
              trailing={
                <span className="flex h-6 shrink-0 items-center">
                  <ChevronDownIcon
                    className="size-3.5 text-icon-muted transition-transform motion-reduce:transition-none group-data-panel-open/timeline-row:rotate-180"
                    aria-hidden
                  />
                </span>
              }
            />
          }
        />
        <CollapsiblePanel>
          <div className="pt-2 pb-1 ps-4.75 pe-4.75">
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
      className="flex min-w-0 flex-col rounded-pane surface-tray p-1"
    >
      <div className="flex min-h-9 min-w-0 items-center gap-2 px-2.5 pb-1">
        <MessageSquareIcon aria-hidden className="size-4 shrink-0 text-info-foreground" />
        <h3 className="min-w-0 flex-1 text-label text-foreground">
          <T>Send this report to the T3 team?</T>
        </h3>
      </div>
      {/* Flat paints wells and secondary buttons with the composer fill, so this box takes the tray fill. */}
      <div className="flex min-w-0 flex-col gap-2.5 rounded-row-card surface-composer px-2.5 pt-2 pb-2.5 in-data-[surface-style=flat]:[--composer-fill:var(--tray-fill)]">
        <p className="min-w-0 px-1 text-meta text-muted-foreground">
          <T>This is everything that leaves your machine. Nothing is sent unless you press Send.</T>
        </p>
        {props.item.conversationTrace !== undefined ? (
          <label className="flex min-w-0 items-center justify-between gap-3 px-1">
            <span className="flex min-w-0 flex-col">
              <span className="text-body text-foreground">
                <T>Include the conversation</T>
              </span>
              <span className="text-meta text-muted-foreground">
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
        <div className="px-1">
          <FeedbackPreview preview={feedbackCardPreview(props.item, includeConversation)} />
        </div>
        {error !== null ? (
          <p role="alert" className="px-1 text-meta text-destructive">
            {error}
          </p>
        ) : !canAnswer ? (
          <p className="px-1 text-meta text-muted-foreground">
            <T>Only someone who can run agents on this machine can send or decline it.</T>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => void send("send")}
          >
            <T>Send</T>
          </Button>
          <Button
            type="button"
            variant="ghost-muted"
            disabled={disabled}
            onClick={() => void send("decline")}
          >
            <T>Don't send</T>
          </Button>
        </div>
      </div>
    </section>
  );
}

function FeedbackPreview({ preview }: { readonly preview: AgentFeedbackPreview }) {
  const m = useMessages();

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body">
        {feedbackPreviewFields(preview, m).map((field) => (
          <div key={field.label} className="contents">
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 wrap-anywhere text-foreground">{field.value}</dd>
          </div>
        ))}
      </dl>
      {preview.trace !== null ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground">
            <ChevronDownIcon
              className="size-3.5 shrink-0 transition-transform motion-reduce:transition-none group-data-panel-open:rotate-180"
              aria-hidden
            />
            {feedbackTraceSummary(preview.trace, m)}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ol className="mt-2 flex max-h-80 min-w-0 flex-col gap-1 overflow-y-auto font-mono text-meta">
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
