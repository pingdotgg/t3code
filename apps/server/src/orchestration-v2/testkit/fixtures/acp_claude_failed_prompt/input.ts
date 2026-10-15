import type { OrchestratorFixtureInput } from "../shared.ts";

const ACP_CLAUDE_FAILED_PROMPT = "Check my account settings.";

// Claude Agent on ACP v2. Claude takes the prompt in, starts a tool and a
// reply, and its work fails: the idle carries the `error` stop reason and the
// JSON-RPC error a v1 prompt would fail with.
export function acpClaudeFailedPromptInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: ACP_CLAUDE_FAILED_PROMPT }] };
}
