import type { OrchestratorFixtureInput } from "../shared.ts";

export const KIRO_EFFORT_PROMPT = "Respond with exactly: kiro effort";
export const KIRO_EFFORT_MODEL = "claude-opus-5.5";
export const KIRO_EFFORT_LEVEL = "high";

/**
 * One turn on a Kiro model with reasoning effort, the level picked in the
 * thread's model selection. Kiro advertises `effortLevel` only once the
 * written model runs, so the level must go out after that advert.
 */
export function kiroEffortInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: KIRO_EFFORT_PROMPT }] };
}
