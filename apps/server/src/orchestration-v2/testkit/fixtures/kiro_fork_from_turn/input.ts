import {
  THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/** Forks from the first of two turns, so the fork must leave the second behind. */
export function kiroForkFromTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT },
      { type: "message", text: THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT },
      { type: "fork", fromRunIndex: 1, text: THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT },
    ],
  };
}
