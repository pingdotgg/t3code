/** Web bindings for Claude Code → Codex bridge login (fork feature f5). */
import { createClaudeCodexRoutingEnvironmentAtoms } from "@t3tools/client-runtime/state/claude-codex-routing";

import { connectionAtomRuntime } from "../connection/runtime";

export const claudeCodexRoutingEnvironment =
  createClaudeCodexRoutingEnvironmentAtoms(connectionAtomRuntime);
