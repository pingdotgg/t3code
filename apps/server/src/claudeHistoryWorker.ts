import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// A separate process gives SDK history helpers the provider's environment without
// mutating the server's environment. This entry is bundled alongside the server.
const [method, sessionId, rawOptions] = process.argv.slice(2);
const options = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
    }),
  ),
)(rawOptions ?? "{}");
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
