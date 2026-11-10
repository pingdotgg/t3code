import { MessageId, RunId, type ScreenReaderAnnouncements } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import {
  nextTurnDetailAnnouncement,
  turnDetail,
  type TurnDetail,
  type TurnDetailMemory,
  type TurnDetailSnapshot,
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

describe("turnDetail", () => {
  it.each<{
    name: string;
    entries: ReadonlyArray<TimelineEntry>;
    activity: string | null;
  }>([
    { name: "a running command", entries: [prompt, command("git")], activity: "Running git" },
    {
      name: "a command that already finished, until something follows it",
      entries: [prompt, command("git", { toolLifecycleStatus: "completed" })],
      activity: "Running git",
    },
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
      entries: [prompt, work("edit", { itemType: "file_change", changedFiles: ["src/a.ts"] })],
      activity: "Editing src/a.ts",
    },
    {
      name: "the step under a notice",
      entries: [prompt, command("git"), notice],
      activity: "Running git",
    },
    {
      name: "nothing for a failed step",
      entries: [prompt, command("git", { toolLifecycleStatus: "failed" })],
      activity: null,
    },
    {
      name: "the step a request was about",
      entries: [prompt, command("git"), work("ask", { itemType: "approval_request" })],
      activity: "Running git",
    },
    {
      name: "nothing once the agent is writing again",
      entries: [prompt, command("git"), message("reply", "assistant", { streaming: true })],
      activity: null,
    },
    {
      name: "nothing from the turn before",
      entries: [message("earlier", "user"), command("git"), prompt],
      activity: null,
    },
  ])("names $name", ({ entries, activity }) => {
    expect(turnDetail(entries, undefined).activity).toBe(activity);
  });

  it.each<{
    name: string;
    entries: ReadonlyArray<TimelineEntry>;
    messages: ReadonlyArray<string>;
  }>([
    {
      name: "a message the agent kept working after, but not its last",
      entries: [
        prompt,
        message("first", "assistant"),
        command("git"),
        message("last", "assistant"),
      ],
      messages: ["first"],
    },
    {
      name: "a message once the next one starts",
      entries: [
        prompt,
        message("first", "assistant"),
        message("second", "assistant", { streaming: true }),
      ],
      messages: ["first"],
    },
    {
      name: "a message across a steer",
      entries: [
        prompt,
        message("first", "assistant"),
        message("steer", "user", { inputIntent: "steer" }),
        command("git"),
      ],
      messages: ["first"],
    },
    {
      name: "nothing while the message is still streaming",
      entries: [prompt, message("first", "assistant", { streaming: true }), command("git")],
      messages: [],
    },
    {
      name: "nothing for a last message that only a notice follows",
      entries: [prompt, command("git"), message("last", "assistant"), notice],
      messages: [],
    },
    {
      name: "nothing for a last message when another run picks the thread up",
      entries: [
        prompt,
        message("last", "assistant"),
        command("git", { runId: RunId.make("run-2") }),
      ],
      messages: [],
    },
    {
      name: "nothing from the turn before",
      entries: [message("earlier", "user"), message("first", "assistant"), command("git"), prompt],
      messages: [],
    },
  ])("reads $name", ({ entries, messages }) => {
    expect(turnDetail(entries, undefined).messages.map((spoken) => spoken.text)).toEqual(messages);
  });
});

const working = (
  activity: string | null,
  messages: ReadonlyArray<string> = [],
  status: TurnDetailSnapshot["status"] = "working",
): TurnDetail & Pick<TurnDetailSnapshot, "status"> => ({
  status,
  activity,
  messages: messages.map((id) => ({ id, text: id })),
});

function speak(
  level: ScreenReaderAnnouncements,
  snapshots: ReadonlyArray<TurnDetail & Pick<TurnDetailSnapshot, "status">>,
) {
  let memory: TurnDetailMemory | null = null;
  const spoken: string[] = [];
  for (const snapshot of snapshots) {
    const result = nextTurnDetailAnnouncement(memory, { ...snapshot, level });
    memory = result.memory;
    spoken.push(...result.messages);
    if (result.activity !== null) spoken.push(result.activity);
  }
  return spoken;
}

describe("nextTurnDetailAnnouncement", () => {
  const turn = [
    working(null),
    working("Running git"),
    working("Running git"),
    working("Reading a.ts", ["first"]),
    working(null, ["first", "second"]),
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
        working("Running git", ["first"]),
        working("Running git", ["first"]),
        working("Reading a.ts", ["first", "second"]),
      ]),
    ).toEqual(["T3 Code: second", "Reading a.ts"]);
  });

  it("reads Markdown as plain text and skips a message with no text", () => {
    const message = (id: string, text: string) => ({ id, text });
    const first = message("first", "**Tests** pass in `web`.\n\n- See [docs](https://x)");
    expect(
      nextTurnDetailAnnouncement(
        { activity: null, spokenMessageIds: new Set() },
        {
          level: "messages",
          status: "working",
          activity: null,
          messages: [first, message("empty", "``")],
        },
      ).messages,
    ).toEqual(["T3 Code: Tests pass in web. See docs"]);
  });

  it("says a step again after waiting on the user", () => {
    expect(
      speak("everything", [
        working(null),
        working("Running git"),
        working("Running git", [], "approval"),
        working("Running git"),
      ]),
    ).toEqual(["Running git", "Running git"]);
  });

  it("stays silent about a turn that already ended", () => {
    expect(
      speak("everything", [
        working(null, [], "idle"),
        working("Running git", ["first"], "idle"),
        working("Running git", ["first"]),
      ]),
    ).toEqual(["Running git"]);
  });
});
