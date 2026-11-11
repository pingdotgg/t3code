import {
  nextThreadAnnouncement,
  type ThreadAnnouncementMemory,
} from "@t3tools/client-runtime/state/thread-activity-announcement";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextThreadActivitySnapshot,
  type ThreadActivityInput,
  type ThreadActivityMemory,
} from "./threadStatusAnnouncement";

const run = RunId.make("run-1");

/** A frame of a working turn: what the question card shows and what the shell holds. */
function frame(card: string | null, shell: string | null): ThreadActivityInput {
  return {
    approvalRequestId: null,
    userInputRequestId: card,
    shellRequestId: shell,
    shellPendingUserInput: shell !== null,
    working: true,
    run: { runId: run, status: "running" },
  };
}

const idle: ThreadActivityInput = { ...frame(null, null), working: false, run: null };
const done: ThreadActivityInput = {
  ...frame(null, null),
  working: false,
  run: { runId: run, status: "completed" },
};

function announcements(frames: ReadonlyArray<ThreadActivityInput>): ReadonlyArray<string | null> {
  let activity: ThreadActivityMemory | null = null;
  let memory: ThreadAnnouncementMemory | null = null;
  return frames.map((input) => {
    activity = nextThreadActivitySnapshot(activity, input);
    const next = nextThreadAnnouncement(memory, activity.snapshot);
    memory = next.memory;
    return next.announcement;
  });
}

describe("nextThreadActivitySnapshot", () => {
  it("says each question once while the card and the shell catch up at different times", () => {
    expect(
      announcements([
        idle,
        frame(null, null),
        // The card shows question A before the shell has it.
        frame("a", null),
        frame("a", "a"),
        // Answered: the card hides A at once, the shell still holds it.
        frame(null, "a"),
        // Question B reaches the card while the shell still holds A, and is answered before the shell has B.
        frame("b", "a"),
        frame(null, "a"),
        frame(null, "b"),
        frame(null, null),
        // A secret request shows only in the shell.
        frame(null, "secret"),
        frame(null, null),
        done,
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
      null,
      "Needs your input",
      null,
      "Done",
    ]);
  });
});
