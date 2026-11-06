import {
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/** Exceed the 30-minute idle timeout to force a fresh process; the second prompt requires resumed history. */
export function providerThreadResumeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: PROVIDER_THREAD_RESUME_FIRST_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: PROVIDER_THREAD_RESUME_SECOND_PROMPT },
    ],
  };
}
