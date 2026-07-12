import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_IDLE_RESUME_PROMPT_1 = "Respond with exactly: idle resume first turn complete";
export const CLAUDE_IDLE_RESUME_PROMPT_2 = "Respond with exactly: idle resume second turn complete";

/**
 * Regression for the stale-session first-message failure (threads 47763f5e
 * run 10 and d0fe9018 runs 7/8, 2026-07-01/02): the provider session manager
 * idle-releases the session runtime between turns, wiping the adapter's
 * in-memory openedNativeThreads set. The next turn must reopen the SDK query
 * with `resume` (the persisted provider thread proves the native session
 * exists) — a create-style `sessionId` open fails against an existing
 * session and burned the user's first message after every idle gap.
 */
export function claudeIdleResumeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_IDLE_RESUME_PROMPT_1 },
      // Past ProviderSessionManager's 30-minute idle timeout: the reaper
      // releases the live session entry and closes the SDK query.
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: CLAUDE_IDLE_RESUME_PROMPT_2 },
    ],
  };
}
