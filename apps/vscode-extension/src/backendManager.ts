import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn as spawnChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_MCP_TOOL_TIMEOUT_SEC, normalizeMcpToolTimeoutSec } from "@t3tools/shared/mcp";
import {
  cleanupDesktopBackendAdvertisements,
  readDesktopBackendAdvertisements,
} from "@t3tools/shared/desktopBackendAdvertisement";
import {
  cleanupHostMcpAdvertisements,
  createHostMcpAdvertisement,
  HOST_MCP_ADVERTISEMENT_HEARTBEAT_MS,
  removeHostMcpAdvertisement,
  writeHostMcpAdvertisement,
  type CleanupHostMcpAdvertisementsResult,
} from "@t3tools/shared/hostMcp";
import * as vscode from "vscode";

import {
  ensureGithubVirtualWorkspaceClone,
  parseGithubVirtualWorkspace,
  pruneVirtualWorkspaceCache as pruneVirtualWorkspaceCacheImpl,
} from "./virtualWorkspaceCache.ts";

const READINESS_PATH = "/.well-known/t3/environment";
const REVOKE_BEARER_SESSION_TIMEOUT_MS = 5_000;
const VSCODE_WORKSPACE_BOOTSTRAP_PATH = "/api/vscode/workspace-bootstrap";

export interface BootstrapWorkspaceFolder {
  readonly key: string;
  readonly name: string;
  readonly cwd: string;
  readonly uriScheme: string;
  readonly uriAuthority: string;
}

export interface BackendConnection {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
  readonly cwd: string;
  readonly t3Home: string;
  readonly environmentId: string;
  readonly workspaceFolders: readonly BootstrapWorkspaceFolder[];
  readonly activeWorkspaceFolderKey?: string | undefined;
  readonly bootstrapProjects: readonly BackendWorkspaceBootstrapProject[];
  readonly initialThreadRoute?: string | undefined;
}

export interface BackendWorkspaceBootstrapProject {
  readonly workspaceFolderKey: string;
  readonly workspaceFolderName: string;
  readonly cwd: string;
  readonly projectId: string;
  readonly bootstrapThreadId: string;
  readonly isActive?: boolean | undefined;
}

export interface BackendMcpServerBootstrap {
  readonly name: string;
  readonly socketPath: string;
  readonly toolTimeoutSec?: number;
}

export interface BackendMcpBridge {
  ensureStarted(): Promise<BackendMcpServerBootstrap | null>;
}

export interface BackendRunCommandOptions {
  readonly cwd?: string;
}

export type BackendRunCommand = (
  command: string,
  args: readonly string[],
  options?: BackendRunCommandOptions,
) => Promise<void>;

export type BackendPairingTokenPrompt = (input: {
  readonly httpBaseUrl: string;
  readonly t3Home: string;
  readonly workspaceFolders: readonly BootstrapWorkspaceFolder[];
}) => Promise<string | null>;

export class DesktopBackendUnavailableError extends Error {
  constructor(
    message = "T3 Code for VS Code requires the T3 Code desktop app to be running on this machine.",
  ) {
    super(message);
    this.name = "DesktopBackendUnavailableError";
  }
}

class BackendStartupCancelledError extends Error {
  constructor() {
    super("Desktop backend startup was cancelled.");
    this.name = "BackendStartupCancelledError";
  }
}

interface BackendStartupToken {
  cancelled: boolean;
  readonly abortController: AbortController;
}

export interface BackendManagerDependencies {
  readonly fetch: typeof fetch;
  readonly mkdirSync: typeof fs.mkdirSync;
  readonly pruneVirtualWorkspaceCache: typeof pruneVirtualWorkspaceCacheImpl;
  readonly randomBytes: typeof crypto.randomBytes;
  readonly runCommand: BackendRunCommand;
  readonly readDesktopBackendAdvertisements: typeof readDesktopBackendAdvertisements;
  readonly cleanupDesktopBackendAdvertisements: typeof cleanupDesktopBackendAdvertisements;
  readonly writeHostMcpAdvertisement: typeof writeHostMcpAdvertisement;
  readonly removeHostMcpAdvertisement: typeof removeHostMcpAdvertisement;
  readonly cleanupHostMcpAdvertisements: typeof cleanupHostMcpAdvertisements;
  readonly promptForPairingToken: BackendPairingTokenPrompt;
}

