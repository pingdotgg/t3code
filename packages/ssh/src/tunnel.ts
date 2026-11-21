import {
  DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE,
  DESKTOP_UPDATE_IN_PROGRESS_TTL_MS,
} from "@lathe/contracts";
import type { DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentTarget } from "@lathe/contracts";
import { waitForHttpReady as waitForHttpReadyShared } from "@lathe/shared/httpReadiness";
import { cliReleaseDownloadBaseUrl } from "@lathe/shared/cliRelease";
import { FORK_HOME_SHELL } from "@lathe/shared/forkBaseDir";
import { forkCliArchiveShell, forkCliExecutableShell } from "@lathe/shared/forkCliArtifacts";
import { FORK_IDENTITY } from "@lathe/shared/forkIdentity";
import * as KeyedLock from "@lathe/shared/KeyedLock";
import * as NetService from "@lathe/shared/Net";
import { extractJsonObject, fromLenientJson } from "@lathe/shared/schemaJson";
import { satisfiesSemverRange } from "@lathe/shared/semver";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import * as ControlMaster from "./controlMaster.ts";
import {
  annotateSshTargetSpan,
  baseSshArgs,
  buildSshHostSpecEffect,
  getLastNonEmptyOutputLine,
  remoteStateKey,
  resolveSshCommand,
  resolveSshTarget,
  runSshCommand,
  SSH_DIRECT,
  type SshMultiplex,
  shellSingleQuote,
  sshTargetLogFields,
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
import { SshOutputObserver } from "./output.ts";

const DEFAULT_REMOTE_PORT = FORK_IDENTITY.defaultPort;
const REMOTE_PORT_SCAN_WINDOW = 200;
const SSH_READY_TIMEOUT_MS = 20_000;
const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
// Probes through the forward pay several link round trips, about 4s at a 1s RTT.
const SSH_TUNNEL_READY_PROBE_TIMEOUT_MS = 5_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const TUNNEL_STDERR_TAIL_CHARS = 16_384;
const REMOTE_READY_TIMEOUT_MS = 60_000;
const REMOTE_LAUNCH_BASE_TIMEOUT_MS = 90_000;
// Matches the node-script launch command's ssh run without the launch lock wait.
const SSH_TUNNEL_CONNECT_TIMEOUT_MS = REMOTE_LAUNCH_BASE_TIMEOUT_MS;
const SSH_TUNNEL_FORWARD_PROBE_INTERVAL_MS = 100;
// Cold archive launches download and extract ~70 MB and may wait on an install lock.
// Lock waits must outlast both downloads and extraction; SSH must outlast install or wait plus readiness.
// Leave slack for verification and extraction, which have no timeout.
const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;
const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;
const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;
const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;
const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;
// A stopping server reconciles its state before it exits, usually in 5-11s.
const REMOTE_SERVER_STOP_WAIT_SECONDS = 15;
// An update restart waits longer, since a replacement started over a server
// still shutting down exits on its ownership lock. Busy hosts took ~60s.
const REMOTE_SERVER_RESTART_WAIT_SECONDS = 120;
// Readiness is probed in slices so a server that exits early fails at once.
const REMOTE_READY_SLICE_MS = 2_000;
// The server answers HTTP before it writes server-runtime.json, which is how
// a launch for another alias finds it.
const REMOTE_RUNTIME_RECORD_WAIT_SECONDS = 10;
// The desktop update wait runs under the home lock. Its last poll and the
// adoption after it each add a reuse probe, and the poll adds one sleep.
const REMOTE_UPDATE_WAIT_MS =
  DESKTOP_UPDATE_IN_PROGRESS_TTL_MS +
  2 * (REMOTE_REUSE_READY_TIMEOUT_MS + SSH_READY_PROBE_TIMEOUT_MS) +
  1_000;
// A launch waits this long for a server that holds the home to answer; its
// last poll adds a reuse probe.
const REMOTE_OWNER_WAIT_MS =
  REMOTE_READY_TIMEOUT_MS + REMOTE_REUSE_READY_TIMEOUT_MS + SSH_READY_PROBE_TIMEOUT_MS;
// A launch holds the home lock through up to two reuse probes, readiness, a
// stop wait and a restart wait for an old server, the runtime record wait, the
// update wait, and the owner wait; each probe may overrun its deadline by one
// request.
const REMOTE_LAUNCH_LOCK_WAIT_SECONDS = Math.ceil(
  (REMOTE_READY_TIMEOUT_MS +
    2 * REMOTE_REUSE_READY_TIMEOUT_MS +
    (REMOTE_SERVER_STOP_WAIT_SECONDS + REMOTE_SERVER_RESTART_WAIT_SECONDS) * 1000 +
    REMOTE_RUNTIME_RECORD_WAIT_SECONDS * 1000 +
    4 * SSH_READY_PROBE_TIMEOUT_MS +
    REMOTE_UPDATE_WAIT_MS +
    REMOTE_OWNER_WAIT_MS) /
    1000,
);
// Covers another launch's hold on the lock, then this launch's own restart
// wait for the old server plus readiness of the new one.
const REMOTE_LAUNCH_TIMEOUT_MS =
  REMOTE_LAUNCH_LOCK_WAIT_SECONDS * 1000 +
  REMOTE_UPDATE_WAIT_MS +
  REMOTE_OWNER_WAIT_MS +
  REMOTE_LAUNCH_BASE_TIMEOUT_MS +
  REMOTE_SERVER_RESTART_WAIT_SECONDS * 1000;

export interface RemoteLatheRunnerOptions {
  readonly nodeScriptPath?: string | null;
  readonly nodeEngineRange?: string | null;
  readonly archiveVersion?: string | null;
  readonly releaseBaseUrl?: string | null;
}

export interface SshEnvironmentManagerOptions {
  readonly resolveCliRunner?: Effect.Effect<RemoteLatheRunnerOptions>;
  /**
   * Where the manager keeps its owned ssh ControlMaster sockets, normally
   * `<base dir>/ssh`. Without one every command connects directly.
   */
  readonly controlSocketDirectory?: string;
  // Identifies this install to the remote across edits of a connection; null when unknown.
  readonly resolveLauncherId?: Effect.Effect<string | null>;
}

/**
 * Auth for a one-shot command, plus how it multiplexes. The manager always
 * chooses: its owned master, or a direct connection, never a user master.
 */
interface RemoteCommandOptions extends SshAuth.SshAuthOptions {
  readonly multiplex: SshMultiplex;
}

interface SshTunnelEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
}

type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshAuth.SshPasswordPrompt;

type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

type SshPhase =
  | "targetResolveMs"
  | "lockWaitMs"
  | "existingTunnelCheckMs"
  | "controlMasterMs"
  | "launchMs"
  | "tunnelStartMs"
  | "pairingMs"
  | "tunnelCloseMs"
  | "remoteStopMs";

/**
 * What one ensure or disconnect did, logged once as its outcome event so a
 * single trace event answers where a slow reconnect spent its time. Phases
 * that did not run stay absent; a phase that ran twice (a mux retry) sums.
 */
interface SshConnectionSummary {
  readonly phases: Partial<Record<SshPhase, number>>;
  tunnel: "reused" | "stale-replaced" | "created" | "pruned-exited" | "closed" | "none" | null;
  controlMaster: ControlMaster.ControlMasterOutcome["decision"] | "not-used";
  controlMasterReason: string | null;
  launchAction: RemoteLaunchAction | null;
  remoteServerKind: "external" | "managed" | null;
  remotePort: number | null;
  localPort: number | null;
}

const makeConnectionSummary = (): SshConnectionSummary => ({
  phases: {},
  tunnel: null,
  controlMaster: "not-used",
  controlMasterReason: null,
  launchAction: null,
  remoteServerKind: null,
  remotePort: null,
  localPort: null,
});

/** Adds the effect's wall time, success or not, to one phase of the summary. */
const timePhase =
  (summary: SshConnectionSummary | undefined, phase: SshPhase) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    summary === undefined
      ? effect
      : Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
          effect.pipe(
            Effect.ensuring(
              Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
                Effect.sync(() => {
                  summary.phases[phase] = (summary.phases[phase] ?? 0) + (endedAt - startedAt);
                }),
              ),
            ),
          ),
        );

function connectionSummaryLogFields(summary: SshConnectionSummary, totalMs: number) {
  return {
    totalMs,
    ...summary.phases,
    tunnel: summary.tunnel,
    controlMaster: summary.controlMaster,
    ...(summary.controlMasterReason === null
      ? {}
      : { controlMasterReason: summary.controlMasterReason }),
    launchAction: summary.launchAction,
    remoteServerKind: summary.remoteServerKind,
    remotePort: summary.remotePort,
    localPort: summary.localPort,
  };
}

const PHASE_LABELS: Record<SshPhase, string> = {
  targetResolveMs: "resolving the host",
  lockWaitMs: "waiting for another connect",
  existingTunnelCheckMs: "checking the existing tunnel",
  controlMasterMs: "control master",
  launchMs: "launch",
  tunnelStartMs: "tunnel start",
  pairingMs: "pairing",
  tunnelCloseMs: "tunnel close",
  remoteStopMs: "remote stop",
};
const SLOW_PHASE_MS = 1_000;

const TUNNEL_TEXT: Partial<Record<NonNullable<SshConnectionSummary["tunnel"]>, string>> = {
  created: "opened a tunnel",
  reused: "reused the tunnel",
  "stale-replaced": "replaced a stale tunnel",
  "pruned-exited": "reopened a tunnel that had exited",
};

/** The output panel's one-line account of an ensure, which is all a tunnel reuse reports. */
function describeConnectionSummary(
  summary: SshConnectionSummary,
  succeeded: boolean,
  totalMs: number,
): string {
  const seconds = (ms: number) => `${(ms / 1_000).toFixed(1)}s`;
  const details: Array<string> = [];
  const tunnel = summary.tunnel === null ? undefined : TUNNEL_TEXT[summary.tunnel];
  if (tunnel !== undefined && summary.localPort !== null && summary.remotePort !== null) {
    details.push(
      `${tunnel} from local port ${summary.localPort} to remote port ${summary.remotePort}`,
    );
  }
  if (summary.controlMaster !== "not-used" && summary.controlMaster !== "disabled") {
    details.push(
      `control master ${summary.controlMaster}${summary.controlMasterReason === null ? "" : `: ${summary.controlMasterReason}`}`,
    );
  }
  const slow = (Object.entries(summary.phases) as Array<[SshPhase, number]>)
    .filter(([, ms]) => ms >= SLOW_PHASE_MS)
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([phase, ms]) => `${PHASE_LABELS[phase]} ${seconds(ms)}`);
  const head = succeeded ? `Connected in ${seconds(totalMs)}` : `Failed after ${seconds(totalMs)}`;
  return [
    details.length === 0 ? head : `${head}: ${details.join(", ")}`,
    ...(slow.length === 0
      ? []
      : [`slowest step${slow.length === 1 ? "" : "s"}: ${slow.join(", ")}`]),
  ].join("; ");
}

const MAX_SUMMARY_ERROR_LENGTH = 500;

/** A short tag and message for a failed outcome; errors here never carry a credential. */
function summaryErrorFields(cause: Cause.Cause<unknown>) {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : error !== undefined
        ? "Error"
        : Cause.hasInterruptsOnly(cause)
          ? "Interrupted"
          : "Defect";
  const message =
    error instanceof Error
      ? error.message
      : tag === "Interrupted"
        ? "interrupted"
        : String(Cause.squash(cause));
  return {
    errorTag: tag,
    errorMessage:
      message.length > MAX_SUMMARY_ERROR_LENGTH
        ? `${message.slice(0, MAX_SUMMARY_ERROR_LENGTH)}...`
        : message,
  };
}

