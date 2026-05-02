import { describe, expect, it } from "vitest";

import {
  isValidTaskIntakeExternalLinkIdentity,
  toTaskIntakeExternalLinkIdentity,
} from "./taskIntakeExternalLink.ts";

describe("Task Intake External Link identity helpers", () => {
  it.each([
    ["linear", "linear_issue", "issue-123"],
    ["slack", "slack_thread", "T123:C123:1712345678.000100"],
    ["support_email", "support_email_thread", "ticket-123"],
    ["webhook", "webhook_event", "event-123"],
  ] as const)("maps %s conversations to %s lookup keys", (source, externalLinkKind, externalId) => {
    expect(
      toTaskIntakeExternalLinkIdentity({
        source,
        externalLinkKind,
        externalId,
      }),
    ).toEqual({
      kind: externalLinkKind,
      externalId,
    });
  });

  it("rejects source and External Link kind mismatches", () => {
    expect(
      isValidTaskIntakeExternalLinkIdentity({
        source: "slack",
        kind: "linear_issue",
      }),
    ).toBe(false);

    expect(() =>
      toTaskIntakeExternalLinkIdentity({
        source: "slack",
        externalLinkKind: "linear_issue",
        externalId: "issue-123",
      }),
    ).toThrow(/Invalid Task Intake External Link kind/);
  });
});
