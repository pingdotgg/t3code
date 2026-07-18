import { describe, expect, it } from "vite-plus/test";

import {
  applyExactComposerEdits,
  shouldContinueAfterVoiceTools,
  voiceInstructions,
} from "./VoiceSession";

describe("voiceInstructions", () => {
  it("requires tool calls before any spoken preamble", () => {
    const instructions = voiceInstructions("Latest task context");

    expect(instructions).toContain("Spoken preambles are disabled for every tool");
    expect(instructions).toContain("the function call must be the first response item");
    expect(instructions).toContain(
      "Correct order: function call -> tool result -> concise spoken answer",
    );
  });

  it("targets concise technical conversation and supports silence", () => {
    const instructions = voiceInstructions(null);

    expect(instructions).toContain("The user is a software developer");
    expect(instructions).toContain("Default spoken answer budget: 35 words");
    expect(instructions).toContain("never more than two short sentences");
    expect(instructions).toContain('Do not end with "anything else?"');
    expect(instructions).toContain("call stay_silent");
    expect(instructions).toContain("produce no conversational response");
  });
});

describe("shouldContinueAfterVoiceTools", () => {
  it("does not request speech after a no-op tool", () => {
    expect(shouldContinueAfterVoiceTools(["stay_silent"])).toBe(false);
    expect(shouldContinueAfterVoiceTools(["stay_silent", "search_web"])).toBe(true);
    expect(shouldContinueAfterVoiceTools(["read_composer"])).toBe(true);
  });
});

describe("applyExactComposerEdits", () => {
  it("applies multiple exact edits in order", () => {
    expect(
      applyExactComposerEdits("Draft a long prompt about React.", [
        { oldText: "long", newText: "concise" },
        { oldText: "React", newText: "T3 Code" },
      ]),
    ).toEqual({ ok: true, text: "Draft a concise prompt about T3 Code." });
  });

  it("rejects missing and ambiguous matches without changing text", () => {
    expect(applyExactComposerEdits("one two", [{ oldText: "three", newText: "four" }])).toEqual({
      ok: false,
      error: "An oldText block was not found exactly in the composer.",
    });
    expect(applyExactComposerEdits("one one", [{ oldText: "one", newText: "two" }])).toEqual({
      ok: false,
      error: "An oldText block matched more than once. Include more surrounding text.",
    });
  });
});