function isNodeScriptRunner(runner: RemoteLatheRunnerOptions | undefined): boolean {
  return Boolean(runner?.nodeScriptPath?.trim());
}

function sshRunnerLogFields(runner: RemoteLatheRunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }
  if (runner?.archiveVersion?.trim()) {
    return { runner: "archive", archiveVersion: runner.archiveVersion.trim() };
  }
  return { runner: "archive" };
}

interface SshAuthOperationInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuth.SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

type RunOneShot = <T>(
  operation: (
    options: RemoteCommandOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>,
) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;

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
  /** Closes every tunnel, as the manager's scope finalizer does. */
  readonly closeAllTunnels: Effect.Effect<void>;
}

/** What the launch script did with the remote server, reported as its `action`. */
export const REMOTE_LAUNCH_ACTIONS = [
  /** No live server was found, so a managed one was started. */
  "started",
  /** The running managed server answered and was kept. */
  "reused",
  /** The managed server was stopped and started again because the runner changed. */
  "restarted-runner-changed",
  /** A server this script does not own was already running and is used instead. */
  "adopted-external",
  /** Same, and the managed server that was running was stopped first. */
  "replaced-by-external",
  /** The external server used last time still answers. */
  "reused-external",
] as const;

export type RemoteLaunchAction = (typeof REMOTE_LAUNCH_ACTIONS)[number];

const RemoteLaunchResult = Schema.Struct({
  remotePort: Schema.Number,
  serverKind: Schema.optional(Schema.Literals(["external", "managed"])),
  action: Schema.optional(Schema.Literals(REMOTE_LAUNCH_ACTIONS)),
});

const RemotePairingResult = Schema.Struct({
  credential: Schema.String,
});

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));
const decodeRemotePairingResult = Schema.decodeEffect(fromLenientJson(RemotePairingResult));

const decodeRemoteJsonOutput = <A, E>(
  stdout: string,
  decode: (input: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  decode(stdout).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const jsonObject = extractJsonObject(stdout);
        if (jsonObject === stdout.trim()) {
          return yield* Effect.fail(error);
        }
        const exit = yield* Effect.exit(decode(jsonObject));
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        return yield* Effect.fail(error);
      }),
    ),
  );

const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

const decodeRemotePairingOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemotePairingResult);

const remoteNodeEngineCheckMain = function remoteNodeEngineCheckMain() {
  const range = process.argv[2] || "";
  const rawVersion =
    process.versions && process.versions.node ? process.versions.node : process.version;

  if (!satisfiesSemverRange(rawVersion, range)) {
    process.stderr.write(
      "Remote node " + rawVersion + " does not satisfy required range " + range + ".\n",
    );
    process.exit(1);
  }
};

function buildRemoteNodeEngineCheckScript(): string {
  return `${satisfiesSemverRange.toString()}
(${remoteNodeEngineCheckMain.toString()})();`;
}

function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

function applyScriptPlaceholders(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    // A replacer function keeps `$$` and other `$` patterns in the value literal.
    result = result.replaceAll(`@@${token}@@`, () => value);
  }
  return result;
}

const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2] ?? "";
const defaultPort = Number.parseInt(process.argv[3] ?? "", 10);
const scanWindow = Number.parseInt(process.argv[4] ?? "", 10);
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : defaultPort;
const end = start + scanWindow;

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(!error));
    });
  });
}

// macOS lets the bind above succeed while another process listens on
// *:<port>, so also skip any port that already answers on loopback.
function answersOnLoopback(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

(async () => {
  for (let port = start; port < end; port += 1) {
    const available = (await canBind(port)) && !(await answersOnLoopback(port));
    if (available) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

const REMOTE_WAIT_READY_SCRIPT = `const http = require("node:http");
const port = Number.parseInt(process.argv[2] ?? "", 10);
const timeoutMs = Number.parseInt(process.argv[3] ?? "", 10);
const probeTimeoutMs = Number.parseInt(process.argv[4] ?? "", 10);
if (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {
  process.exit(1);
}
const deadline = Date.now() + timeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        timeout: probeTimeoutMs,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode >= 200 && response.statusCode < 300 ? "ready" : "not-ready");
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve("not-ready");
    });
    request.once("error", (error) => resolve(error?.code === "ECONNREFUSED" ? "refused" : "not-ready"));
  });
}

(async () => {
  let refusedOnly = true;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result === "ready") {
      process.exit(0);
    }
    refusedOnly &&= result === "refused";
    await sleep(100);
  }
  process.exit(refusedOnly ? 2 : 1);
})().catch(() => process.exit(1));
`;

const REMOTE_NODE_ENV_SCRIPT = `prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

remote_node_satisfies_engine() {
  LATHE_NODE_ENGINE_RANGE=@@LATHE_NODE_ENGINE_RANGE@@
  if [ -z "$LATHE_NODE_ENGINE_RANGE" ]; then
    return 0
  fi
  node - "$LATHE_NODE_ENGINE_RANGE" <<'NODE'
@@LATHE_NODE_ENGINE_CHECK_SCRIPT@@
NODE
}

ensure_remote_node_path() {
  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then
    return 0
  fi

  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/home/linuxbrew/.linuxbrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"

  if [ -z "\${VOLTA_HOME:-}" ]; then
    VOLTA_HOME="$HOME/.volta"
  fi
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ ! -x "$HOME/.asdf/shims/node" ] && [ -s "$HOME/.asdf/asdf.sh" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.asdf/asdf.sh"
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${FNM_DIR:-}" ]; then
    FNM_DIR="$HOME/.local/share/fnm"
  fi
  export FNM_DIR
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${NVM_DIR:-}" ]; then
    NVM_DIR="$HOME/.nvm"
  fi
  export NVM_DIR

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
    fi
  fi

  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for LATHE_NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      if [ -x "$LATHE_NODE_BIN/node" ]; then
        PATH="$LATHE_NODE_BIN:$PATH"
        export PATH
      fi
    done
  fi

  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine
}
`;

const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
@@LATHE_NODE_ENV_SCRIPT@@
LATHE_NODE_SCRIPT_PATH=@@LATHE_NODE_SCRIPT_PATH@@
if [ -n "$LATHE_NODE_SCRIPT_PATH" ]; then
  # Dev mode: a source checkout on the remote. This is the only path that
  # needs Node, so Node discovery runs here and nowhere else.
  ensure_remote_node_path || true
  if ! command -v node >/dev/null 2>&1; then
    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
    exit 1
  fi
  exec node "$LATHE_NODE_SCRIPT_PATH" "$@"
fi
LATHE_ARCHIVE_VERSION=@@LATHE_ARCHIVE_VERSION@@
if [ -z "$LATHE_ARCHIVE_VERSION" ]; then
  printf 'No t3 release version was provided for the remote runtime.\\n' >&2
  exit 1
fi
LATHE_SYSTEM_EXECUTABLE="$(command -v ${FORK_IDENTITY.cliBin} 2>/dev/null || true)"
if [ -n "$LATHE_SYSTEM_EXECUTABLE" ] && LATHE_SYSTEM_VERSION="$("$LATHE_SYSTEM_EXECUTABLE" --version 2>/dev/null)" && [ "$LATHE_SYSTEM_VERSION" = "${FORK_IDENTITY.cliBin} v$LATHE_ARCHIVE_VERSION" ]; then
  # A matching host-provided runtime supports platforms such as musl Linux,
  # where the portable release archive cannot run.
  exec "$LATHE_SYSTEM_EXECUTABLE" "$@"
fi
# Self-contained release archive: no Node, npm, or compiler on the remote.
# Unpacked into the pinned-runtime layout so \`t3 service install\` reuses it.
LATHE_RELEASE_BASE_URL=@@LATHE_RELEASE_BASE_URL@@
LATHE_RUNTIME_DIR="${FORK_HOME_SHELL}/runtime/versions/$LATHE_ARCHIVE_VERSION"
lathe_runtime_ready() {
  [ -x "${forkCliExecutableShell("$LATHE_RUNTIME_DIR")}" ] && [ "$(cat "$LATHE_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$LATHE_ARCHIVE_VERSION" ]
}
if ! lathe_runtime_ready; then
  mkdir -p "${FORK_HOME_SHELL}/runtime/versions"
  LATHE_LOCK="${FORK_HOME_SHELL}/runtime/versions/.$LATHE_ARCHIVE_VERSION.install.lock"
  # uutils mkdir can report success on EEXIST, so use shell noclobber.
  # An empty lock gets a short grace period for its owner to publish a PID.
  LATHE_LOCK_WAITED=0
  LATHE_LOCK_UNOWNED=0
  while ! (set -C; printf '%s\\n' "$$" > "$LATHE_LOCK") 2>/dev/null; do
    LATHE_LOCK_OWNER="$(cat "$LATHE_LOCK" 2>/dev/null || true)"
    if [ -n "$LATHE_LOCK_OWNER" ]; then
      LATHE_LOCK_UNOWNED=0
      if ! kill -0 "$LATHE_LOCK_OWNER" 2>/dev/null; then
        rm -rf "$LATHE_LOCK"
        continue
      fi
    else
      LATHE_LOCK_UNOWNED=$((LATHE_LOCK_UNOWNED + 1))
      if [ "$LATHE_LOCK_UNOWNED" -ge 5 ]; then
        rm -rf "$LATHE_LOCK"
        continue
      fi
    fi
    if [ "$LATHE_LOCK_WAITED" -ge @@LATHE_ARCHIVE_LOCK_WAIT_SECONDS@@ ]; then
      printf 'Another t3 %s installation has held %s for too long.\\n' "$LATHE_ARCHIVE_VERSION" "$LATHE_LOCK" >&2
      exit 1
    fi
    sleep 1
    LATHE_LOCK_WAITED=$((LATHE_LOCK_WAITED + 1))
  done
  trap 'rm -rf "$LATHE_LOCK"' EXIT
fi
if ! lathe_runtime_ready; then
  # Keep aligned with CLI_ARCHIVE_PLATFORM_KEYS in packages/shared/src/cliRelease.ts.
  case "$(uname -s) $(uname -m)" in
    "Darwin arm64") LATHE_PLATFORM_KEY="darwin-arm64" ;;
    "Linux arm64" | "Linux aarch64") LATHE_PLATFORM_KEY="linux-arm64" ;;
    "Linux x86_64" | "Linux amd64") LATHE_PLATFORM_KEY="linux-x64" ;;
    *) printf 'Remote host %s has no t3 release archive.\\n' "$(uname -s) $(uname -m)" >&2; exit 1 ;;
  esac
  if ! command -v tar >/dev/null 2>&1; then
    printf 'Remote host needs tar to unpack the %s release archive for %s. Install tar on it and try again.\\n' "$LATHE_ARCHIVE_VERSION" "$LATHE_PLATFORM_KEY" >&2
    exit 1
  fi
  LATHE_STAGING="$(mktemp -d "${FORK_HOME_SHELL}/runtime/versions/.staging-XXXXXX")"
  trap 'rm -rf "$LATHE_STAGING" "$LATHE_LOCK"' EXIT
  lathe_fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 "$1" -O "$2"
    else printf 'Remote host needs curl or wget to download %s.\\n' "$1" >&2; exit 1
    fi || {
      printf 'Could not download ${FORK_IDENTITY.cliBin} %s from %s. If this host cannot reach it, install ${FORK_IDENTITY.cliBin} %s on it with https://raw.githubusercontent.com/${FORK_IDENTITY.releaseRepository}/main/scripts/install.sh (LATHE_VERSION=%s; LATHE_RELEASE_BASE_URL selects a mirror).\\n' "$LATHE_ARCHIVE_VERSION" "$1" "$LATHE_ARCHIVE_VERSION" "$LATHE_ARCHIVE_VERSION" >&2
      exit 1
    }
  }
  lathe_fetch "$LATHE_RELEASE_BASE_URL/v$LATHE_ARCHIVE_VERSION/SHA256SUMS" "$LATHE_STAGING/SHA256SUMS" @@LATHE_ARCHIVE_CHECKSUMS_SECONDS@@
  LATHE_ARCHIVE="${forkCliArchiveShell("$LATHE_STAGING/SHA256SUMS", "$LATHE_ARCHIVE_VERSION-$LATHE_PLATFORM_KEY.tar.gz")}"
  lathe_fetch "$LATHE_RELEASE_BASE_URL/v$LATHE_ARCHIVE_VERSION/$LATHE_ARCHIVE" "$LATHE_STAGING/$LATHE_ARCHIVE" @@LATHE_ARCHIVE_DOWNLOAD_SECONDS@@
  LATHE_EXPECTED="$(grep " \\*\\{0,1\\}$LATHE_ARCHIVE$" "$LATHE_STAGING/SHA256SUMS" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then
    LATHE_ACTUAL="$(sha256sum < "$LATHE_STAGING/$LATHE_ARCHIVE" | cut -d' ' -f1)"
  else
    LATHE_ACTUAL="$(shasum -a 256 < "$LATHE_STAGING/$LATHE_ARCHIVE" | cut -d' ' -f1)"
  fi
  if [ -z "$LATHE_EXPECTED" ] || [ "$LATHE_ACTUAL" != "$LATHE_EXPECTED" ]; then
    printf 'Checksum mismatch for %s.\\n' "$LATHE_ARCHIVE" >&2; exit 1
  fi
  if ! LATHE_TAR_ERROR="$(tar -xzf "$LATHE_STAGING/$LATHE_ARCHIVE" -C "$LATHE_STAGING" --strip-components=1 2>&1)"; then
    # Some tars (BusyBox) gunzip internally, so gzip is only blamed once extraction fails.
    if command -v gzip >/dev/null 2>&1; then printf '%s\\n' "$LATHE_TAR_ERROR" >&2
    else printf 'Remote host needs gzip to unpack %s. Install gzip on it and try again.\\n' "$LATHE_ARCHIVE" >&2
    fi
    exit 1
  fi
  rm -f "$LATHE_STAGING/$LATHE_ARCHIVE" "$LATHE_STAGING/SHA256SUMS"
  # Prove the runtime runs here before marking it ready, or every later launch
  # would exec a broken install instead of retrying. The executable is
  # preferred; a host whose libc cannot load it (NixOS, musl) runs the same
  # bundle with its own Node instead, recorded so later launches skip the probe.
  if "${forkCliExecutableShell("$LATHE_STAGING")}" --version >/dev/null 2>&1; then
    printf 'exe\\n' > "$LATHE_STAGING/.launcher"
  elif ensure_remote_node_path && node "$LATHE_STAGING/bin.mjs" --version >/dev/null 2>&1; then
    printf 'node\\n' > "$LATHE_STAGING/.launcher"
  else
    printf 'The t3 %s executable does not run on this host, and no compatible node is on PATH to run it as a script.\\n' "$LATHE_ARCHIVE_VERSION" >&2; exit 1
  fi
  printf '%s\\n' "$LATHE_ARCHIVE_VERSION" > "$LATHE_STAGING/.install-complete"
  rm -rf "$LATHE_RUNTIME_DIR"
  mv "$LATHE_STAGING" "$LATHE_RUNTIME_DIR"
