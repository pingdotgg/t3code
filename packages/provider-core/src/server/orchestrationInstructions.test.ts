import { describe, expect, it } from "vite-plus/test";

import {
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

// Codex native spawn copies the parent's reasoning effort and service tier, so inherited
// Codex options alone must not push plain subagent requests onto delegate_task (#23525).
describe("orchestration instructions for inherited Codex options", () => {
  const injected = {
    systemPrompt: t3OrchestrationSystemPrompt(true)!,
    firstRunPrompt: t3OrchestrationPromptForFirstRun({
      prompt: "Summarize two packages with parallel subagents.",
      runOrdinal: 1,
      hasT3Mcp: true,
    }),
  };

  it.each(Object.entries(injected))("%s lets Codex native subagents inherit options", (_, text) => {
    expect(text).not.toMatch(/no model options are requested or inherited/i);
    expect(text).toMatch(/Codex native subagents keep the parent's reasoning effort/i);
  });
});
