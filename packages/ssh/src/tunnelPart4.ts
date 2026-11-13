import { cliReleaseDownloadBaseUrl } from "@t3tools/shared/cliRelease";
import * as Schema from "effect/Schema";
import type { RemoteT3RunnerOptions } from "./tunnel.ts";
import { DEFAULT_REMOTE_PORT, REMOTE_ARCHIVE_CHECKSUMS_SECONDS, REMOTE_ARCHIVE_DOWNLOAD_SECONDS, REMOTE_ARCHIVE_LOCK_WAIT_SECONDS, REMOTE_PICK_PORT_SCRIPT, REMOTE_PORT_SCAN_WINDOW, REMOTE_READY_TIMEOUT_MS, REMOTE_REUSE_READY_TIMEOUT_MS, REMOTE_WAIT_READY_SCRIPT, SSH_READY_PROBE_TIMEOUT_MS, applyScriptPlaceholders, buildRemoteNodeEngineCheckScript, isNodeScriptRunner, shellSingleQuote, stripTrailingNewlines } from "./tunnelPart2.ts";
import { REMOTE_NODE_ENV_SCRIPT, REMOTE_RUNNER_SCRIPT } from "./tunnelPart3.ts";

const REMOTE_LAUNCH_SCRIPT = `set -eu
@@T3_NODE_ENV_SCRIPT@@
STATE_KEY="$1"
STATE_DIR="$HOME/.t3/ssh-launch/$STATE_KEY"
DEFAULT_SERVER_HOME="$HOME/.t3"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
mkdir -p "$STATE_DIR"
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
T3_ARCHIVE_MODE=@@T3_ARCHIVE_MODE@@
if [ "$T3_ARCHIVE_MODE" = "1" ]; then
  # The archive ships the helpers below inside the executable; the remote
  # needs no Node at all. Resolving the runner once here also downloads the
  # archive before the port and readiness probes rely on it.
  "$RUNNER_FILE" --version >/dev/null
elif ! ensure_remote_node_path; then
  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
  exit 1
fi
pick_port() {
  if [ "$T3_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE" "@@T3_DEFAULT_REMOTE_PORT@@" "@@T3_REMOTE_PORT_SCAN_WINDOW@@"
    return
  fi
  node - "$PORT_FILE" "@@T3_DEFAULT_REMOTE_PORT@@" "@@T3_REMOTE_PORT_SCAN_WINDOW@@" <<'NODE'
@@T3_PICK_PORT_SCRIPT@@
NODE
}
wait_ready() {
  if [ "$T3_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT" "$1" "@@T3_READY_PROBE_TIMEOUT_MS@@"
    return
  fi
  node - "$REMOTE_PORT" "$1" "@@T3_READY_PROBE_TIMEOUT_MS@@" <<'NODE'
@@T3_WAIT_READY_SCRIPT@@
NODE
}
wait_for_pid_exit() {
  PID_TO_WAIT="$1"
  WAIT_COUNT=0
  while kill -0 "$PID_TO_WAIT" 2>/dev/null && [ "$WAIT_COUNT" -lt 20 ]; do
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
resolve_default_runtime_port() {
  if [ "$T3_ARCHIVE_MODE" = "1" ]; then
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
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port 2>/dev/null || true)"
DEFAULT_RUNTIME_PID=""
DEFAULT_REMOTE_PORT=""
ADOPTED_PID=""
if [ -n "$DEFAULT_RUNTIME_INFO" ]; then
  DEFAULT_RUNTIME_PID="\${DEFAULT_RUNTIME_INFO%% *}"
  DEFAULT_REMOTE_PORT="\${DEFAULT_RUNTIME_INFO#* }"
fi
# The managed server runs on the default home, so it writes the default
# runtime file too. When that file names the PID this launcher recorded as
# managed, it describes our own server and its real port, not one to adopt.
if [ -n "$DEFAULT_REMOTE_PORT" ] && [ "$REMOTE_MANAGED" = "managed" ] && [ "$DEFAULT_RUNTIME_PID" = "$REMOTE_PID" ]; then
  REMOTE_PORT="$DEFAULT_REMOTE_PORT"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
elif [ -n "$DEFAULT_REMOTE_PORT" ]; then
  REMOTE_PORT="$DEFAULT_REMOTE_PORT"
  if wait_ready "@@T3_REUSE_READY_TIMEOUT_MS@@"; then
    ADOPTED_PID="$DEFAULT_RUNTIME_PID"
    if [ "$REMOTE_MANAGED" = "managed" ]; then
      if [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
        kill "$REMOTE_PID" 2>/dev/null || true
        wait_for_pid_exit "$REMOTE_PID"
      fi
      REMOTE_PID=""
      REMOTE_PORT="$DEFAULT_REMOTE_PORT"
      REMOTE_MANAGED="external"
      rm -f "$PID_FILE"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
    else
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
      REMOTE_PID=""
      REMOTE_MANAGED="external"
    fi
  else
    REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
    REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
  fi
fi
if [ "$REMOTE_MANAGED" = "external" ]; then
  # A server adopted above has just answered. While it is still alive, probing
  # it again could catch a momentary stall and launch a second server beside it.
  if server_running "$ADOPTED_PID"; then
    :
  elif [ -z "$REMOTE_PORT" ] || ! wait_ready "@@T3_REUSE_READY_TIMEOUT_MS@@"; then
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  fi
elif [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && server_running "$REMOTE_PID"; then
  # Reconnect owns the local tunnel, not the lifetime of an already running
  # server. A changed runner is the update path and still replaces it.
  if [ "$RUNNER_CHANGED" -eq 1 ]; then
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  elif ! wait_ready "@@T3_READY_TIMEOUT_MS@@"; then
    printf 'Remote T3 server is still running but did not become ready. Retry the connection; the server was left running.\\n' >&2
    exit 1
  fi
else
  REMOTE_PID=""
  REMOTE_PORT=""
  REMOTE_MANAGED=""
fi
if [ -z "$REMOTE_PORT" ]; then
  REMOTE_PORT="$(pick_port)" || true
  if [ -z "$REMOTE_PORT" ]; then
    if [ "$T3_ARCHIVE_MODE" = "1" ]; then
      printf 'Failed to find an available port on the remote host.\\n' >&2
    else
      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2
    fi
    exit 1
  fi
  nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  REMOTE_PID="$!"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
  printf 'managed\\n' >"$MANAGED_FILE"
  if ! wait_ready "@@T3_READY_TIMEOUT_MS@@"; then
    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' "$REMOTE_PORT" >&2
    if [ -s "$LOG_FILE" ]; then
      tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    else
      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' "$LOG_FILE" >&2
    fi
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
    exit 1
  fi
fi
printf '{"remotePort":%s,"serverKind":"%s"}\\n' "$REMOTE_PORT" "\${REMOTE_MANAGED:-managed}"
`;

