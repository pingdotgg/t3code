import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import * as Net from "node:net";

import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  DesktopSshPasswordPromptRequest,
  DesktopUpdateChannel,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

import { waitForHttpReady } from "./backendReadiness.ts";

const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const SSH_ASKPASS_DIR_NAME = "t3code-ssh-askpass";
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const SSH_READY_TIMEOUT_MS = 20_000;
const PUBLISHABLE_T3_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const DISCOVER_SSH_HOSTS_CHANNEL = "desktop:discover-ssh-hosts";
const ENSURE_SSH_ENVIRONMENT_CHANNEL = "desktop:ensure-ssh-environment";
const FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL = "desktop:fetch-ssh-environment-descriptor";
const BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL = "desktop:bootstrap-ssh-bearer-session";
const FETCH_SSH_SESSION_STATE_CHANNEL = "desktop:fetch-ssh-session-state";
const ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL = "desktop:issue-ssh-websocket-token";
const SSH_PASSWORD_PROMPT_CHANNEL = "desktop:ssh-password-prompt";
const RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL = "desktop:resolve-ssh-password-prompt";
const DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;

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

function expandHomePath(input: string, homeDir: string = OS.homedir()): string {
  return input.replace(/^~(?=$|\/|\\)/u, homeDir);
}

function resolveSshConfigIncludePattern(
  includePattern: string,
  _directory: string,
  homeDir: string = OS.homedir(),
): string {
  const expandedPattern = expandHomePath(includePattern, homeDir);
  return Path.isAbsolute(expandedPattern)
    ? expandedPattern
    : Path.resolve(Path.join(homeDir, ".ssh"), expandedPattern);
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
  homeDir: string = OS.homedir(),
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
        const resolvedPattern = resolveSshConfigIncludePattern(includePattern, directory, homeDir);
        for (const includedPath of expandGlob(resolvedPattern)) {
          for (const alias of collectSshConfigAliasesFromFile(includedPath, visited, homeDir)) {
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

function normalizeKnownHostsHostname(rawHost: string): string {
  const bracketMatch = /^\[([^\]]+)\]:(\d+)$/u.exec(rawHost);
  if (bracketMatch?.[1]) {
    return bracketMatch[1];
  }

  if (!rawHost.includes(":")) {
    return rawHost;
  }

  const firstColonIndex = rawHost.indexOf(":");
  const lastColonIndex = rawHost.lastIndexOf(":");
  return firstColonIndex === lastColonIndex ? rawHost.slice(0, lastColonIndex) : rawHost;
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
      const host = normalizeKnownHostsHostname(rawHost).trim();
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

const SSH_SCRIPTS_DIR = Path.join(__dirname, "sshScripts");
const sshScriptCache = new Map<string, string>();

function readSshScriptTemplate(fileName: string): string {
  const cached = sshScriptCache.get(fileName);
  if (cached !== undefined) {
    return cached;
  }
  const contents = FS.readFileSync(Path.join(SSH_SCRIPTS_DIR, fileName), "utf8");
  sshScriptCache.set(fileName, contents);
  return contents;
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
    result = result.replaceAll(`@@${token}@@`, value);
  }
  return result;
}

function toCrlf(value: string): string {
  return value.replace(/\r?\n/gu, "\r\n");
}

function buildPosixSshAskpassScript(): string {
  return readSshScriptTemplate("askpass-posix.sh");
}

function buildWindowsSshAskpassScript(): string {
  return toCrlf(readSshScriptTemplate("askpass-windows.ps1"));
}

function buildWindowsSshAskpassLauncherScript(): string {
  return toCrlf(readSshScriptTemplate("askpass-windows.cmd"));
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
          contents: buildWindowsSshAskpassLauncherScript(),
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
  const normalized = message.toLowerCase();
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]+\)/u.test(
      normalized,
    ) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
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
  return applyScriptPlaceholders(readSshScriptTemplate("remote-launch.sh"), {
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
    T3_PICK_PORT_SCRIPT: stripTrailingNewlines(readSshScriptTemplate("remote-pick-port.cjs")),
    T3_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    T3_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
  });
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
  const appVersion = input.appVersion.trim();
  if (!input.isDevelopment && PUBLISHABLE_T3_VERSION_PATTERN.test(appVersion)) {
    return `t3@${appVersion}`;
  }

  if (input.isDevelopment) {
    return "t3@nightly";
  }

  return input.updateChannel === "nightly" ? "t3@nightly" : "t3@latest";
}

function buildRemoteT3RunnerScript(input?: { readonly packageSpec?: string }): string {
  const packageSpec = input?.packageSpec?.trim() || "t3@latest";
  return stripTrailingNewlines(
    applyScriptPlaceholders(readSshScriptTemplate("remote-runner.sh"), {
      T3_PACKAGE_SPEC: packageSpec,
    }),
  );
}

