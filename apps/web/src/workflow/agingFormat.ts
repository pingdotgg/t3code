import { formatDuration } from "~/session-logic";

const WARN_AFTER_MS = 30 * 60 * 1000;
const ALERT_AFTER_MS = 2 * 60 * 60 * 1000;

export interface TicketAging {
  readonly level: "warn" | "alert";
  readonly label: string;
}

/**
 * "The board nags you": tickets stuck waiting on a human (or blocked) for
 * long enough get a visible age. Warn after 30 minutes, alert after 2 hours.
 */
export const ticketAging = (
  ticket: { readonly status: string; readonly updatedAt?: string | undefined },
  nowMs: number,
): TicketAging | null => {
  if (ticket.status !== "waiting_on_user" && ticket.status !== "blocked") {
    return null;
  }
  if (ticket.updatedAt === undefined) {
    return null;
  }
  const since = Date.parse(ticket.updatedAt);
  if (!Number.isFinite(since)) {
    return null;
  }
  const ageMs = nowMs - since;
  if (ageMs < WARN_AFTER_MS) {
    return null;
  }
  const verb = ticket.status === "blocked" ? "blocked" : "needs you";
  return {
    level: ageMs >= ALERT_AFTER_MS ? "alert" : "warn",
    label: `${verb} · ${formatDuration(ageMs)}`,
  };
};

export const countNeedsAttention = (
  tickets: ReadonlyArray<{ readonly status: string; readonly updatedAt?: string | undefined }>,
  nowMs: number,
): number => tickets.filter((ticket) => ticketAging(ticket, nowMs) !== null).length;
