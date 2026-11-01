// The SDK leaves editor variables literal; agent-level stdio clients take precedence.
import type { McpServerConfig } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import * as HostProcess from "@t3tools/shared/HostProcess";

// The SDK's own placeholder grammar: `${env:NAME}`, `${NAME}` and `${NAME:-default}`.
const PLACEHOLDER_PATTERN = /\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|([^:}]+)(?::-([^}]*))?)\}/g;
const WORKSPACE_VARIABLE_PATTERN =
  /\$\{(?:workspaceFolder|workspaceFolderBasename|userHome|pathSeparator|\/)\}/;

const StringRecord = Schema.Record(Schema.String, Schema.String);
const CursorMcpFile = Schema.Struct({
  mcpServers: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.Struct({
        type: Schema.optional(Schema.Literal("stdio")),
        command: Schema.String,
        args: Schema.optional(Schema.Array(Schema.String)),
        env: Schema.optional(StringRecord),
        cwd: Schema.optional(Schema.String),
        startupTimeoutSec: Schema.optional(Schema.Number),
      }),
      Schema.Struct({
        type: Schema.optional(Schema.Literals(["http", "sse"])),
        url: Schema.String,
      }),
    ]),
  ),
});
const decodeCursorMcpFile = Schema.decodeUnknownOption(CursorMcpFile);
const decodeDisabledServers = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

function expand<A>(value: A, resolve: (text: string) => string): A {
  if (typeof value === "string") return resolve(value) as A;
  if (Array.isArray(value)) return value.map((item: unknown) => expand(item, resolve)) as A;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expand(item, resolve)]),
    ) as A;
  }
  return value;
}

function someString(value: unknown, test: (text: string) => boolean): boolean {
  if (typeof value === "string") return test(value);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => someString(item, test));
  }
  return false;
}

/** Cursor's project slug, as `~/.cursor/projects/<slug>` names it. */
function cursorProjectSlug(projectRoot: string): string {
  return projectRoot
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const cursorWorkspaceMcpServers = Effect.fn("cursorWorkspaceMcpServers")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readJsonc = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((contents): unknown => {
        const errors: ParseError[] = [];
        const value: unknown = parseJsonc(contents, errors, { allowTrailingComma: true });
        return errors.length === 0 ? value : null;
      }),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
    );

  const hostEnvironment = yield* HostProcess.Environment;
  const root = yield* spawnAndCollect(
    "git",
    ChildProcess.make("git", ["rev-parse", "--show-toplevel"], { cwd }),
  ).pipe(Effect.option);
  const projectRoot = Option.isSome(root) && root.value.code === 0 ? root.value.stdout.trim() : cwd;
  const userHome = yield* HostProcess.HomeDirectory;
  const cursorDataDirectory = hostEnvironment.CURSOR_DATA_DIR || path.join(userHome, ".cursor");
  const disabledText = yield* fileSystem
    .readFileString(
      path.join(
        cursorDataDirectory,
        "projects",
        cursorProjectSlug(projectRoot),
        "mcp-disabled.json",
      ),
    )
    .pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed("[]"),
      ),
    );
  const disabled = new Set(yield* decodeDisabledServers(disabledText));
  const variables = new Map([
    ["workspaceFolder", projectRoot],
    ["workspaceFolderBasename", path.basename(projectRoot)],
    ["userHome", userHome],
    ["pathSeparator", path.sep],
    ["/", path.sep],
  ]);
  const resolve = (text: string) =>
    text.replace(
      PLACEHOLDER_PATTERN,
      (match, envName: string | undefined, name: string, fallback: string | undefined) =>
        (envName === undefined
          ? (variables.get(name) ?? environment[name] ?? fallback)
          : environment[envName]) ?? match,
    );

  const seen = new Set<string>();
  const servers: Record<string, McpServerConfig> = {};
  for (const file of [
    path.join(projectRoot, ".cursor", "mcp.json"),
    path.join(userHome, ".cursor", "mcp.json"),
  ]) {
    const contents = yield* readJsonc(file);
    // Like the SDK, expand before validating, so `"type": "${env:TYPE}"` is valid.
    const config = decodeCursorMcpFile(expand(contents, resolve));
    if (Option.isNone(config)) continue;
    const rawServers = (
      contents as {
        readonly mcpServers: Record<string, { command?: unknown; args?: ReadonlyArray<unknown> }>;
      }
    ).mcpServers;
    for (const [name, server] of Object.entries(config.value.mcpServers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (disabled.has(name)) continue;
      // The SDK already resolves every other server the same way. It names plugin
      // servers `plugin-<plugin>-<name>` and prefers them over file servers, so a
      // file server with such a name stays with the SDK, which can see plugins.
      if (
        "command" in server &&
        !name.startsWith("plugin-") &&
        // File clients start before deduplication; only replace executable/script paths.
        someString(
          [rawServers[name]?.command, rawServers[name]?.args?.[0]],
          (text) => !text.startsWith("-") && WORKSPACE_VARIABLE_PATTERN.test(text),
        )
      ) {
        servers[name] = server as McpServerConfig;
      }
    }
  }
  return servers;
});
