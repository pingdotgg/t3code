import { Check } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { ChatMarkdown } from "../chat/Markdown";
import { cardTitle, type CardState, type CardView, type ForYouItem } from "../domain/forYou";
import { describeTrackerWrite } from "../issues/issueLinks";
import { answerItem, type ForYouTarget } from "../foryou/actions";
import { ApprovalBody } from "./ApprovalBody";
import { ItemActions } from "./ItemActions";
import { MergeApprovalConditions } from "./MergeApprovalConditions";
import { SecretBody } from "./SecretBody";
import { useRevealRef } from "./Viewport";

const KIND_LABEL = {
  merge_approval: "Merge approval",
  question: "Question",
  ticket_draft: "Ticket draft",
  tracker_write: "Tracker write",
  gate: "Gate",
  read: "Read",
  resume: "Resume",
} as const satisfies Record<ForYouItem["kind"], string>;

const STATE = {
  open: { label: "Open", chip: "bg-amber-500/15 text-amber-300" },
  sent: { label: "Sent", chip: "bg-sky-500/15 text-sky-300" },
  held: { label: "Held", chip: "bg-hover text-muted" },
  resolved: { label: "Resolved", chip: "bg-emerald-500/15 text-emerald-300" },
} as const satisfies Record<CardState, { label: string; chip: string }>;

export interface CardContext {
  readonly target: ForYouTarget;
  readonly orchestratorThreadId: string | null;
  /** A toast or the sidebar sent the user here. */
  readonly focused: boolean;
}

/** One thing that needs the user: what it is, what to choose, and whether the choice went through. */
export function ForYouCard({ view, context }: { view: CardView; context: CardContext }) {
  const { card, state, detail } = view;
  const { target, orchestratorThreadId, focused } = context;
  const [error, setError] = useState<string | null>(null);
  const previous = useRef<CardState | null>(null);

  // A ref callback runs after the commit that shows a new state, which is what the user waits on.
  // The resolved layout is its own element, so a card that loads resolved never marks.
  const markState = useCallback(
    (element: HTMLElement | null) => {
      const before = previous.current;
      if (element === null || before === state) return;
      previous.current = state;
      if (before === null || (state !== "sent" && state !== "resolved")) return;
      requestAnimationFrame(() =>
        performance.mark(state === "sent" ? "board:foryou-sent" : "board:foryou-resolved", {
          detail: { id: card.id },
        }),
      );
    },
    [state, card.id],
  );
  const revealRef = useRevealRef();
  const ref = useCallback(
    (element: HTMLElement | null) => {
      markState(element);
      if (focused) revealRef(element);
    },
    [markState, revealRef, focused],
  );

  const title = cardTitle(card);
  const label =
    card.origin === "file"
      ? KIND_LABEL[card.item.kind]
      : card.request.kind === "approval"
        ? "Approval"
        : "Secret";
  const chip = STATE[state];
  const sent = state === "sent";

  if (state === "resolved") {
    return (
      <article
        ref={ref}
        data-testid="foryou-card"
        data-card-id={card.id}
        data-kind={card.origin === "file" ? card.item.kind : card.request.kind}
        data-state={state}
        aria-label={`${title}, resolved`}
        className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1.5"
      >
        <Check className="size-3.5 shrink-0 text-emerald-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{title}</span>
        {detail !== null && <span className="shrink-0 text-[11px] text-faint">{detail}</span>}
      </article>
    );
  }

  return (
    <article
      ref={ref}
      data-testid="foryou-card"
      data-card-id={card.id}
      data-kind={card.origin === "file" ? card.item.kind : card.request.kind}
      data-state={state}
      aria-label={`${title}, ${chip.label.toLowerCase()}`}
      className={`flex flex-col gap-2 rounded-lg border bg-panel p-2.5 shadow-panel ${focused ? "border-focus ring-1 ring-focus" : "border-line"}`}
    >
      <header className="flex items-center gap-1.5">
        <span className="rounded bg-hover px-1.5 text-[10px] leading-4 font-semibold text-muted">
          {label}
        </span>
        <span className="flex-1" />
        <span
          data-testid="foryou-state"
          className={`rounded px-1.5 text-[10px] leading-4 font-medium ${chip.chip}`}
        >
          {chip.label}
        </span>
      </header>
      <h4 className="text-[13px] leading-[18px] font-semibold break-words text-fg">{title}</h4>
      {card.origin === "file" ? (
        <>
          {card.item.body.trim() !== "" && (
            <div className="text-[12px] break-words text-muted">
              <ChatMarkdown text={card.item.body} untrusted />
            </div>
          )}
          {card.item.kind === "merge_approval" && <MergeApprovalConditions item={card.item} />}
          {card.item.kind === "tracker_write" && (
            <pre
              data-testid="tracker-write"
              className="max-h-40 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px] break-words whitespace-pre-wrap text-fg"
            >
              {describeTrackerWrite(card.item.write)}
            </pre>
          )}
          <ItemActions
            item={card.item}
            sent={sent}
            send={(answer) => {
              setError(null);
              void answerItem(target, orchestratorThreadId, card, answer).then(setError);
            }}
          />
        </>
      ) : card.request.kind === "approval" ? (
        <ApprovalBody
          target={target}
          card={card}
          request={card.request}
          sent={sent}
          onError={setError}
        />
      ) : (
        <SecretBody
          target={target}
          card={card}
          request={card.request}
          sent={sent}
          onError={setError}
        />
      )}
      {sent && (
        <p data-testid="foryou-sent" className="text-[11px] text-sky-300">
          {card.origin === "file"
            ? `Sent to the orchestrator: ${detail}. Waiting for it to record the answer.`
            : `${detail}. Waiting for the engine.`}
        </p>
      )}
      {state === "held" && detail !== null && <p className="text-[11px] text-muted">{detail}</p>}
      {error !== null && (
        <p role="alert" className="text-[11px] break-words text-red-400">
          {error}
        </p>
      )}
    </article>
  );
}
