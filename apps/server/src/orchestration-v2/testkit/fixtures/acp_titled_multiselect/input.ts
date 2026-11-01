import type { OrchestratorFixtureInput } from "../shared.ts";

export const ACP_TITLED_MULTISELECT_PROMPT =
  "Ask which areas this fixture should cover, allowing several. After receiving the answer, respond exactly: titled multi-select fixture complete";

/**
 * An ACP form elicitation whose multi-select lists titled `anyOf` options.
 * The client submits option values, including one the form never offered.
 */
export function acpTitledMultiSelectInput(): OrchestratorFixtureInput {
  return {
    interactionMode: "plan",
    steps: [
      { type: "message", text: ACP_TITLED_MULTISELECT_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: { fixture_areas: ["ui", "unknown", "schemas"] },
      },
    ],
  };
}
