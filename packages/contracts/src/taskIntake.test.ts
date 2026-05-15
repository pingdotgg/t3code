import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  TaskIntakeDeliveryResult,
  TaskIntakeMessage,
  TaskIntakeResolution,
  TaskIntakeSource,
} from "./taskIntake.ts";

const decodeTaskIntakeSource = Schema.decodeUnknownSync(TaskIntakeSource);
const decodeTaskIntakeMessage = Schema.decodeUnknownSync(TaskIntakeMessage);
const decodeTaskIntakeResolution = Schema.decodeUnknownSync(TaskIntakeResolution);
const decodeTaskIntakeDeliveryResult = Schema.decodeUnknownSync(TaskIntakeDeliveryResult);

describe("Task Intake contracts", () => {
  it.each(["slack", "linear", "support_email", "webhook"] as const)(
    "accepts %s as an intake source",
    (source) => {
      expect(decodeTaskIntakeSource(source)).toBe(source);
    },
  );

  it("decodes a Slack thread message into the shared intake shape", () => {
    const message = decodeTaskIntakeMessage({
      eventId: "slack:event:1",
      source: "slack",
      conversation: {
        source: "slack",
        externalLinkKind: "slack_thread",
        externalId: "T123:C123:1712345678.000100",
        teamId: "T123",
        channelId: "C123",
        url: "https://example.slack.com/archives/C123/p1712345678000100",
      },
      messageId: "1712345678.000200",
      actor: {
        externalId: "U123",
        displayName: "Vivek",
      },
      text: "@AI Engineer please debug the checkout webhook failure",
      attachments: [
        {
          name: "checkout.log",
          url: "https://files.slack.com/files-pri/T123-F123/checkout.log",
        },
      ],
      receivedAt: "2026-05-02T16:00:00.000Z",
    });

    expect(message.source).toBe("slack");
    expect(message.conversation.externalLinkKind).toBe("slack_thread");
    expect(message.conversation.externalId).toBe("T123:C123:1712345678.000100");
    expect(message.actor?.displayName).toBe("Vivek");
    expect(message.attachments?.[0]?.url).toBe(
      "https://files.slack.com/files-pri/T123-F123/checkout.log",
    );
  });

  it("decodes native image attachments for chat intake", () => {
    const message = decodeTaskIntakeMessage({
      eventId: "slack:event:image",
      source: "slack",
      conversation: {
        source: "slack",
        externalLinkKind: "slack_thread",
        externalId: "T123:C123:1712345678.000100",
      },
      messageId: "1712345678.000300",
      text: "What changed in this screenshot?",
      attachments: [
        {
          type: "image",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 4,
          dataUrl: "data:image/png;base64,dGVzdA==",
          url: "https://files.slack.com/files-pri/T123-F123/screenshot.png",
        },
      ],
      receivedAt: "2026-05-02T16:00:00.000Z",
    });

    expect(message.attachments?.[0]).toMatchObject({
      type: "image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 4,
      url: "https://files.slack.com/files-pri/T123-F123/screenshot.png",
    });
    expect(message.attachments?.[0]).toHaveProperty("dataUrl", "data:image/png;base64,dGVzdA==");
  });

  it("decodes a Linear issue comment into the shared intake shape", () => {
    const message = decodeTaskIntakeMessage({
      eventId: "linear:webhook:1",
      source: "linear",
      conversation: {
        source: "linear",
        externalLinkKind: "linear_issue",
        externalId: "issue-123",
        issueId: "issue-123",
        commentId: "comment-123",
        url: "https://linear.app/acme/issue/ENG-123/fix-login",
      },
      messageId: "comment-123",
      actor: {
        externalId: "user-123",
        displayName: "Ari",
        email: "ari@example.com",
      },
      text: "Can you take a look at this regression?",
      receivedAt: "2026-05-02T16:01:00.000Z",
    });

    expect(message.source).toBe("linear");
    expect(message.conversation.externalLinkKind).toBe("linear_issue");
    expect(message.conversation.issueId).toBe("issue-123");
  });

  it("decodes a support email webhook into the same intake shape", () => {
    const message = decodeTaskIntakeMessage({
      eventId: "support-email:event:1",
      source: "support_email",
      conversation: {
        source: "support_email",
        externalLinkKind: "support_email_thread",
        externalId: "ticket-123",
        emailMessageId: "message-123",
        url: "https://support.example.com/tickets/123",
      },
      messageId: "message-123",
      actor: {
        email: "customer@example.com",
      },
      text: "The dashboard crashes every time I open billing.",
      receivedAt: "2026-05-02T16:02:00.000Z",
    });

    expect(message.source).toBe("support_email");
    expect(message.conversation.externalLinkKind).toBe("support_email_thread");
    expect(message.conversation.emailMessageId).toBe("message-123");
  });

  it("supports create, route-existing, needs-input, and ignore resolutions", () => {
    expect(
      decodeTaskIntakeResolution({
        type: "create_task",
        initialPrompt: "Debug the failing checkout webhook",
        title: "Debug checkout webhook",
      }).type,
    ).toBe("create_task");

    expect(
      decodeTaskIntakeResolution({
        type: "route_existing_task",
        taskId: "task-123",
      }).type,
    ).toBe("route_existing_task");

    expect(
      decodeTaskIntakeResolution({
        type: "needs_input",
        reason: "Project is ambiguous",
        reply: {
          source: "slack",
          conversation: {
            source: "slack",
            externalLinkKind: "slack_thread",
            externalId: "T123:C123:1712345678.000100",
          },
          body: "Which repo should I use?",
          idempotencyKey: "reply-1",
        },
      }).type,
    ).toBe("needs_input");

    expect(
      decodeTaskIntakeResolution({
        type: "ignore",
        reason: "duplicate",
      }).type,
    ).toBe("ignore");
  });

  it("decodes delivery results for posted, skipped, and failed replies", () => {
    expect(
      decodeTaskIntakeDeliveryResult({
        status: "posted",
        externalMessageId: "message-1",
      }).status,
    ).toBe("posted");
    expect(
      decodeTaskIntakeDeliveryResult({
        status: "skipped",
        reason: "duplicate",
      }).status,
    ).toBe("skipped");
    expect(
      decodeTaskIntakeDeliveryResult({
        status: "failed",
        error: "adapter unavailable",
      }).status,
    ).toBe("failed");
  });

  it("rejects unknown intake sources and empty external ids", () => {
    expect(() => decodeTaskIntakeSource("teams")).toThrow();
    expect(() =>
      decodeTaskIntakeMessage({
        eventId: "event-1",
        source: "webhook",
        conversation: {
          source: "webhook",
          externalLinkKind: "webhook_event",
          externalId: " ",
        },
        messageId: "message-1",
        text: "Run this task",
        receivedAt: "2026-05-02T16:03:00.000Z",
      }),
    ).toThrow();
  });
});
