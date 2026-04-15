import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import * as Net from "node:net";

import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  DesktopUpdateChannel,
} from "@t3tools/contracts";

import { waitForHttpReady } from "./backendReadiness";

const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const SSH_ASKPASS_DIR_NAME = "t3code-ssh-askpass";
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const SSH_READY_TIMEOUT_MS = 20_000;
const STABLE_T3_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

interface SshTunnelEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcess.ChildProcess;
}

interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface SshAskpassFile {
  readonly path: string;
  readonly contents: string;
  readonly mode?: number;
}

interface SshAskpassHelperDescriptor {
  readonly launcherPath: string;
  readonly files: ReadonlyArray<SshAskpassFile>;
}

interface SshAuthOptions {
  readonly authSecret?: string | null;
  readonly batchMode?: "yes" | "no";
  readonly interactiveAuth?: boolean;
}

interface DesktopSshPasswordRequest {
  readonly destination: string;
  readonly username: string | null;
  readonly prompt: string;
  readonly attempt: number;
}

interface DesktopSshEnvironmentManagerOptions {
  readonly passwordProvider?: (request: DesktopSshPasswordRequest) => Promise<string | null>;
  readonly resolveCliPackageSpec?: () => string;
}

const NO_HOSTS = [] as const;

function stripInlineComment(line: string): string {
  const hashIndex = line.indexOf("#");
  return (hashIndex >= 0 ? line.slice(0, hashIndex) : line).trim();
}