fi
if [ -n "\${LATHE_LOCK:-}" ]; then
  rm -rf "$LATHE_LOCK"
  trap - EXIT
fi
if [ "$(cat "$LATHE_RUNTIME_DIR/.launcher" 2>/dev/null)" = "node" ]; then
  ensure_remote_node_path || true
  exec node "$LATHE_RUNTIME_DIR/bin.mjs" "$@"
fi
exec "${forkCliExecutableShell("$LATHE_RUNTIME_DIR")}" "$@"
`;

// kill -0 also passes for a zombie, a reused PID and, on Linux, a thread ID,
// which ps does not list. Only the serve command the launcher started counts;
// where ps cannot look up a PID at all, trust kill -0.
const REMOTE_MANAGED_SERVER_RUNNING_SCRIPT = `managed_server_running() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null || return 1
  if MANAGED_ARGS="$(ps -ww -o args= -p "$1" 2>/dev/null)"; then
    case "$MANAGED_ARGS" in
      *" serve --host 127.0.0.1 --port "[0-9]*) return 0 ;;
    esac
    return 1
  fi
  ! ps -ww -o args= -p "$$" >/dev/null 2>&1
}`;

// NFS-shared homes can link ~/.lathe to a directory that does not exist yet, and
// mkdir -p fails with EEXIST on a dangling symlink, so create its target first.
const REMOTE_ENSURE_LATHE_HOME_SCRIPT = `if [ -L "$HOME/.lathe" ] && [ ! -e "$HOME/.lathe" ]; then
  (cd "$HOME" && mkdir -p "$(readlink .lathe)")
fi`;

const REMOTE_LAUNCH_SCRIPT = `set -eu
@@LATHE_NODE_ENV_SCRIPT@@
READY_TIMEOUT_MS=@@LATHE_READY_TIMEOUT_MS@@
RESTART_WAIT_SECONDS=@@LATHE_SERVER_RESTART_WAIT_SECONDS@@
STATE_KEY="$1"
LAUNCHER_ID="\${2:-}"
STATE_DIR="${FORK_HOME_SHELL}/ssh-launch/$STATE_KEY"
DEFAULT_SERVER_HOME="${FORK_HOME_SHELL}"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-lathe.sh"
RUNNER_NEXT="$STATE_DIR/run-lathe.next.$$"
LAUNCH_LOCK="$DEFAULT_SERVER_HOME/ssh-launch/.launch.lock"
LAUNCH_BREAK_LOCK="$LAUNCH_LOCK.break"
@@LATHE_ENSURE_LATHE_HOME_SCRIPT@@
mkdir -p "$STATE_DIR"
cleanup_launch() {
  rm -f "$RUNNER_NEXT"
  for OWNED_LOCK in "$LAUNCH_LOCK" "$LAUNCH_BREAK_LOCK"; do
    if [ "$(cat "$OWNED_LOCK" 2>/dev/null || true)" = "$$" ]; then
      rm -f "$OWNED_LOCK"
    fi
  done
}
trap cleanup_launch EXIT
# A dropped SSH session signals the launch (PIPE on its next write); exit so
# the lock is released.
trap 'exit 1' HUP INT PIPE TERM
cat >"$RUNNER_NEXT" <<'SH'
@@LATHE_RUNNER_SCRIPT@@
SH
chmod 700 "$RUNNER_NEXT"
LATHE_ARCHIVE_MODE=@@LATHE_ARCHIVE_MODE@@
if [ "$LATHE_ARCHIVE_MODE" = "1" ]; then
  # The archive ships the helpers below inside the executable; the remote
  # needs no Node at all. Resolving the runner once here also downloads the
  # archive before the port and readiness probes rely on it.
  "$RUNNER_NEXT" --version >/dev/null
elif ! ensure_remote_node_path; then
  if ! command -v node >/dev/null 2>&1; then
    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
  fi
  exit 1
fi
# Recovery runs under its own lock and re-reads the owner there, so a waiter
# that judged an earlier lock stale cannot remove its successor's lock. No
# launch removes another's recovery lock: only SIGKILL inside these lines
# leaves one behind, and the wait below then fails naming it.
discard_stale_launch_lock() {
  (set -C; printf '%s\\n' "$$" >"$LAUNCH_BREAK_LOCK") 2>/dev/null || return 1
  if [ "$(cat "$LAUNCH_LOCK" 2>/dev/null || true)" = "$1" ]; then
    rm -f "$LAUNCH_LOCK"
  fi
  rm -f "$LAUNCH_BREAK_LOCK"
}
# Concurrent launches share this home's owner lock and may share this record.
# Hold the lock from comparing the runner until the server is recorded and
# ready, so a waiting launch reuses that server instead of starting or
# replacing one.
LAUNCH_LOCK_WAITED=0
LAUNCH_LOCK_UNOWNED=0
while ! (set -C; printf '%s\\n' "$$" >"$LAUNCH_LOCK") 2>/dev/null; do
  LAUNCH_LOCK_OWNER="$(cat "$LAUNCH_LOCK" 2>/dev/null || true)"
  if [ -n "$LAUNCH_LOCK_OWNER" ]; then
    LAUNCH_LOCK_UNOWNED=0
    if ! kill -0 "$LAUNCH_LOCK_OWNER" 2>/dev/null && discard_stale_launch_lock "$LAUNCH_LOCK_OWNER"; then
      continue
    fi
  else
    LAUNCH_LOCK_UNOWNED=$((LAUNCH_LOCK_UNOWNED + 1))
    if [ "$LAUNCH_LOCK_UNOWNED" -ge 5 ] && discard_stale_launch_lock ""; then
      LAUNCH_LOCK_UNOWNED=0
      continue
    fi
  fi
  if [ "$LAUNCH_LOCK_WAITED" -ge @@LATHE_LAUNCH_LOCK_WAIT_SECONDS@@ ]; then
    if [ -e "$LAUNCH_BREAK_LOCK" ]; then
      printf 'A Lathe server launch stopped while recovering %s. If no launch is running, delete %s.\\n' "$LAUNCH_LOCK" "$LAUNCH_BREAK_LOCK" >&2
    else
      printf 'Another Lathe server launch has held %s for too long.\\n' "$LAUNCH_LOCK" >&2
    fi
    exit 1
  fi
  sleep 1
  LAUNCH_LOCK_WAITED=$((LAUNCH_LOCK_WAITED + 1))
done
RUNNER_CHANGED=0
if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  RUNNER_CHANGED=1
fi
mv "$RUNNER_NEXT" "$RUNNER_FILE"
if [ -n "$LAUNCHER_ID" ]; then
  printf '%s\\n' "$LAUNCHER_ID" >"$STATE_DIR/launcher"
