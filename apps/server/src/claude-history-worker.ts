// Standalone entry for npm-distributed runtimes: `node claudeHistoryWorker.mjs
// <method> <session-id> [options]`. The executable reaches the same worker
// through the `__claude-history` subcommand.
import { runClaudeHistoryWorker } from "./claudeHistoryWorker.ts";

const [method, sessionId, rawOptions] = process.argv.slice(2);
await runClaudeHistoryWorker(method, sessionId, rawOptions);
