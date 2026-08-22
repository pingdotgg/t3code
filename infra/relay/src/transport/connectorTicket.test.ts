import { describe, expect, it } from "vite-plus/test";

import { connectorTicketDisposition, constantTimeStringEqual } from "./connectorTicket.ts";

describe("connector ticket validation", () => {
  const stored = { ticket: "ticket-valid", expiresAtEpochMillis: 2_000 } as const;

  it("accepts only the matching unexpired ticket", () => {
    expect(
      connectorTicketDisposition({ stored, presented: "ticket-valid", nowEpochMillis: 1_000 }),
    ).toBe("valid");
    expect(
      connectorTicketDisposition({ stored, presented: "ticket-invalid", nowEpochMillis: 1_000 }),
    ).toBe("invalid");
  });

  it("distinguishes expiration so storage can clean up only expired tickets", () => {
    expect(
      connectorTicketDisposition({ stored, presented: "ticket-valid", nowEpochMillis: 2_001 }),
    ).toBe("expired");
    expect(
      connectorTicketDisposition({ stored: undefined, presented: "anything", nowEpochMillis: 0 }),
    ).toBe("invalid");
  });

  it("compares values of different lengths without accepting a shared prefix", () => {
    expect(constantTimeStringEqual("ticket", "ticket-longer")).toBe(false);
  });
});
