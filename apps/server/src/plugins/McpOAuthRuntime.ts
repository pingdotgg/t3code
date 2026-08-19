import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as CodexClient from "effect-codex-app-server/client";
import * as Layer from "effect/Layer";

import type {
  PluginMarketplaceHarnessId,
  PluginMarketplaceMcpAuthStatus,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as ProcessRunner from "../processRunner.ts";

export type McpOAuthHarness = Extract<PluginMarketplaceHarnessId, "codex" | "claude" | "cursor">;

export interface McpOAuthServerStatus {
  readonly name: string;
  readonly url: string | null;
  readonly status: PluginMarketplaceMcpAuthStatus;
  readonly detail: string | null;
  readonly authorizationUrl: string | null;
  readonly canConnect: boolean;
  readonly canDisconnect: boolean;
}

interface McpOAuthStart {
  readonly authorizationUrl: string;
  readonly callbackRequired: boolean;
}

const McpOAuthRuntimeErrorFields = {
  operation: Schema.Literals(["status", "start", "complete", "disconnect"]),
  harness: Schema.Literals(["codex", "claude", "cursor"]),
  serverName: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
};

function providerLabel(harness: McpOAuthHarness): string {
  return harness === "codex" ? "Codex" : harness === "claude" ? "Claude Code" : "Cursor";
}

export class McpOAuthProviderUnavailableError extends Schema.TaggedErrorClass<McpOAuthProviderUnavailableError>()(
  "McpOAuthProviderUnavailableError",
  McpOAuthRuntimeErrorFields,
) {
  override get message(): string {
    return `${providerLabel(this.harness)} is unavailable for MCP ${this.operation}.`;
  }
}

export class McpOAuthCallbackMismatchError extends Schema.TaggedErrorClass<McpOAuthCallbackMismatchError>()(
  "McpOAuthCallbackMismatchError",
  McpOAuthRuntimeErrorFields,
) {
  override get message(): string {
    return "The callback URL does not match this authentication request.";
  }
}

export class McpOAuthCallbackRejectedError extends Schema.TaggedErrorClass<McpOAuthCallbackRejectedError>()(
  "McpOAuthCallbackRejectedError",
  McpOAuthRuntimeErrorFields,
) {
  override get message(): string {
    return `${providerLabel(this.harness)} could not accept the authentication callback.`;
  }
}

export class McpOAuthAuthenticationCancelledError extends Schema.TaggedErrorClass<McpOAuthAuthenticationCancelledError>()(
  "McpOAuthAuthenticationCancelledError",
  McpOAuthRuntimeErrorFields,
) {
  override get message(): string {
    return "Authentication was cancelled.";
  }
}

export class McpOAuthAuthenticationFailedError extends Schema.TaggedErrorClass<McpOAuthAuthenticationFailedError>()(
  "McpOAuthAuthenticationFailedError",
  { ...McpOAuthRuntimeErrorFields, exitCode: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return `${providerLabel(this.harness)} did not complete MCP authentication.`;
  }
}

export class McpOAuthUnsupportedHarnessError extends Schema.TaggedErrorClass<McpOAuthUnsupportedHarnessError>()(
  "McpOAuthUnsupportedHarnessError",
  McpOAuthRuntimeErrorFields,
) {
  override get message(): string {
    return `${providerLabel(this.harness)} manages MCP authentication in its own settings.`;
  }
}

export class McpOAuthNoPendingSessionError extends Schema.TaggedErrorClass<McpOAuthNoPendingSessionError>()(
  "McpOAuthNoPendingSessionError",
  McpOAuthRuntimeErrorFields,
) {
  override get message(): string {
    return "There is no pending authentication request.";
  }
}

export class McpOAuthAuthorizationTimeoutError extends Schema.TaggedErrorClass<McpOAuthAuthorizationTimeoutError>()(
  "McpOAuthAuthorizationTimeoutError",
  McpOAuthRuntimeErrorFields,
) {
  override get message(): string {
    return `${providerLabel(this.harness)} did not produce an authorization URL.`;
  }
}

export class McpOAuthCommandFailedError extends Schema.TaggedErrorClass<McpOAuthCommandFailedError>()(
  "McpOAuthCommandFailedError",
  { ...McpOAuthRuntimeErrorFields, exitCode: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return `${providerLabel(this.harness)} could not complete the requested MCP operation.`;
  }
}

export const McpOAuthRuntimeError = Schema.Union([
  McpOAuthProviderUnavailableError,
  McpOAuthCallbackMismatchError,
  McpOAuthCallbackRejectedError,
  McpOAuthAuthenticationCancelledError,
  McpOAuthAuthenticationFailedError,
  McpOAuthUnsupportedHarnessError,
  McpOAuthNoPendingSessionError,
  McpOAuthAuthorizationTimeoutError,
  McpOAuthCommandFailedError,
]);
export type McpOAuthRuntimeError = typeof McpOAuthRuntimeError.Type;
const isMcpOAuthRuntimeError = Schema.is(McpOAuthRuntimeError);

export class McpOAuthRuntime extends Context.Service<
  McpOAuthRuntime,
  {
    readonly status: (
      harness: McpOAuthHarness,
    ) => Effect.Effect<ReadonlyArray<McpOAuthServerStatus>, McpOAuthRuntimeError>;
    readonly start: (
      harness: McpOAuthHarness,
      name: string,
    ) => Effect.Effect<McpOAuthStart, McpOAuthRuntimeError>;
    readonly complete: (
      harness: McpOAuthHarness,
      name: string,
      callbackUrl: string,
    ) => Effect.Effect<void, McpOAuthRuntimeError>;
    readonly disconnect: (
      harness: McpOAuthHarness,
      name: string,
    ) => Effect.Effect<void, McpOAuthRuntimeError>;
  }
>()("t3/plugins/McpOAuthRuntime") {}

export interface McpOAuthRuntimeOptions {
  readonly commands?: Partial<
    Readonly<Record<McpOAuthHarness, { readonly command: string; readonly env: NodeJS.ProcessEnv }>>
  >;
  readonly resolveCommand?: (
    harness: McpOAuthHarness,
  ) => Effect.Effect<{ readonly command: string; readonly env: NodeJS.ProcessEnv } | undefined>;
  readonly cwd?: string;
}

const CodexMcpServer = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  disabled_reason: Schema.NullOr(Schema.String),
  transport: Schema.Struct({
    type: Schema.String,
    url: Schema.optional(Schema.String),
  }),
  auth_status: Schema.String,
});
const decodeCodexMcpServers = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(CodexMcpServer)),
);
const CodexMcpServerUrl = Schema.Struct({
  transport: Schema.optional(
    Schema.Struct({
      url: Schema.optional(Schema.String),
    }),
  ),
});
const decodeCodexMcpServerUrl = Schema.decodeUnknownOption(
  Schema.fromJsonString(CodexMcpServerUrl),
);

