import { describe, expect, it } from "vitest";

import {
  buildTaskLifecycleReplyBody,
  buildTaskPullRequestStatusReplyBody,
  buildTaskUserInputRequestReplyBody,
  taskPullRequestStatusReplyEventKey,
  taskStartedStatusReplyEventKey,
} from "../../convex/taskEvents.ts";
import { chatSdkThreadIdForLifecycleReply } from "./lifecycleReplies.ts";

describe("chatSdkThreadIdForLifecycleReply", () => {
  it("builds Linear Chat SDK thread ids from issue links", () => {
    expect(
      chatSdkThreadIdForLifecycleReply({
        kind: "linear_issue",
        externalId: "issue-123",
      }),
    ).toBe("linear:issue-123");
  });

  it("builds Slack Chat SDK thread ids from team-scoped thread links", () => {
    expect(
      chatSdkThreadIdForLifecycleReply({
        kind: "slack_thread",
        externalId: "T1:C1:1777709239.758019",
      }),
    ).toBe("slack:C1:1777709239.758019");
  });

  it("builds Slack Chat SDK thread ids from channel-scoped thread links", () => {
    expect(
      chatSdkThreadIdForLifecycleReply({
        kind: "slack_thread",
        externalId: "C1:1777709239.758019",
      }),
    ).toBe("slack:C1:1777709239.758019");
  });

  it("includes the pull request URL in completion replies when available", () => {
    expect(
      buildTaskLifecycleReplyBody({
        taskId: "task-123",
        workSessionId: "work-session-123",
        status: "completed",
        t3ThreadId: "thread-123",
        pullRequestUrl: "https://github.com/acme/app/pull/42",
      }),
    ).toContain("Pull request: https://github.com/acme/app/pull/42");
  });

  it("uses only the assistant response as the completion reply when available", () => {
    expect(
      buildTaskLifecycleReplyBody({
        taskId: "task-123",
        workSessionId: "work-session-123",
        status: "completed",
        t3ThreadId: "thread-123",
        assistantResponse: "I checked the local bridge and verified the smoke path end to end.",
        pullRequestUrl: "https://github.com/acme/app/pull/42",
      }),
    ).toBe("I checked the local bridge and verified the smoke path end to end.");
  });

  it("builds a compact pull request status reply with the public preview URL", () => {
    expect(
      buildTaskPullRequestStatusReplyBody({
        pullRequestUrl: "https://github.com/acme/app/pull/42",
        previewUrl: "https://app-abc123.acme.com",
      }),
    ).toBe(
      "Pull request: https://github.com/acme/app/pull/42\nPreview: https://app-abc123.acme.com",
    );
  });

  it("includes every public deployment preview URL when multiple previews are available", () => {
    expect(
      buildTaskPullRequestStatusReplyBody({
        pullRequestUrl: "https://github.com/acme/app/pull/42",
        deploymentPreviews: [
          {
            environment: "Preview - nextcard-web",
            url: "https://nextcard-web-abc123.nextcard.com",
          },
          {
            environment: "Preview - nextcard-mcp",
            url: "https://nextcard-mcp-abc123.nextcard.com",
          },
        ],
      }),
    ).toBe(
      [
        "Pull request: https://github.com/acme/app/pull/42",
        "Preview (Preview - nextcard-web): https://nextcard-web-abc123.nextcard.com",
        "Preview (Preview - nextcard-mcp): https://nextcard-mcp-abc123.nextcard.com",
      ].join("\n"),
    );
  });

  it("relays provider user-input questions without extra orchestration framing", () => {
    expect(
      buildTaskUserInputRequestReplyBody({
        questions: [
          {
            id: "confirm",
            header: "Confirm approach",
            question: "Should I update the seed branch prefixes now?",
            options: [
              {
                label: "Yes",
                description: "Apply the change.",
              },
              {
                label: "No",
                description: "Leave it unchanged.",
              },
            ],
          },
        ],
      }),
    ).toBe(
      [
        "*Confirm approach*",
        "Should I update the seed branch prefixes now?",
        "- Yes: Apply the change.",
        "- No: Leave it unchanged.",
      ].join("\n"),
    );
  });

  it("keys pull request status replies by PR and destination link, not turn", () => {
    expect(
      taskPullRequestStatusReplyEventKey({
        workSessionId: "work-session-123",
        pullRequestExternalId: "acme/app#42",
        linkId: "link-123",
      }),
    ).toBe("task-pr-status-reply:work-session-123:acme/app#42:link-123");
  });

  it("keys task started status cards by task and destination link", () => {
    expect(
      taskStartedStatusReplyEventKey({
        taskId: "task-123",
        linkId: "link-123",
      }),
    ).toBe("task-started-status-reply:task-123:link-123");
  });
});
