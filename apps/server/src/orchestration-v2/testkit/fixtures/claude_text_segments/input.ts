import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_TEXT_SEGMENTS_PROMPT = "List the workspace files, narrating before and after.";

/**
 * Regression for merged assistant text (audit plan #11, thread
 * thread:mcp:6d618dc4 on build fc23be8184): interleaved assistant text
 * segments were accumulated and emitted as ONE item at result time — text
 * joined with no separator and ordered after all tool calls, losing the
 * narrate → tool → narrate structure. Each SDK assistant message uuid must
 * project its own assistant_message item at its position in the stream.
 */
export function claudeTextSegmentsInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_TEXT_SEGMENTS_PROMPT }],
  };
}
