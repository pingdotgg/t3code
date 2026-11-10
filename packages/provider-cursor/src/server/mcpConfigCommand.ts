import type { McpServerConfig } from "@cursor/sdk";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

class McpConfigCommandError extends Schema.TaggedError<McpConfigCommandError>()(
  "McpConfigCommandError",
  {},
) {
  override get message() {
    return "Cursor MCP configuration command failed. Check the command and its JSON output on the agent environment.";
  }
}

const Command = Schema.fromJsonString(Schema.Array(Schema.String));
const Config = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.Literal("http"),
        url: Schema.String,
        headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  }),
);

const decodeCommand = Schema.decodeEffect(Command);
const decodeConfig = Schema.decodeEffect(Config);

export const loadMcpConfigCommand = Effect.fn("Cursor.loadMcpConfigCommand")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | null;
  readonly threadId: string;
}) {
  const command = input.environment.T3CODE_CURSOR_MCP_CONFIG_COMMAND;
  if (!command) return {};
  const resolve = Effect.gen(function* () {
    const argv = yield* decodeCommand(command);
    const executable = argv[0];
    if (!executable || argv.some((arg) => arg.length === 0))
      return yield* new McpConfigCommandError({});
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(executable, argv.slice(1), {
        cwd: input.cwd ?? undefined,
        env: { ...input.environment, T3CODE_THREAD_ID: input.threadId },
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 1024 * 1024 }),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0 || stdout.truncated || stdout.invalidUtf8)
      return yield* new McpConfigCommandError({});
    const config = yield* decodeConfig(stdout.text);
    const result: Record<string, McpServerConfig> = {};
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (name === "t3-code") continue;
      if (
        !/^[a-zA-Z0-9_-]+$/.test(name) ||
        !/^https?:\/\//.test(server.url) ||
        !URL.canParse(server.url)
      )
        return yield* new McpConfigCommandError({});
      result[name] = server;
    }
    return result;
  });
  return yield* resolve.pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new McpConfigCommandError({})),
  );
});
