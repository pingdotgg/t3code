import type { StepRunId, TicketId } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";

export const TICKET_REFS_PREFIX = "refs/t3/tickets";

const encodeRefPart = (value: string) => Encoding.encodeBase64Url(value);

export const ticketRefsPrefix = (ticketId: TicketId): string =>
  `${TICKET_REFS_PREFIX}/${encodeRefPart(ticketId as string)}`;

export const ticketBaseRef = (ticketId: TicketId): string => `${ticketRefsPrefix(ticketId)}/base`;

export const ticketStepRef = (
  ticketId: TicketId,
  stepRunId: StepRunId,
  kind: "pre" | "post",
): string =>
  `${TICKET_REFS_PREFIX}/${encodeRefPart(ticketId as string)}/step/${encodeRefPart(
    stepRunId as string,
  )}/${kind}`;