const defaultBackendManagerDependencies: BackendManagerDependencies = {
  fetch,
  mkdirSync: fs.mkdirSync,
  pruneVirtualWorkspaceCache: pruneVirtualWorkspaceCacheImpl,
  randomBytes: crypto.randomBytes,
  runCommand,
  readDesktopBackendAdvertisements,
  cleanupDesktopBackendAdvertisements,
  writeHostMcpAdvertisement,
  removeHostMcpAdvertisement,
  cleanupHostMcpAdvertisements,
  promptForPairingToken: defaultPromptForPairingToken,
};

export class BackendManager {
  #connection: BackendConnection | null = null;
  #starting: Promise<BackendConnection> | null = null;
  #startupToken: BackendStartupToken | null = null;
  #hostMcpAdvertisement: {
    readonly t3Home: string;
    readonly hostId: string;
    readonly interval: NodeJS.Timeout;
  } | null = null;
  #outputChannel: vscode.OutputChannel;
  readonly #secrets: vscode.SecretStorage;
  readonly #dependencies: BackendManagerDependencies;
  readonly #mcpBridge: BackendMcpBridge | null;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    dependencies: BackendManagerDependencies = defaultBackendManagerDependencies,
    mcpBridge: BackendMcpBridge | null = null,
  ) {
    this.#outputChannel = outputChannel;
    this.#secrets = context.secrets;
    this.#dependencies = dependencies;
    this.#mcpBridge = mcpBridge;
  }

  async ensureStarted(): Promise<BackendConnection> {
    if (this.#connection) {
      return this.#connection;
    }

    if (this.#starting) {
      return this.#starting;
    }

    const startupToken: BackendStartupToken = {
      abortController: new AbortController(),
      cancelled: false,
    };
    this.#startupToken = startupToken;
    this.#starting = this.#connect(startupToken);
    try {
      return await this.#starting;
    } finally {
      if (this.#startupToken === startupToken) {
        this.#starting = null;
        this.#startupToken = null;
      }
    }
  }

  get activeCwd(): string | null {
    return this.#connection?.cwd ?? null;
  }

  async restart(): Promise<BackendConnection> {
    await this.stop();
    return await this.ensureStarted();
  }

  async stop(): Promise<void> {
    this.#stopHostMcpAdvertisement();
    if (this.#startupToken) {
      this.#startupToken.cancelled = true;
      this.#startupToken.abortController.abort();
      this.#startupToken = null;
    }
    this.#starting = null;
    this.#connection = null;
  }

  async #connect(startupToken: BackendStartupToken): Promise<BackendConnection> {
    const t3Home = resolveT3Home();
    this.#dependencies.mkdirSync(t3Home, { recursive: true });
    const workspaceFolders = await resolveBootstrapWorkspaceFolders({
      t3Home,
      dependencies: this.#dependencies,
      outputChannel: this.#outputChannel,
    });
    this.#assertStartupActive(startupToken);
    const activeWorkspaceFolder = resolveActiveWorkspaceFolder(workspaceFolders);
    const cwd = activeWorkspaceFolder?.cwd ?? os.homedir();
    const mcpServer = await this.#mcpBridge?.ensureStarted();
    this.#assertStartupActive(startupToken);
    const mcpToolTimeoutSec = resolveMcpToolTimeoutSec();

    this.#refreshHostMcpAdvertisement({
      t3Home,
      mcpServer: mcpServer ? { ...mcpServer, toolTimeoutSec: mcpToolTimeoutSec } : null,
      workspaceFolders,
      activeWorkspaceFolderKey: activeWorkspaceFolder?.key,
    });
    this.#assertStartupActive(startupToken);

    const desktopBackend = this.#resolveDesktopBackendAdvertisement(t3Home);
    const environment = await waitForBackendReady(
      desktopBackend.httpBaseUrl,
      this.#dependencies.fetch,
      startupToken.abortController.signal,
    );
    const bearerToken = await this.#resolveDesktopBearerToken({
      t3Home,
      httpBaseUrl: desktopBackend.httpBaseUrl,
      workspaceFolders,
      startupToken,
      signal: startupToken.abortController.signal,
    });
    let shouldRevokeStartupBearer = bearerToken.source === "pairing";
    try {
      this.#assertStartupActive(startupToken);
      const workspaceBootstrap = await ensureWorkspaceBootstrap({
        httpBaseUrl: desktopBackend.httpBaseUrl,
        bearerToken: bearerToken.token,
        workspaceFolders,
        activeWorkspaceFolder,
        fetchFn: this.#dependencies.fetch,
        signal: startupToken.abortController.signal,
      });
      this.#assertStartupActive(startupToken);
      if (bearerToken.source === "pairing") {
        await this.#secrets.store(bearerToken.secretKey, bearerToken.token);
        shouldRevokeStartupBearer = false;
      }

      this.#connection = {
        httpBaseUrl: desktopBackend.httpBaseUrl,
        wsBaseUrl: toWebSocketBaseUrl(desktopBackend.httpBaseUrl),
        bearerToken: bearerToken.token,
        cwd,
        t3Home,
        environmentId: environment.environmentId,
        workspaceFolders,
        ...(activeWorkspaceFolder ? { activeWorkspaceFolderKey: activeWorkspaceFolder.key } : {}),
        bootstrapProjects: workspaceBootstrap.bootstrapProjects,
        ...(workspaceBootstrap.activeThreadId
          ? {
              initialThreadRoute: makeThreadRoute(
                environment.environmentId,
                workspaceBootstrap.activeThreadId,
              ),
            }
          : {}),
      };
    } catch (error) {
      if (shouldRevokeStartupBearer) {
        await revokeBearerSession(
          desktopBackend.httpBaseUrl,
          bearerToken.token,
          this.#dependencies.fetch,
        ).catch((revokeError) => {
          this.#outputChannel.appendLine(
            `[backend] Failed to revoke failed startup bearer session: ${errorMessage(revokeError)}`,
          );
        });
      }
      this.#assertStartupActive(startupToken);
      throw error;
    }

    void Promise.resolve().then(() => {
      try {
        const result = this.#dependencies.pruneVirtualWorkspaceCache({
          t3Home,
          activeCheckoutPaths: workspaceFolders.map((folder) => folder.cwd),
          outputChannel: this.#outputChannel,
        });
        if (result.deleted > 0 || result.errors > 0) {
          this.#outputChannel.appendLine(
            `[backend] Pruned ${result.deleted} virtual workspace checkout(s); kept ${result.kept}; errors ${result.errors}.`,
          );
        }
      } catch (error) {
        this.#outputChannel.appendLine(
          `[backend] Failed to prune virtual workspace cache: ${errorMessage(error)}`,
        );
      }
    });

    void Promise.resolve().then(() => {
      try {
        const result = this.#dependencies.cleanupHostMcpAdvertisements({ t3Home });
        logHostMcpCleanupResult(this.#outputChannel, result);
      } catch (error) {
        this.#outputChannel.appendLine(
          `[mcp] Failed to clean host MCP advertisements: ${errorMessage(error)}`,
        );
      }
    });

    return this.#connection;
  }

  #assertStartupActive(startupToken: BackendStartupToken): void {
    if (
      startupToken.cancelled ||
      startupToken.abortController.signal.aborted ||
      this.#startupToken !== startupToken
    ) {
      throw new BackendStartupCancelledError();
    }
  }

  #resolveDesktopBackendAdvertisement(t3Home: string): {
    readonly backendId: string;
    readonly httpBaseUrl: string;
  } {
    try {
      this.#dependencies.cleanupDesktopBackendAdvertisements({ t3Home });
      const result = this.#dependencies.readDesktopBackendAdvertisements({ t3Home });
      for (const advertisement of result.advertisements) {
        if (!isLoopbackHttpBaseUrl(advertisement.httpBaseUrl)) {
          continue;
        }
        return {
          backendId: advertisement.backendId,
          httpBaseUrl: advertisement.httpBaseUrl,
        };
      }
    } catch (error) {
      throw new Error(
        `Failed to discover the required T3 Code desktop backend: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    throw new DesktopBackendUnavailableError();
  }

  async #resolveDesktopBearerToken(input: {
    readonly t3Home: string;
    readonly httpBaseUrl: string;
    readonly workspaceFolders: readonly BootstrapWorkspaceFolder[];
    readonly startupToken: BackendStartupToken;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly source: "stored"; readonly token: string; readonly secretKey: string }
    | { readonly source: "pairing"; readonly token: string; readonly secretKey: string }
  > {
    const secretKey = resolveStoredBearerTokenSecretKey(input);
    const storedBearerToken = (await this.#secrets.get(secretKey))?.trim();
    if (storedBearerToken) {
      const authenticated = await fetchBearerSessionAuthenticated({
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: storedBearerToken,
        fetchFn: this.#dependencies.fetch,
        signal: input.signal,
      });
      this.#assertStartupActive(input.startupToken);
      if (authenticated) {
        return { source: "stored", token: storedBearerToken, secretKey };
      }
      await this.#secrets.delete(secretKey);
    }

    const pairingToken = (
      await this.#dependencies.promptForPairingToken({
        httpBaseUrl: input.httpBaseUrl,
        t3Home: input.t3Home,
        workspaceFolders: input.workspaceFolders,
      })
    )?.trim();
    this.#assertStartupActive(input.startupToken);
    if (!pairingToken) {
      throw new Error("T3 Code VS Code pairing was cancelled.");
    }

    const token = await exchangeBootstrapBearerSession(
      input.httpBaseUrl,
      pairingToken,
      this.#dependencies.fetch,
      input.signal,
    );
    this.#assertStartupActive(input.startupToken);
    return { source: "pairing", token, secretKey };
  }

  #refreshHostMcpAdvertisement(input: {
    readonly t3Home: string;
    readonly mcpServer: BackendMcpServerBootstrap | null;
    readonly workspaceFolders: readonly BootstrapWorkspaceFolder[];
    readonly activeWorkspaceFolderKey?: string | undefined;
  }): void {
    this.#stopHostMcpAdvertisement();
    if (!input.mcpServer || input.workspaceFolders.length === 0) {
      return;
    }

    const mcpServer = input.mcpServer;
    const hostId = `vscode-${process.pid}-${this.#dependencies.randomBytes(8).toString("hex")}`;
    const writeAdvertisement = () => {
      this.#dependencies.writeHostMcpAdvertisement({
        t3Home: input.t3Home,
        advertisement: createHostMcpAdvertisement({
          hostId,
          mcpServer,
          workspaceFolders: input.workspaceFolders,
          activeWorkspaceFolderKey: input.activeWorkspaceFolderKey,
        }),
      });
    };

    try {
      writeAdvertisement();
    } catch (error) {
      this.#outputChannel.appendLine(
        `[mcp] Failed to write host MCP advertisement: ${errorMessage(error)}`,
      );
      return;
    }

    // @effect-diagnostics-next-line globalTimers:off
    const interval = setInterval(() => {
      try {
        writeAdvertisement();
        const result = this.#dependencies.cleanupHostMcpAdvertisements({
          t3Home: input.t3Home,
        });
        logHostMcpCleanupResult(this.#outputChannel, result);
      } catch (error) {
        this.#outputChannel.appendLine(
          `[mcp] Failed to refresh host MCP advertisement: ${errorMessage(error)}`,
        );
      }
    }, HOST_MCP_ADVERTISEMENT_HEARTBEAT_MS);
    interval.unref?.();
    this.#hostMcpAdvertisement = {
      t3Home: input.t3Home,
      hostId,
      interval,
    };
  }

  #stopHostMcpAdvertisement(): void {
    const advertisement = this.#hostMcpAdvertisement;
    this.#hostMcpAdvertisement = null;
    if (!advertisement) {
      return;
    }
    clearInterval(advertisement.interval);
    try {
      this.#dependencies.removeHostMcpAdvertisement({
        t3Home: advertisement.t3Home,
        hostId: advertisement.hostId,
      });
    } catch (error) {
      this.#outputChannel.appendLine(
        `[mcp] Failed to remove host MCP advertisement: ${errorMessage(error)}`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logHostMcpCleanupResult(
  outputChannel: vscode.OutputChannel,
  result: CleanupHostMcpAdvertisementsResult,
): void {
  if (result.deleted > 0 || result.errors > 0) {
    outputChannel.appendLine(
      `[mcp] Cleaned ${result.deleted} expired host MCP advertisement(s); errors ${result.errors}.`,
    );
  }
}

function resolveActiveWorkspaceFolder(
  workspaceFolders: readonly BootstrapWorkspaceFolder[],
): BootstrapWorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    const activeKey = activeWorkspaceFolder ? workspaceFolderKey(activeWorkspaceFolder) : null;
    if (activeKey) {
      return workspaceFolders.find((folder) => folder.key === activeKey);
    }
  }
  return workspaceFolders[0];
}

