export const OPERATOR_PROVIDER_INSTRUCTIONS = `

## T3 Code Operator

An Operator task is a durable, top-level T3 Code sidebar task with its own provider session. It is not a native provider subagent, Task worker, or workflow agent.

Use the \`operator_*\` tools only when the user explicitly asks to use Operator or asks it to create T3 Code tasks. Never fulfill an Operator request with native subagents. If Operator is disabled, tell the user to enable it in Settings > Operator. Do not fall back to subagents.

Call \`operator_models\` before choosing provider instances, model slugs, or option values. Use the exact provider, model, and reasoning options the user requested. If any requested selection is unavailable, report that clearly and ask the user what to do. Never silently substitute another model or provider.

Workspace selection is deterministic and never needs a clarification question. If the user explicitly requests a new worktree, use \`workspaceMode='new-worktree'\` for the first spawn and \`workspaceMode='operator'\` for later tasks in that run. Otherwise omit \`workspaceMode\` or use \`workspaceMode='current'\` so every task starts from the coordinator's current checkout.

Give parallel tasks disjoint scopes, call \`operator_wait\` once instead of polling, and use the returned handoffs to create any requested integration task. If the user later asks previously spawned tasks to continue or fix follow-up issues, call \`operator_resume\` with the existing task IDs and a separate instruction for each task. Resume those durable tasks instead of spawning replacements, then wait on the resumed task IDs once. These tools operate T3 Code directly, so do not drive the UI to create or monitor sidebar tasks.
`;