fi
pick_port() {
  if [ "$LATHE_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE" "@@LATHE_DEFAULT_REMOTE_PORT@@" "@@LATHE_REMOTE_PORT_SCAN_WINDOW@@"
    return
  fi
  node - "$PORT_FILE" "@@LATHE_DEFAULT_REMOTE_PORT@@" "@@LATHE_REMOTE_PORT_SCAN_WINDOW@@" <<'NODE'
@@LATHE_PICK_PORT_SCRIPT@@
NODE
}
wait_ready() {
  if [ "$LATHE_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT" "$1" "@@LATHE_READY_PROBE_TIMEOUT_MS@@"
    return
  fi
  node - "$REMOTE_PORT" "$1" "@@LATHE_READY_PROBE_TIMEOUT_MS@@" <<'NODE'
@@LATHE_WAIT_READY_SCRIPT@@
NODE
}
# 0 once the server answers, 1 while it is alive but not ready by the
# deadline, 2 as soon as it has exited.
wait_server_ready() {
  READY_PID="$1"
  READY_LEFT_MS="$2"
  while [ "$READY_LEFT_MS" -gt 0 ]; do
    READY_SLICE_MS=@@LATHE_READY_SLICE_MS@@
    [ "$READY_LEFT_MS" -lt "$READY_SLICE_MS" ] && READY_SLICE_MS="$READY_LEFT_MS"
    wait_ready "$READY_SLICE_MS" && return 0
    server_running "$READY_PID" || return 2
    READY_LEFT_MS=$((READY_LEFT_MS - READY_SLICE_MS))
  done
  return 1
}
wait_for_pid_exit() {
  PID_TO_WAIT="$1"
  WAIT_SECONDS="\${2:-@@LATHE_SERVER_STOP_WAIT_SECONDS@@}"
  WAIT_COUNT=0
  while kill -0 "$PID_TO_WAIT" 2>/dev/null && [ "$WAIT_COUNT" -lt $((WAIT_SECONDS * 10)) ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
}
# kill -0 also succeeds for a server that exited but was not reaped yet, so
# a zombie does not count as running. Without ps to tell, trust kill -0.
server_running() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null || return 1
  case "$(ps -o stat= -p "$1" 2>/dev/null || true)" in
    *Z*) return 1 ;;
  esac
}
# An older client replacing a same-or-newer server would run below the database's migrations.
keeps_running_server() {
  [ "$LATHE_ARCHIVE_MODE" = "1" ] &&
    "$RUNNER_FILE" __ssh-helper keep-server "$DEFAULT_RUNTIME_FILE" "$REMOTE_PID" >/dev/null 2>&1
}
@@LATHE_MANAGED_SERVER_RUNNING_SCRIPT@@
# The server publishes its runtime record only after it answers, so one that
# has published and now refuses every connection has closed its listener to
# shut down; a starting server has not published yet. Exit 2 means refused.
managed_server_stopping() {
  [ "$DEFAULT_RUNTIME_PID" = "$REMOTE_PID" ] || return 1
  READY_STATUS=0
  wait_ready "@@LATHE_REUSE_READY_TIMEOUT_MS@@" || READY_STATUS=$?
  [ "$READY_STATUS" -eq 2 ]
}
# Both are SQLite locks the OS drops with their holder: a server holds
# server-owner.sqlite, and a boot service holds service-serving.lock from
# before it starts a server, between two of them during its own update, until
# it stops or idles behind another server.
home_owned() {
  if [ "$LATHE_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper home-owned "$DEFAULT_SERVER_HOME" 2>/dev/null
    return
  fi
  node - "$DEFAULT_SERVER_HOME" 2>/dev/null <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const held = (file) => {
  if (!fs.existsSync(file)) return false;
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    return false;
  } catch (error) {
    return error?.errcode === 5;
  } finally {
    db.close();
  }
};
const home = process.argv[2];
process.exitCode =
  held(path.join(home, "runtime", "service-serving.lock")) ||
  held(path.join(home, "userdata", "server-owner.sqlite"))
    ? 0
    : 1;
NODE
}
resolve_default_runtime_port() {
  if [ "$LATHE_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"
    return
  fi
  node - "$DEFAULT_RUNTIME_FILE" <<'NODE'
const fs = require("node:fs");
const runtimePath = process.argv[2] ?? "";
try {
	  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
	  const pid = Number(runtime.pid);
	  const port = Number(runtime.port);
	  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {
	    process.exit(1);
	  }
  const origin = new URL(String(runtime.origin ?? ""));
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    process.exit(1);
  }
  process.kill(pid, 0);
  process.stdout.write(\`\${pid} \${port}\`);
} catch {
  process.exit(1);
}
NODE
}
# This script ships with the SSH client; older clients do not honor this marker.
update_remaining() {
  if [ "$LATHE_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper update-remaining "$DEFAULT_SERVER_HOME/runtime/@@LATHE_UPDATE_MARKER_FILE@@"
    return
  fi
  node - "$DEFAULT_SERVER_HOME/runtime/@@LATHE_UPDATE_MARKER_FILE@@" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
try {
  const { startedAt, expiresAt } = JSON.parse(fs.readFileSync(path, "utf8"));
  const now = Date.now();
  if (Number.isFinite(startedAt) && Number.isFinite(expiresAt) &&
      startedAt <= now && expiresAt > now && expiresAt > startedAt) {
    process.stdout.write(String(Math.min(expiresAt - now, @@LATHE_UPDATE_TTL_MS@@)));
  }
} catch {}
NODE
}
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
# Reported as "action" so the client can tell a reuse from a cold start; see
# REMOTE_LAUNCH_ACTIONS. Branches below set it, and an empty one means started.
LAUNCH_ACTION=""
adopt_default_server() {
DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port 2>/dev/null || true)"
DEFAULT_RUNTIME_PID=""
DEFAULT_REMOTE_PORT=""
ADOPTED_PID=""
if [ -n "$DEFAULT_RUNTIME_INFO" ]; then
  DEFAULT_RUNTIME_PID="\${DEFAULT_RUNTIME_INFO%% *}"
  DEFAULT_REMOTE_PORT="\${DEFAULT_RUNTIME_INFO#* }"
fi
# The managed server runs with --base-dir "$DEFAULT_SERVER_HOME", so it writes
# the default runtime file itself. Only a different process there is external;
# our own server falls through to the managed branch below, which reuses it or
# restarts it when the runner changed.
DEFAULT_RUNTIME_OWNED=0
if [ -n "$DEFAULT_REMOTE_PORT" ] && [ "$REMOTE_MANAGED" = "managed" ]; then
  if [ -n "$REMOTE_PID" ] && [ "$REMOTE_PID" = "$DEFAULT_RUNTIME_PID" ]; then
    DEFAULT_RUNTIME_OWNED=1
  elif [ -z "$REMOTE_PID" ] && [ "$REMOTE_PORT" = "$DEFAULT_REMOTE_PORT" ]; then
    DEFAULT_RUNTIME_OWNED=1
    REMOTE_PID="$DEFAULT_RUNTIME_PID"
    printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  fi
fi
if [ "$DEFAULT_RUNTIME_OWNED" -eq 1 ]; then
  if [ "$REMOTE_PORT" != "$DEFAULT_REMOTE_PORT" ]; then
    REMOTE_PORT="$DEFAULT_REMOTE_PORT"
    printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
  fi
  return 0
elif [ -n "$DEFAULT_REMOTE_PORT" ]; then
  REMOTE_PORT="$DEFAULT_REMOTE_PORT"
  if wait_ready "@@LATHE_REUSE_READY_TIMEOUT_MS@@"; then
    ADOPTED_PID="$DEFAULT_RUNTIME_PID"
    if [ "$REMOTE_MANAGED" = "managed" ]; then
      LAUNCH_ACTION="adopted-external"
      if managed_server_running "$REMOTE_PID"; then
        kill "$REMOTE_PID" 2>/dev/null || true
        wait_for_pid_exit "$REMOTE_PID"
        LAUNCH_ACTION="replaced-by-external"
      fi
      REMOTE_PID=""
      REMOTE_PORT="$DEFAULT_REMOTE_PORT"
      REMOTE_MANAGED="external"
      rm -f "$PID_FILE"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
    else
      if [ "$REMOTE_MANAGED" != "external" ]; then
        LAUNCH_ACTION="adopted-external"
      fi
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
      REMOTE_PID=""
      REMOTE_MANAGED="external"
    fi
    return 0
  else
    REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
    REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
  fi
fi
return 1
}
# Editing a connection's alias, host, user or port changes its key, so the
# adopted server may be one this desktop started under another key. Ownership
# then moves here, leaving one managed record, so updates keep replacing it.
# Another desktop's server stays external. Only this first adoption runs
# before the replace decision, which the previous key's runner settles.
if adopt_default_server && [ -n "$ADOPTED_PID" ] && [ -n "$LAUNCHER_ID" ]; then
  for SIBLING_DIR in "$DEFAULT_SERVER_HOME"/ssh-launch/*; do
    [ "$SIBLING_DIR" != "$STATE_DIR" ] && [ "$(cat "$SIBLING_DIR/managed" 2>/dev/null || true)" = "managed" ] || continue
    [ "$(cat "$SIBLING_DIR/pid" 2>/dev/null || true)" = "$ADOPTED_PID" ] && managed_server_running "$ADOPTED_PID" || continue
    [ "$(cat "$SIBLING_DIR/launcher" 2>/dev/null || true)" = "$LAUNCHER_ID" ] || break
    REMOTE_PID="$ADOPTED_PID"
    REMOTE_MANAGED="managed"
    printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
    printf 'managed\\n' >"$MANAGED_FILE"
    printf 'external\\n' >"$SIBLING_DIR/managed"
    rm -f "$SIBLING_DIR/pid"
    RUNNER_CHANGED=1
    if cmp -s "$RUNNER_FILE" "$SIBLING_DIR/run-lathe.sh"; then
      RUNNER_CHANGED=0
    fi
    break
  done
fi
if [ "$REMOTE_MANAGED" = "external" ]; then
  # A server adopted above has just answered. While it is still alive, probing
  # it again could catch a momentary stall and launch a second server beside it.
  if server_running "$ADOPTED_PID"; then
    LAUNCH_ACTION="\${LAUNCH_ACTION:-reused-external}"
  elif [ -z "$REMOTE_PORT" ] || ! wait_ready "@@LATHE_REUSE_READY_TIMEOUT_MS@@"; then
    LAUNCH_ACTION=""
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  elif [ -z "$LAUNCH_ACTION" ]; then
    LAUNCH_ACTION="reused-external"
  fi
elif [ -n "$REMOTE_PORT" ] && managed_server_running "$REMOTE_PID"; then
  # Reconnect owns the local tunnel, not the lifetime of an already running
  # server. A changed runner is the update path and replaces an older server.
  if [ "$RUNNER_CHANGED" -eq 1 ] && ! keeps_running_server; then
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID" "$RESTART_WAIT_SECONDS"
    if server_running "$REMOTE_PID"; then
      # A missing runner reads as changed, so the next launch retries the restart.
      rm -f "$RUNNER_FILE"
      printf 'The previous Lathe server (PID %s) is still shutting down, so no replacement was started. Retry the connection once it exits.\\n' "$REMOTE_PID" >&2
      exit 1
    fi
    LAUNCH_ACTION="restarted-runner-changed"
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  elif managed_server_stopping; then
    wait_for_pid_exit "$REMOTE_PID"
    if managed_server_running "$REMOTE_PID"; then
      printf 'The previous remote Lathe server (PID %s) is still shutting down. Retry once it has exited.\\n' "$REMOTE_PID" >&2
      exit 1
    fi
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  else
    READY_STATUS=0
    wait_server_ready "$REMOTE_PID" "$READY_TIMEOUT_MS" || READY_STATUS=$?
    if [ "$READY_STATUS" -eq 0 ]; then
      LAUNCH_ACTION="reused"
    elif [ "$READY_STATUS" -eq 1 ]; then
      printf 'Remote Lathe server is still starting on 127.0.0.1:%s. A large database can take minutes to migrate. Retry the connection; the server was left running.\\n' "$REMOTE_PORT" >&2
      exit 1
    else
      REMOTE_PID=""
      REMOTE_PORT=""
      REMOTE_MANAGED=""
    fi
  fi
else
  REMOTE_PID=""
  REMOTE_PORT=""
  REMOTE_MANAGED=""
fi
# The server may answer long before it publishes its runtime record, or never
# publish one; another alias's launch record still names it. Only one server
# owns the home, so the first live one decides.
if [ -z "$REMOTE_PORT" ] && [ -z "$DEFAULT_RUNTIME_INFO" ]; then
  for SIBLING_DIR in "$DEFAULT_SERVER_HOME"/ssh-launch/*; do
    [ "$SIBLING_DIR" != "$STATE_DIR" ] && [ "$(cat "$SIBLING_DIR/managed" 2>/dev/null || true)" = "managed" ] || continue
    managed_server_running "$(cat "$SIBLING_DIR/pid" 2>/dev/null || true)" || continue
    REMOTE_PORT="$(cat "$SIBLING_DIR/port" 2>/dev/null || true)"
    if [ -n "$REMOTE_PORT" ] && wait_ready "@@LATHE_REUSE_READY_TIMEOUT_MS@@"; then
      REMOTE_MANAGED="external"
      LAUNCH_ACTION="adopted-external"
      rm -f "$PID_FILE"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
    else
      REMOTE_PORT=""
    fi
    break
  done
fi
if [ -z "$REMOTE_PORT" ]; then
  # The sleep count bounds a host clock that stops advancing.
  UPDATE_WAITED=0
  UPDATE_SAW_MARKER=0
  while [ "$UPDATE_WAITED" -le @@LATHE_UPDATE_TTL_SECONDS@@ ]; do
    UPDATE_REMAINING="$(update_remaining 2>/dev/null || true)"
    [ -n "$UPDATE_REMAINING" ] || break
    UPDATE_SAW_MARKER=1
    [ "$UPDATE_WAITED" -lt @@LATHE_UPDATE_TTL_SECONDS@@ ] || break
    if adopt_default_server; then break; fi
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
    sleep 1
    UPDATE_WAITED=$((UPDATE_WAITED + 1))
  done
  # The desktop clears the marker after publishing runtime, possibly before the first marker read,
  # so refresh once more before falling back. A cleanly stopped server leaves no runtime file.
  if { [ "$UPDATE_SAW_MARKER" -eq 1 ] || [ -f "$DEFAULT_RUNTIME_FILE" ]; } && [ -z "$REMOTE_PORT" ] && ! adopt_default_server; then
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  fi
fi
# A server that holds the home without answering yet is still starting, and a
# boot service holds it between two servers while it updates. A second server
# would lose the home to it or take the home from it, so wait while the home is
# held and start one only once it is free. The managed server an update just
# stopped may still be exiting. The sleep count bounds a host clock that stops.
OWNER_WAITED=0
OWNER_DEADLINE=$(($(date +%s) + @@LATHE_READY_TIMEOUT_SECONDS@@))
while [ -z "$REMOTE_PORT" ] && ! managed_server_running "$(cat "$PID_FILE" 2>/dev/null || true)" && home_owned; do
  if adopt_default_server; then break; fi
  REMOTE_PID=""
  REMOTE_PORT=""
  REMOTE_MANAGED=""
  if [ "$OWNER_WAITED" -ge @@LATHE_READY_TIMEOUT_SECONDS@@ ] || [ "$(date +%s)" -ge "$OWNER_DEADLINE" ]; then
    printf 'A Lathe server or boot service holds %s but did not become ready, so no second server was started. Retry once it has started.\\n' "$DEFAULT_SERVER_HOME" >&2
    exit 1
  fi
  sleep 1
  OWNER_WAITED=$((OWNER_WAITED + 1))
done
if [ -z "$REMOTE_PORT" ]; then
  REMOTE_PORT="$(pick_port)" || true
  if [ -z "$REMOTE_PORT" ]; then
    if [ "$LATHE_ARCHIVE_MODE" = "1" ]; then
      printf 'Failed to find an available port on the remote host.\\n' >&2
    else
      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2
    fi
    exit 1
  fi
  # Start this launch's log empty. Unlink rather than truncate: a process from an
  # earlier launch can still hold the old log open and keep writing to it.
  rm -f "$LOG_FILE"
  nohup env LATHE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  REMOTE_PID="$!"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
  printf 'managed\\n' >"$MANAGED_FILE"
  # A stop keeps the launcher file; it must not name this server's owner.
  if [ -z "$LAUNCHER_ID" ]; then
    rm -f "$STATE_DIR/launcher"
  fi
  READY_STATUS=0
  wait_server_ready "$REMOTE_PID" "$READY_TIMEOUT_MS" || READY_STATUS=$?
  if [ "$READY_STATUS" -eq 1 ]; then
    # Killing it would discard a migration in progress and leave the home
    # locked for the next attempt; the next launch waits for it instead.
    printf 'Remote Lathe server is still starting on 127.0.0.1:%s. A large database can take minutes to migrate. Retry the connection; the server was left running.\\n' "$REMOTE_PORT" >&2
    tail -n 20 "$LOG_FILE" >&2 2>/dev/null || true
    exit 1
  elif [ "$READY_STATUS" -eq 2 ]; then
    printf 'Remote Lathe server exited before it became ready on 127.0.0.1:%s.\\n' "$REMOTE_PORT" >&2
    if [ -s "$LOG_FILE" ]; then
      tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    else
      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' "$LOG_FILE" >&2
    fi
    rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
    exit 1
  fi
  # Keep the lock until another alias's launch can find this server, or it
  # would start a second one that loses the home's owner lock.
  RECORD_DEADLINE=$(($(date +%s) + @@LATHE_RUNTIME_RECORD_WAIT_SECONDS@@))
  while [ "$(date +%s)" -lt "$RECORD_DEADLINE" ]; do
    DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port 2>/dev/null || true)"
    [ "\${DEFAULT_RUNTIME_INFO%% *}" = "$REMOTE_PID" ] && break
    # A host wrapper can spawn the server instead of replacing itself.
    RUNTIME_PID="\${DEFAULT_RUNTIME_INFO%% *}"
    if [ "\${DEFAULT_RUNTIME_INFO#* }" = "$REMOTE_PORT" ] && managed_server_running "$RUNTIME_PID"; then
      RUNTIME_ANCESTOR="$RUNTIME_PID"
      while [ -n "$RUNTIME_ANCESTOR" ] && [ "$RUNTIME_ANCESTOR" != "1" ] && [ "$RUNTIME_ANCESTOR" != "$REMOTE_PID" ]; do
        RUNTIME_ANCESTOR="$(ps -o ppid= -p "$RUNTIME_ANCESTOR" 2>/dev/null | tr -d '[:space:]')"
      done
      if [ "$RUNTIME_ANCESTOR" = "$REMOTE_PID" ]; then
        REMOTE_PID="$RUNTIME_PID"
        printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
        break
      fi
    fi
    sleep 0.1
  done
  LAUNCH_ACTION="\${LAUNCH_ACTION:-started}"
fi
printf '{"remotePort":%s,"serverKind":"%s","action":"%s"}\\n' "$REMOTE_PORT" "\${REMOTE_MANAGED:-managed}" "$LAUNCH_ACTION"
`;

const REMOTE_PAIRING_SCRIPT = `set -eu
STATE_DIR="${FORK_HOME_SHELL}/ssh-launch/@@LATHE_STATE_KEY@@"
DEFAULT_SERVER_HOME="${FORK_HOME_SHELL}"
RUNNER_FILE="$STATE_DIR/run-lathe.sh"
RUNNER_NEXT="$STATE_DIR/run-lathe.next.$$"
@@LATHE_ENSURE_LATHE_HOME_SCRIPT@@
mkdir -p "$STATE_DIR"
cleanup_runner_next() {
  rm -f "$RUNNER_NEXT"
}
trap cleanup_runner_next EXIT
cat >"$RUNNER_NEXT" <<'SH'
@@LATHE_RUNNER_SCRIPT@@
SH
# A launch may be running the current runner, so replace it only by rename and
# only when it differs; the launch compares these same bytes to detect changes.
if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  chmod 700 "$RUNNER_NEXT"
  mv "$RUNNER_NEXT" "$RUNNER_FILE"
fi
PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"
"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
`;

const REMOTE_STOP_SCRIPT = `set -eu
STATE_DIR="${FORK_HOME_SHELL}/ssh-launch/@@LATHE_STATE_KEY@@"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
MANAGED_FILE="$STATE_DIR/managed"
STOP_WAIT_SECONDS=@@LATHE_SERVER_STOP_WAIT_SECONDS@@
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
@@LATHE_MANAGED_SERVER_RUNNING_SCRIPT@@
if [ "$REMOTE_MANAGED" != "external" ] && managed_server_running "$REMOTE_PID"; then
  kill "$REMOTE_PID" 2>/dev/null || true
  WAIT_COUNT=0
  while kill -0 "$REMOTE_PID" 2>/dev/null && [ "$WAIT_COUNT" -lt $((STOP_WAIT_SECONDS * 10)) ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
  if kill -0 "$REMOTE_PID" 2>/dev/null; then
    printf 'Remote Lathe server with PID %s did not stop within %s seconds. Its ownership files were kept.\\n' "$REMOTE_PID" "$STOP_WAIT_SECONDS" >&2
    exit 1
  fi
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
printf '{"stopped":true}\\n'
`;

const REMOTE_LOG_TAIL_SCRIPT = `set -eu
STATE_DIR="${FORK_HOME_SHELL}/ssh-launch/@@LATHE_STATE_KEY@@"
LOG_FILE="$STATE_DIR/server.log"
if [ -f "$LOG_FILE" ]; then
  tail -n 80 "$LOG_FILE" 2>/dev/null || true
fi
`;

export class SshInvalidArchiveVersionError extends Schema.TaggedError<SshInvalidArchiveVersionError>()(
  "SshInvalidArchiveVersionError",
  { archiveVersion: Schema.String },
) {
  override get message(): string {
    return `'${this.archiveVersion}' is not an exact t3 version and cannot name a runtime directory.`;
  }
}

// The version becomes a directory name the runner removes and recreates, so
// it must be one exact SemVer segment: no separators, no `..`, no shell
// metacharacters beyond what SemVer allows.
const EXACT_ARCHIVE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class SshMissingRunnerError extends Schema.TaggedError<SshMissingRunnerError>()(
  "SshMissingRunnerError",
  {},
) {
  override get message(): string {
    return "A remote t3 runner needs an archive version or a node script path.";
  }
}

export function buildRemoteLatheRunnerScript(input?: RemoteLatheRunnerOptions): string {
  const nodeScriptPath = input?.nodeScriptPath?.trim() || "";
  const archiveVersion = input?.archiveVersion?.trim() || "";
  if (nodeScriptPath === "" && archiveVersion === "") {
    throw new SshMissingRunnerError();
  }
  if (archiveVersion !== "" && !EXACT_ARCHIVE_VERSION.test(archiveVersion)) {
    throw new SshInvalidArchiveVersionError({ archiveVersion });
  }
  const releaseBaseUrl = cliReleaseDownloadBaseUrl("", input?.releaseBaseUrl ?? undefined).replace(
    /\/v$/u,
    "",
  );
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_RUNNER_SCRIPT, {
      LATHE_NODE_SCRIPT_PATH: shellSingleQuote(nodeScriptPath),
      LATHE_ARCHIVE_VERSION: shellSingleQuote(archiveVersion),
      LATHE_RELEASE_BASE_URL: shellSingleQuote(releaseBaseUrl),
      LATHE_ARCHIVE_LOCK_WAIT_SECONDS: String(REMOTE_ARCHIVE_LOCK_WAIT_SECONDS),
      LATHE_ARCHIVE_DOWNLOAD_SECONDS: String(REMOTE_ARCHIVE_DOWNLOAD_SECONDS),
      LATHE_ARCHIVE_CHECKSUMS_SECONDS: String(REMOTE_ARCHIVE_CHECKSUMS_SECONDS),
      LATHE_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    }),
  );
}

export function buildRemoteNodeEnvScript(input?: RemoteLatheRunnerOptions): string {
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_NODE_ENV_SCRIPT, {
      LATHE_NODE_ENGINE_RANGE: shellSingleQuote(input?.nodeEngineRange?.trim() || ""),
      LATHE_NODE_ENGINE_CHECK_SCRIPT: stripTrailingNewlines(buildRemoteNodeEngineCheckScript()),
    }),
  );
}

