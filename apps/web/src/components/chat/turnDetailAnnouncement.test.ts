import { MessageId, RunAttemptId, RunId, type ScreenReaderAnnouncements } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineAttempt, TimelineEntry, WorkLogEntry } from "../../session-logic";
import {
  nextTurnDetailAnnouncement,
  turnDetail,
  type TurnDetailMemory,
  type TurnDetailSnapshot,
  type TurnMessage,
} from "./turnDetailAnnouncement";

const run = RunId.make("run-1");
const at = "2026-01-01T00:00:00.000Z";

function message(
  id: string,
  role: "user" | "assistant",
  fields: Partial<Extract<TimelineEntry, { kind: "message" }>["message"]> = {},
): TimelineEntry {
  return {
    kind: "message",
    id,
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      runId: role === "assistant" ? run : null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
      ...fields,
    },
  };
}

function work(id: string, fields: Partial<WorkLogEntry> = {}): TimelineEntry {
  return {
    kind: "work",
    id,
    createdAt: at,
    entry: { id, createdAt: at, runId: run, label: id, tone: "tool", ...fields },
  };
}

const prompt = message("prompt", "user");
const command = (id: string, fields: Partial<WorkLogEntry> = {}) =>
  work(id, {
    itemType: "command_execution",
    command: "git status",
    toolLifecycleStatus: "inProgress",
    ...fields,
  });
const notice = work("notice", { itemType: "system_notice", tone: "info", label: "Heads up" });
const steer = message("steer", "user", { inputIntent: "steer" });
const time = (clock: string) => DateTime.makeUnsafe(`2026-01-01T${clock}.000Z`);
const inAttempt = (
  entry: TimelineEntry,
  id: string,
  status: TimelineAttempt["status"],
  completed?: string,
): TimelineEntry => ({
  ...entry,
  attempt: {
    id: RunAttemptId.make(id),
    runId: run,
    attemptOrdinal: 1,
    rootNodeId: `${id}-root` as TimelineAttempt["rootNodeId"],
    status,
    completedAt: completed === undefined ? null : time(completed),
  },
});
const completedAt = (entry: TimelineEntry, clock: string) =>
  ({
    ...entry,
    projectedItem: {
      item: { type: "assistant_message", status: "completed", completedAt: time(clock) },
    },
  }) as TimelineEntry;

