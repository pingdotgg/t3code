import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_VOICE_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3VoicePrompt,
  t3VoiceSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("t3VoiceSystemPrompt", () => {
  it("carries only the voice rules, and only with T3's MCP server", () => {
    assert.equal(t3VoiceSystemPrompt(true), T3_CODE_VOICE_INSTRUCTIONS);
    assert.isUndefined(t3VoiceSystemPrompt(false));
    assert.notInclude(T3_CODE_VOICE_INSTRUCTIONS, "delegate_task");
  });
});

describe("t3VoicePrompt", () => {
  it("prefixes the voice rules once per conversation", () => {
    const prompt = (voiceDelivered: boolean) =>
      t3VoicePrompt({ prompt: "Check the login screen.", hasT3Mcp: true, voiceDelivered });
    assert.include(prompt(false), T3_CODE_VOICE_INSTRUCTIONS);
    assert.equal(prompt(true), "Check the login screen.");
    assert.equal(t3VoicePrompt({ prompt: "Hi.", hasT3Mcp: false, voiceDelivered: false }), "Hi.");
  });
});

describe("t3AcpPromptWithInstructions", () => {
  it("sends the mode and voice rules again only when the state changes", () => {
    const state = { interactionMode: "default", hasT3Mcp: true } as const;
    const first = t3AcpPromptWithInstructions({ prompt: "Check the login screen.", state });
    assert.include(first, T3_CODE_VOICE_INSTRUCTIONS);
    assert.include(first, "## T3 Code interaction mode: Default");
    assert.notInclude(first, "delegate_task` for");
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt: "Plan it.",
        state: { ...state, interactionMode: "plan" },
        previousState: state,
      }),
      "## T3 Code interaction mode: Plan",
    );
  });
});