function cleanedCliLine(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- Provider output can include ANSI escape sequences.
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
      // eslint-disable-next-line no-control-regex -- Provider output can include ANSI hyperlink sequences.
      .replace(/\u001B\]8;;[^\u0007]*\u0007/gu, "")
      .trim()
  );
}

function findHttpUrl(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- URLs end before terminal control sequences.
  const match = value.match(/https?:\/\/[^\s\u0007\u001B]+/u)?.[0];
  return match?.replace(/[),.;]+$/u, "") ?? null;
}

export function isCodexMcpServerMissingError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "object" && current !== null && "message" in current
          ? String(Reflect.get(current, "message"))
          : String(current);
    if (/no mcp server named/iu.test(message)) return true;
    current =
      current instanceof Error
        ? current.cause
        : typeof current === "object" && current !== null && "cause" in current
          ? Reflect.get(current, "cause")
          : undefined;
  }
  return false;
}

export function codexMcpLoginArgs(name: string, url?: string | null): ReadonlyArray<string> {
  const trimmedUrl = url?.trim();
  return trimmedUrl
    ? ["-c", `mcp_servers.${name}.url=${JSON.stringify(trimmedUrl)}`, "mcp", "login", name]
    : ["mcp", "login", name];
}

export function findClaudeMcpAuthorizationUrl(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- URLs end before terminal control sequences.
  for (const match of value.matchAll(/https?:\/\/[^\s\u0007\u001B]+/gu)) {
    const candidate = match[0];
    try {
      const url = new URL(candidate);
      const redirectValue = url.searchParams.get("redirect_uri");
      if (!redirectValue) continue;
      const redirect = new URL(redirectValue);
      if (redirect.protocol === "http:" || redirect.protocol === "https:") return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function parseCodexMcpStatusOutput(output: string): ReadonlyArray<McpOAuthServerStatus> {
  const decoded = decodeCodexMcpServers(output);
  if (Option.isNone(decoded)) return [];
  return decoded.value.map((server) => {
    const authStatus = server.auth_status.toLocaleLowerCase().replaceAll("_", "");
    const connected = authStatus === "oauth" || authStatus === "bearertoken";
    const needsLogin = authStatus === "notloggedin";
    return {
      name: server.name,
      url: server.transport.url ?? null,
      status: !server.enabled
        ? "unavailable"
        : connected
          ? "connected"
          : needsLogin
            ? "not_connected"
            : "unsupported",
      detail: !server.enabled
        ? (server.disabled_reason ?? "Disabled in Codex")
        : authStatus === "oauth"
          ? "Connected with OAuth in Codex"
          : authStatus === "bearertoken"
            ? "Using a bearer token configured in Codex"
            : needsLogin
              ? "Sign in with Codex to use this MCP server"
              : "This Codex MCP server does not use OAuth",
      authorizationUrl: null,
      canConnect: server.enabled && needsLogin && server.transport.url !== undefined,
      canDisconnect: server.enabled && authStatus === "oauth",
    } satisfies McpOAuthServerStatus;
  });
}

export function parseClaudeMcpStatusOutput(output: string): ReadonlyArray<McpOAuthServerStatus> {
  return output
    .split(/\r?\n/gu)
    .map(cleanedCliLine)
    .filter((line) => line.includes(":"))
    .flatMap((line): ReadonlyArray<McpOAuthServerStatus> => {
      const separator = line.indexOf(": ");
      if (separator < 1) return [];
      const name = line.slice(0, separator).trim();
      const description = line.slice(separator + 2).trim();
      if (!name || !description) return [];
      const normalized = description.toLocaleLowerCase();
      const needsLogin =
        normalized.includes("needs authentication") ||
        normalized.includes("requires authentication") ||
        normalized.includes("requires_authentication");
      const failed = normalized.includes("failed to connect");
      const pendingApproval = normalized.includes("pending approval");
      const connected = normalized.includes("connected") && !failed;
      return [
        {
          name,
          url: findHttpUrl(description),
          status: needsLogin
            ? "not_connected"
            : connected
              ? "connected"
              : failed
                ? "failed"
                : pendingApproval
                  ? "unavailable"
                  : "unsupported",
          detail: needsLogin
            ? "Sign in with Claude Code to use this MCP server"
            : connected
              ? "Connected in Claude Code"
              : failed || pendingApproval
                ? (description.split(" — ").at(-1) ?? description)
                : "This Claude Code MCP server does not use OAuth",
          authorizationUrl: null,
          canConnect: needsLogin,
          canDisconnect: connected,
        },
      ];
    });
}

export function parseCursorMcpStatusOutput(output: string): ReadonlyArray<McpOAuthServerStatus> {
  return output
    .split(/\r?\n/gu)
    .map(cleanedCliLine)
    .filter((line) => line.includes(":"))
    .flatMap((line): ReadonlyArray<McpOAuthServerStatus> => {
      const separator = line.indexOf(":");
      const name = line.slice(0, separator).trim();
      const nativeStatus = line
        .slice(separator + 1)
        .trim()
        .toLocaleLowerCase();
      if (!name || !nativeStatus) return [];
      const connected = nativeStatus === "ready";
      const needsLogin = nativeStatus.includes("authentication");
      return [
        {
          name,
          url: null,
          status: connected ? "connected" : needsLogin ? "not_connected" : "unavailable",
          detail: connected
            ? "Connected in Cursor"
            : needsLogin
              ? "Authentication is managed in Cursor"
              : `Cursor reports ${nativeStatus}`,
          authorizationUrl: null,
          canConnect: false,
          canDisconnect: false,
        },
      ];
    });
}

export function validateMcpOAuthCallback(authorizationUrl: string, callbackUrl: string): boolean {
  try {
    const authorization = new URL(authorizationUrl);
    const callback = new URL(callbackUrl);
    const redirectValue = authorization.searchParams.get("redirect_uri");
    if (!redirectValue) return false;
    const redirect = new URL(redirectValue);
    if (redirect.origin !== callback.origin || redirect.pathname !== callback.pathname)
      return false;
    const responseParameters = new Set(["code", "error", "state"]);
    for (const name of new Set(redirect.searchParams.keys())) {
      const expected = redirect.searchParams.getAll(name).toSorted();
      const actual = callback.searchParams.getAll(name).toSorted();
      if (
        expected.length !== actual.length ||
        expected.some((value, index) => actual[index] !== value)
      )
        return false;
    }
    for (const name of callback.searchParams.keys()) {
      if (!redirect.searchParams.has(name) && !responseParameters.has(name)) return false;
    }
    const expectedState = authorization.searchParams.get("state");
    if (expectedState && callback.searchParams.get("state") !== expectedState) return false;
    return callback.searchParams.has("code") || callback.searchParams.has("error");
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

interface ActiveSession {
  readonly harness: McpOAuthHarness;
  readonly name: string;
  readonly started: Deferred.Deferred<McpOAuthStart, McpOAuthRuntimeError>;
  readonly cancelled: Deferred.Deferred<void>;
  readonly submitCallback: Ref.Ref<
    ((callbackUrl: string) => Effect.Effect<void, McpOAuthRuntimeError>) | null
  >;
}

function sessionKey(harness: McpOAuthHarness, name: string): string {
  return `${harness}:${name.toLocaleLowerCase()}`;
}

export const make = (options: McpOAuthRuntimeOptions = {}) =>
  Effect.gen(function* () {
    const runtimeScope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const activeSessions = yield* Ref.make(new Map<string, ActiveSession>());
    const failures = yield* Ref.make(new Map<string, string>());
    const sessionLock = yield* Semaphore.make(1);
    const cwd = options.cwd ?? (yield* HostProcessWorkingDirectory);
    const hostEnvironment = yield* HostProcessEnvironment;
    const commandFor = Effect.fn("McpOAuthRuntime.commandFor")(function* (
      harness: McpOAuthHarness,
      fallback: string,
    ) {
      if (options.resolveCommand) return yield* options.resolveCommand(harness);
      return options.commands?.[harness] ?? { command: fallback, env: hostEnvironment };
    });

    const clearFailure = (key: string) =>
      Ref.update(failures, (current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });

    const recordFailure = (key: string, detail: string) =>
      Ref.update(failures, (current) => {
        const next = new Map(current);
        next.set(key, detail);
        return next;
      });

    const removeSession = (key: string, session: ActiveSession) =>
      Ref.update(activeSessions, (current) => {
        if (current.get(key) !== session) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });

    const runCodexAppServerLogin = (session: ActiveSession) =>
      Effect.scoped(
        Effect.gen(function* () {
          const configured = yield* commandFor("codex", "codex");
          if (!configured) {
            return yield* new McpOAuthProviderUnavailableError({
              operation: "start",
              harness: "codex",
              serverName: session.name,
            });
          }
          const environment = configured.env;
          const spawnCommand = yield* resolveSpawnCommand(configured.command, ["app-server"], {
            env: environment,
            extendEnv: true,
          });
          const child = yield* spawner.spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd,
              env: environment,
              extendEnv: true,
              shell: spawnCommand.shell,
              forceKillAfter: "2 seconds",
            }),
          );
          const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(clientContext),
          );
          const completed = yield* Deferred.make<
            { readonly success: boolean; readonly error?: string | null },
            never
          >();
          yield* client.handleServerNotification("mcpServer/oauthLogin/completed", (payload) =>
            payload.name === session.name
              ? Deferred.succeed(completed, payload).pipe(Effect.asVoid)
              : Effect.void,
          );
          yield* client.request("initialize", {
            clientInfo: {
              name: "t3code_mcp_oauth",
              title: "T3 Code MCP Authentication",
              version: "0.1.0",
            },
            capabilities: { experimentalApi: true },
          });
          yield* client.notify("initialized", undefined);
          yield* client.request("config/mcpServer/reload", undefined).pipe(Effect.ignore);
          const response = yield* client.request("mcpServer/oauth/login", {
            name: session.name,
            timeoutSecs: 600,
          });
          yield* Ref.set(session.submitCallback, (callbackUrl) => {
            if (
              !isLoopbackHttpUrl(callbackUrl) ||
              !validateMcpOAuthCallback(response.authorizationUrl, callbackUrl)
            ) {
              return new McpOAuthCallbackMismatchError({
                operation: "complete",
                harness: "codex",
                serverName: session.name,
              });
            }
            return httpClient.get(callbackUrl).pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.mapError(
                (cause) =>
                  new McpOAuthCallbackRejectedError({
                    operation: "complete",
                    harness: "codex",
                    serverName: session.name,
                    cause,
                  }),
              ),
              Effect.asVoid,
            );
          });
          yield* Deferred.succeed(session.started, {
            authorizationUrl: response.authorizationUrl,
            callbackRequired: true,
          });
          const result = yield* Effect.raceFirst(
            Deferred.await(completed),
            Deferred.await(session.cancelled).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new McpOAuthAuthenticationCancelledError({
                    operation: "start",
                    harness: "codex",
                    serverName: session.name,
                  }),
                ),
              ),
            ),
          );
          if (!result.success) {
            return yield* new McpOAuthAuthenticationFailedError({
              operation: "start",
              harness: "codex",
              serverName: session.name,
            });
          }
        }),
      );

    const runCodexCliLogin = (session: ActiveSession) =>
      Effect.scoped(
        Effect.gen(function* () {
          const configured = yield* commandFor("codex", "codex");
          if (!configured) {
            return yield* new McpOAuthProviderUnavailableError({
              operation: "start",
              harness: "codex",
              serverName: session.name,
            });
          }
          const listed = yield* processRunner
            .run({
              command: configured.command,
              args: ["mcp", "get", session.name, "--json"],
              cwd,
              env: configured.env,
              timeout: "30 seconds",
              maxOutputBytes: 512 * 1024,
              outputMode: "truncate",
            })
            .pipe(Effect.option);
          const listedUrl =
            Option.isSome(listed) && listed.value.code === 0
              ? Option.match(decodeCodexMcpServerUrl(listed.value.stdout), {
                  onNone: () => null,
                  onSome: (server) => server.transport?.url?.trim() || null,
                })
              : null;
          const environment = configured.env;
          const spawnCommand = yield* resolveSpawnCommand(
            configured.command,
            [...codexMcpLoginArgs(session.name, listedUrl)],
            {
              env: environment,
              extendEnv: true,
            },
          );
          const child = yield* spawner.spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd,
              env: environment,
              extendEnv: true,
              shell: spawnCommand.shell,
              forceKillAfter: "2 seconds",
            }),
          );
          yield* Deferred.succeed(session.started, {
            authorizationUrl: "",
            callbackRequired: false,
          });
          const exitCode = yield* Effect.raceFirst(
            child.exitCode,
            Deferred.await(session.cancelled).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new McpOAuthAuthenticationCancelledError({
                    operation: "start",
                    harness: "codex",
                    serverName: session.name,
                  }),
                ),
              ),
            ),
          );
          if (exitCode !== 0) {
            return yield* new McpOAuthAuthenticationFailedError({
              operation: "start",
              harness: "codex",
              serverName: session.name,
              exitCode,
            });
          }
        }),
      );

    const runCodexSession = (key: string, session: ActiveSession) =>
      runCodexAppServerLogin(session).pipe(
        Effect.catchIf(isCodexMcpServerMissingError, () => runCodexCliLogin(session)),
        Effect.mapError((cause) =>
          isMcpOAuthRuntimeError(cause)
            ? cause
            : new McpOAuthProviderUnavailableError({
                operation: "start",
                harness: "codex",
                serverName: session.name,
                cause,
              }),
        ),
        Effect.tap(() => clearFailure(key)),
        Effect.tapError((error) =>
          Effect.gen(function* () {
            yield* Deferred.fail(session.started, error).pipe(Effect.ignore);
            const cancelled = yield* Deferred.poll(session.cancelled);
            if (Option.isNone(cancelled)) yield* recordFailure(key, error.message);
          }),
        ),
        Effect.ensuring(removeSession(key, session)),
        Effect.ignoreCause({ log: true }),
      );

    const runClaudeSession = (key: string, session: ActiveSession) =>
      Effect.scoped(
        Effect.gen(function* () {
          const args = ["mcp", "login", "--no-browser", session.name];
          const configured = yield* commandFor("claude", "claude");
          if (!configured) {
            return yield* new McpOAuthProviderUnavailableError({
              operation: "start",
              harness: "claude",
              serverName: session.name,
            });
          }
          const environment = configured.env;
          const spawnCommand = yield* resolveSpawnCommand(configured.command, args, {
            env: environment,
            extendEnv: true,
          });
          const child = yield* spawner.spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd,
              env: environment,
              extendEnv: true,
              shell: spawnCommand.shell,
              forceKillAfter: "2 seconds",
            }),
          );
          const authorizationUrl = yield* Ref.make<string | null>(null);
          yield* Ref.set(session.submitCallback, (callbackUrl) =>
            Effect.gen(function* () {
              const expected = yield* Ref.get(authorizationUrl);
              if (!expected || !validateMcpOAuthCallback(expected, callbackUrl)) {
                return yield* new McpOAuthCallbackMismatchError({
                  operation: "complete",
                  harness: "claude",
                  serverName: session.name,
                });
              }
              yield* Stream.run(
                Stream.encodeText(Stream.make(`${callbackUrl}\n`)),
                child.stdin,
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new McpOAuthCallbackRejectedError({
                      operation: "complete",
                      harness: "claude",
                      serverName: session.name,
                      cause,
                    }),
                ),
              );
            }),
          );

          const scanOutput = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => {
            const decoder = new TextDecoder();
            let buffered = "";
            return Stream.runForEach(stream, (chunk) =>
              Effect.gen(function* () {
                buffered = `${buffered}${decoder.decode(chunk, { stream: true })}`.slice(
                  -64 * 1024,
                );
                const url = findClaudeMcpAuthorizationUrl(buffered);
                if (!url || (yield* Ref.get(authorizationUrl)) !== null) return;
                yield* Ref.set(authorizationUrl, url);
                yield* Deferred.succeed(session.started, {
                  authorizationUrl: url,
                  callbackRequired: true,
                });
              }),
            );
          };
          yield* scanOutput(child.stdout).pipe(Effect.ignore, Effect.forkScoped);
          yield* scanOutput(child.stderr).pipe(Effect.ignore, Effect.forkScoped);
          const exitCode = yield* Effect.raceFirst(
            child.exitCode,
            Deferred.await(session.cancelled).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new McpOAuthAuthenticationCancelledError({
                    operation: "start",
                    harness: "claude",
                    serverName: session.name,
                  }),
                ),
              ),
            ),
          );
          if (exitCode !== 0 || (yield* Ref.get(authorizationUrl)) === null) {
            return yield* new McpOAuthAuthenticationFailedError({
              operation: "start",
              harness: "claude",
              serverName: session.name,
              ...(exitCode === 0 ? {} : { exitCode }),
            });
          }
          yield* clearFailure(key);
        }),
      ).pipe(
        Effect.mapError((error) =>
          isMcpOAuthRuntimeError(error)
            ? error
            : new McpOAuthProviderUnavailableError({
                operation: "start",
                harness: "claude",
                serverName: session.name,
                cause: error,
              }),
        ),
        Effect.tapError((error) =>
          Effect.gen(function* () {
            yield* Deferred.fail(session.started, error).pipe(Effect.ignore);
            const cancelled = yield* Deferred.poll(session.cancelled);
            if (Option.isNone(cancelled)) yield* recordFailure(key, error.message);
          }),
        ),
        Effect.ensuring(removeSession(key, session)),
        Effect.ignoreCause({ log: true }),
      );

    const status: McpOAuthRuntime["Service"]["status"] = (harness) =>
      Effect.gen(function* () {
        const configured = yield* commandFor(
          harness,
          harness === "cursor" ? "cursor-agent" : harness,
        );
        if (!configured) {
          return yield* new McpOAuthProviderUnavailableError({
            operation: "status",
            harness,
          });
        }
        const invocation =
          harness === "codex"
            ? {
                command: configured.command,
                args: ["mcp", "list", "--json"],
              }
            : harness === "claude"
              ? { command: configured.command, args: ["mcp", "list"] }
              : {
                  command: configured.command,
                  args: ["mcp", "list"],
                };
        const environment = configured.env;
        const result = yield* processRunner
          .run({
            ...invocation,
            cwd,
            ...(environment ? { env: environment } : {}),
            timeout: "30 seconds",
            maxOutputBytes: 2 * 1024 * 1024,
            outputMode: "truncate",
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new McpOAuthCommandFailedError({
                  operation: "status",
                  harness,
                  cause,
                }),
            ),
          );
        if (result.code !== 0) {
          return yield* new McpOAuthCommandFailedError({
            operation: "status",
            harness,
            ...(result.code === null ? {} : { exitCode: result.code }),
          });
        }
        const parsed =
          harness === "codex"
            ? parseCodexMcpStatusOutput(result.stdout)
            : harness === "claude"
              ? parseClaudeMcpStatusOutput(`${result.stdout}\n${result.stderr}`)
              : parseCursorMcpStatusOutput(`${result.stdout}\n${result.stderr}`);
        const [active, recordedFailures] = yield* Effect.all([
          Ref.get(activeSessions),
          Ref.get(failures),
        ]);
        return yield* Effect.forEach(parsed, (server) =>
          Effect.gen(function* () {
            const key = sessionKey(harness, server.name);
            const session = active.get(key);
            const failure = recordedFailures.get(key);
            if (session) {
              const started = yield* Deferred.poll(session.started);
              const startResult = Option.isSome(started)
                ? yield* started.value.pipe(Effect.option)
                : Option.none<McpOAuthStart>();
              return {
                ...server,
                status: "connecting",
                detail:
                  harness === "claude"
                    ? "Finish signing in, then paste the browser callback URL here"
                    : "Waiting for browser authentication to finish",
                authorizationUrl: Option.isSome(startResult)
                  ? startResult.value.authorizationUrl
                  : null,
                canConnect: false,
                canDisconnect: true,
              } satisfies McpOAuthServerStatus;
            }
            if (failure && server.status !== "connected") {
              return {
                ...server,
                status: "failed",
                detail: failure,
                canConnect: true,
                canDisconnect: false,
              } satisfies McpOAuthServerStatus;
            }
            return server;
          }),
        );
      });

    const start: McpOAuthRuntime["Service"]["start"] = (harness, name) =>
      Effect.gen(function* () {
        if (harness === "cursor") {
          return yield* new McpOAuthUnsupportedHarnessError({
            operation: "start",
            harness,
            serverName: name,
          });
        }
        const selected = yield* sessionLock.withPermits(1)(
          Effect.gen(function* () {
            const key = sessionKey(harness, name);
            const existing = (yield* Ref.get(activeSessions)).get(key);
            if (existing) return { session: existing, ownsSession: false } as const;
            const session: ActiveSession = {
              harness,
              name,
              started: yield* Deferred.make<McpOAuthStart, McpOAuthRuntimeError>(),
              cancelled: yield* Deferred.make<void>(),
              submitCallback: yield* Ref.make<
                ((callbackUrl: string) => Effect.Effect<void, McpOAuthRuntimeError>) | null
              >(null),
            };
            yield* Ref.update(activeSessions, (current) => new Map(current).set(key, session));
            yield* clearFailure(key);
            yield* (
              harness === "codex" ? runCodexSession(key, session) : runClaudeSession(key, session)
            ).pipe(Effect.forkIn(runtimeScope));
            return { session, ownsSession: true } as const;
          }),
        );
        const started = yield* Deferred.await(selected.session.started).pipe(
          Effect.timeoutOption("20 seconds"),
          Effect.onInterrupt(() =>
            selected.ownsSession
              ? Deferred.succeed(selected.session.cancelled, undefined)
              : Effect.void,
          ),
        );
        if (Option.isNone(started)) {
          if (selected.ownsSession) {
            yield* Deferred.succeed(selected.session.cancelled, undefined);
          }
          return yield* new McpOAuthAuthorizationTimeoutError({
            operation: "start",
            harness,
            serverName: name,
          });
        }
        return started.value;
      });

    const complete: McpOAuthRuntime["Service"]["complete"] = (harness, name, callbackUrl) =>
      Effect.gen(function* () {
        if (harness === "cursor") {
          return yield* new McpOAuthUnsupportedHarnessError({
            operation: "complete",
            harness,
            serverName: name,
          });
        }
        const session = (yield* Ref.get(activeSessions)).get(sessionKey(harness, name));
        const submit = session ? yield* Ref.get(session.submitCallback) : null;
        if (!submit) {
          return yield* new McpOAuthNoPendingSessionError({
            operation: "complete",
            harness,
            serverName: name,
          });
        }
        yield* submit(callbackUrl);
      });

    const disconnect: McpOAuthRuntime["Service"]["disconnect"] = (harness, name) =>
      sessionLock.withPermits(1)(
        Effect.gen(function* () {
          if (harness === "cursor") {
            return yield* new McpOAuthUnsupportedHarnessError({
              operation: "disconnect",
              harness,
              serverName: name,
            });
          }
          const key = sessionKey(harness, name);
          const session = (yield* Ref.get(activeSessions)).get(key);
          if (session) {
            yield* removeSession(key, session);
            yield* Deferred.succeed(session.cancelled, undefined).pipe(Effect.ignore);
          }
          const configured = yield* commandFor(harness, harness);
          if (!configured) {
            return yield* new McpOAuthProviderUnavailableError({
              operation: "disconnect",
              harness,
              serverName: name,
            });
          }
          const result = yield* processRunner
            .run({
              command: configured.command,
              args: ["mcp", "logout", name],
              cwd,
              env: configured.env,
              timeout: "30 seconds",
              maxOutputBytes: 512 * 1024,
              outputMode: "truncate",
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new McpOAuthCommandFailedError({
                    operation: "disconnect",
                    harness,
                    serverName: name,
                    cause,
                  }),
              ),
            );
          if (result.code !== 0) {
            return yield* new McpOAuthCommandFailedError({
              operation: "disconnect",
              harness,
              serverName: name,
              ...(result.code === null ? {} : { exitCode: result.code }),
            });
          }
          yield* clearFailure(key);
        }),
      );

    return McpOAuthRuntime.of({ status, start, complete, disconnect });
  });

export const layer = <E, R>(options: Effect.Effect<McpOAuthRuntimeOptions, E, R>) =>
  Layer.effect(McpOAuthRuntime, Effect.flatMap(options, make));
