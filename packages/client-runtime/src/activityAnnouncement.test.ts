import { describe, expect, it } from "vite-plus/test";
import {
  activityAnnouncementMessages,
  type ActivityAnnouncementState,
} from "./activityAnnouncement.ts";

const idle: ActivityAnnouncementState = {
  threadKey: "env:thread-1",
  working: false,
  turnId: "turn-1",
  turnState: "completed",
  turnRequestedAt: "2026-09-24T10:00:00.000Z",
  approvalRequestId: null,
  userInputRequestId: null,
};
const running: ActivityAnnouncementState = {
  ...idle,
  working: true,
  turnId: "turn-2",
  turnState: "running",
  turnRequestedAt: "2026-09-24T10:05:00.000Z",
};

describe("activityAnnouncementMessages", () => {
  it("stays silent on first render, thread switches, and unchanged state", () => {
    expect(activityAnnouncementMessages(null, running)).toEqual([]);
    expect(activityAnnouncementMessages(idle, { ...running, threadKey: "env:thread-2" })).toEqual(
      [],
    );
    expect(activityAnnouncementMessages(running, { ...running })).toEqual([]);
  });

  it("announces work starting and how the running turn ended", () => {
    expect(activityAnnouncementMessages(idle, { ...idle, working: true })).toEqual([
      "Agent working",
    ]);
    const ended = (turnState: ActivityAnnouncementState["turnState"]) =>
      activityAnnouncementMessages(running, { ...running, working: false, turnState });
    expect(ended("completed")).toEqual(["Response complete"]);
    expect(ended("interrupted")).toEqual(["Response stopped"]);
    expect(ended("error")).toEqual(["Response failed"]);
  });

  it("does not claim the turn ended while it is still running", () => {
    expect(activityAnnouncementMessages(running, { ...running, working: false })).toEqual([]);
  });

  it("announces a turn that finished before its running state was seen", () => {
    const finished = { ...running, working: false, turnState: "completed" as const };
    expect(activityAnnouncementMessages({ ...idle, working: true }, finished)).toEqual([
      "Response complete",
    ]);
    // Started from another device while this client was idle.
    expect(activityAnnouncementMessages(idle, finished)).toEqual(["Response complete"]);
    // The thread's first turn, sent from this client.
    const empty = { ...idle, turnId: null, turnState: null, turnRequestedAt: null };
    expect(activityAnnouncementMessages({ ...empty, working: true }, finished)).toEqual([
      "Response complete",
    ]);
  });

  it("stays silent for history loading and reverting to an older turn", () => {
    const empty = { ...idle, turnId: null, turnState: null, turnRequestedAt: null };
    expect(activityAnnouncementMessages(empty, idle)).toEqual([]);
    const reverting = { ...running, turnState: "completed" as const };
    expect(activityAnnouncementMessages(reverting, { ...idle, working: true })).toEqual([]);
  });

  it("announces each new request once, including two that arrive together", () => {
    const approval = { ...running, approvalRequestId: "approval-1" };
    expect(activityAnnouncementMessages(running, approval)).toEqual(["Approval needed"]);
    expect(activityAnnouncementMessages(approval, { ...approval })).toEqual([]);
    expect(
      activityAnnouncementMessages(running, { ...approval, userInputRequestId: "input-1" }),
    ).toEqual(["Approval needed", "Question from agent"]);
  });
});
