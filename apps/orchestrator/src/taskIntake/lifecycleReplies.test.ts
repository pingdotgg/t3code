import { describe, expect, it } from "vitest";

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
});
