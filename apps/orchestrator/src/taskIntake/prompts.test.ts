import { describe, expect, it } from "vitest";

import type { TaskIntakeMessage } from "./contracts.ts";
import { buildTaskIntakeFollowUpPrompt, buildTaskIntakeInitialPrompt } from "./prompts.ts";

const message: TaskIntakeMessage = {
  eventId: "slack:event-1",
  source: "slack",
  conversation: {
    source: "slack",
    externalLinkKind: "slack_thread",
    externalId: "T1:C1:1712923200.000100",
    teamId: "T1",
    channelId: "C1",
  },
  messageId: "1712923210.000200",
  text: "  <@BOT> fix checkout  ",
  attachments: [
    {
      name: "error-log.txt",
      url: "https://files.slack.com/files-pri/T1-F1/error-log.txt",
    },
    {
      url: "https://files.slack.com/files-pri/T1-F2/screenshot.png",
    },
  ],
  receivedAt: "2026-04-12T12:00:00.000Z",
};

describe("Task Intake prompts", () => {
  it("relays the source message body and attachment links without source metadata", () => {
    expect(buildTaskIntakeInitialPrompt(message)).toBe(
      [
        "<@BOT> fix checkout",
        "",
        "error-log.txt: https://files.slack.com/files-pri/T1-F1/error-log.txt",
        "Attachment 2: https://files.slack.com/files-pri/T1-F2/screenshot.png",
      ].join("\n"),
    );
  });

  it("uses the same plain relay format for follow-ups", () => {
    expect(buildTaskIntakeFollowUpPrompt(message)).not.toContain("Source:");
    expect(buildTaskIntakeFollowUpPrompt(message)).not.toContain("Follow-up message:");
    expect(buildTaskIntakeFollowUpPrompt(message)).toContain("<@BOT> fix checkout");
  });
});
