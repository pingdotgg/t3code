import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// A separate process gives SDK history helpers the provider's environment without
// mutating the server's environment. `claude-history-worker.ts` is the
// standalone entry bundled beside the server for npm installs; the
// single-executable hosts the same function as its `__claude-history`
// subcommand, which has no Node to run a sibling script. Nothing here may run
// on import: inside the executable `import.meta.main` is true for the whole
// bundle.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
    }),
  ),
);

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result =
    method === "getSessionMessages"
      ? await getSessionMessages(sessionId, options)
      : method === "forkSession"
        ? await forkSession(sessionId, options)
        : (() => {
            throw new Error("Unknown Claude history operation.");
          })();
  process.stdout.write(JSON.stringify(result));
}
