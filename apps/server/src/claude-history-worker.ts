import { runClaudeHistoryWorker } from "./claudeHistoryWorker.ts";

const [method, sessionId, rawOptions] = process.argv.slice(2);
await runClaudeHistoryWorker(method, sessionId, rawOptions);
