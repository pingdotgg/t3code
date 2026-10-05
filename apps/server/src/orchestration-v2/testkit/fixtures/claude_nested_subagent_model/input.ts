import type { OrchestratorFixtureInput } from "../shared.ts";

// The outer Agent call names a model; the inner one names none, so the nested
// subagent runs on its owner's model rather than the session's.
export const CLAUDE_NESTED_SUBAGENT_MODEL_PROMPT = [
  "Live-test nested subagents. Do exactly this, with no extra steps.",
  "",
  '1) Call the Agent tool once with subagent_type "general-purpose", model "haiku", run_in_background false, and this prompt:',
  '   "Call the Agent tool once with subagent_type \\"general-purpose\\", run_in_background false, no model parameter, and the prompt: Reply with exactly NESTED_LEAF_OK. Then reply with exactly what that agent said."',
  "2) When it finishes, reply with exactly what it said.",
].join("\n");

export function claudeNestedSubagentModelInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_NESTED_SUBAGENT_MODEL_PROMPT }],
  };
}
