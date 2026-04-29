import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { type NetError, NetService } from "@t3tools/shared/Net";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  Deferred,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
  Schedule,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSshChildEnvironment,
  type SshAuthOptions,
  SshPasswordPrompt,
  isSshAuthFailure,
} from "./auth.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  collectProcessOutput,
  getLastNonEmptyOutputLine,
  remoteStateKey,
  resolveSshTarget,
  runSshCommand,
  targetConnectionKey,
} from "./command.ts";
import {
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

export const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const SSH_READY_TIMEOUT_MS = 20_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;

export interface RemoteT3RunnerOptions {
  readonly packageSpec?: string;
  readonly nodeScriptPath?: string | null;
}

export interface SshEnvironmentManagerOptions {
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: () => RemoteT3RunnerOptions;
}

interface SshTunnelEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Scope;
}

type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService
  | SshPasswordPrompt;

type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetError;

function makeSshTunnelCancelledError(target: DesktopSshEnvironmentTarget): SshCommandError {
  return new SshCommandError({
    command: ["ssh"],
    exitCode: null,
    stderr: "",
    message: `SSH environment connection was cancelled for ${target.alias || target.hostname}.`,
  });
}

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function sshRunnerLogFields(runner: RemoteT3RunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }
  if (runner?.packageSpec?.trim()) {
    return { runner: "package", packageSpec: runner.packageSpec.trim() };
  }
  return { runner: "default" };
}

interface SshAuthOperationInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export interface SshEnvironmentManagerShape {
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

const RemoteLaunchResult = Schema.Struct({
  remotePort: Schema.Number,
});

const RemotePairingResult = Schema.Struct({
  credential: Schema.String,
});

const RemoteHttpError = Schema.Struct({
  error: Schema.optional(Schema.String),
});

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));
const decodeRemotePairingResult = Schema.decodeEffect(fromLenientJson(RemotePairingResult));
const decodeRemoteHttpError = Schema.decodeEffect(Schema.fromJsonString(RemoteHttpError));

export function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function applyScriptPlaceholders(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(`@@${token}@@`, value);
  }
  return result;
}

export const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2] ?? "";
const defaultPort = Number.parseInt(process.argv[3] ?? "", 10);
const scanWindow = Number.parseInt(process.argv[4] ?? "", 10);
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : defaultPort;
const end = start + scanWindow;

function tryPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error ? false : port));
    });
  });
}

