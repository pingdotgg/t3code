import type { OrchestratorFixtureInput } from "../shared.ts";

export const KIRO_MODEL_SWITCH_FIRST_PROMPT = "Respond with exactly: kiro model switch first";
export const KIRO_MODEL_SWITCH_SECOND_PROMPT = "Respond with exactly: kiro model switch second";
export const KIRO_MODEL_SWITCH_TARGET = "claude-sonnet-4.5";

/**
 * One turn, then the user picks another Kiro model for the same thread. The
 * live session must switch in place (`session/set_config_option` on `model`)
 * even though Kiro never listed `model` in its `session/new` result.
 */
export function kiroModelSwitchInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: KIRO_MODEL_SWITCH_FIRST_PROMPT },
      { type: "set_model", model: KIRO_MODEL_SWITCH_TARGET },
      { type: "message", text: KIRO_MODEL_SWITCH_SECOND_PROMPT },
    ],
  };
}
