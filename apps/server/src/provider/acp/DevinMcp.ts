import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AcpTransportError } from "effect-acp/errors";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeConnected = Schema.decodeUnknownEffect(
  Schema.Struct({ connectionStatus: Schema.Literal("connected") }),
);

// Devin ignores session/new.mcpServers. Its MCP extension can instead load a
// private configuration directory, without changing user or workspace settings.
export const prepareDevinMcp = Effect.fn("prepareDevinMcp")(function* (
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-mcp-" });
  const configDirectory = path.join(directory, ".devin");
  yield* fs.makeDirectory(configDirectory, { mode: 0o700 });
  yield* fs.writeFileString(
    path.join(configDirectory, "mcp_config.local.json"),
    encodeConfig({
      mcpServers: {
        "t3-code": {
          serverUrl: session.endpoint,
          headers: { Authorization: session.authorizationHeader },
        },
      },
    }),
    { mode: 0o600 },
  );
  const connect = (runtime: Pick<AcpSessionRuntime["Service"], "request">) =>
    runtime
      .request("_cognition.ai/mcp/connectServer", {
        serverId: "t3-code",
        workspaceDirs: [directory],
      })
      .pipe(
        Effect.flatMap(decodeConnected),
        Effect.timeout("20 seconds"),
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new AcpTransportError({ detail: "Devin could not connect to T3 Code tools.", cause }),
        ),
      );
  return { directory, connect };
});
