import { describe, expect, it } from "vite-plus/test";

import {
  threadActivityAnnouncement,
  type ThreadActivityAnnouncementState,
} from "./thread-activity-announcement";

const idle: ThreadActivityAnnouncementState = {
  threadKey: "env:thread-1",
  connected: true,
  environmentLabel: "Mac mini",
  working: false,
  turnId: "turn-1",
  turnState: "completed",
  turnRequestedAt: "2026-09-24T10:00:00.000Z",
  approvalRequestId: null,
  userInputRequestId: null,
};
const working = { ...idle, working: true, turnState: "running" } as const;

describe("threadActivityAnnouncement", () => {
  it("stays silent when a thread opens or the selection switches threads", () => {
    expect(threadActivityAnnouncement(null, working)).toBeNull();
    expect(threadActivityAnnouncement(idle, { ...working, threadKey: "env:thread-2" })).toBeNull();
  });

  it("announces the connection only when it crosses connected", () => {
    const disconnected = { ...idle, connected: false };
    expect(threadActivityAnnouncement(idle, disconnected)).toBe("Disconnected from Mac mini");
    expect(threadActivityAnnouncement(disconnected, { ...disconnected })).toBeNull();
    expect(threadActivityAnnouncement(disconnected, idle)).toBe("Connected to Mac mini");
  });

  it("combines changes that land in the same render into one message", () => {
    expect(threadActivityAnnouncement({ ...working, connected: false }, idle)).toBe(
      "Connected to Mac mini. Response complete",
    );
  });
});
