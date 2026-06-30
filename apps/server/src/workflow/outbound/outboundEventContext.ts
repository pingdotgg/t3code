import type { OutboundEventContext, OutboundTrigger } from "@t3tools/contracts";
import { redactSensitiveText } from "../redactSensitiveText.ts";

// INVARIANT: every member here must have an explicit case in `primaryTrigger`
// (pinned by the "every gated event type maps to an explicit (non-fallback) trigger"
// coverage test). Adding a tag without updating the switch would silently get the
// `lane_entered` fallback and fire `lane_entered` rules spuriously.
export const OUTBOUND_EVENT_TYPES = new Set<string>([
  "StepAwaitingUser",
  "TicketBlocked",
  "TicketMovedToLane",
  "TicketAdmitted",
]);

export interface OutboundContextInput {
  readonly eventType: string;
  readonly ticketId: string;
  readonly boardId: string;
  readonly title: string;
  readonly fromLane: string | null;
  readonly toLane: string | null;
  readonly postStatus: string;
  readonly isTerminal: boolean;
  readonly reason: string | undefined;
  readonly occurredAt: string;
}

// The PRIMARY trigger label the event maps to (ctx.trigger). `done` is NOT a primary label —
// it's computed in matchesTrigger as lane_entered && isTerminal so a `when` on `trigger` is predictable.
const primaryTrigger = (eventType: string): OutboundTrigger => {
  switch (eventType) {
    case "StepAwaitingUser":
      return "needs_attention";
    case "TicketBlocked":
      return "blocked";
    case "TicketMovedToLane":
    case "TicketAdmitted":
      return "lane_entered";
    default:
      return "lane_entered";
  }
};

export const buildOutboundContext = (input: OutboundContextInput): OutboundEventContext => ({
  trigger: primaryTrigger(input.eventType),
  ticketId: input.ticketId,
  boardId: input.boardId,
  title: input.title,
  status: input.postStatus,
  fromLane: input.fromLane,
  toLane: input.toLane,
  isTerminal: input.isTerminal,
  // Redact secrets from `reason` before it is persisted in context_json and
  // POSTed to a user-configured third-party endpoint. `reason` can carry step
  // stderr or `Cause.pretty(...)` output, exactly where tokens surface — the
  // internal push path redacts the same field, so outbound must too.
  ...(input.reason !== undefined ? { reason: redactSensitiveText(input.reason) } : {}),
  occurredAt: input.occurredAt,
});

// Rule-specific context used for `when` evaluation, storage (context_json) and
// later rendering. `matchesTrigger` deliberately gates `done` against the BASE
// ctx (lane_entered && isTerminal); once a rule has MATCHED as `done`, the
// context it carries forward must report `trigger: "done"` so that a
// `{"==":[{"var":"trigger"},"done"]}` predicate (which the board editor suggests)
// matches and the rendered payload shows "Done" rather than the "Moved" label.
export const contextForRule = (
  rule: { on: OutboundTrigger },
  ctx: OutboundEventContext,
): OutboundEventContext => (rule.on === "done" ? { ...ctx, trigger: "done" } : ctx);

export const matchesTrigger = (
  rule: { on: OutboundTrigger },
  ctx: OutboundEventContext,
): boolean => {
  switch (rule.on) {
    case "needs_attention":
      return ctx.trigger === "needs_attention";
    case "blocked":
      return ctx.trigger === "blocked";
    case "lane_entered":
      return ctx.trigger === "lane_entered";
    case "done":
      return ctx.trigger === "lane_entered" && ctx.isTerminal;
    default:
      return false;
  }
};
