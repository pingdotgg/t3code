import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  displayEventFromTurnItem,
  isAckInput,
  REPLACE_SEND_TO_USER_TOOL_NAME,
  SEND_TO_USER_TOOL_NAME,
} from "@t3tools/shared/displayModes";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";

/** How far the agent's answer to one user message has come. It only moves forward. */
export type ReplyStage = "open" | "acked" | "answered";

/** A call toward that answer. `delivered` is false for a send that still runs. */
export interface ReplyCall {
  readonly kind: "ack" | "answer" | "replace";
  readonly delivered: boolean;
}

/** Names the user message in refusals, and the call that changes its answer. */
export interface ReplySubject {
  readonly what: string;
  readonly replace: string;
}

export type ReplyVerdict =
  | { readonly ok: true; readonly next: ReplyStage }
  | { readonly ok: false; readonly reason: string };

type Refusal = "second-ack" | "late-ack" | "second-answer";

const RANK: Record<ReplyStage, number> = { open: 0, acked: 1, answered: 2 };
const REACHES: Record<ReplyCall["kind"], ReplyStage> = {
  ack: "acked",
  answer: "answered",
  replace: "answered",
};
const SEND_STEPS: Record<
  ReplyStage,
  Record<"ack" | "answer", { readonly next: ReplyStage } | { readonly refused: Refusal }>
> = {
  open: { ack: { next: "acked" }, answer: { next: "answered" } },
  acked: { ack: { refused: "second-ack" }, answer: { next: "answered" } },
  answered: { ack: { refused: "late-ack" }, answer: { refused: "second-answer" } },
};
const REFUSALS: Record<Refusal, (subject: ReplySubject) => string> = {
  "second-answer": (s) =>
    `you already answered ${s.what}. To change your answer, call ${s.replace}.`,
  "second-ack": (s) =>
    `you already sent an ack for ${s.what}. Send your answer without ack, or make the ack your answer with ${s.replace}.`,
  "late-ack": (s) =>
    `you already answered ${s.what}, and an ack goes only before the answer. To change your answer, call ${s.replace}.`,
};
const DELIVERING = (s: ReplySubject) =>
  `your message for ${s.what} is still being delivered. Call ${s.replace} again.`;

/**
 * The call that `item` makes toward an answer. Null for any other item, and for a call that does
 * not count: a refused or failed one, a replace still running, and without `named`, a send still
 * running, which the caller's hold covers instead.
 */
export function replyCallOf(item: OrchestrationV2TurnItem, named: boolean): ReplyCall | null {
  if (item.type !== "dynamic_tool") return null;
  const event = displayEventFromTurnItem(item);
  switch (resolveT3McpToolId(item.toolName)) {
    case SEND_TO_USER_TOOL_NAME: {
      if (event?.type === "sent") return { kind: event.ack ? "ack" : "answer", delivered: true };
      const kind = isAckInput(item.input) ? "ack" : "answer";
      return named && event === null ? { kind, delivered: false } : null;
    }
    case REPLACE_SEND_TO_USER_TOOL_NAME:
      return event?.type === "rewrite" ? { kind: "replace", delivered: true } : null;
    default:
      return null;
  }
}

const furthest = (stages: Iterable<ReplyStage>) => {
  let stage: ReplyStage = "open";
  for (const reached of stages) if (RANK[reached] > RANK[stage]) stage = reached;
  return stage;
};

const reachOf = (calls: ReadonlyArray<ReplyCall>) => calls.map((call) => REACHES[call.kind]);

/** Whether a send of `kind` may go out now, and the stage it leaves. `held` is the hold's stage. */
export function judgeSend(input: {
  readonly calls: ReadonlyArray<ReplyCall>;
  readonly held: ReplyStage;
  readonly kind: "ack" | "answer";
  readonly subject: ReplySubject;
}): ReplyVerdict {
  const step = SEND_STEPS[furthest([input.held, ...reachOf(input.calls)])][input.kind];
  return "next" in step
    ? { ok: true, next: step.next }
    : { ok: false, reason: REFUSALS[step.refused](input.subject) };
}

/**
 * Whether a replace may go out now. It checks its old text against the delivered messages, so it
 * waits while an accepted send is not delivered yet. A replace always leaves an answer.
 */
export function judgeReplace(input: {
  readonly calls: ReadonlyArray<ReplyCall>;
  readonly held: ReplyStage;
  readonly subject: ReplySubject;
}): ReplyVerdict {
  const accepted = furthest([input.held, ...reachOf(input.calls)]);
  const delivered = furthest(reachOf(input.calls.filter((call) => call.delivered)));
  return RANK[accepted] > RANK[delivered]
    ? { ok: false, reason: DELIVERING(input.subject) }
    : { ok: true, next: "answered" };
}

/**
 * The stages that accepted calls reached before the provider stored them, by user message, each
 * for `holdMs`. A call that names itself counts from history while it runs, except a replace: a
 * running replace may still be refused, so only a replace that the handler accepted is held.
 */
export function makeReplyHolds(holdMs: number) {
  const holds = new Map<
    string,
    { readonly stage: ReplyStage; readonly until: number; readonly replace: boolean }
  >();
  return {
    held: (key: string, named: boolean, now: number): ReplyStage => {
      for (const [held, { until }] of holds) if (until <= now) holds.delete(held);
      const hold = holds.get(key);
      return hold === undefined || (named && !hold.replace) ? "open" : hold.stage;
    },
    record: (
      key: string,
      named: boolean,
      call: ReplyCall["kind"],
      stage: ReplyStage,
      now: number,
    ) => {
      if (named && call !== "replace") return;
      holds.set(key, { stage, until: now + holdMs, replace: call === "replace" });
    },
  };
}