function buildRemotePairingScript(
  target: DesktopSshEnvironmentTarget,
  input?: { readonly packageSpec?: string },
): string {
  return applyScriptPlaceholders(readSshScriptTemplate("remote-pairing.sh"), {
    T3_STATE_KEY: remoteStateKey(target),
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
  });
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
    throw new Error(
      `SSH launch did not return a remote port. stdout=${JSON.stringify(result.stdout)}`,
    );
  }

  let parsed: { remotePort?: unknown };
  try {
    parsed = JSON.parse(line) as { remotePort?: unknown };
  } catch (cause) {
    throw new Error(
      `SSH launch returned unparseable output. line=${JSON.stringify(line)} stdout=${JSON.stringify(result.stdout)}`,
      { cause },
    );
  }
  if (typeof parsed.remotePort !== "number" || !Number.isInteger(parsed.remotePort)) {
    throw new Error(
      `SSH launch returned an invalid remote port. parsed=${JSON.stringify(parsed)} stdout=${JSON.stringify(result.stdout)}`,
    );
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
    throw new Error(
      `SSH pairing did not return a credential. stdout=${JSON.stringify(result.stdout)}`,
    );
  }

  let parsed: { credential?: unknown };
  try {
    parsed = JSON.parse(line) as { credential?: unknown };
  } catch (cause) {
    throw new Error(
      `SSH pairing returned unparseable output. line=${JSON.stringify(line)} stdout=${JSON.stringify(result.stdout)}`,
      { cause },
    );
  }
  if (typeof parsed.credential !== "string" || parsed.credential.trim().length === 0) {
    throw new Error(
      `SSH pairing command returned an invalid credential. parsed=${JSON.stringify(parsed)} stdout=${JSON.stringify(result.stdout)}`,
    );
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
    let hardStopTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (hardStopTimer) {
        clearTimeout(hardStopTimer);
      }
      resolve();
    };

    const onExit = () => {
      settle();
    };

    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      settle();
      return;
    }
    if (!child.kill("SIGTERM")) {
      settle();
      return;
    }
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      hardStopTimer = setTimeout(() => {
        settle();
      }, 1_000);
      hardStopTimer.unref();
    }, TUNNEL_SHUTDOWN_TIMEOUT_MS);
    forceKillTimer.unref();
  });
}

export async function discoverDesktopSshHosts(input?: {
  readonly homeDir?: string;
}): Promise<readonly DesktopDiscoveredSshHost[]> {
  const homeDir = input?.homeDir ?? OS.homedir();
  const sshDirectory = Path.join(homeDir, ".ssh");
  const configAliases = collectSshConfigAliasesFromFile(
    Path.join(sshDirectory, "config"),
    new Set<string>(),
    homeDir,
  );
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
  private readonly pendingTunnelEntries = new Map<string, Promise<SshTunnelEntry>>();
  private readonly authSecrets = new Map<string, string>();
  private readonly options: DesktopSshEnvironmentManagerOptions;

  constructor(options: DesktopSshEnvironmentManagerOptions = {}) {
    this.options = options;
  }

  private deleteTunnelIfCurrent(entry: SshTunnelEntry): void {
    if (this.tunnels.get(entry.key) === entry) {
      this.tunnels.delete(entry.key);
    }
  }

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
    const baseResolved = await resolveDesktopSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    const packageSpec = this.options.resolveCliPackageSpec?.();
    const entry = await this.ensureTunnelEntry(key, resolvedTarget, packageSpec);

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

  private async ensureTunnelEntry(
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    packageSpec?: string,
  ): Promise<SshTunnelEntry> {
    let entry = this.tunnels.get(key) ?? null;

    if (entry !== null) {
      try {
        await waitForHttpReady(entry.httpBaseUrl, { timeoutMs: 2_000 });
        return entry;
      } catch {
        await stopTunnel(entry).catch(() => undefined);
        this.deleteTunnelIfCurrent(entry);
        entry = null;
      }
    }

    const pending = this.pendingTunnelEntries.get(key);
    if (pending) {
      return await pending;
    }

    const nextEntry = (async () => {
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
      return await this.runWithSshAuth(key, resolvedTarget, async (authOptions) => {
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
        const tunnelEntry: SshTunnelEntry = {
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
            this.deleteTunnelIfCurrent(tunnelEntry);
            reject(error);
          });
          process.once("exit", (code) => {
            this.deleteTunnelIfCurrent(tunnelEntry);
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
            .catch((error: unknown) => reject(error));
        });
        this.tunnels.set(key, tunnelEntry);
        try {
          await tunnelReady;
          return tunnelEntry;
        } catch (error) {
          await stopTunnel(tunnelEntry).catch(() => undefined);
          this.deleteTunnelIfCurrent(tunnelEntry);
          throw error;
        }
      });
    })();
    this.pendingTunnelEntries.set(key, nextEntry);
    return await nextEntry.finally(() => {
      if (this.pendingTunnelEntries.get(key) === nextEntry) {
        this.pendingTunnelEntries.delete(key);
      }
    });
  }

  async dispose(): Promise<void> {
    const entries = [...this.tunnels.values()];
    this.tunnels.clear();
    this.pendingTunnelEntries.clear();
    await Promise.all(entries.map((entry) => stopTunnel(entry).catch(() => undefined)));
  }
}