export function buildRemoteLaunchScript(input?: RemoteLatheRunnerOptions): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    LATHE_UPDATE_MARKER_FILE: DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE,
    LATHE_UPDATE_TTL_MS: String(DESKTOP_UPDATE_IN_PROGRESS_TTL_MS),
    LATHE_UPDATE_TTL_SECONDS: String(DESKTOP_UPDATE_IN_PROGRESS_TTL_MS / 1000),
    LATHE_ARCHIVE_MODE: isNodeScriptRunner(input) ? "0" : "1",
    LATHE_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    LATHE_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteLatheRunnerScript(input)),
    LATHE_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    LATHE_WAIT_READY_SCRIPT: stripTrailingNewlines(REMOTE_WAIT_READY_SCRIPT),
    LATHE_MANAGED_SERVER_RUNNING_SCRIPT: REMOTE_MANAGED_SERVER_RUNNING_SCRIPT,
    LATHE_ENSURE_LATHE_HOME_SCRIPT: REMOTE_ENSURE_LATHE_HOME_SCRIPT,
    LATHE_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    LATHE_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
    LATHE_READY_TIMEOUT_MS: String(REMOTE_READY_TIMEOUT_MS),
    LATHE_READY_TIMEOUT_SECONDS: String(REMOTE_READY_TIMEOUT_MS / 1000),
    LATHE_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    LATHE_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
    LATHE_SERVER_STOP_WAIT_SECONDS: String(REMOTE_SERVER_STOP_WAIT_SECONDS),
    LATHE_SERVER_RESTART_WAIT_SECONDS: String(REMOTE_SERVER_RESTART_WAIT_SECONDS),
    LATHE_READY_SLICE_MS: String(REMOTE_READY_SLICE_MS),
    LATHE_LAUNCH_LOCK_WAIT_SECONDS: String(REMOTE_LAUNCH_LOCK_WAIT_SECONDS),
    LATHE_RUNTIME_RECORD_WAIT_SECONDS: String(REMOTE_RUNTIME_RECORD_WAIT_SECONDS),
  });
}

