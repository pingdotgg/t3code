import {
  nextThreadAnnouncement,
  type ThreadAnnouncementMemory,
} from "@t3tools/client-runtime/state/thread-activity-announcement";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadActivitySnapshot } from "./threadStatusAnnouncement";

const run = RunId.make("run-1");

function shellWith(pendingId: string | null) {
  return {
    hasPendingUserInput: pendingId !== null,
    source: { pendingRuntimeRequest: pendingId === null ? null : { id: pendingId } },
  };
}

function announcements(
  frames: ReadonlyArray<Parameters<typeof threadActivitySnapshot>[0]>,
): ReadonlyArray<string | null> {
  let memory: ThreadAnnouncementMemory | null = null;
  return frames.map((frame) => {
    const next = nextThreadAnnouncement(memory, threadActivitySnapshot(frame));
    memory = next.memory;
    return next.announcement;
  });
}

const working = { runId: run, status: "running" as const };

describe("threadActivitySnapshot", () => {
  it("says each question once while the card and the shell catch up at different times", () => {
    expect(
      announcements([
        {
          approvalRequestId: null,
          userInputRequestId: null,
          shell: shellWith(null),
          working: false,
          run: null,
        },
        {
          approvalRequestId: null,
          userInputRequestId: null,
          shell: shellWith(null),
          working: true,
          run: working,
        },
        // The card shows question A before the shell has it.
        {
          approvalRequestId: null,
          userInputRequestId: "a",
          shell: shellWith(null),
          working: true,
          run: working,
        },
        {
          approvalRequestId: null,
          userInputRequestId: "a",
          shell: shellWith("a"),
          working: true,
          run: working,
        },
        // Answered: the card hides A at once, the shell still holds it.
        {
          approvalRequestId: null,
          userInputRequestId: null,
          shell: shellWith("a"),
          working: true,
          run: working,
        },
        // Question B reaches the card while the shell still holds A.
        {
          approvalRequestId: null,
          userInputRequestId: "b",
          shell: shellWith("a"),
          working: true,
          run: working,
        },
        {
          approvalRequestId: null,
          userInputRequestId: "b",
          shell: shellWith("b"),
          working: true,
          run: working,
        },
        {
          approvalRequestId: null,
          userInputRequestId: null,
          shell: shellWith(null),
          working: true,
          run: working,
        },
        {
          approvalRequestId: null,
          userInputRequestId: null,
          shell: shellWith(null),
          working: false,
          run: { runId: run, status: "completed" },
        },
      ]),
    ).toEqual([
      null,
      "Working",
      "Needs your input",
      null,
      null,
      "Needs your input",
      null,
      null,
      "Done",
    ]);
  });
});