function getSafeDesktopSshTarget(rawTarget: unknown): DesktopSshEnvironmentTarget | null {
  if (typeof rawTarget !== "object" || rawTarget === null) {
    return null;
  }

  const target = rawTarget as Partial<DesktopSshEnvironmentTarget>;
  if (typeof target.alias !== "string" || typeof target.hostname !== "string") {
    return null;
  }
  if (
    target.username !== null &&
    target.username !== undefined &&
    typeof target.username !== "string"
  ) {
    return null;
  }
  if (target.port !== null && target.port !== undefined && !Number.isInteger(target.port)) {
    return null;
  }

  const alias = target.alias.trim();
  const hostname = target.hostname.trim();
  if (alias.length === 0 || hostname.length === 0) {
    return null;
  }

  return {
    alias,
    hostname,
    username: target.username?.trim() || null,
    port: target.port ?? null,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function resolveLoopbackSshHttpUrl(rawHttpBaseUrl: unknown, pathname: string): URL {
  if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
    throw new Error("Invalid SSH forwarded http base URL.");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawHttpBaseUrl);
  } catch {
    throw new Error("Invalid SSH forwarded http base URL.");
  }

  if (!isLoopbackHostname(baseUrl.hostname)) {
    throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
  }

  const url = new URL(baseUrl.toString());
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

async function readRemoteFetchErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text();
  if (!text) {
    return fallbackMessage;
  }

  try {
    const parsed = JSON.parse(text) as { readonly error?: string };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    // Fall back to the raw text below.
  }

  return text;
}

