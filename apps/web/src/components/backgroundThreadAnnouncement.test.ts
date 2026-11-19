import { RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type BackgroundThreadMemory,
  type BackgroundThreadSnapshot,
  nextBackgroundThreadAnnouncement,
  resolveBackgroundThreadRequest,
} from "./backgroundThreadAnnouncement";

const firstRun = RunId.make("run-1");
const secondRun = RunId.make("run-2");

function thread(
  key: string,
  title: string,
  state: Partial<Omit<BackgroundThreadSnapshot, "key" | "title">> = {},
): BackgroundThreadSnapshot {
  return {
    key,
    title,
    request: null,
    requestId: null,
    runId: firstRun,
    runStatus: "running",
    activeRunId: null,
    snoozed: false,
    ...state,
  };
}
const login = (state?: Partial<BackgroundThreadSnapshot>) =>
  thread("env:login", "Fix login redirect", state);
const docs = (state?: Partial<BackgroundThreadSnapshot>) =>
  thread("env:docs", "Update docs", state);

function speak(
  frames: ReadonlyArray<{
    readonly threads: ReadonlyArray<BackgroundThreadSnapshot>;
    readonly open?: string;
  }>,
) {
  let memory: BackgroundThreadMemory = new Map();
  const spoken: string[] = [];
  for (const frame of frames) {
    const result = nextBackgroundThreadAnnouncement(memory, frame.threads, frame.open ?? null);
    memory = result.memory;
    if (result.announcement !== null) spoken.push(result.announcement);
  }
  return spoken;
}

describe("nextBackgroundThreadAnnouncement", () => {
  it("names the thread with the same words the open thread uses", () => {
    expect(
      speak([
        { threads: [login()] },
        { threads: [login({ request: "approval" })] },
        { threads: [login()] },
        { threads: [login({ request: "input" })] },
        { threads: [login({ runStatus: "completed" })] },
        { threads: [login({ runId: secondRun, runStatus: "failed" })] },
        { threads: [login({ runId: RunId.make("run-3"), runStatus: "interrupted" })] },
      ]),
    ).toEqual([
      "Needs approval: Fix login redirect",
      "Needs your input: Fix login redirect",
      "Done: Fix login redirect",
      "Failed: Fix login redirect",
      "Stopped: Fix login redirect",
    ]);
  });

  it("announces each run's ending once", () => {
    expect(
      speak([
        { threads: [login()] },
        { threads: [login({ runStatus: "completed" })] },
        // Marking the thread unread or renaming it changes nothing about the run.
        { threads: [login({ runStatus: "completed", title: "Fix the login redirect" })] },
        // The next run can finish between two updates, so it never looks busy here.
        { threads: [login({ runId: secondRun, runStatus: "completed" })] },
        { threads: [login({ runId: RunId.make("run-3"), runStatus: "rolled_back" })] },
      ]),
    ).toEqual(["Done: Fix login redirect", "Done: Fix login redirect"]);
  });

  it("announces a second request of the same kind", () => {
    expect(
      speak([
        { threads: [login()] },
        { threads: [login({ request: "approval", requestId: "request-1" })] },
        { threads: [login({ request: "approval", requestId: "request-2" })] },
      ]),
    ).toEqual(["Needs approval: Fix login redirect", "Needs approval: Fix login redirect"]);
  });

  it("doesn't call a thread stopped when a queued message is cancelled while it works", () => {
    expect(
      speak([
        { threads: [login({ activeRunId: firstRun })] },
        {
          threads: [login({ runId: secondRun, runStatus: "cancelled", activeRunId: firstRun })],
        },
        { threads: [login({ runId: secondRun, runStatus: "cancelled" })] },
      ]),
    ).toEqual([]);
  });

  it("stays quiet for threads it sees for the first time, like on launch or reconnect", () => {
    expect(
      speak([
        { threads: [login({ runStatus: "completed" }), docs({ request: "approval" })] },
        { threads: [login({ runStatus: "completed" }), docs({ request: "approval" })] },
        // The environment drops out while it resyncs, then comes back changed.
        { threads: [] },
        {
          threads: [
            login({ runId: secondRun, runStatus: "failed" }),
            docs({ runStatus: "completed" }),
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("leaves the open thread to its own announcer", () => {
    expect(
      speak([
        { threads: [login(), docs()], open: "env:login" },
        { threads: [login({ runStatus: "completed" }), docs()], open: "env:login" },
        // Switching away from a thread doesn't replay its ending.
        { threads: [login({ runStatus: "completed" }), docs()], open: "env:docs" },
        {
          threads: [login({ runStatus: "completed" }), docs({ request: "input" })],
          open: "env:login",
        },
      ]),
    ).toEqual(["Needs your input: Update docs"]);
  });

  it("keeps a snoozed thread quiet, even after it wakes", () => {
    expect(
      speak([
        { threads: [login({ snoozed: true })] },
        { threads: [login({ snoozed: true, runStatus: "completed" })] },
        { threads: [login({ runStatus: "completed" })] },
      ]),
    ).toEqual([]);
  });

  it("speaks threads that change together in one announcement", () => {
    expect(
      speak([
        { threads: [login(), docs()] },
        { threads: [login({ runStatus: "completed" }), docs({ request: "approval" })] },
      ]),
    ).toEqual(["Done: Fix login redirect. Needs approval: Update docs"]);
  });
});

describe("resolveBackgroundThreadRequest", () => {
  const question = (id: string) => ({
    id: RuntimeRequestId.make(id),
    kind: "user_input" as const,
    createdAt: DateTime.makeUnsafe(0),
  });
  const childApproval = (parentQuestion: string | null) =>
    resolveBackgroundThreadRequest({
      hasPendingApprovals: false,
      hasPendingUserInput: parentQuestion !== null,
      pendingSubagentRequest: "approval",
      source: { pendingRuntimeRequest: parentQuestion === null ? null : question(parentQuestion) },
    });

  it("raises a subagent's request on the parent without borrowing the parent's request id", () => {
    expect(childApproval(null)).toEqual({ request: "approval", requestId: null });
    // The parent's own questions come and go while the child's approval waits.
    expect(
      speak([
        { threads: [login()] },
        { threads: [login(childApproval(null))] },
        { threads: [login(childApproval("question-1"))] },
        { threads: [login(childApproval("question-2"))] },
        { threads: [login(childApproval(null))] },
      ]),
    ).toEqual(["Needs approval: Fix login redirect"]);
  });
});
