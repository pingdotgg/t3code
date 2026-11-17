import { RunId, ThreadId, type OrchestrationV2ThreadGroup } from "@t3tools/contracts";

import type { ThreadStructureTurnItem } from "./models.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupAudienceForPrompt,
  groupMentionOccurrences,
  groupParticipants,
  groupRowSpeaker,
  isQuietPass,
  withoutCloseLine,
  isSeatedSeatThread,
  runningSeats,
  seatActivityLabel,
} from "./threadGroup.ts";

const astra = ThreadId.make("thread-astra");
const opus = ThreadId.make("thread-opus");

const group: OrchestrationV2ThreadGroup = {
  status: "active",
  primary: { model: "fable-5", label: "Fable", handle: "fable" },
  seats: [
    { threadId: astra, handle: "astra", label: "Astra", status: "seated", joinedAfterRun: 0 },
    { threadId: opus, handle: "opus", label: "Opus", status: "left", joinedAfterRun: 0 },
  ],
  discussion: null,
  closedBecause: null,
  closedAt: null,
};

describe("groupParticipants", () => {
  it("lists the primary then seated peers, leaving out seats that left", () => {
    expect(groupParticipants(group).map((p) => [p.member, p.handle])).toEqual([
      ["primary", "fable"],
      [astra, "astra"],
    ]);
    expect(isSeatedSeatThread(group, astra)).toBe(true);
    expect(isSeatedSeatThread(group, opus)).toBe(false);
  });
});

describe("groupAudienceForPrompt", () => {
  it.each([
    ["no group is active", { ...group, status: "ended" as const }, "@astra hi ", undefined],
    ["no chip", group, "what do you all think ", "everyone"],
    ["a seated peer", group, "@astra what do you think ", [astra]],
    [
      "the primary by handle, in any case",
      group,
      "@Fable and @astra weigh in ",
      ["primary", astra],
    ],
    ["a name that is not a member", group, "@README.md please ", "everyone"],
    ["a peer that left", group, "@opus hello ", "everyone"],
    ["a peer at the end of the prompt", group, "what do you think @astra", [astra]],
    ["the primary alias", group, "@PRIMARY please answer", ["primary"]],
    ["only a peer", group, "@astra", [astra]],
    ["a peer before a comma", group, "@astra, what do you think?", [astra]],
    ["a peer before a colon", group, "@astra: what do you think?", [astra]],
    ["a peer before a question mark", group, "thoughts, @astra?", [astra]],
    ["a peer in parentheses", group, "(@astra) what do you think?", [astra]],
    ["an email address", group, "mail me@astra.com about it", "everyone"],
    ["a bare email address", group, "me@astra", "everyone"],
    ["a file mention", group, "look at @astra.ts please", "everyone"],
  ])("%s", (_name, thread, prompt, expected) => {
    expect(groupAudienceForPrompt(thread, prompt)).toEqual(expected);
  });
});

describe("groupMentionOccurrences", () => {
  const mention = (
    text: string,
    source: string,
    label: string,
    isPrimary: boolean,
    member: ThreadId | "primary",
  ) => {
    const start = text.indexOf(source);
    return { start, end: start + source.length, source, label, isPrimary, member };
  };
  it.each([
    ["an email address", "mail me@astra.com about it", []],
    ["a bare email address", "me@astra", []],
    ["a file mention", "look at @astra.ts please", []],
    [
      "trailing punctuation",
      "@astra, what do you think?",
      [mention("@astra, what do you think?", "@astra", "Astra", false, astra)],
    ],
    [
      "the primary alias",
      "hello @PRIMARY",
      [mention("hello @PRIMARY", "@PRIMARY", "Fable", true, "primary")],
    ],
    ["an unknown handle", "@README.md please", []],
    [
      "a seat that left",
      "ask @opus please",
      [mention("ask @opus please", "@opus", "Opus", false, opus)],
    ],
    [
      "the handle's own case",
      "ask @Astra please",
      [mention("ask @Astra please", "@Astra", "Astra", false, astra)],
    ],
  ])("%s", (_name, text, expected) => {
    expect(groupMentionOccurrences(text, group)).toEqual(expected);
  });

  it("leaves a departed seat out of audience routing", () => {
    expect(groupMentionOccurrences("ask @opus please", group, { seatedOnly: true })).toEqual([]);
  });
});

describe("withoutCloseLine", () => {
  it.each([
    ["Use a log.\n\n@user", "Use a log."],
    ["Use a log.\n@USER  ", "Use a log."],
    ["Ask @user about it.", "Ask @user about it."],
    ["Ask @user", "Ask @user"],
    ["Answer.\n@astra @user", "Answer.\n@astra @user"],
    ["Answer.\r\n  @user\n", "Answer."],
    ["Use a log.\n@astra", "Use a log.\n@astra"],
    ["@user", "@user"],
  ])("reads %j as %j", (text, expected) => {
    expect(withoutCloseLine(text)).toBe(expected);
  });
});

describe("isQuietPass", () => {
  it.each([
    ["PASS", true],
    ["PASS\n", true],
    ["pass", false],
    ["PASS, I agree", false],
  ])("%j", (text, expected) => {
    expect(isQuietPass(text)).toBe(expected);
  });
});

describe("groupRowSpeaker", () => {
  const primaryRun = { modelSelection: { instanceId: "i", model: "fable-5" } } as never;
  it("prefers a peer's own snapshot and names the primary from the run", () => {
    expect(groupRowSpeaker(group, { speaker: { label: "Astra", model: "gpt-6" } })).toEqual({
      label: "Astra",
      model: "gpt-6",
    });
    expect(groupRowSpeaker(group, { run: primaryRun })).toEqual({
      label: "Fable",
      model: "fable-5",
    });
  });

  it("names a switched primary by its model and leaves ordinary threads unlabeled", () => {
    const switched = { modelSelection: { instanceId: "i", model: "opus-5" } } as never;
    expect(groupRowSpeaker(group, { run: switched })?.label).toBe("opus-5");
    expect(groupRowSpeaker(null, { run: primaryRun })).toBeNull();
  });
});

describe("runningSeats", () => {
  it("counts only seated seats whose thread has an open run", () => {
    const shells = new Map([
      [astra, { id: astra, runtime: { status: "running" } }],
      [opus, { id: opus, runtime: { status: "running" } }],
    ]);
    expect(runningSeats(group, (id) => shells.get(id) as never).map((s) => s.threadId)).toEqual([
      astra,
    ]);
  });
});

describe("seatActivityLabel", () => {
  it("describes the newest unfinished item of the open run", () => {
    const items = [
      { type: "file_change", status: "completed", runId: "r1", ordinal: 1, fileName: "a.ts" },
      { type: "command_execution", status: "running", runId: "r1", ordinal: 2, input: "pnpm test" },
      { type: "reasoning", status: "running", runId: "r0", ordinal: 9 },
    ] as never as ReadonlyArray<ThreadStructureTurnItem>;
    expect(seatActivityLabel(items, RunId.make("r1"))).toBe("running pnpm test");
    expect(seatActivityLabel([], RunId.make("r1"))).toBe("working");
  });
});
