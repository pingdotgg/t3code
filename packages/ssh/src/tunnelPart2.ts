import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { extractJsonObject, fromLenientJson } from "@t3tools/shared/schemaJson";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import type { RemoteT3RunnerOptions, SshEnvironmentEffectContext, SshEnvironmentEffectError } from "./tunnel.ts";

export const DEFAULT_REMOTE_PORT = 3773;

export const REMOTE_PORT_SCAN_WINDOW = 200;

export const SSH_READY_TIMEOUT_MS = 20_000;

export const SSH_READY_PROBE_TIMEOUT_MS = 1_000;

export const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;

export const TUNNEL_STDERR_TAIL_CHARS = 16_384;

export const REMOTE_READY_TIMEOUT_MS = 60_000;

export const REMOTE_LAUNCH_TIMEOUT_MS = 90_000;

export // Cold archive launches download and extract ~70 MB and may wait on an install lock.
// Lock waits must outlast both downloads and extraction; SSH must outlast install or wait plus readiness.
// Leave slack for verification and extraction, which have no timeout.
const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;

export const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;

export const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;

export const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;

export const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;

export interface SshTunnelEntry {
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

export function isNodeScriptRunner(runner: RemoteT3RunnerOptions | undefined): boolean {
  return Boolean(runner?.nodeScriptPath?.trim());
}

export function sshRunnerLogFields(runner: RemoteT3RunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }
  if (runner?.archiveVersion?.trim()) {
    return { runner: "archive", archiveVersion: runner.archiveVersion.trim() };
  }
  return { runner: "archive" };
}

export interface SshAuthOperationInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuth.SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

export interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

const RemoteLaunchResult = Schema.Struct({
  remotePort: Schema.Number,
  serverKind: Schema.optional(Schema.Literals(["external", "managed"])),
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

export const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

export const decodeRemotePairingOutput = (stdout: string) =>
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

export function buildRemoteNodeEngineCheckScript(): string {
  return `${satisfiesSemverRange.toString()}
(${remoteNodeEngineCheckMain.toString()})();`;
}

export function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

export function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function applyScriptPlaceholders(
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

export const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
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

export const REMOTE_WAIT_READY_SCRIPT = `const http = require("node:http");
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
          resolve(response.statusCode >= 200 && response.statusCode < 300);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

(async () => {
  while (Date.now() < deadline) {
    if (await probe()) {
      process.exit(0);
    }
    await sleep(100);
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;