async function resolveBootstrapWorkspaceFolders(input: {
  readonly t3Home: string;
  readonly dependencies: Pick<BackendManagerDependencies, "mkdirSync" | "runCommand">;
  readonly outputChannel: vscode.OutputChannel;
}): Promise<BootstrapWorkspaceFolder[]> {
  const workspaceFolders: BootstrapWorkspaceFolder[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const resolvedFolder = await resolveBootstrapWorkspaceFolder(folder, input);
    if (resolvedFolder) {
      workspaceFolders.push(resolvedFolder);
    }
  }
  return workspaceFolders;
}

async function resolveBootstrapWorkspaceFolder(
  folder: vscode.WorkspaceFolder,
  input: {
    readonly t3Home: string;
    readonly dependencies: Pick<BackendManagerDependencies, "mkdirSync" | "runCommand">;
    readonly outputChannel: vscode.OutputChannel;
  },
): Promise<BootstrapWorkspaceFolder | null> {
  const uriScheme = folder.uri.scheme || "file";
  const uriAuthority = folder.uri.authority || "";
  const key = workspaceFolderKey(folder);
  if (uriScheme === "file" || uriScheme === "vscode-remote") {
    return {
      key,
      name: folder.name || path.basename(folder.uri.fsPath) || "workspace",
      cwd: folder.uri.fsPath,
      uriScheme,
      uriAuthority,
    };
  }

  const githubWorkspace = parseGithubVirtualWorkspace(folder);
  if (githubWorkspace) {
    const cwd = await ensureGithubVirtualWorkspaceClone({
      ...githubWorkspace,
      key,
      t3Home: input.t3Home,
      dependencies: input.dependencies,
      outputChannel: input.outputChannel,
    });
    return {
      key,
      name: folder.name || githubWorkspace.repository,
      cwd,
      uriScheme,
      uriAuthority,
    };
  }

  input.outputChannel.appendLine(
    `[backend] Skipping unsupported virtual workspace folder ${folder.name || key} (${key}). T3 Code requires a local filesystem checkout for agent execution.`,
  );
  return null;
}

