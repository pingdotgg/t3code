import type { RunId, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNextPromptChips,
  nextPromptChipDraft,
  nextPromptChipFor,
  nextPromptChipsAllowed,
  nextPromptCommandsToFreeze,
  offeredNextPromptCommands,
  visibleNextPromptChips,
} from "./nextPromptChips";

const runId = "run-1" as RunId;

describe("buildNextPromptChips", () => {
  const suggestions = [
    { text: "Use React.", kind: "prompt" as const },
    { text: "use react", kind: "prompt" as const },
    { text: "review", kind: "skill" as const },
    { text: "compact", kind: "command" as const },
    { text: "Ship it", kind: "prompt" as const },
    { text: "Park it", kind: "prompt" as const },
  ];

  it("dedupes by trailing punctuation and keeps four", () => {
    const chips = buildNextPromptChips({
      enabled: true,
      completedRunId: runId,
      data: { runId, suggestions },
    });
    expect(chips.map((chip) => chip.insertText)).toEqual([
      "Use React.",
      "$review ",
      "/compact ",
      "Ship it",
    ]);
    expect(chips[1]?.label).toBe("$review");
  });

  it("puts the provider's predicted prompt first unless the reply has options", () => {
    const data = { runId, suggestions: [{ text: "Ship it", kind: "prompt" as const }] };
    const built = (input: { enabled: boolean; data: typeof data | null; fromReply?: boolean }) =>
      buildNextPromptChips({
        enabled: input.enabled,
        completedRunId: runId,
        data: input.data && { ...input.data, ...(input.fromReply ? { fromReply: true } : {}) },
        builtInSuggestion: "Run the tests",
      }).map((chip) => chip.insertText);
    expect(built({ enabled: true, data })).toEqual(["Run the tests", "Ship it"]);
    expect(built({ enabled: true, data: null })).toEqual(["Run the tests"]);
    expect(built({ enabled: true, data, fromReply: true })).toEqual(["Ship it"]);
    expect(built({ enabled: false, data: null })).toEqual([]);
  });

  it("shows model guesses only with the Labs switch on", () => {
    const data = { runId, suggestions };
    expect(buildNextPromptChips({ enabled: false, completedRunId: runId, data })).toEqual([]);
    expect(
      buildNextPromptChips({
        enabled: false,
        completedRunId: runId,
        data: { ...data, fromReply: true },
      }),
    ).toHaveLength(4);
  });

  it("ignores suggestions for another run or no completed run", () => {
    const data = { runId, suggestions };
    expect(buildNextPromptChips({ enabled: true, completedRunId: "run-2" as RunId, data })).toEqual(
      [],
    );
    expect(buildNextPromptChips({ enabled: true, completedRunId: null, data })).toEqual([]);
  });
});

describe("visibleNextPromptChips", () => {
  const chips = [nextPromptChipFor("prompt", "Ship it"), nextPromptChipFor("skill", "review")];

  it("shows the buttons for an empty or untouched composer", () => {
    expect(visibleNextPromptChips(chips, "")).toEqual({ chips, activeIndex: -1 });
    expect(visibleNextPromptChips(chips, "$review ")).toEqual({ chips, activeIndex: 1 });
  });

  it("hides them once the person types", () => {
    expect(visibleNextPromptChips(chips, "Ship it now")).toEqual({ chips: [], activeIndex: -1 });
  });
});

describe("nextPromptChipDraft", () => {
  const chips = [nextPromptChipFor("prompt", "Ship it"), nextPromptChipFor("command", "compact")];

  it("fills an empty box or swaps an untouched suggestion", () => {
    expect(nextPromptChipDraft(chips, "", chips[1]!)).toBe("/compact ");
    expect(nextPromptChipDraft(chips, "Ship it", chips[1]!)).toBe("/compact ");
  });

  it("never replaces the person's own text", () => {
    expect(nextPromptChipDraft(chips, "my words", chips[0]!)).toBeNull();
  });
});

describe("offeredNextPromptCommands", () => {
  it("lists enabled, user-invocable skills and every slash command", () => {
    const skills = [
      { name: "review", enabled: true, shortDescription: "Review code" },
      { name: "hidden", enabled: true, userInvocable: false },
      { name: "off", enabled: false },
    ] as unknown as ServerProvider["skills"];
    const slashCommands = [{ name: "compact" }] as unknown as ServerProvider["slashCommands"];
    expect(offeredNextPromptCommands(skills, slashCommands)).toEqual([
      { name: "review", kind: "skill", description: "Review code" },
      { name: "compact", kind: "command" },
    ]);
  });
});

describe("nextPromptCommandsToFreeze", () => {
  const provider = {
    skills: [{ name: "review", enabled: true }],
    slashCommands: [{ name: "compact" }],
  } as unknown as ServerProvider;

  it("waits while the server config is still loading", () => {
    expect(nextPromptCommandsToFreeze({ configLoaded: false, provider: null })).toBeNull();
    expect(nextPromptCommandsToFreeze({ configLoaded: false, provider })).toBeNull();
  });

  it("freezes an empty list once loaded without a provider, so options chips still show", () => {
    expect(nextPromptCommandsToFreeze({ configLoaded: true, provider: null })).toEqual([]);
  });

  it("freezes the provider's skills and commands once loaded", () => {
    expect(nextPromptCommandsToFreeze({ configLoaded: true, provider })).toEqual([
      { name: "review", kind: "skill" },
      { name: "compact", kind: "command" },
    ]);
  });
});

describe("nextPromptChipsAllowed", () => {
  const idle = {
    isDraft: false,
    sentSinceLatestRun: false,
    canOperateThread: true,
    threadBusy: false,
    queuedMessageCount: 0,
    editingQueuedMessage: false,
    submissionLocked: false,
    voiceInputPresented: false,
    modelUnavailable: false,
    attachmentCount: 0,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };

  it("shows for an idle thread waiting for the next message", () => {
    expect(nextPromptChipsAllowed(idle)).toBe(true);
  });

  it("hides while a sent message waits to reach the server", () => {
    expect(nextPromptChipsAllowed({ ...idle, queuedMessageCount: 1 })).toBe(false);
  });

  it("stays hidden once a message was sent after the latest run", () => {
    expect(nextPromptChipsAllowed({ ...idle, sentSinceLatestRun: true })).toBe(false);
  });

  it("hides while busy or over a question, approval or plan", () => {
    expect(nextPromptChipsAllowed({ ...idle, threadBusy: true })).toBe(false);
    expect(nextPromptChipsAllowed({ ...idle, hasPendingApprovals: true })).toBe(false);
    expect(nextPromptChipsAllowed({ ...idle, hasPendingUserInput: true })).toBe(false);
    expect(nextPromptChipsAllowed({ ...idle, hasActionableProposedPlan: true })).toBe(false);
    expect(nextPromptChipsAllowed({ ...idle, attachmentCount: 1 })).toBe(false);
  });
});
