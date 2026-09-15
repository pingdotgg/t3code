export interface ConnectorTicketRecord {
  readonly ticket: string;
  readonly expiresAtEpochMillis: number;
}

export type ConnectorTicketDisposition = "valid" | "invalid" | "expired";

export function constantTimeStringEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function connectorTicketDisposition(input: {
  readonly stored: ConnectorTicketRecord | undefined;
  readonly presented: string | undefined;
  readonly nowEpochMillis: number;
}): ConnectorTicketDisposition {
  if (input.stored === undefined || input.presented === undefined) return "invalid";
  if (input.stored.expiresAtEpochMillis < input.nowEpochMillis) return "expired";
  return constantTimeStringEqual(input.stored.ticket, input.presented) ? "valid" : "invalid";
}