async function fetchLoopbackSshJson<T>(input: {
  readonly httpBaseUrl: unknown;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: unknown;
  readonly body?: unknown;
}): Promise<T> {
  const requestUrl = resolveLoopbackSshHttpUrl(input.httpBaseUrl, input.pathname).toString();
  const bearerToken =
    typeof input.bearerToken === "string" && input.bearerToken.trim().length > 0
      ? input.bearerToken
      : null;

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: input.method ?? "GET",
      headers: {
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    throw new Error(
      `Failed to reach SSH forwarded endpoint ${requestUrl} (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }

  if (!response.ok) {
    const message = await readRemoteFetchErrorMessage(
      response,
      `SSH forwarded request failed (${response.status}).`,
    );
    throw new Error(`[ssh_http:${response.status}] ${message}`);
  }

  return (await response.json()) as T;
}

/** Minimal subset of Electron's BrowserWindow used by the SSH bridge. */
export interface DesktopSshBridgeWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  readonly webContents: {
    send(channel: string, ...args: readonly unknown[]): void;
  };
}

/** Minimal subset of Electron's ipcMain used by the SSH bridge. */
export interface DesktopSshBridgeIpcMain {
  removeHandler(channel: string): void;
  handle(
    channel: string,
    listener: (event: unknown, ...args: readonly unknown[]) => unknown | Promise<unknown>,
  ): void;
}

export interface DesktopSshEnvironmentBridgeOptions {
  readonly getMainWindow: () => DesktopSshBridgeWindow | null;
  readonly resolveCliPackageSpec: () => string;
  readonly passwordPromptTimeoutMs?: number;
}

interface PendingSshPasswordPrompt {
  readonly resolve: (password: string | null) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

/**
 * Wires the SSH environment manager to Electron IPC, owning the renderer-facing
 * password prompt state so `main.ts` only needs to register, cancel, and dispose.
 */
export class DesktopSshEnvironmentBridge {
  private readonly options: DesktopSshEnvironmentBridgeOptions;
  private readonly manager: DesktopSshEnvironmentManager;
  private readonly pendingPrompts = new Map<string, PendingSshPasswordPrompt>();
  private readonly passwordPromptTimeoutMs: number;

  constructor(options: DesktopSshEnvironmentBridgeOptions) {
    this.options = options;
    this.passwordPromptTimeoutMs =
      options.passwordPromptTimeoutMs ?? DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS;
    this.manager = new DesktopSshEnvironmentManager({
      passwordProvider: (request) => this.requestPasswordFromRenderer(request),
      resolveCliPackageSpec: options.resolveCliPackageSpec,
    });
  }

  registerIpcHandlers(ipcMain: DesktopSshBridgeIpcMain): void {
    ipcMain.removeHandler(DISCOVER_SSH_HOSTS_CHANNEL);
    ipcMain.handle(DISCOVER_SSH_HOSTS_CHANNEL, async () => this.manager.discoverHosts());

    ipcMain.removeHandler(ENSURE_SSH_ENVIRONMENT_CHANNEL);
    ipcMain.handle(ENSURE_SSH_ENVIRONMENT_CHANNEL, async (_event, rawTarget, rawOptions) => {
      const target = getSafeDesktopSshTarget(rawTarget);
      if (!target) {
        throw new Error("Invalid desktop SSH target.");
      }

      const issuePairingToken =
        typeof rawOptions === "object" &&
        rawOptions !== null &&
        "issuePairingToken" in rawOptions &&
        (rawOptions as { issuePairingToken?: unknown }).issuePairingToken === true;

      return await this.manager.ensureEnvironment(target, { issuePairingToken });
    });

    ipcMain.removeHandler(FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL);
    ipcMain.handle(FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, async (_event, rawHttpBaseUrl) =>
      fetchLoopbackSshJson<ExecutionEnvironmentDescriptor>({
        httpBaseUrl: rawHttpBaseUrl,
        pathname: "/.well-known/t3/environment",
      }),
    );

    ipcMain.removeHandler(BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL);
    ipcMain.handle(
      BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
      async (_event, rawHttpBaseUrl, rawCredential) =>
        fetchLoopbackSshJson<AuthBearerBootstrapResult>({
          httpBaseUrl: rawHttpBaseUrl,
          pathname: "/api/auth/bootstrap/bearer",
          method: "POST",
          body: { credential: rawCredential },
        }),
    );

    ipcMain.removeHandler(FETCH_SSH_SESSION_STATE_CHANNEL);
    ipcMain.handle(
      FETCH_SSH_SESSION_STATE_CHANNEL,
      async (_event, rawHttpBaseUrl, rawBearerToken) =>
        fetchLoopbackSshJson<AuthSessionState>({
          httpBaseUrl: rawHttpBaseUrl,
          pathname: "/api/auth/session",
          bearerToken: rawBearerToken,
        }),
    );

    ipcMain.removeHandler(ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL);
    ipcMain.handle(
      ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
      async (_event, rawHttpBaseUrl, rawBearerToken) =>
        fetchLoopbackSshJson<AuthWebSocketTokenResult>({
          httpBaseUrl: rawHttpBaseUrl,
          pathname: "/api/auth/ws-token",
          method: "POST",
          bearerToken: rawBearerToken,
        }),
    );

    ipcMain.removeHandler(RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL);
    ipcMain.handle(
      RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
      async (_event, rawRequestId, rawPassword) => {
        if (typeof rawRequestId !== "string" || rawRequestId.trim().length === 0) {
          throw new Error("Invalid SSH password prompt id.");
        }
        if (rawPassword !== null && typeof rawPassword !== "string") {
          throw new Error("Invalid SSH password prompt response.");
        }

        const pending = this.pendingPrompts.get(rawRequestId);
        if (!pending) {
          throw new Error("SSH password prompt is no longer pending.");
        }

        clearTimeout(pending.timeout);
        this.pendingPrompts.delete(rawRequestId);
        pending.resolve(rawPassword);
      },
    );
  }

  cancelPendingPasswordPrompts(reason: string): void {
    for (const [requestId, pending] of this.pendingPrompts) {
      clearTimeout(pending.timeout);
      this.pendingPrompts.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  async dispose(): Promise<void> {
    this.cancelPendingPasswordPrompts("SSH environment bridge disposed.");
    await this.manager.dispose();
  }

  private async requestPasswordFromRenderer(
    input: DesktopSshPasswordRequest,
  ): Promise<string | null> {
    const window = this.options.getMainWindow();
    if (!window || window.isDestroyed()) {
      throw new Error("T3 Code window is not available for SSH authentication.");
    }

    const request: DesktopSshPasswordPromptRequest = {
      requestId: Crypto.randomUUID(),
      destination: input.destination,
      username: input.username,
      prompt: input.prompt,
    };

    return await new Promise<string | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPrompts.delete(request.requestId);
        reject(new Error(`SSH authentication timed out for ${input.destination}.`));
      }, this.passwordPromptTimeoutMs);
      timeout.unref();

      this.pendingPrompts.set(request.requestId, { resolve, reject, timeout });

      window.webContents.send(SSH_PASSWORD_PROMPT_CHANNEL, request);
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    });
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
  expandHomePath,
  normalizeKnownHostsHostname,
  parseKnownHostsHostnames,
  parseSshResolveOutput,
  resolveSshConfigIncludePattern,
  stopTunnel,
};