export function buildRemotePairingScript(
  stateKey: string,
  input?: RemoteLatheRunnerOptions,
): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    LATHE_STATE_KEY: stateKey,
    LATHE_ENSURE_LATHE_HOME_SCRIPT: REMOTE_ENSURE_LATHE_HOME_SCRIPT,
    LATHE_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteLatheRunnerScript(input)),
  });
}

export function buildRemoteStopScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_STOP_SCRIPT, {
    LATHE_STATE_KEY: stateKey,
    LATHE_SERVER_STOP_WAIT_SECONDS: String(REMOTE_SERVER_STOP_WAIT_SECONDS),
    LATHE_MANAGED_SERVER_RUNNING_SCRIPT: REMOTE_MANAGED_SERVER_RUNNING_SCRIPT,
  });
}

function buildRemoteLogTailScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_LOG_TAIL_SCRIPT, {
    LATHE_STATE_KEY: stateKey,
  });
}

// Shells known to take `-l -c` with a POSIX-style `exec` read their own login
// profiles first; any other shell (csh, pwsh, ...) keeps the plain `sh -l` launch.
const remoteLoginShellArgs = (args = "") => [
  "sh",
  "-c",
  shellSingleQuote(
    `case "\${SHELL##*/}" in bash|zsh|ksh|fish|nu) exec "$SHELL" -l -c "exec sh -s${args ? ` -- ${args}` : ""}" ;; *) exec sh -l -s${args ? ` -- ${args}` : ""} ;; esac`,
  ),
];

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: RemoteCommandOptions,
    runner?: RemoteLatheRunnerOptions,
    launcherId?: string | null,
  ): Effect.fn.Return<
    {
      readonly remotePort: number;
      readonly remoteServerKind: "external" | "managed" | null;
      /** Null from a launch script that predates the field. */
      readonly launchAction: RemoteLaunchAction | null;
    },
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | Digest.Digest | FileSystem.FileSystem | Path.Path
  > {
    const stateKey = yield* remoteStateKey(target);
    yield* annotateSshTargetSpan(target, { "ssh.stateKey": stateKey });
    // The launcher ID is interpolated into the remote shell command, so only hex passes.
    const launchArgs =
      typeof launcherId === "string" && /^[0-9a-f]{32}$/u.test(launcherId)
        ? `${stateKey} ${launcherId}`
        : stateKey;
    yield* Effect.logInfo("ssh.remoteServer.launch.start", {
      ...sshTargetLogFields(target),
      ...sshRunnerLogFields(runner),
      stateKey,
    });
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: remoteLoginShellArgs(launchArgs),
      stdin: buildRemoteLaunchScript(runner),
      timeoutMs: isNodeScriptRunner(runner)
        ? REMOTE_LAUNCH_TIMEOUT_MS
        : REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
      // The launch answers with its port, server kind and action, never a credential.
      observe: { source: "launch", stdout: true },
      purpose: "launch",
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
      ...(input === undefined ? {} : { multiplex: input.multiplex }),
    });
    if (!getLastNonEmptyOutputLine(result.stdout)) {
      return yield* new SshLaunchError({
        message: "SSH launch did not return a remote port.",
        stdout: result.stdout,
      });
    }
    const parsed = yield* decodeRemoteLaunchOutput(result.stdout).pipe(
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
    const launchAction = parsed.action ?? null;
    yield* Effect.annotateCurrentSpan({
      "ssh.remotePort": parsed.remotePort,
      ...(launchAction === null ? {} : { "ssh.launchAction": launchAction }),
    });
    yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
      ...sshTargetLogFields(target),
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      launchAction,
      stateKey,
    });
    if (launchAction !== null) {
      const observer = yield* SshOutputObserver;
      yield* observer({
        source: "launch",
        stream: "stdout",
        text: `${describeLaunchAction(launchAction, parsed.remotePort)}\n`,
      });
    }
    return {
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      launchAction,
    };
  },
);

/** The output panel's one-line account of what the launch did. */
function describeLaunchAction(action: RemoteLaunchAction, port: number): string {
  switch (action) {
    case "started":
      return `Remote server started on port ${port}`;
    case "reused":
      return `Remote server reused on port ${port}`;
    case "restarted-runner-changed":
      return `Remote server restarted on port ${port}: runner changed`;
    case "adopted-external":
      return `Using the external remote server on port ${port}`;
    case "replaced-by-external":
      return `Stopped the managed remote server, using the external one on port ${port}`;
    case "reused-external":
      return `External remote server reused on port ${port}`;
  }
}

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: RemoteCommandOptions,
  runner?: RemoteLatheRunnerOptions,
): Effect.fn.Return<
  {
    readonly credential: string;
  },
  SshCommandError | SshInvalidTargetError | SshPairingError,
  ChildProcessSpawner.ChildProcessSpawner | Digest.Digest | FileSystem.FileSystem | Path.Path
> {
  const stateKey = yield* remoteStateKey(target);
  yield* annotateSshTargetSpan(target, { "ssh.stateKey": stateKey });
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.start", {
    ...sshTargetLogFields(target),
    stateKey,
  });
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: remoteLoginShellArgs(),
    stdin: buildRemotePairingScript(stateKey, runner),
    purpose: "pairing",
    // Pairing runs after the launch under the same target lock, so the runtime
    // is installed and the default timeout applies.
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    ...(input === undefined ? {} : { multiplex: input.multiplex }),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingOutput(result.stdout).pipe(
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
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.created", {
    ...sshTargetLogFields(target),
    stateKey,
  });
  return {
    credential: parsed.credential,
  };
});

const stopRemoteServer = Effect.fn("ssh/tunnel.stopRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: RemoteCommandOptions,
): Effect.fn.Return<
  void,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | Digest.Digest | FileSystem.FileSystem | Path.Path
> {
  const stateKey = yield* remoteStateKey(target);
  yield* annotateSshTargetSpan(target, { "ssh.stateKey": stateKey });
  yield* Effect.logInfo("ssh.remoteServer.stop.start", {
    ...sshTargetLogFields(target),
    stateKey,
  });
  yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteStopScript(stateKey),
    purpose: "stop",
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    ...(input === undefined ? {} : { multiplex: input.multiplex }),
  });
  yield* Effect.logInfo("ssh.remoteServer.stop.succeeded", {
    ...sshTargetLogFields(target),
    stateKey,
  });
});

const readRemoteServerLogTail = Effect.fn("ssh/tunnel.readRemoteServerLogTail")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: RemoteCommandOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | Digest.Digest | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteLogTailScript(yield* remoteStateKey(target)),
    timeoutMs: 10_000,
    observe: { source: "remote-log", stdout: true },
    purpose: "log-tail",
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    ...(input === undefined ? {} : { multiplex: input.multiplex }),
  });
  return result.stdout.trim();
});

const waitForHttpReady = (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly path?: string;
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_TUNNEL_READY_PROBE_TIMEOUT_MS,
    makeError: ({ requestUrl, probeTimeoutMs, cause }) => {
      if (typeof cause === "object" && cause !== null && "kind" in cause) {
        const kind = (cause as { readonly kind?: unknown }).kind;
        if (kind === "probe-timeout") {
          return new SshReadinessError({
            message: `Backend readiness probe exceeded ${probeTimeoutMs}ms at ${requestUrl}.`,
            cause,
          });
        }
        if (kind === "overall-timeout") {
          const overall = cause as unknown as {
            readonly baseUrl: string;
            readonly timeoutMs: number;
            readonly lastFailure: unknown;
          };
          return new SshReadinessError({
            message: `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}.`,
            cause: overall.lastFailure,
          });
        }
      }
      return new SshReadinessError({
        message: `Backend readiness probe failed at ${requestUrl}.`,
        cause,
      });
    },
  });

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export const resolveLoopbackSshHttpBaseUrl = Effect.fn("ssh/tunnel.resolveLoopbackSshHttpBaseUrl")(
  function* (rawHttpBaseUrl: unknown): Effect.fn.Return<string, SshHttpBridgeError> {
    return yield* Effect.try({
      try: () => {
        if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
          throw new Error("Invalid SSH forwarded http base URL.");
        }
        const baseUrl = new URL(rawHttpBaseUrl);
        if (!isLoopbackHostname(baseUrl.hostname)) {
          throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
        }
        return baseUrl.toString();
      },
      catch: (cause) =>
        new SshHttpBridgeError({
          message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
          cause,
        }),
    });
  },
);

const reserveLocalTunnelPort = Effect.fn("ssh/tunnel.reserveLocalTunnelPort")(function* () {
  const net = yield* NetService.NetService;
  return yield* net.reserveLoopbackPort();
});

// ssh only binds the forward after it connects, which can take ConnectTimeout per dead address.
const waitForTunnelForward = Effect.fn("ssh/tunnel.waitForTunnelForward")(function* (input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly localPort: number;
}) {
  const net = yield* NetService.NetService;
  yield* net.hasListenerOnHost(input.localPort, "127.0.0.1").pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(SSH_TUNNEL_FORWARD_PROBE_INTERVAL_MS)),
      until: (listening) => listening,
    }),
    Effect.timeoutOrElse({
      duration: Duration.millis(SSH_TUNNEL_CONNECT_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new SshReadinessError({
            message: `SSH connection to ${input.target.alias} did not come up within ${SSH_TUNNEL_CONNECT_TIMEOUT_MS}ms.`,
          }),
        ),
    }),
  );
});