function workspaceFolderKey(folder: vscode.WorkspaceFolder): string {
  return `${folder.uri.scheme || "file"}:${folder.uri.authority || ""}:${folder.uri.fsPath}`;
}

export function resolveT3Home(): string {
  const configured = vscode.workspace.getConfiguration("t3code").get<string>("home")?.trim();
  if (configured) {
    return configured.replace(/^~(?=$|[/\\])/, os.homedir());
  }
  return path.join(os.homedir(), ".t3");
}

export function resolveMcpToolTimeoutSec(): number {
  const configured = vscode.workspace
    .getConfiguration("t3code")
    .get<number>("mcp.toolTimeoutSec", DEFAULT_MCP_TOOL_TIMEOUT_SEC);
  return normalizeMcpToolTimeoutSec(configured);
}

function runCommand(
  command: string,
  args: readonly string[],
  options?: BackendRunCommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnChildProcess(command, [...args], {
      cwd: options?.cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      reject(
        new Error(`Command failed: ${command} ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`),
      );
    });
  });
}

async function defaultPromptForPairingToken(): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    title: "Pair T3 Code with VS Code",
    prompt: "Enter a pairing token from T3 Code Desktop.",
    placeHolder: "Pairing token",
    password: true,
    ignoreFocusOut: true,
  });
  return value ?? null;
}

