import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

/**
 * Variables older T3 builds used to hand a raw MCP credential to a provider
 * child: ACP agents and their terminals, Pi, and Claude. A server started from
 * such a child's terminal inherits them, and everything it spawns would pass
 * them on, into crash dumps too.
 */
export const LEGACY_RAW_MCP_CREDENTIAL_ENV = [
  "T3_ACP_MCP_AUTHORIZATION",
  "T3_MCP_BEARER_TOKEN",
  "T3_CODE_MCP_AUTHORIZATION",
] as const;

/**
 * `environment`, or the inherited one when it is unset, with every
 * `LEGACY_RAW_MCP_CREDENTIAL_ENV` variable set to `undefined`. Node skips
 * `undefined` entries, and they still mask `process.env` when a spawner merges
 * this over it.
 */
export function withoutRawMcpCredentials(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const result = { ...(environment ?? process.env) };
  for (const name of LEGACY_RAW_MCP_CREDENTIAL_ENV) result[name] = undefined;
  return result;
}

/**
 * Owner-only files holding MCP `Authorization` header values, one per key,
 * each in a private temporary directory that closing the scope removes.
 *
 * Child processes that send the header themselves (the ACP stdio bridge and
 * `acp-mcp-call`, the Pi extension) receive a path instead of the value: an
 * environment variable reaches everything the agent spawns, and on Linux every
 * crash dump of those processes. A key keeps its path for the life of the
 * scope, so a process handed the path before a rotation reads the new value.
 */
export const makeMcpCredentialFiles = Effect.fn("makeMcpCredentialFiles")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  // Writes run one at a time, so each file holds the header recorded for it
  // and the next read that sees a different header rewrites it.
  const permit = yield* Semaphore.make(1);
  const files = new Map<
    string,
    { readonly path: string; readonly authorization: string | undefined }
  >();
  return {
    /** Writes `authorization` to `key`'s file and returns its path. */
    write: (key: string, authorization: string) =>
      permit.withPermit(
        Effect.gen(function* () {
          const current = files.get(key);
          if (current?.authorization === authorization) return current.path;
          let path = current?.path;
          if (path === undefined) {
            path = yield* fs.makeTempFileScoped({ prefix: "t3-mcp-" }).pipe(Scope.provide(scope));
            files.set(key, { path, authorization: undefined });
          }
          // Renamed over the file, so a reader never finds it missing or half written.
          const temporary = `${path}.tmp`;
          yield* fs.writeFileString(temporary, authorization, { mode: 0o600 }).pipe(
            Effect.andThen(fs.rename(temporary, path)),
            Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          );
          files.set(key, { path, authorization });
          return path;
        }),
      ),
    /** Deletes `key`'s file, if any. A later `write` puts it back at the same path. */
    remove: (key: string) =>
      permit.withPermit(
        Effect.gen(function* () {
          const current = files.get(key);
          if (current === undefined) return;
          // Even with no header recorded: a failed write can leave either file.
          yield* fs.remove(current.path, { force: true });
          yield* fs.remove(`${current.path}.tmp`, { force: true });
          files.set(key, { path: current.path, authorization: undefined });
        }),
      ),
  };
});
