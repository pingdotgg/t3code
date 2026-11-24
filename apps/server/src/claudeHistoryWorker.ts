import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Bundled import.meta.main is always true; imports must have no side effects.
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
  if (method === "getSessionMessages") {
    process.stdout.write(JSON.stringify(await getSessionMessages(sessionId, options)));
    return;
  }
  if (method !== "forkSession") throw new Error("Unknown Claude history operation.");

  // Preserve the SDK message across the process boundary without dumping its minified source line.
  const forked = await forkSession(sessionId, options).catch((cause: unknown) => {
    process.stderr.write(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
    return undefined;
  });
  if (forked === undefined) return;
  const headMessageId = await getSessionMessages(forked.sessionId, options)
    .then((messages) => messages.at(-1)?.uuid)
    .catch(() => undefined);
  process.stdout.write(
    JSON.stringify(headMessageId === undefined ? forked : { ...forked, headMessageId }),
  );
}
