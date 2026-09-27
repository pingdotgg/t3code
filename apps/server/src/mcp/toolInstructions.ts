/**
 * Fork (toolboxmd/t3code#46): when to reach for the `t3-code` tools.
 *
 * Harnesses that defer tool schemas show agents only tool names, and Grok not
 * even those, so an agent never learns when to use `prism_submit` or
 * `spawn_thread`. `buildRuntimeInstructions` appends this to every harness's
 * launch prompt. MCP server `instructions` (Effect 4.0.0-rc.116+) would reach
 * Claude Code, Codex, OpenCode and Grok, but not Cursor over ACP, and
 * Antigravity only writes them to a file, so do not move it there. Adding it
 * to both would make Claude Code show it twice.
 */
const T3_CODE_TOOL_INSTRUCTIONS =
  "Reach for the t3-code tools when work should stay visible in this T3 Code thread: delegating to other agents, testing web or native UI, and linking Issues. Delegate with them, not with agents started in a terminal. For an authorized job that should end in one PR, call prism_submit: Prism picks models, recovers failures and wakes you only for judgment (prism_questions, then prism_answer). For small direct work, or when a specific model and effort is wanted, call spawn_thread, then read_thread and message_thread. For web UI: preview_open, preview_snapshot, then act. For simulators: device_list, then device_open.";

/** The launch-prompt block `buildRuntimeInstructions` appends. */
export const T3_CODE_TOOL_USE_BLOCK = `<t3_code_tool_use>\n${T3_CODE_TOOL_INSTRUCTIONS}\n</t3_code_tool_use>`;