export function resolveStoredBearerTokenSecretKey(input: {
  readonly t3Home: string;
  readonly httpBaseUrl: string;
  readonly workspaceFolders: readonly BootstrapWorkspaceFolder[];
}): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        t3Home: input.t3Home,
        httpBaseUrl: new URL(input.httpBaseUrl).href,
        workspaceFolders: input.workspaceFolders
          .map((folder) => ({
            key: folder.key,
            cwd: folder.cwd,
            uriScheme: folder.uriScheme,
            uriAuthority: folder.uriAuthority,
          }))
          .toSorted((left, right) => left.key.localeCompare(right.key)),
      }),
    )
    .digest("hex");
  return `t3code.vscode.bearer.v1:${digest}`;
}

async function waitForBackendReady(
  httpBaseUrl: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ readonly environmentId: string }> {
  const deadline = Date.now() + 10_000;
  const readinessUrl = new URL(READINESS_PATH, httpBaseUrl);

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const timeout = createAbortTimeout(1_000, signal);
    try {
      const response = await fetchFn(readinessUrl, { signal: timeout.signal });
      if (response.ok) {
        const body = (await response.json()) as { readonly environmentId?: unknown };
        if (typeof body.environmentId !== "string" || body.environmentId.length === 0) {
          throw new Error("Desktop backend readiness response did not include an environment id.");
        }
        return { environmentId: body.environmentId };
      }
    } catch {
      throwIfAborted(signal);
      // Retry until the desktop backend is ready or its advertisement expires.
    } finally {
      timeout.clear();
    }
    await sleep(100, undefined, { signal }).catch(() => {
      throwIfAborted(signal);
    });
  }

  throw new Error(`Timed out waiting for T3 desktop backend readiness at ${readinessUrl}.`);
}