const startSshTunnel = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuth.SshAuthOptions;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly scope: Scope.Closeable;
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
> {
  yield* annotateSshTargetSpan(input.resolvedTarget, {
    "ssh.stateKey": yield* remoteStateKey(input.resolvedTarget),
    "ssh.localPort": input.localPort,
    "ssh.remotePort": input.remotePort,
  });
  // Captured here so the stderr monitor reports to it whichever fiber ends up running it.
  const observer = yield* SshOutputObserver;
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget);
  const childEnvironment = yield* SshAuth.buildSshChildEnvironment({
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
    // A mux client's forward belongs to the master and outlives the client, so
    // the tunnel keeps its own connection and its exit still means "gone".
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? "no",
      multiplex: SSH_DIRECT,
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlPersist=no",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-n",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    "--",
    hostSpec,
  ];
  const sshCommand = yield* resolveSshCommand;
  const tunnelCommand = [sshCommand, ...args];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { scope } = input;
  yield* Effect.logDebug("ssh.tunnel.spawn.start", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    localPort: input.localPort,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    httpBaseUrl: input.httpBaseUrl,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: childEnvironment,
        extendEnv: true,
        stdin: {
          stream: Stream.empty,
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: tunnelCommand,
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
  yield* Effect.logDebug("ssh.tunnel.spawn.succeeded", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const tunnelEntry: SshTunnelEntry = {
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
    scope,
  };
  // Readiness cancels the exit waiter, but diagnostics must drain until the tunnel closes.
  let stderrTail = "";
  const stderrDrain = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + chunk).slice(-TUNNEL_STDERR_TAIL_CHARS);
      }).pipe(Effect.andThen(observer({ source: "tunnel", stream: "stderr", text: chunk }))),
    ),
    // Diagnostics are best-effort: a failed read must not hide the real exit.
    Effect.ignore,
    Effect.forkIn(scope),
  );
  const exitFailure = Effect.all(
    [Fiber.join(stderrDrain), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: tunnelCommand,
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([, exitCode]) => {
      const stderr = stderrTail;
      const error = new SshCommandError({
        command: tunnelCommand,
        exitCode,
        stderr,
        message: normalizeSshErrorMessage(
          stderr,
          `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
        ),
      });
      return Effect.logWarning("ssh.tunnel.process.exited", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
        exitCode,
        stderr,
      }).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );
  yield* Effect.raceFirst(
    waitForTunnelForward({ target: input.resolvedTarget, localPort: input.localPort }).pipe(
      Effect.andThen(
        waitForHttpReady({
          baseUrl: input.httpBaseUrl,
          timeoutMs: SSH_READY_TIMEOUT_MS,
        }),
      ),
    ),
    exitFailure,
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("ssh.tunnel.ready", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const processRunningExit = yield* Effect.exit(child.isRunning);
        const localPortAvailableExit = yield* Effect.exit(
          net.canListenOnHost(input.localPort, "127.0.0.1"),
        );
        const remoteLogTailExit = yield* Effect.exit(
          readRemoteServerLogTail(input.resolvedTarget, {
            ...input.authOptions,
            multiplex: SSH_DIRECT,
          }),
        );
        const processRunning = Exit.isSuccess(processRunningExit) ? processRunningExit.value : null;
        const localPortAvailable = Exit.isSuccess(localPortAvailableExit)
          ? localPortAvailableExit.value
          : null;
        const remoteLogTail = Exit.isSuccess(remoteLogTailExit)
          ? remoteLogTailExit.value || null
          : null;
        yield* Effect.logWarning("ssh.tunnel.ready.failed", {
          ...sshTargetLogFields(input.resolvedTarget),
          command: tunnelCommand,
          pid: child.pid,
          processRunning,
          ...(Exit.isSuccess(processRunningExit)
            ? {}
            : { processRunningError: processRunningExit.cause }),
          localPort: input.localPort,
          localPortListening: localPortAvailable === null ? null : !localPortAvailable,
          remotePort: input.remotePort,
          httpBaseUrl: input.httpBaseUrl,
          ...(Exit.isSuccess(localPortAvailableExit)
            ? {}
            : { localPortProbeError: localPortAvailableExit.cause }),
          ...(remoteLogTail === null ? {} : { remoteLogTail }),
          ...(Exit.isSuccess(remoteLogTailExit)
            ? {}
            : { remoteLogTailError: remoteLogTailExit.cause }),
          cause,
        });
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
  // Targets whose tunnel ssh exited on its own since the last ensure, so the
  // next ensure's summary can say why it had no tunnel to reuse.
  const exitedTunnels = new Set<string>();
  const targetLocks = yield* KeyedLock.make<string>();
  const authSecrets = new Map<string, string>();
  // Managed remote servers this manager launched and no disconnect has
  // stopped, with how to stop each. Shutdown stops those whose tunnel died
  // earlier; the tunnel finalizer stops the rest.
  const managedRemotes = new Map<string, Effect.Effect<void>>();
  // Made before the shutdown finalizer below, so its masters close last. The
  // remote stops that run at shutdown connect directly and do not use them.
  const controlMasters = yield* ControlMaster.make({
    directory: options.controlSocketDirectory,
  });

  // Keep one lock per target so reconnect cannot reuse a server while stop is pending.
  const withTargetLock = Effect.fn("ssh/tunnel.withTargetLock")(function* <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    return yield* targetLocks.withLock(key, effect);
  });

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    yield* Effect.logDebug("ssh.tunnel.close.start", {
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

  const closeAllTunnels = Effect.sync(() => [...tunnels.values()]).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(entries, closeTunnelEntry, { concurrency: "unbounded" }),
    ),
    Effect.ignore,
  );

  yield* Scope.addFinalizer(
    managerScope,
    Effect.suspend(() => {
      const orphanedStops = [...managedRemotes]
        .filter(([key]) => !tunnels.has(key))
        .map(([, stop]) => stop);
      managedRemotes.clear();
      return Effect.all(
        [closeAllTunnels, Effect.all(orphanedStops, { concurrency: "unbounded" })],
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }).pipe(Effect.ignore),
  );

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<
    string,
    SshInvalidTargetError | SshPasswordPromptError,
    SshAuth.SshPasswordPrompt
  > {
    const promptService = yield* SshAuth.SshPasswordPrompt;
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
      prompt: `Enter the SSH password or verification code for ${hostSpec}.`,
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
      if (!SshAuth.isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      yield* Effect.logWarning("ssh.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshAuth.SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2 || SshAuth.isSshAgentSigningFailure(input.error)) {
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
    const promptService = yield* SshAuth.SshPasswordPrompt;
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

  /**
   * Runs a target's one-shot commands through its owned master, resolving the
   * master once per locked section. `"reuse"` never starts a master. A command
   * that reports a broken mux replaces the master and runs once more.
   */
  const makeOneShotRunner = (
    key: string,
    target: DesktopSshEnvironmentTarget,
    mode: "acquire" | "reuse",
    summary?: SshConnectionSummary,
  ): RunOneShot => {
    let controlPath: string | null | undefined;
    const lookup: Effect.Effect<
      | ControlMaster.ControlMasterOutcome
      | { readonly socketPath: null; readonly decision: "not-used" },
      SshEnvironmentEffectError,
      SshEnvironmentEffectContext
    > =
      mode === "acquire"
        ? controlMasters.acquire({
            key,
            target,
            authenticate: (start) => runWithSshAuth({ key, target, operation: start }),
          })
        : controlMasters
            .reuse(key, target)
            .pipe(
              Effect.map((socketPath) =>
                socketPath === null
                  ? { socketPath, decision: "not-used" as const }
                  : { socketPath, decision: "reused" as const },
              ),
            );
    const resolveControlPath = Effect.suspend(
      (): Effect.Effect<string | null, SshEnvironmentEffectError, SshEnvironmentEffectContext> =>
        controlPath !== undefined
          ? Effect.succeed(controlPath)
          : lookup.pipe(
              timePhase(summary, "controlMasterMs"),
              Effect.map((outcome) => {
                controlPath = outcome.socketPath;
                if (summary !== undefined) {
                  summary.controlMaster = outcome.decision;
                  summary.controlMasterReason = "reason" in outcome ? outcome.reason : null;
                }
                return outcome.socketPath;
              }),
            ),
    );
    return (operation) =>
      Effect.gen(function* () {
        const attempt = (socketPath: string | null) =>
          runWithSshAuth({
            key,
            target,
            operation: (authOptions) =>
              operation({
                ...authOptions,
                multiplex: socketPath === null ? SSH_DIRECT : { mode: "client", socketPath },
              }),
          });
        const socketPath = yield* resolveControlPath;
        return yield* attempt(socketPath).pipe(
          Effect.catchIf(
            (error) => socketPath !== null && ControlMaster.isMuxFailure(error),
            (error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("ssh.controlMaster.muxFailure", {
                  ...sshTargetLogFields(target),
                  key,
                  cause: error,
                });
                yield* controlMasters.close(key);
                controlPath = undefined;
                return yield* attempt(yield* resolveControlPath);
              }),
          ),
        );
      });
  };

  const createTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly runner?: RemoteLatheRunnerOptions;
    readonly runOneShot: RunOneShot;
    readonly summary: SshConnectionSummary;
  }): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const { summary } = input;
    yield* Effect.logDebug("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });
    const launcherId =
      options.resolveLauncherId === undefined ? null : yield* options.resolveLauncherId;
    const remoteLaunch = yield* input.runOneShot((authOptions) =>
      launchOrReuseRemoteServer(input.resolvedTarget, authOptions, input.runner, launcherId).pipe(
        timePhase(summary, "launchMs"),
        // A launch that reached the host but hung or answered nonsense leaves its reason in
        // the server log; the read reports it through the output observer. A failure to
        // connect at all has nothing to read, and the launch script tails the log itself
        // when the server exits early.
        Effect.tapError((error) =>
          error._tag === "SshLaunchError" ||
          (error._tag === "SshCommandError" && error.timedOut === true)
            ? readRemoteServerLogTail(input.resolvedTarget, authOptions).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    );
    const remotePort = remoteLaunch.remotePort;
    summary.launchAction = remoteLaunch.launchAction;
    summary.remoteServerKind = remoteLaunch.remoteServerKind;
    summary.remotePort = remotePort;
    yield* Effect.logDebug("ssh.environment.remotePort.ready", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      remotePort,
      remoteServerKind: remoteLaunch.remoteServerKind,
    });
    const localPort = yield* reserveLocalTunnelPort();
    summary.localPort = localPort;
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    yield* Effect.logDebug("ssh.environment.localPort.reserved", {
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
          remoteServerKind: remoteLaunch.remoteServerKind,
          scope: entryScope,
        }).pipe(timePhase(summary, "tunnelStartMs")),
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );
    tunnels.set(input.key, tunnelEntry);
    const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
    const digestService = yield* Digest.Digest;
    const fileSystemService = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    // Stops the remote server over its own connection, as shutdown must not
    // depend on the target's master or on the caller's services.
    const stopRemoteDirect = Effect.suspend(() => {
      const authSecret = authSecrets.get(tunnelEntry.key) ?? null;
      return stopRemoteServer(
        tunnelEntry.target,
        authSecret === null
          ? {
              batchMode: "yes",
              interactiveAuth: false,
              multiplex: SSH_DIRECT,
            }
          : {
              authSecret,
              batchMode: "no",
              interactiveAuth: true,
              multiplex: SSH_DIRECT,
            },
      );
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerService),
      Effect.provideService(Digest.Digest, digestService),
      Effect.provideService(FileSystem.FileSystem, fileSystemService),
      Effect.provideService(Path.Path, pathService),
    );
    if (tunnelEntry.remoteServerKind === "managed") {
      managedRemotes.set(tunnelEntry.key, stopRemoteDirect.pipe(Effect.ignore));
    } else {
      managedRemotes.delete(tunnelEntry.key);
    }
    yield* Scope.addFinalizer(
      entryScope,
      Effect.gen(function* () {
        const stopRemote = tunnels.get(tunnelEntry.key) === tunnelEntry;
        if (stopRemote) {
          tunnels.delete(tunnelEntry.key);
        }
        yield* tunnelEntry.process
          .kill({
            killSignal: "SIGTERM",
            forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
          })
          .pipe(Effect.ignore);
        if (!stopRemote) {
          return;
        }
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.start", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
        yield* stopRemoteDirect;
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.succeeded", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
      }).pipe(Effect.ignore),
    );
    // A tunnel whose ssh exits on its own leaves the map, so the next ensure creates one instead
    // of probing a dead port; its finalizer then skips the remote stop, and `managedRemotes` still
    // stops a managed server at shutdown. Forked after the finalizer so a normal close interrupts
    // this watcher before the kill.
    yield* tunnelEntry.process.exitCode.pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.gen(function* () {
          if (tunnels.get(tunnelEntry.key) !== tunnelEntry) {
            return;
          }
          tunnels.delete(tunnelEntry.key);
          exitedTunnels.add(tunnelEntry.key);
          yield* Effect.logInfo("ssh.environment.tunnel.exited", {
            ...sshTargetLogFields(tunnelEntry.target),
            key: tunnelEntry.key,
            localPort: tunnelEntry.localPort,
            remotePort: tunnelEntry.remotePort,
          });
          // Closing the scope interrupts this fiber, so it runs on its own.
          yield* closeTunnelEntry(tunnelEntry).pipe(Effect.forkIn(managerScope));
        }),
      ),
      Effect.forkIn(entryScope),
    );
    yield* Effect.logDebug("ssh.environment.tunnel.create.succeeded", {
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
    runOneShot: RunOneShot,
    summary: SshConnectionSummary,
    runner?: RemoteLatheRunnerOptions,
  ): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const entry = tunnels.get(key) ?? null;
    summary.tunnel = exitedTunnels.delete(key) && entry === null ? "pruned-exited" : "created";

    if (entry !== null) {
      yield* Effect.logDebug("ssh.environment.tunnel.existing.check", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
      });
      const reused = yield* Effect.gen(function* () {
        let answered = false;
        const markAnswered = Effect.sync(() => {
          answered = true;
        });
        const client = yield* HttpClient.HttpClient;
        const readinessExit = yield* Effect.exit(
          waitForHttpReady({
            baseUrl: entry.httpBaseUrl,
            timeoutMs: SSH_TUNNEL_READY_PROBE_TIMEOUT_MS,
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              client.pipe(
                HttpClient.transform((request) =>
                  request.pipe(
                    Effect.tap(() => markAnswered),
                    Effect.tapError(() => markAnswered),
                  ),
                ),
              ),
            ),
          ),
        );
        // ssh closes the channel when nothing listens remotely, so a forward that
        // is up but got no answer leads to a live server that is only slow.
        const keepSlowForward =
          Exit.isFailure(readinessExit) &&
          !answered &&
          (yield* entry.process.isRunning.pipe(Effect.orElseSucceed(() => false))) &&
          (yield* (yield* NetService.NetService).hasListenerOnHost(entry.localPort, "127.0.0.1"));
        if (keepSlowForward) {
          yield* Effect.logWarning("ssh.environment.tunnel.existing.slow", {
            ...sshTargetLogFields(resolvedTarget),
            key,
            localPort: entry.localPort,
            remotePort: entry.remotePort,
          });
          return true;
        }
        if (Exit.isSuccess(readinessExit)) {
          yield* Effect.logDebug("ssh.environment.tunnel.reused", {
            ...sshTargetLogFields(resolvedTarget),
            key,
            localPort: entry.localPort,
            remotePort: entry.remotePort,
          });
          return true;
        }
        yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
          cause: readinessExit.cause,
        });
        // Only the tunnel is stale. Leaving the map first makes the finalizer skip
        // the remote stop, so the launch below can reuse the running server.
        yield* Effect.gen(function* () {
          tunnels.delete(key);
          yield* closeTunnelEntry(entry);
        }).pipe(Effect.uninterruptible);
        return false;
      }).pipe(timePhase(summary, "existingTunnelCheckMs"));
      if (reused) {
        summary.tunnel = "reused";
        summary.remoteServerKind = entry.remoteServerKind;
        summary.remotePort = entry.remotePort;
        summary.localPort = entry.localPort;
        return entry;
      }
      summary.tunnel = "stale-replaced";
    }

    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      runOneShot,
      summary,
      ...(runner === undefined ? {} : { runner }),
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("ssh.environment.tunnel.create.failed", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          cause,
        }),
      ),
    );
  });

  /** Applies the caller's username and port over what `ssh -G` resolved for the alias. */
  const resolveTarget = (target: DesktopSshEnvironmentTarget) =>
    resolveSshTarget(target.alias || target.hostname, { multiplex: SSH_DIRECT }).pipe(
      Effect.map((baseResolved): DesktopSshEnvironmentTarget => ({
        ...baseResolved,
        ...(target.username !== null ? { username: target.username } : {}),
        ...(target.port !== null ? { port: target.port } : {}),
      })),
    );

  type ResolvedConnection = {
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly key: string;
  };

  /**
   * Runs `body` with the target lock held and logs exactly one outcome event,
   * `<event>.succeeded` or `<event>.failed`, carrying the summary `body` fills.
   */
  const withConnectionSummary = Effect.fn("ssh/tunnel.withConnectionSummary")(function* <
    A,
    E,
    R,
  >(input: {
    readonly event: string;
    readonly target: DesktopSshEnvironmentTarget;
    readonly summary: SshConnectionSummary;
    readonly fields: () => Readonly<Record<string, unknown>>;
    readonly body: (resolved: ResolvedConnection) => Effect.Effect<A, E, R>;
  }) {
    const { summary } = input;
    const startedAt = yield* Clock.currentTimeMillis;
    let resolvedFields: Readonly<Record<string, unknown>> = sshTargetLogFields(input.target);
    const outcomeFields = Effect.map(Clock.currentTimeMillis, (now) => ({
      ...resolvedFields,
      ...connectionSummaryLogFields(summary, now - startedAt),
      ...input.fields(),
    }));
    return yield* Effect.gen(function* () {
      const resolvedTarget = yield* resolveTarget(input.target).pipe(
        timePhase(summary, "targetResolveMs"),
      );
      const key = targetConnectionKey(resolvedTarget);
      const stateKey = yield* remoteStateKey(resolvedTarget);
      resolvedFields = { ...sshTargetLogFields(resolvedTarget), key, stateKey };
      yield* annotateSshTargetSpan(resolvedTarget, { "ssh.stateKey": stateKey });
      const lockRequestedAt = yield* Clock.currentTimeMillis;
      return yield* withTargetLock(
        key,
        Effect.gen(function* () {
          summary.phases.lockWaitMs = (yield* Clock.currentTimeMillis) - lockRequestedAt;
          const result = yield* input.body({ resolvedTarget, key });
          yield* Effect.logInfo(`${input.event}.succeeded`, yield* outcomeFields);
          return result;
        }),
      );
    }).pipe(
      Effect.onError((cause) =>
        Effect.flatMap(outcomeFields, (fields) =>
          Effect.logInfo(`${input.event}.failed`, { ...fields, ...summaryErrorFields(cause) }),
        ),
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
    yield* annotateSshTargetSpan(target);
    yield* Effect.logInfo("ssh.environment.ensure.start", {
      ...sshTargetLogFields(target),
      issuePairingToken: requestOptions?.issuePairingToken === true,
    });
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    yield* Effect.logDebug("ssh.environment.runner.resolved", {
      ...sshTargetLogFields(target),
      ...sshRunnerLogFields(runner),
    });
    const summary = makeConnectionSummary();
    let issuedPairingToken = false;
    const startedAt = yield* Clock.currentTimeMillis;
    const observer = yield* SshOutputObserver;
    const reportSummary = (succeeded: boolean) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        observer({
          source: "tunnel",
          stream: "stdout",
          text: `${describeConnectionSummary(summary, succeeded, now - startedAt)}\n`,
        }),
      );
    return yield* withConnectionSummary({
      event: "ssh.environment.ensure",
      target,
      summary,
      fields: () => ({ issuedPairingToken }),
      body: Effect.fnUntraced(function* ({ resolvedTarget, key }: ResolvedConnection) {
        yield* Effect.logDebug("ssh.environment.target.resolved", {
          ...sshTargetLogFields(resolvedTarget),
          key,
        });
        const runOneShot = makeOneShotRunner(key, resolvedTarget, "acquire", summary);
        const entry = yield* ensureTunnelEntry(key, resolvedTarget, runOneShot, summary, runner);

        const pairingResult = requestOptions?.issuePairingToken
          ? yield* runOneShot((authOptions) =>
              issueRemotePairingToken(entry.target, authOptions, runner).pipe(
                timePhase(summary, "pairingMs"),
              ),
            )
          : null;
        const pairingToken = pairingResult?.credential ?? null;
        issuedPairingToken = pairingToken !== null;

        return {
          // Callers save this target; a port ssh -G resolved would pin the alias's current Port.
          target: { ...entry.target, port: target.port },
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
        };
      }),
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? reportSummary(true)
          : Cause.hasInterruptsOnly(exit.cause)
            ? Effect.void
            : reportSummary(false),
      ),
    );
  });

  const disconnectEnvironment = Effect.fn("ssh/tunnel.disconnectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* annotateSshTargetSpan(target);
    yield* Effect.logInfo("ssh.environment.disconnect.start", sshTargetLogFields(target));
    const summary = makeConnectionSummary();
    summary.tunnel = "none";
    yield* withConnectionSummary({
      event: "ssh.environment.disconnect",
      target,
      summary,
      fields: () => ({}),
      body: Effect.fnUntraced(function* ({ resolvedTarget, key }: ResolvedConnection) {
        const entry = tunnels.get(key) ?? null;
        exitedTunnels.delete(key);
        // The stop below is this server's stop; shutdown does not repeat it.
        managedRemotes.delete(key);
        yield* Effect.logDebug("ssh.environment.disconnect.targetResolved", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          hasTunnel: entry !== null,
        });
        if (entry !== null) {
          summary.tunnel = "closed";
          summary.remoteServerKind = entry.remoteServerKind;
          summary.remotePort = entry.remotePort;
          summary.localPort = entry.localPort;
          // Explicit disconnect owns the remote stop so its failure reaches the caller.
          yield* Effect.gen(function* () {
            tunnels.delete(key);
            yield* closeTunnelEntry(entry);
          }).pipe(Effect.uninterruptible, timePhase(summary, "tunnelCloseMs"));
        }
        // The stop rides a healthy master if there is one, then the master goes too.
        yield* makeOneShotRunner(
          key,
          resolvedTarget,
          "reuse",
          summary,
        )((authOptions) =>
          stopRemoteServer(resolvedTarget, authOptions).pipe(timePhase(summary, "remoteStopMs")),
        ).pipe(Effect.ensuring(controlMasters.close(key)));
      }),
    });
  });

  return SshEnvironmentManager.of({ ensureEnvironment, disconnectEnvironment, closeAllTunnels });
});

/**
 * @effect-expect-leaking ChildProcessSpawner | Digest | FileSystem | HttpClient | NetService | Path | SshPasswordPrompt
 */
export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@lathe/ssh/tunnel/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}