const REMOTE_PAIRING_SCRIPT = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.t3"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
mkdir -p "$STATE_DIR"
cat >"$RUNNER_FILE" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
chmod 700 "$RUNNER_FILE"
PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"
"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
`;

const REMOTE_STOP_SCRIPT = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
MANAGED_FILE="$STATE_DIR/managed"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  kill "$REMOTE_PID" 2>/dev/null || true
  WAIT_COUNT=0
  while kill -0 "$REMOTE_PID" 2>/dev/null && [ "$WAIT_COUNT" -lt 20 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
  if kill -0 "$REMOTE_PID" 2>/dev/null; then
    printf 'Remote T3 server with PID %s did not stop within 2 seconds. Its ownership files were kept.\\n' "$REMOTE_PID" >&2
    exit 1
  fi
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
printf '{"stopped":true}\\n'
`;

const REMOTE_LOG_TAIL_SCRIPT = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
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

export function buildRemoteT3RunnerScript(input?: RemoteT3RunnerOptions): string {
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
      T3_NODE_SCRIPT_PATH: shellSingleQuote(nodeScriptPath),
      T3_ARCHIVE_VERSION: shellSingleQuote(archiveVersion),
      T3_RELEASE_BASE_URL: shellSingleQuote(releaseBaseUrl),
      T3_ARCHIVE_LOCK_WAIT_SECONDS: String(REMOTE_ARCHIVE_LOCK_WAIT_SECONDS),
      T3_ARCHIVE_DOWNLOAD_SECONDS: String(REMOTE_ARCHIVE_DOWNLOAD_SECONDS),
      T3_ARCHIVE_CHECKSUMS_SECONDS: String(REMOTE_ARCHIVE_CHECKSUMS_SECONDS),
      T3_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    }),
  );
}

export function buildRemoteNodeEnvScript(input?: RemoteT3RunnerOptions): string {
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_NODE_ENV_SCRIPT, {
      T3_NODE_ENGINE_RANGE: shellSingleQuote(input?.nodeEngineRange?.trim() || ""),
      T3_NODE_ENGINE_CHECK_SCRIPT: stripTrailingNewlines(buildRemoteNodeEngineCheckScript()),
    }),
  );
}

export function buildRemoteLaunchScript(input?: RemoteT3RunnerOptions): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    T3_ARCHIVE_MODE: isNodeScriptRunner(input) ? "0" : "1",
    T3_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
    T3_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    T3_WAIT_READY_SCRIPT: stripTrailingNewlines(REMOTE_WAIT_READY_SCRIPT),
    T3_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    T3_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
    T3_READY_TIMEOUT_MS: String(REMOTE_READY_TIMEOUT_MS),
    T3_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    T3_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
  });
}

export function buildRemotePairingScript(stateKey: string, input?: RemoteT3RunnerOptions): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    T3_STATE_KEY: stateKey,
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
  });
}

export function buildRemoteStopScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_STOP_SCRIPT, {
    T3_STATE_KEY: stateKey,
  });
}

export function buildRemoteLogTailScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_LOG_TAIL_SCRIPT, {
    T3_STATE_KEY: stateKey,
  });
}