async function ensureWorkspaceBootstrap(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly workspaceFolders: readonly BootstrapWorkspaceFolder[];
  readonly activeWorkspaceFolder?: BootstrapWorkspaceFolder | undefined;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly bootstrapProjects: readonly BackendWorkspaceBootstrapProject[];
  readonly activeThreadId?: string | undefined;
}> {
  if (input.workspaceFolders.length === 0) {
    return { bootstrapProjects: [] };
  }

  const bootstrapUrl = new URL(VSCODE_WORKSPACE_BOOTSTRAP_PATH, input.httpBaseUrl);
  const response = await input
    .fetchFn(bootstrapUrl, {
      body: JSON.stringify({
        workspaceFolders: input.workspaceFolders,
        ...(input.activeWorkspaceFolder
          ? { activeWorkspaceFolderKey: input.activeWorkspaceFolder.key }
          : {}),
      }),
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: input.signal ?? null,
    })
    .catch((error) => {
      throwIfAborted(input.signal);
      throw new Error(
        `Failed to bootstrap VS Code workspace on desktop backend: ${errorMessage(error)}.`,
        { cause: error },
      );
    });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to bootstrap VS Code workspace on desktop backend (${response.status})${errorText ? `: ${errorText}` : ""}.`,
    );
  }
  const body = (await response.json()) as {
    readonly bootstrapProjects?: readonly BackendWorkspaceBootstrapProject[];
  };
  const bootstrapProjects = body.bootstrapProjects ?? [];

  const activeProject =
    bootstrapProjects.find((project) => project.isActive) ?? bootstrapProjects[0] ?? null;
  return {
    bootstrapProjects,
    ...(activeProject ? { activeThreadId: activeProject.bootstrapThreadId } : {}),
  };
}

function makeThreadRoute(environmentId: string, threadId: string): string {
  return `/_chat/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

async function fetchBearerSessionAuthenticated(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const sessionUrl = new URL("/api/auth/session", input.httpBaseUrl);
  const response = await input.fetchFn(sessionUrl, {
    headers: {
      authorization: `Bearer ${input.bearerToken}`,
    },
    signal: input.signal ?? null,
  });
  if (response.status === 401 || response.status === 403) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`Failed to validate stored desktop bearer session (${response.status}).`);
  }
  const body = (await response.json()) as { readonly authenticated?: unknown };
  return body.authenticated === true;
}

async function exchangeBootstrapBearerSession(
  httpBaseUrl: string,
  bootstrapToken: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  const bootstrapUrl = new URL("/api/auth/bootstrap/bearer", httpBaseUrl);
  const response = await fetchFn(bootstrapUrl, {
    body: JSON.stringify({ credential: bootstrapToken }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
    signal: signal ?? null,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Pairing token was rejected by T3 Code Desktop.");
    }
    throw new Error(`Failed to create desktop bearer session (${response.status}).`);
  }

  const body = (await response.json()) as { readonly sessionToken?: unknown };
  if (typeof body.sessionToken !== "string" || body.sessionToken.length === 0) {
    throw new Error("Desktop bearer session response did not include a session token.");
  }

  return body.sessionToken;
}

async function revokeBearerSession(
  httpBaseUrl: string,
  bearerToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const revokeUrl = new URL("/api/auth/session/revoke", httpBaseUrl);
  const timeout = createAbortTimeout(REVOKE_BEARER_SESSION_TIMEOUT_MS);
  const response = await fetchFn(revokeUrl, {
    headers: {
      authorization: `Bearer ${bearerToken}`,
    },
    method: "POST",
    signal: timeout.signal,
  }).finally(timeout.clear);

  if (!response.ok) {
    throw new Error(`Failed to revoke desktop bearer session (${response.status}).`);
  }
}

function toWebSocketBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function isLoopbackHttpBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.username || url.password) {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }
  return net.isIP(hostname) === 4 && hostname.startsWith("127.");
}

function createAbortTimeout(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): {
  readonly signal: AbortSignal;
  readonly clear: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) {
    abort();
  } else {
    parentSignal?.addEventListener("abort", abort, { once: true });
  }
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => {
      globalThis.clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BackendStartupCancelledError();
  }
}