describe("turnDetail", () => {
  it.each<{
    name: string;
    entries: ReadonlyArray<TimelineEntry>;
    activity: string | null;
  }>([
    { name: "a running command", entries: [prompt, command("git")], activity: "Running git" },
    {
      name: "reasoning, without its text",
      entries: [
        prompt,
        work("thought", { itemType: "reasoning", tone: "thinking", detail: "Private idea." }),
      ],
      activity: "Thinking",
    },
    {
      name: "a file change, with the verb its icon stands for",
      entries: [prompt, work("edit", { itemType: "file_change", changedFiles: ["search.ts"] })],
      activity: "Editing search.ts",
    },
    {
      name: "the step under a request and a notice",
      entries: [prompt, command("git"), work("ask", { itemType: "approval_request" }), notice],
      activity: "Running git",
    },
    {
      name: "nothing for a failed step",
      entries: [prompt, command("git", { toolLifecycleStatus: "failed" })],
      activity: null,
    },
    {
      name: "nothing once the agent is writing again",
      entries: [prompt, command("git"), message("reply", "assistant", { streaming: true })],
      activity: null,
    },
    {
      name: "the context being compacted",
      entries: [
        prompt,
        command("git"),
        work("compact", {
          tone: "info",
          sourceActivityKind: "context-compaction",
          label: "Compacting context",
          toolLifecycleStatus: "inProgress",
        }),
      ],
      activity: "Compacting context",
    },
    {
      name: "nothing once the context is compacted",
      entries: [
        prompt,
        command("git"),
        work("compact", {
          tone: "info",
          sourceActivityKind: "context-compaction",
          label: "Context compacted",
          toolLifecycleStatus: "completed",
        }),
      ],
      activity: null,
    },
    {
      name: "nothing from the turn before",
      entries: [message("earlier", "user"), command("git"), prompt],
      activity: null,
    },
  ])("names $name", ({ entries, activity }) => {
    expect(turnDetail(entries, undefined, null).activity).toBe(activity);
  });

  it("cuts a long step without splitting an emoji", () => {
    const edit = work("edit", { itemType: "file_change", changedFiles: [`${"a".repeat(111)}😀z`] });
    expect(turnDetail([prompt, edit], undefined, null).activity).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it.each<{
    name: string;
    entries: ReadonlyArray<TimelineEntry>;
    finished: ReadonlyArray<string>;
  }>([
    {
      name: "a message the agent kept working after, but not its last",
      entries: [
        prompt,
        message("first", "assistant"),
        command("git"),
        message("last", "assistant"),
      ],
      finished: ["first"],
    },
    {
      name: "a message once the next one starts",
      entries: [
        prompt,
        message("first", "assistant"),
        message("second", "assistant", { streaming: true }),
      ],
      finished: ["first"],
    },
    {
      name: "no reply a steer cut off",
      entries: [
        prompt,
        inAttempt(message("cut off", "assistant"), "attempt-1", "superseded"),
        steer,
        inAttempt(command("git"), "attempt-2", "running"),
      ],
      finished: [],
    },
    {
      name: "a reply that completed before a steer replaced its attempt",
      entries: [
        prompt,
        completedAt(
          inAttempt(message("complete", "assistant"), "attempt-1", "superseded", "00:00:10"),
          "00:00:04",
        ),
        steer,
        inAttempt(command("git"), "attempt-2", "running"),
      ],
      finished: ["complete"],
    },
    {
      name: "no last message that only a notice follows",
      entries: [prompt, command("git"), message("last", "assistant"), notice],
      finished: [],
    },
    {
      name: "no last message when another run picks the thread up",
      entries: [
        prompt,
        message("last", "assistant"),
        command("git", { runId: RunId.make("run-2") }),
      ],
      finished: [],
    },
  ])("counts $name as finished", ({ entries, finished }) => {
    const { messages } = turnDetail(entries, undefined, null);
    expect(messages.filter((spoken) => spoken.finished).map((spoken) => spoken.text)).toEqual(
      finished,
    );
  });

  it.each<{ name: string; knownTailId: string | null; fresh: ReadonlyArray<boolean> }>([
    { name: "after the entry last seen", knownTailId: "seen", fresh: [false, true] },
    { name: "after a prompt that was last seen", knownTailId: "prompt", fresh: [true, true] },
    { name: "not when the entry last seen is gone", knownTailId: "gone", fresh: [false, false] },
  ])("marks messages as fresh $name", ({ knownTailId, fresh }) => {
    const entries = [
      prompt,
      message("loaded", "assistant"),
      command("seen"),
      message("new", "assistant"),
      command("git"),
    ];
    expect(
      turnDetail(entries, undefined, knownTailId).messages.map((spoken) => spoken.fresh),
    ).toEqual(fresh);
  });
});

type Frame = Pick<TurnDetailSnapshot, "status" | "activity" | "messages">;
const said = (id: string, finished = true, fresh = false): TurnMessage => ({
  id,
  text: id,
  finished,
  fresh,
});
const frame = (
  activity: string | null,
  messages: ReadonlyArray<TurnMessage> = [],
  status: TurnDetailSnapshot["status"] = "working",
): Frame => ({ status, activity, messages });

function speak(level: ScreenReaderAnnouncements, frames: ReadonlyArray<Frame>) {
  let memory: TurnDetailMemory | null = null;
  const spoken: string[] = [];
  for (const next of frames) {
    const result = nextTurnDetailAnnouncement(memory, { ...next, level, tailId: null });
    memory = result.memory;
    spoken.push(...result.messages);
    if (result.activity !== null) spoken.push(result.activity);
  }
  return spoken;
}

describe("nextTurnDetailAnnouncement", () => {
  const turn = [
    frame(null),
    frame("Running git", [said("first", false)]),
    frame("Running git", [said("first", false)]),
    frame("Reading a.ts", [said("first"), said("second", false)]),
    frame(null, [said("first"), said("second")]),
  ];

  it.each<{ level: ScreenReaderAnnouncements; spoken: ReadonlyArray<string> }>([
    { level: "status", spoken: [] },
    { level: "messages", spoken: ["T3 Code: first", "T3 Code: second"] },
    {
      level: "everything",
      spoken: ["Running git", "T3 Code: first", "Reading a.ts", "T3 Code: second"],
    },
  ])("says each message and step once at the $level level", ({ level, spoken }) => {
    expect(speak(level, turn)).toEqual(spoken);
  });

  it("stays silent about what was there when the thread opened", () => {
    expect(
      speak("everything", [
        frame("Running git", [said("first")]),
        frame("Running git", [said("first")]),
        frame("Reading a.ts", [said("first"), said("second", true, true)]),
      ]),
    ).toEqual(["T3 Code: second", "Reading a.ts"]);
  });

  it("stays silent about history loaded above the messages it knows", () => {
    expect(
      speak("messages", [
        frame(null, [said("recent")]),
        frame(null, [said("older"), said("recent")]),
        frame(null, [said("older"), said("recent")]),
      ]),
    ).toEqual([]);
  });

  it("reads Markdown as the text it renders and skips a message with none", () => {
    const first = {
      ...said("first", true, true),
      text: "**Tests** pass in `web`.\n\n- See [the docs](https://x.test/a(b)c?token=secret)<br>",
    };
    expect(
      speak("messages", [
        frame(null),
        frame(null, [first, { ...said("empty", true, true), text: "<!-- note -->" }]),
      ]),
    ).toEqual(["T3 Code: Tests pass in web. See the docs"]);
  });

  it("cuts a long message without splitting an emoji", () => {
    const long = { ...said("long", true, true), text: `${"a".repeat(1999)}😀z` };
    const [spoken] = speak("messages", [frame(null), frame(null, [long])]);
    expect(spoken).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("says a step again after waiting on the user", () => {
    expect(
      speak("everything", [
        frame(null),
        frame("Running git"),
        frame("Running git", [], "approval"),
        frame("Running git"),
      ]),
    ).toEqual(["Running git", "Running git"]);
  });

  it("stays silent about a turn that already ended", () => {
    expect(
      speak("everything", [
        frame(null, [], "idle"),
        frame("Running git", [said("first", true, true)], "idle"),
        frame("Running git", [said("first")]),
      ]),
    ).toEqual(["Running git"]);
  });
});