function splitDirectiveArgs(value: string): ReadonlyArray<string> {
  return value
    .trim()
    .split(/\s+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function hasSshPattern(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.startsWith("!");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${escapeRegex(pattern).replace(/\\\*/gu, ".*").replace(/\\\?/gu, ".")}$`,
    "u",
  );
}

function expandGlob(pattern: string): ReadonlyArray<string> {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return FS.existsSync(pattern) ? [pattern] : NO_HOSTS;
  }

  const directory = Path.dirname(pattern);
  const basePattern = Path.basename(pattern);
  if (!FS.existsSync(directory)) {
    return NO_HOSTS;
  }

  const matcher = globToRegExp(basePattern);
  return FS.readdirSync(directory)
    .filter((entry) => matcher.test(entry))
    .map((entry) => Path.join(directory, entry))
    .filter((entry) => FS.existsSync(entry))
    .toSorted((left, right) => left.localeCompare(right));
}

function collectSshConfigAliasesFromFile(
  filePath: string,
  visited = new Set<string>(),
): ReadonlyArray<string> {
  const resolvedPath = Path.resolve(filePath);
  if (visited.has(resolvedPath) || !FS.existsSync(resolvedPath)) {
    return NO_HOSTS;
  }
  visited.add(resolvedPath);

  const aliases = new Set<string>();
  const directory = Path.dirname(resolvedPath);
  const raw = FS.readFileSync(resolvedPath, "utf8");

  for (const line of raw.split(/\r?\n/u)) {
    const stripped = stripInlineComment(line);
    if (stripped.length === 0) {
      continue;
    }

    const [directive = "", ...rawArgs] = splitDirectiveArgs(stripped);
    const normalizedDirective = directive.toLowerCase();
    if (normalizedDirective === "include") {
      for (const includePattern of rawArgs) {
        const resolvedPattern = Path.isAbsolute(includePattern)
          ? includePattern
          : Path.resolve(directory, includePattern);
        for (const includedPath of expandGlob(resolvedPattern)) {
          for (const alias of collectSshConfigAliasesFromFile(includedPath, visited)) {
            aliases.add(alias);
          }
        }
      }
      continue;
    }

    if (normalizedDirective !== "host") {
      continue;
    }

    for (const alias of rawArgs) {
      if (alias.length === 0 || hasSshPattern(alias)) {
        continue;
      }
      aliases.add(alias);
    }
  }

  return [...aliases].toSorted((left, right) => left.localeCompare(right));
}

function parseKnownHostsHostnames(raw: string): ReadonlyArray<string> {
  const hostnames = new Set<string>();

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const withoutMarker = trimmed.startsWith("@")
      ? trimmed.split(/\s+/u).slice(1).join(" ")
      : trimmed;
    const [hostField = ""] = withoutMarker.split(/\s+/u);
    if (hostField.length === 0 || hostField.startsWith("|")) {
      continue;
    }

    for (const rawHost of hostField.split(",")) {
      const bracketMatch = /^\[([^\]]+)\]:(\d+)$/u.exec(rawHost);
      const host = (
        bracketMatch?.[1] ?? (rawHost.includes(":") ? rawHost : rawHost.replace(/:.*$/u, ""))
      ).trim();
      if (host.length === 0 || hasSshPattern(host)) {
        continue;
      }
      hostnames.add(host);
    }
  }

  return [...hostnames].toSorted((left, right) => left.localeCompare(right));
}

function readKnownHostsHostnames(filePath: string): ReadonlyArray<string> {
  if (!FS.existsSync(filePath)) {
    return NO_HOSTS;
  }

  return parseKnownHostsHostnames(FS.readFileSync(filePath, "utf8"));
}

function parseSshResolveOutput(alias: string, stdout: string): DesktopSshEnvironmentTarget {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [key, ...rest] = trimmed.split(/\s+/u);
    if (!key || rest.length === 0 || values.has(key)) {
      continue;
    }
    values.set(key, rest.join(" ").trim());
  }

  const hostname = values.get("hostname")?.trim() || alias;
  const username = values.get("user")?.trim() || null;
  const rawPort = values.get("port")?.trim() ?? "";
  const parsedPort = Number.parseInt(rawPort, 10);

  return {
    alias,
    hostname,
    username,
    port: Number.isInteger(parsedPort) ? parsedPort : null,
  };
}

async function findAvailableLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = Net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a local tunnel port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function targetConnectionKey(target: DesktopSshEnvironmentTarget): string {
  return `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}`;
}

function remoteStateKey(target: DesktopSshEnvironmentTarget): string {
  return Crypto.createHash("sha256").update(targetConnectionKey(target)).digest("hex").slice(0, 16);
}

function buildSshHostSpec(target: DesktopSshEnvironmentTarget): string {
  const destination = target.alias.trim() || target.hostname.trim();
  if (destination.length === 0) {
    throw new Error("SSH target is missing its alias/hostname.");
  }
  return target.username ? `${target.username}@${destination}` : destination;
}

function getDefaultSshAskpassDirectory(): string {
  return Path.join(OS.tmpdir(), SSH_ASKPASS_DIR_NAME);
}

function buildPosixSshAskpassScript(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'PROMPT="${1:-SSH authentication}"',
    'if [ "${T3_SSH_AUTH_SECRET+x}" = "x" ]; then',
    '  printf "%s\\n" "$T3_SSH_AUTH_SECRET"',
    "  exit 0",
    "fi",
    "if command -v osascript >/dev/null 2>&1; then",
    "  T3_SSH_ASKPASS_PROMPT=\"$PROMPT\" /usr/bin/osascript <<'APPLESCRIPT'",
    'set promptText to system attribute "T3_SSH_ASKPASS_PROMPT"',
    "try",
    '  set dialogResult to display dialog promptText default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel"',
    "  text returned of dialogResult",
    "on error number -128",
    "  error number -128",
    "end try",
    "APPLESCRIPT",
    "  exit $?",
    "fi",
    "if command -v zenity >/dev/null 2>&1; then",
    '  zenity --password --title="SSH authentication" --text="$PROMPT"',
    "  exit $?",
    "fi",
    "if command -v kdialog >/dev/null 2>&1; then",
    '  kdialog --title "SSH authentication" --password "$PROMPT"',
    "  exit $?",
    "fi",
    "if command -v ssh-askpass >/dev/null 2>&1; then",
    '  ssh-askpass "$PROMPT"',
    "  exit $?",
    "fi",
    "printf 'Unable to open an SSH password prompt on this desktop.\\n' >&2",
    "exit 1",
    "",
  ].join("\n");
}

function buildWindowsSshAskpassScript(): string {
  return [
    "if ($env:T3_SSH_AUTH_SECRET -ne $null) {",
    "  [Console]::Out.WriteLine($env:T3_SSH_AUTH_SECRET)",
    "  exit 0",
    "}",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    '$prompt = if ($args.Length -gt 0 -and $args[0]) { $args[0] } else { "SSH authentication" }',
    "$form = New-Object System.Windows.Forms.Form",
    '$form.Text = "SSH authentication"',
    "$form.Width = 420",
    "$form.Height = 185",
    '$form.StartPosition = "CenterScreen"',
    '$form.FormBorderStyle = "FixedDialog"',
    "$form.MaximizeBox = $false",
    "$form.MinimizeBox = $false",
    "$form.TopMost = $true",
    "$label = New-Object System.Windows.Forms.Label",
    "$label.Left = 16",
    "$label.Top = 16",
    "$label.Width = 372",
    "$label.Height = 34",
    "$label.Text = $prompt",
    "$textbox = New-Object System.Windows.Forms.TextBox",
    "$textbox.Left = 16",
    "$textbox.Top = 60",
    "$textbox.Width = 372",
    "$textbox.UseSystemPasswordChar = $true",
    "$okButton = New-Object System.Windows.Forms.Button",
    '$okButton.Text = "OK"',
    "$okButton.Left = 232",
    "$okButton.Top = 100",
    "$okButton.Width = 75",
    "$cancelButton = New-Object System.Windows.Forms.Button",
    '$cancelButton.Text = "Cancel"',
    "$cancelButton.Left = 313",
    "$cancelButton.Top = 100",
    "$cancelButton.Width = 75",
    "$okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK",
    "$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel",
    "$form.AcceptButton = $okButton",
    "$form.CancelButton = $cancelButton",
    "$form.Controls.Add($label)",
    "$form.Controls.Add($textbox)",
    "$form.Controls.Add($okButton)",
    "$form.Controls.Add($cancelButton)",
    "$result = $form.ShowDialog()",
    "if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }",
    "[Console]::Out.WriteLine($textbox.Text)",
    "",
  ].join("\r\n");
}

function buildSshAskpassHelperDescriptor(input?: {
  readonly directory?: string;
  readonly platform?: NodeJS.Platform;
}): SshAskpassHelperDescriptor {
  const platform = input?.platform ?? process.platform;
  const directory = input?.directory ?? getDefaultSshAskpassDirectory();
  const pathModule = platform === "win32" ? Path.win32 : Path.posix;

  if (platform === "win32") {
    const powershellPath = pathModule.join(directory, "ssh-askpass.ps1");
    return {
      launcherPath: pathModule.join(directory, "ssh-askpass.cmd"),
      files: [
        {
          path: pathModule.join(directory, "ssh-askpass.cmd"),
          contents: [
            "@echo off",
            'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ssh-askpass.ps1" %*',
            "",
          ].join("\r\n"),
        },
        {
          path: powershellPath,
          contents: buildWindowsSshAskpassScript(),
        },
      ],
    };
  }

  return {
    launcherPath: pathModule.join(directory, "ssh-askpass.sh"),
    files: [
      {
        path: pathModule.join(directory, "ssh-askpass.sh"),
        contents: buildPosixSshAskpassScript(),
        mode: 0o700,
      },
    ],
  };
}

function ensureSshAskpassHelpers(input?: {
  readonly directory?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const descriptor = buildSshAskpassHelperDescriptor(input);
  const platform = input?.platform ?? process.platform;
  FS.mkdirSync(Path.dirname(descriptor.launcherPath), { recursive: true });

  for (const file of descriptor.files) {
    const current =
      FS.existsSync(file.path) && FS.statSync(file.path).isFile()
        ? FS.readFileSync(file.path, "utf8")
        : null;
    if (current !== file.contents) {
      FS.writeFileSync(file.path, file.contents, "utf8");
    }
    if (file.mode !== undefined && platform !== "win32") {
      FS.chmodSync(file.path, file.mode);
    }
  }

  return descriptor.launcherPath;
}

function buildSshChildEnvironment(input?: {
  readonly interactiveAuth?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly askpassDirectory?: string;
  readonly authSecret?: string | null;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const baseEnv = { ...(input?.baseEnv ?? process.env) };
  if (!input?.interactiveAuth) {
    return baseEnv;
  }

  const platform = input?.platform ?? process.platform;
  const askpassInput =
    input?.askpassDirectory === undefined
      ? { platform }
      : {
          directory: input.askpassDirectory,
          platform,
        };
  return {
    ...baseEnv,
    SSH_ASKPASS: ensureSshAskpassHelpers(askpassInput),
    SSH_ASKPASS_REQUIRE: "force",
    ...(input?.authSecret === undefined ? {} : { T3_SSH_AUTH_SECRET: input.authSecret ?? "" }),
    ...(platform === "win32" || baseEnv.DISPLAY ? {} : { DISPLAY: "t3code" }),
  };
}

function baseSshArgs(
  target: DesktopSshEnvironmentTarget,
  input?: { readonly batchMode?: "yes" | "no" },
): string[] {
  return [
    "-o",
    `BatchMode=${input?.batchMode ?? "no"}`,
    "-o",
    "ConnectTimeout=10",
    ...(target.port !== null ? ["-p", String(target.port)] : []),
  ];
}

function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function isSshAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /permission denied|authentication failed|keyboard-interactive/u.test(
    message.toLowerCase(),
  );
}

async function runSshCommand(
  target: DesktopSshEnvironmentTarget,
  input?: {
    readonly preHostArgs?: ReadonlyArray<string>;
    readonly remoteCommandArgs?: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly signal?: AbortSignal;
    readonly authSecret?: string | null;
    readonly batchMode?: "yes" | "no";
    readonly interactiveAuth?: boolean;
  },
): Promise<SshCommandResult> {
  const hostSpec = buildSshHostSpec(target);

  return await new Promise<SshCommandResult>((resolve, reject) => {
    const childEnvironment =
      input?.interactiveAuth === undefined
        ? buildSshChildEnvironment()
        : buildSshChildEnvironment({
            interactiveAuth: input.interactiveAuth,
            ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
          });
    const child = ChildProcess.spawn(
      "ssh",
      [
        ...baseSshArgs(target, {
          batchMode: input?.batchMode ?? (input?.interactiveAuth ? "no" : "yes"),
        }),
        ...(input?.preHostArgs ?? []),
        hostSpec,
        ...(input?.remoteCommandArgs ?? []),
      ],
      {
        env: childEnvironment,
        stdio: "pipe",
      },
    );

    let stdout = "";
    let stderr = "";

    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error(`SSH command aborted for ${hostSpec}.`));
    };

    input?.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      input?.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      input?.signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          normalizeSshErrorMessage(stderr, `SSH command failed for ${hostSpec} (exit ${code}).`),
        ),
      );
    });

    if (input?.stdin !== undefined) {
      child.stdin?.end(input.stdin);
      return;
    }
    child.stdin?.end();
  });
}

async function resolveDesktopSshTarget(alias: string): Promise<DesktopSshEnvironmentTarget> {
  const trimmedAlias = alias.trim();
  if (trimmedAlias.length === 0) {
    throw new Error("SSH host alias is required.");
  }

  try {
    const result = await runSshCommand(
      {
        alias: trimmedAlias,
        hostname: trimmedAlias,
        username: null,
        port: null,
      },
      { preHostArgs: ["-G"] },
    );
    return parseSshResolveOutput(trimmedAlias, result.stdout);
  } catch {
    return {
      alias: trimmedAlias,
      hostname: trimmedAlias,
      username: null,
      port: null,
    };
  }
}

function buildRemoteLaunchScript(input?: { readonly packageSpec?: string }): string {
  const runnerScript = buildRemoteT3RunnerScript(input);
  return `
set -eu
STATE_KEY="$1"
STATE_DIR="$HOME/.t3/ssh-launch/$STATE_KEY"
SERVER_HOME="$STATE_DIR/server-home"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
mkdir -p "$STATE_DIR" "$SERVER_HOME"
cat >"$RUNNER_FILE" <<'SH'
${runnerScript}
SH
chmod 700 "$RUNNER_FILE"
pick_port() {
  node - "$PORT_FILE" <<'NODE'
const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2];
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : ${DEFAULT_REMOTE_PORT};
const end = start + ${REMOTE_PORT_SCAN_WINDOW};

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
NODE
}
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
if [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  :
else
  REMOTE_PORT="$(pick_port)"
  nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  REMOTE_PID="$!"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
fi
printf '{"remotePort":%s}\\n' "$REMOTE_PORT"
`.trimStart();
}

function getLastNonEmptyOutputLine(stdout: string): string | null {
  return (
    stdout
      .trim()
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .findLast((entry) => entry.length > 0) ?? null
  );
}

export function resolveRemoteT3CliPackageSpec(input: {
  readonly appVersion: string;
  readonly updateChannel: DesktopUpdateChannel;
  readonly isDevelopment?: boolean;
}): string {
  if (input.updateChannel === "nightly") {
    return "t3@nightly";
  }

  const appVersion = input.appVersion.trim();
  if (!input.isDevelopment && STABLE_T3_VERSION_PATTERN.test(appVersion)) {
    return `t3@${appVersion}`;
  }

  return "t3@latest";
}

function buildRemoteT3RunnerScript(input?: { readonly packageSpec?: string }): string {
  const packageSpec = input?.packageSpec?.trim() || "t3@latest";
  return [
    "#!/bin/sh",
    "set -eu",
    "if command -v t3 >/dev/null 2>&1; then",
    '  exec t3 "$@"',
    "fi",
    "if command -v npx >/dev/null 2>&1; then",
    `  exec npx --yes ${packageSpec} "$@"`,
    "fi",
    "if command -v npm >/dev/null 2>&1; then",
    `  exec npm exec --yes ${packageSpec} -- "$@"`,
    "fi",
    `printf 'Remote host is missing the t3 CLI and could not install ${packageSpec} because npx and npm are unavailable on PATH.\\n' >&2`,
    "exit 1",
  ].join("\n");
}

function buildRemotePairingScript(
  target: DesktopSshEnvironmentTarget,
  input?: { readonly packageSpec?: string },
): string {
  const runnerScript = buildRemoteT3RunnerScript(input);
  return `
set -eu
STATE_DIR="$HOME/.t3/ssh-launch/${remoteStateKey(target)}"
SERVER_HOME="$STATE_DIR/server-home"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
mkdir -p "$STATE_DIR" "$SERVER_HOME"
cat >"$RUNNER_FILE" <<'SH'
${runnerScript}
SH
chmod 700 "$RUNNER_FILE"
"$RUNNER_FILE" auth pairing create --base-dir "$SERVER_HOME" --json
`.trimStart();
}

async function launchOrReuseRemoteServer(
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
  runner?: { readonly packageSpec?: string },
): Promise<number> {
  const result = await runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s", "--", remoteStateKey(target)],
    stdin: buildRemoteLaunchScript(runner),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  const line = getLastNonEmptyOutputLine(result.stdout);
  if (!line) {
    throw new Error("SSH launch did not return a remote port.");
  }

  const parsed = JSON.parse(line) as { remotePort?: unknown };
  if (typeof parsed.remotePort !== "number" || !Number.isInteger(parsed.remotePort)) {
    throw new Error("SSH launch returned an invalid remote port.");
  }
  return parsed.remotePort;
}

async function issueRemotePairingToken(
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
  runner?: { readonly packageSpec?: string },
): Promise<string> {
  const result = await runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemotePairingScript(target, runner),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  const line = getLastNonEmptyOutputLine(result.stdout);
  if (!line) {
    throw new Error("SSH pairing did not return a credential.");
  }

  const parsed = JSON.parse(line) as { credential?: unknown };
  if (typeof parsed.credential !== "string" || parsed.credential.trim().length === 0) {
    throw new Error("SSH pairing command returned an invalid credential.");
  }
  return parsed.credential;
}

async function stopTunnel(entry: SshTunnelEntry): Promise<void> {
  const child = entry.process;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve();
    };

    const onExit = () => {
      settle();
    };

    child.once("exit", onExit);
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, TUNNEL_SHUTDOWN_TIMEOUT_MS);
    forceKillTimer.unref();
  });
}

export async function discoverDesktopSshHosts(input?: {
  readonly homeDir?: string;
}): Promise<readonly DesktopDiscoveredSshHost[]> {
  const sshDirectory = Path.join(input?.homeDir ?? OS.homedir(), ".ssh");
  const configAliases = collectSshConfigAliasesFromFile(Path.join(sshDirectory, "config"));
  const knownHosts = readKnownHostsHostnames(Path.join(sshDirectory, "known_hosts"));
  const discovered = new Map<string, DesktopDiscoveredSshHost>();

  for (const alias of configAliases) {
    discovered.set(alias, {
      alias,
      hostname: alias,
      username: null,
      port: null,
      source: "ssh-config",
    });
  }

  for (const hostname of knownHosts) {
    if (discovered.has(hostname)) {
      continue;
    }
    discovered.set(hostname, {
      alias: hostname,
      hostname,
      username: null,
      port: null,
      source: "known-hosts",
    });
  }

  return [...discovered.values()].toSorted((left, right) => left.alias.localeCompare(right.alias));
}

export class DesktopSshEnvironmentManager {
  private readonly tunnels = new Map<string, SshTunnelEntry>();
  private readonly authSecrets = new Map<string, string>();

  constructor(private readonly options: DesktopSshEnvironmentManagerOptions = {}) {}

  private async promptForPassword(
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Promise<string> {
    const passwordProvider = this.options.passwordProvider;
    if (!passwordProvider) {
      throw new Error(`SSH authentication failed for ${buildSshHostSpec(target)}.`);
    }

    const password = await passwordProvider({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${buildSshHostSpec(target)}.`,
    });
    if (password === null) {
      throw new Error(`SSH authentication cancelled for ${buildSshHostSpec(target)}.`);
    }
    return password;
  }

  private async runWithSshAuth<T>(
    key: string,
    target: DesktopSshEnvironmentTarget,
    operation: (authOptions: SshAuthOptions) => Promise<T>,
  ): Promise<T> {
    let authSecret = this.authSecrets.get(key) ?? null;
    let promptCount = 0;

    while (true) {
      try {
        return await operation(
          authSecret === null
            ? {
                batchMode: this.options.passwordProvider ? "yes" : "no",
                interactiveAuth: !this.options.passwordProvider,
              }
            : {
                authSecret,
                batchMode: "no",
                interactiveAuth: true,
              },
        );
      } catch (error) {
        if (!isSshAuthFailure(error)) {
          throw error;
        }

        if (!this.options.passwordProvider) {
          throw error;
        }

        if (authSecret !== null) {
          this.authSecrets.delete(key);
        }
        if (promptCount >= 2) {
          throw error;
        }

        promptCount += 1;
        authSecret = await this.promptForPassword(target, promptCount);
        this.authSecrets.set(key, authSecret);
      }
    }
  }

  async discoverHosts(): Promise<readonly DesktopDiscoveredSshHost[]> {
    return await discoverDesktopSshHosts();
  }

  async ensureEnvironment(
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ): Promise<DesktopSshEnvironmentBootstrap> {
    const resolvedTarget = await resolveDesktopSshTarget(target.alias || target.hostname);
    const key = targetConnectionKey(resolvedTarget);
    const packageSpec = this.options.resolveCliPackageSpec?.();
    let entry = this.tunnels.get(key) ?? null;

    if (entry !== null) {
      try {
        await waitForHttpReady(entry.httpBaseUrl, { timeoutMs: 2_000 });
      } catch {
        await stopTunnel(entry).catch(() => undefined);
        this.tunnels.delete(key);
        entry = null;
      }
    }

    if (entry === null) {
      const remotePort = await this.runWithSshAuth(key, resolvedTarget, (authOptions) =>
        launchOrReuseRemoteServer(
          resolvedTarget,
          authOptions,
          packageSpec === undefined ? undefined : { packageSpec },
        ),
      );
      const localPort = await findAvailableLocalPort();
      const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
      const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
      entry = await this.runWithSshAuth(key, resolvedTarget, async (authOptions) => {
        const process = ChildProcess.spawn(
          "ssh",
          [
            ...baseSshArgs(resolvedTarget, { batchMode: authOptions.batchMode ?? "no" }),
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-N",
            "-L",
            `${localPort}:127.0.0.1:${remotePort}`,
            buildSshHostSpec(resolvedTarget),
          ],
          {
            env: buildSshChildEnvironment({
              ...(authOptions.authSecret === undefined
                ? {}
                : { authSecret: authOptions.authSecret }),
              ...(authOptions.interactiveAuth === undefined
                ? {}
                : { interactiveAuth: authOptions.interactiveAuth }),
            }),
            stdio: "pipe",
          },
        );
        const nextEntry: SshTunnelEntry = {
          key,
          target: resolvedTarget,
          remotePort,
          localPort,
          httpBaseUrl,
          wsBaseUrl,
          process,
        };
        const tunnelReady = new Promise<void>((resolve, reject) => {
          let stderr = "";
          process.stderr?.setEncoding("utf8");
          process.stderr?.on("data", (chunk: string) => {
            stderr += chunk;
          });
          process.once("error", (error) => {
            this.tunnels.delete(key);
            reject(error);
          });
          process.once("exit", (code) => {
            this.tunnels.delete(key);
            reject(
              new Error(
                normalizeSshErrorMessage(
                  stderr,
                  `SSH tunnel exited unexpectedly for ${resolvedTarget.alias} (exit ${code ?? "unknown"}).`,
                ),
              ),
            );
          });
          waitForHttpReady(httpBaseUrl, { timeoutMs: SSH_READY_TIMEOUT_MS })
            .then(() => resolve())
            .catch((error) => reject(error));
        });
        this.tunnels.set(key, nextEntry);
        try {
          await tunnelReady;
          return nextEntry;
        } catch (error) {
          await stopTunnel(nextEntry).catch(() => undefined);
          this.tunnels.delete(key);
          throw error;
        }
      });
    }

    const pairingToken = options?.issuePairingToken
      ? await this.runWithSshAuth(key, entry.target, (authOptions) =>
          issueRemotePairingToken(
            entry.target,
            authOptions,
            packageSpec === undefined ? undefined : { packageSpec },
          ),
        )
      : null;

    return {
      target: entry.target,
      httpBaseUrl: entry.httpBaseUrl,
      wsBaseUrl: entry.wsBaseUrl,
      pairingToken,
    };
  }

  async dispose(): Promise<void> {
    const entries = [...this.tunnels.values()];
    this.tunnels.clear();
    await Promise.all(entries.map((entry) => stopTunnel(entry).catch(() => undefined)));
  }
}

export const __test = {
  baseSshArgs,
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteT3RunnerScript,
  resolveRemoteT3CliPackageSpec,
  buildSshAskpassHelperDescriptor,
  buildSshChildEnvironment,
  getLastNonEmptyOutputLine,
  isSshAuthFailure,
  collectSshConfigAliasesFromFile,
  parseKnownHostsHostnames,
  parseSshResolveOutput,
};
