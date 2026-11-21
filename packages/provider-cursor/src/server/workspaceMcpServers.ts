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
const WORKSPACE_PATH_PATTERN = /^\$\{(?:workspaceFolder|userHome)\}[\\/]/;
// These exit when their script argument is missing; other arguments may be labels a server ignores.
const SCRIPT_INTERPRETERS = new Set(["node", "bun", "tsx", "python", "python3"]);

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

// Only servers whose literal copy cannot start: the SDK also starts the file-defined copy and
// loses its handle when it keeps the inline one, and inline configs drop envFile and enabledTools.
function needsWorkspaceExpansion(server: unknown): boolean {
  if (typeof server !== "object" || server === null) return false;
  if ("envFile" in server || "enabledTools" in server) return false;
  const { command, cwd, args } = server as Record<string, unknown>;
  return (
    [command, cwd].some(
      (text) => typeof text === "string" && WORKSPACE_VARIABLE_PATTERN.test(text),
    ) ||
    (typeof command === "string" &&
      SCRIPT_INTERPRETERS.has(command.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "")) &&
      Array.isArray(args) &&
      typeof args[0] === "string" &&
      WORKSPACE_PATH_PATTERN.test(args[0]))
  );
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
  const loadDisabled = fileSystem
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
      Effect.flatMap(decodeDisabledServers),
      Effect.map((names) => new Set(names)),
    );
  let disabled: Set<string> | undefined;
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
          : (environment[envName] ?? "")) ?? match,
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
        readonly mcpServers: Record<string, unknown>;
      }
    ).mcpServers;
    for (const [name, server] of Object.entries(config.value.mcpServers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      // Plugin definitions take precedence in the SDK, which can see enabled plugins.
      if (
        "command" in server &&
        !name.startsWith("plugin-") &&
        needsWorkspaceExpansion(rawServers[name])
      ) {
        disabled ??= yield* loadDisabled;
        if (disabled.has(name)) continue;
        servers[name] = { ...server, cwd: server.cwd ?? projectRoot } as McpServerConfig;
      }
    }
  }
  return servers;
});
