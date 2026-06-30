export const MAX_TICKET_MESSAGE_BODY_LENGTH = 8_000;

const TICKET_MESSAGE_TRUNCATION_SUFFIX = "...";

export function truncateTicketMessageBody(body: string): string {
  if (body.length <= MAX_TICKET_MESSAGE_BODY_LENGTH) {
    return body;
  }
  return `${body.slice(
    0,
    MAX_TICKET_MESSAGE_BODY_LENGTH - TICKET_MESSAGE_TRUNCATION_SUFFIX.length,
  )}${TICKET_MESSAGE_TRUNCATION_SUFFIX}`;
}
