import { describe, expect, it } from "vitest";

import { linearIngressToTaskIntakeMessage } from "./linear.ts";
import { slackEnvelopeToTaskIntakeMessage } from "./slack.ts";

describe("task intake source normalization", () => {
  it("normalizes Linear ingress into the shared TaskIntakeMessage contract", () => {
    const message = linearIngressToTaskIntakeMessage({
      eventId: "linear:event-1",
      threadKind: "comment",
      linearThreadKey: "linear:issue-123",
      issueId: "issue-123",
      issueIdentifier: "ENG-1",
      commentId: "comment-1",
      messageId: "comment-2",
      authorName: "Vivek",
      body: "@Engineering fix checkout",
      commentUrl: "https://linear.app/affil/issue/ENG-1/comment/comment-2",
      receivedAt: Date.parse("2026-04-12T12:00:00.000Z"),
      shouldStartRun: true,
    });

    expect(message.source).toBe("linear");
    expect(message.conversation.externalLinkKind).toBe("linear_issue");
    expect(message.conversation.externalId).toBe("issue-123");
    expect(message.messageId).toBe("comment-2");
  });

  it("normalizes Slack thread messages into the shared TaskIntakeMessage contract", () => {
    const message = slackEnvelopeToTaskIntakeMessage({
      eventId: "slack:event-1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1712923200.000100",
      messageTs: "1712923210.000200",
      userId: "U1",
      userName: "Vivek",
      text: "<@BOT> fix checkout",
      receivedAt: Date.parse("2026-04-12T12:00:00.000Z"),
    });

    expect(message.source).toBe("slack");
    expect(message.conversation.externalLinkKind).toBe("slack_thread");
    expect(message.conversation.externalId).toBe("T1:C1:1712923200.000100");
    expect(message.actor?.externalId).toBe("U1");
  });
});
