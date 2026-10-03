import {
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/**
 * The idle gap outlasts ProviderSessionManager's 30-minute idle timeout, which
 * releases the provider session. The second message therefore starts a fresh
 * provider process that must resume the recorded native thread, and its prompt
 * only succeeds if the resumed thread kept the first turn's history.
 */
export function providerThreadResumeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: PROVIDER_THREAD_RESUME_FIRST_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: PROVIDER_THREAD_RESUME_SECOND_PROMPT },
    ],
  };
}