(async () => {
  for (let port = start; port < end; port += 1) {
    const available = await tryPort(port);
    if (available) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

export const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
T3_NODE_SCRIPT_PATH=@@T3_NODE_SCRIPT_PATH@@
if [ -n "$T3_NODE_SCRIPT_PATH" ]; then
  exec node "$T3_NODE_SCRIPT_PATH" "$@"
fi
if command -v t3 >/dev/null 2>&1; then
  exec t3 "$@"
fi
if command -v npx >/dev/null 2>&1; then
  exec npx --yes @@T3_PACKAGE_SPEC@@ "$@"
fi
if command -v npm >/dev/null 2>&1; then
  exec npm exec --yes @@T3_PACKAGE_SPEC@@ -- "$@"
fi
printf 'Remote host is missing the t3 CLI and could not install @@T3_PACKAGE_SPEC@@ because npx and npm are unavailable on PATH.\\n' >&2
exit 1
`;

export const REMOTE_LAUNCH_SCRIPT = `set -eu
STATE_KEY="$1"
STATE_DIR="$HOME/.t3/ssh-launch/$STATE_KEY"
SERVER_HOME="$STATE_DIR/server-home"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
mkdir -p "$STATE_DIR" "$SERVER_HOME"
cleanup_runner_next() {
  rm -f "$RUNNER_NEXT"
}
trap cleanup_runner_next EXIT
cat >"$RUNNER_NEXT" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
RUNNER_CHANGED=0
if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  RUNNER_CHANGED=1
fi
mv "$RUNNER_NEXT" "$RUNNER_FILE"
chmod 700 "$RUNNER_FILE"
pick_port() {
  node - "$PORT_FILE" "@@T3_DEFAULT_REMOTE_PORT@@" "@@T3_REMOTE_PORT_SCAN_WINDOW@@" <<'NODE'
@@T3_PICK_PORT_SCRIPT@@
NODE
}
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
if [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  if [ "$RUNNER_CHANGED" -eq 1 ]; then
    kill "$REMOTE_PID" 2>/dev/null || true
    REMOTE_PID=""
    REMOTE_PORT=""
  fi
else
  REMOTE_PID=""
  REMOTE_PORT=""
fi
if [ -z "$REMOTE_PID" ] || [ -z "$REMOTE_PORT" ]; then
  REMOTE_PORT="$(pick_port)" || true
  if [ -z "$REMOTE_PORT" ]; then
    printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2
    exit 1
  fi
  nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  REMOTE_PID="$!"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
fi
printf '{"remotePort":%s}\\n' "$REMOTE_PORT"
`;

export const REMOTE_PAIRING_SCRIPT = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
SERVER_HOME="$STATE_DIR/server-home"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
mkdir -p "$STATE_DIR" "$SERVER_HOME"
cat >"$RUNNER_FILE" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
chmod 700 "$RUNNER_FILE"
"$RUNNER_FILE" auth pairing create --base-dir "$SERVER_HOME" --json
`;

export const REMOTE_STOP_SCRIPT = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  kill "$REMOTE_PID" 2>/dev/null || true
fi
rm -f "$PID_FILE" "$PORT_FILE"
printf '{"stopped":true}\\n'
`;

export function buildRemoteT3RunnerScript(input?: RemoteT3RunnerOptions): string {
  const packageSpec = input?.packageSpec?.trim() || "t3@latest";
  const nodeScriptPath = input?.nodeScriptPath?.trim() || "";
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_RUNNER_SCRIPT, {
      T3_PACKAGE_SPEC: packageSpec,
      T3_NODE_SCRIPT_PATH: shellSingleQuote(nodeScriptPath),
    }),
  );
}

export function buildRemoteLaunchScript(input?: RemoteT3RunnerOptions): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
    T3_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    T3_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    T3_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
  });
}

export function buildRemotePairingScript(
  target: DesktopSshEnvironmentTarget,
  input?: RemoteT3RunnerOptions,
): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    T3_STATE_KEY: remoteStateKey(target),
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
  });
}

export function buildRemoteStopScript(target: DesktopSshEnvironmentTarget): string {
  return applyScriptPlaceholders(REMOTE_STOP_SCRIPT, {
    T3_STATE_KEY: remoteStateKey(target),
  });
}

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuthOptions,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<
    number,
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    yield* Effect.logInfo("ssh.remoteServer.launch.start", {
      ...sshTargetLogFields(target),
      ...sshRunnerLogFields(runner),
      stateKey: remoteStateKey(target),
    });
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-s", "--", remoteStateKey(target)],
      stdin: buildRemoteLaunchScript(runner),
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    });
    if (!getLastNonEmptyOutputLine(result.stdout)) {
      return yield* new SshLaunchError({
        message: "SSH launch did not return a remote port.",
        stdout: result.stdout,
      });
    }
    const parsed = yield* decodeRemoteLaunchResult(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: "SSH launch returned unparseable output.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (!Number.isInteger(parsed.remotePort)) {
      return yield* new SshLaunchError({
        message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
        stdout: result.stdout,
      });
    }
    yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
      ...sshTargetLogFields(target),
      remotePort: parsed.remotePort,
      stateKey: remoteStateKey(target),
    });
    return parsed.remotePort;
  },
);

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
  runner?: RemoteT3RunnerOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError | SshPairingError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  yield* Effect.logInfo("ssh.remoteServer.pairingToken.start", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemotePairingScript(target, runner),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingResult(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "SSH pairing returned unparseable output.",
          stdout: result.stdout,
          cause,
        }),
    ),
  );
  if (parsed.credential.trim().length === 0) {
    return yield* new SshPairingError({
      message: "SSH pairing command returned an invalid credential.",
      stdout: result.stdout,
    });
  }
  yield* Effect.logInfo("ssh.remoteServer.pairingToken.created", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  return parsed.credential;
});

export const stopRemoteServer = Effect.fn("ssh/tunnel.stopRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
): Effect.fn.Return<
  void,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  yield* Effect.logInfo("ssh.remoteServer.stop.start", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteStopScript(target),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  yield* Effect.logInfo("ssh.remoteServer.stop.succeeded", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
});

export const waitForHttpReady = Effect.fn("ssh/tunnel.waitForHttpReady")(function* (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly path?: string;
}): Effect.fn.Return<void, SshReadinessError, HttpClient.HttpClient> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const maxRetries = Math.max(0, Math.ceil(timeoutMs / intervalMs));
  const requestUrl = new URL(input.path ?? "/", input.baseUrl).toString();
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  yield* Effect.logInfo("ssh.tunnel.httpReady.start", {
    baseUrl: input.baseUrl,
    requestUrl,
    timeoutMs,
    intervalMs,
  });

  const result = yield* client.execute(HttpClientRequest.get(requestUrl)).pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new SshReadinessError({
          message: `Backend readiness probe failed at ${input.baseUrl}.`,
          cause,
        }),
    ),
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(intervalMs)),
      times: maxRetries,
    }),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
  );

  return yield* Option.match(result, {
    onSome: () =>
      Effect.logInfo("ssh.tunnel.httpReady.succeeded", {
        baseUrl: input.baseUrl,
        requestUrl,
      }),
    onNone: () =>
      Effect.fail(
        new SshReadinessError({
          message: `Timed out waiting ${timeoutMs}ms for backend readiness at ${input.baseUrl}.`,
        }),
      ),
  });
});

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function resolveLoopbackSshHttpUrl(
  rawHttpBaseUrl: unknown,
  pathname: string,
): Effect.Effect<URL, SshHttpBridgeError> {
  return Effect.try({
    try: () => {
      if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
        throw new Error("Invalid SSH forwarded http base URL.");
      }
      const baseUrl = new URL(rawHttpBaseUrl);
      if (!isLoopbackHostname(baseUrl.hostname)) {
        throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
      }
      const url = new URL(baseUrl.toString());
      url.pathname = pathname;
      url.search = "";
      url.hash = "";
      return url;
    },
    catch: (cause) =>
      new SshHttpBridgeError({
        message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
        cause,
      }),
  });
}

export const fetchLoopbackSshJson = Effect.fn("ssh/tunnel.fetchLoopbackSshJson")(function* <
  T,
>(input: {
  readonly httpBaseUrl: unknown;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: unknown;
  readonly body?: unknown;
}): Effect.fn.Return<T, SshHttpBridgeError, HttpClient.HttpClient> {
  const requestUrl = yield* resolveLoopbackSshHttpUrl(input.httpBaseUrl, input.pathname);
  const bearerToken =
    typeof input.bearerToken === "string" && input.bearerToken.trim().length > 0
      ? input.bearerToken
      : null;

  const request = (
    input.method === "POST"
      ? HttpClientRequest.post(requestUrl.toString())
      : HttpClientRequest.get(requestUrl.toString())
  ).pipe(
    input.body === undefined ? (req) => req : HttpClientRequest.bodyJsonUnsafe(input.body),
    bearerToken
      ? HttpClientRequest.setHeader("authorization", `Bearer ${bearerToken}`)
      : (req) => req,
  );
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new SshHttpBridgeError({
          message: `Failed to reach SSH forwarded endpoint ${requestUrl.toString()}.`,
          cause,
        }),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    const text = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
    const parsedError = yield* decodeRemoteHttpError(text).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const message =
      parsedError?.error && parsedError.error.trim().length > 0
        ? parsedError.error
        : text || `SSH forwarded request failed (${response.status}).`;
    return yield* new SshHttpBridgeError({
      status: response.status,
      message: `[ssh_http:${response.status}] ${message}`,
    });
  }
  return (yield* response.json.pipe(
    Effect.mapError(
      (cause) =>
        new SshHttpBridgeError({
          message: `SSH forwarded endpoint ${requestUrl.toString()} returned invalid JSON.`,
          cause,
        }),
    ),
  )) as T;
});

const reserveLocalTunnelPort = Effect.fn("ssh/tunnel.reserveLocalTunnelPort")(function* () {
  const net = yield* NetService;
  return yield* net.reserveLoopbackPort();
});

const startSshTunnel = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuthOptions;
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | Scope.Scope
> {
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget);
  const childEnvironment = yield* buildSshChildEnvironment({
    ...(input.authOptions.authSecret === undefined
      ? {}
      : { authSecret: input.authOptions.authSecret }),
    ...(input.authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: input.authOptions.interactiveAuth }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? "no",
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    hostSpec,
  ];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  yield* Effect.logInfo("ssh.tunnel.spawn.start", {
    ...sshTargetLogFields(input.resolvedTarget),
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make("ssh", args, {
        env: childEnvironment,
        shell: process.platform === "win32",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: ["ssh", ...args],
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH tunnel for ${input.resolvedTarget.alias}.`,
            cause,
          }),
      ),
    );
  yield* Effect.logInfo("ssh.tunnel.spawn.succeeded", {
    ...sshTargetLogFields(input.resolvedTarget),
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const tunnelEntry: SshTunnelEntry = {
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
    scope,
  };
  const exitFailure = Effect.all(
    [collectProcessOutput(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh", ...args],
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([stderr, exitCode]) =>
      Effect.fail(
        new SshCommandError({
          command: ["ssh", ...args],
          exitCode,
          stderr,
          message: normalizeSshErrorMessage(
            stderr,
            `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
          ),
        }),
      ),
    ),
  );
  yield* Effect.raceFirst(
    waitForHttpReady({
      baseUrl: input.httpBaseUrl,
      timeoutMs: SSH_READY_TIMEOUT_MS,
    }),
    exitFailure,
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("ssh.tunnel.ready", {
        ...sshTargetLogFields(input.resolvedTarget),
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.logWarning("ssh.tunnel.ready.failed", {
        ...sshTargetLogFields(input.resolvedTarget),
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
        cause,
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : child
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore),
    ),
  );
  return tunnelEntry;
});

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const tunnels = new Map<string, SshTunnelEntry>();
  const pendingTunnelEntries = new Map<
    string,
    Deferred.Deferred<SshTunnelEntry, SshEnvironmentEffectError>
  >();
  const authSecrets = new Map<string, string>();

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    yield* Effect.logInfo("ssh.tunnel.close.start", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("ssh.tunnel.close.succeeded", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.sync(() => [...tunnels.values()]).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, closeTunnelEntry, { concurrency: "unbounded" }),
      ),
      Effect.ignore,
    ),
  );

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<string, SshInvalidTargetError | SshPasswordPromptError, SshPasswordPrompt> {
    const promptService = yield* SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);
    if (!promptService.isAvailable) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.unavailable", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.request", {
      ...sshTargetLogFields(target),
      attempt,
    });
    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${hostSpec}.`,
    });
    if (password === null) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.cancelled", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }
    yield* Effect.logInfo("ssh.auth.passwordPrompt.received", {
      ...sshTargetLogFields(target),
      attempt,
    });
    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/tunnel.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError;
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
      if (!isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      yield* Effect.logWarning("ssh.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/tunnel.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const promptService = yield* SshPasswordPrompt;
    const authOptions =
      input.authSecret === null
        ? {
            batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
            interactiveAuth: !promptService.isAvailable,
          }
        : {
            authSecret: input.authSecret,
            batchMode: "no" as const,
            interactiveAuth: true,
          };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/tunnel.runWithSshAuth")(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: authSecrets.get(input.key) ?? null,
    });
  });

  const createTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly runner?: RemoteT3RunnerOptions;
  }): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logInfo("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });
    const remotePort = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        launchOrReuseRemoteServer(input.resolvedTarget, authOptions, input.runner),
    });
    yield* Effect.logInfo("ssh.environment.remotePort.ready", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      remotePort,
    });
    const localPort = yield* reserveLocalTunnelPort();
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    yield* Effect.logInfo("ssh.environment.localPort.reserved", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    const entryScope = yield* Scope.make("sequential");
    const tunnelEntry = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        startSshTunnel({
          key: input.key,
          resolvedTarget: input.resolvedTarget,
          remotePort,
          localPort,
          httpBaseUrl,
          wsBaseUrl,
          authOptions,
        }).pipe(Effect.provideService(Scope.Scope, entryScope)),
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );
    tunnels.set(input.key, tunnelEntry);
    const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystemService = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* Scope.addFinalizer(
      entryScope,
      Effect.gen(function* () {
        if (tunnels.get(tunnelEntry.key) !== tunnelEntry) {
          return;
        }
        yield* Effect.logInfo("ssh.environment.tunnel.finalizer.start", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
        tunnels.delete(tunnelEntry.key);
        const authSecret = authSecrets.get(tunnelEntry.key) ?? null;
        yield* Effect.all(
          [
            tunnelEntry.process.kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            }),
            stopRemoteServer(
              tunnelEntry.target,
              authSecret === null
                ? {
                    batchMode: "yes",
                    interactiveAuth: false,
                  }
                : {
                    authSecret,
                    batchMode: "no",
                    interactiveAuth: true,
                  },
            ).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerService),
              Effect.provideService(FileSystem.FileSystem, fileSystemService),
              Effect.provideService(Path.Path, pathService),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.ignore);
        yield* Effect.logInfo("ssh.environment.tunnel.finalizer.succeeded", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
      }).pipe(Effect.ignore),
    );
    yield* Effect.logInfo("ssh.environment.tunnel.create.succeeded", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    return tunnelEntry;
  });

  const ensureTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry")(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    let entry = tunnels.get(key) ?? null;

    if (entry !== null) {
      yield* Effect.logDebug("ssh.environment.tunnel.existing.check", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
      });
      const readinessExit = yield* Effect.exit(
        waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: 2_000 }),
      );
      if (Exit.isSuccess(readinessExit)) {
        yield* Effect.logInfo("ssh.environment.tunnel.reused", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
        });
        return entry;
      }
      yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
        cause: readinessExit.cause,
      });
      yield* closeTunnelEntry(entry);
      entry = null;
    }

    const pending = pendingTunnelEntries.get(key);
    if (pending) {
      yield* Effect.logInfo("ssh.environment.tunnel.pending.await", {
        ...sshTargetLogFields(resolvedTarget),
        key,
      });
      return yield* Deferred.await(pending);
    }

    const deferred = yield* Deferred.make<SshTunnelEntry, SshEnvironmentEffectError>();
    pendingTunnelEntries.set(key, deferred);

    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      ...(runner === undefined ? {} : { runner }),
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("ssh.environment.tunnel.create.failed", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          cause,
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (pendingTunnelEntries.get(key) === deferred) {
            pendingTunnelEntries.delete(key);
          }
        }).pipe(Effect.andThen(Deferred.done(deferred, exit))),
      ),
    );
  });

  const ensureEnvironment = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: { readonly issuePairingToken?: boolean },
  ): Effect.fn.Return<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    yield* Effect.logInfo("ssh.environment.ensure.start", {
      ...sshTargetLogFields(target),
      issuePairingToken: requestOptions?.issuePairingToken === true,
    });
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    yield* Effect.logInfo("ssh.environment.target.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
    const packageSpec = options.resolveCliPackageSpec?.();
    const runner =
      options.resolveCliRunner?.() ?? (packageSpec === undefined ? undefined : { packageSpec });
    yield* Effect.logDebug("ssh.environment.runner.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      ...sshRunnerLogFields(runner),
      key,
    });
    const entry = yield* ensureTunnelEntry(key, resolvedTarget, runner);

    const pairingToken = requestOptions?.issuePairingToken
      ? yield* runWithSshAuth({
          key,
          target: entry.target,
          operation: (authOptions) => issueRemotePairingToken(entry.target, authOptions, runner),
        })
      : null;

    yield* Effect.logInfo("ssh.environment.ensure.succeeded", {
      ...sshTargetLogFields(entry.target),
      key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
      issuedPairingToken: pairingToken !== null,
    });
    return {
      target: entry.target,
      httpBaseUrl: entry.httpBaseUrl,
      wsBaseUrl: entry.wsBaseUrl,
      pairingToken,
    };
  });

  const disconnectEnvironment = Effect.fn("ssh/tunnel.disconnectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logInfo("ssh.environment.disconnect.start", sshTargetLogFields(target));
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    const entry = tunnels.get(key) ?? null;
    yield* Effect.logDebug("ssh.environment.disconnect.targetResolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
      hasTunnel: entry !== null,
      hasPendingTunnel: pendingTunnelEntries.has(key),
    });
    if (entry !== null) {
      yield* closeTunnelEntry(entry);
    }
    const pending = pendingTunnelEntries.get(key);
    if (pending) {
      pendingTunnelEntries.delete(key);
      yield* Deferred.fail(pending, makeSshTunnelCancelledError(resolvedTarget)).pipe(
        Effect.ignore,
      );
    }
    if (entry === null) {
      yield* runWithSshAuth({
        key,
        target: resolvedTarget,
        operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
      });
    }
    yield* Effect.logInfo("ssh.environment.disconnect.succeeded", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
  });

  return SshEnvironmentManager.of({ ensureEnvironment, disconnectEnvironment });
});

export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@t3tools/ssh/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}
