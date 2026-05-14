import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as vscode from "vscode";

const READINESS_PATH = "/.well-known/t3/environment";

interface BackendBootstrap {
  readonly mode: "desktop";
  readonly noBrowser: boolean;
  readonly port: number;
  readonly t3Home: string;
  readonly host: string;
  readonly desktopBootstrapToken: string;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

export interface BackendConnection {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bootstrapToken: string;
  readonly bearerToken: string;
  readonly cwd: string;
  readonly t3Home: string;
}

interface ResolvedServerCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface BackendSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["ignore", "pipe", "pipe", "pipe"];
}

export type BackendSpawn = (
  command: string,
  args: readonly string[],
  options: BackendSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface BackendManagerDependencies {
  readonly findAvailablePort: () => Promise<number>;
  readonly fetch: typeof fetch;
  readonly mkdirSync: typeof fs.mkdirSync;
  readonly randomBytes: typeof crypto.randomBytes;
  readonly spawn: BackendSpawn;
}

const defaultBackendManagerDependencies: BackendManagerDependencies = {
  findAvailablePort,
  fetch,
  mkdirSync: fs.mkdirSync,
  randomBytes: crypto.randomBytes,
  spawn: (command, args, options) =>
    spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [...options.stdio],
    }) as ChildProcessWithoutNullStreams,
};

export class BackendManager {
  #process: ChildProcessWithoutNullStreams | null = null;
  #connection: BackendConnection | null = null;
  #starting: Promise<BackendConnection> | null = null;
  #outputChannel: vscode.OutputChannel;
  readonly #context: vscode.ExtensionContext;
  readonly #dependencies: BackendManagerDependencies;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    dependencies: BackendManagerDependencies = defaultBackendManagerDependencies,
  ) {
    this.#context = context;
    this.#outputChannel = outputChannel;
    this.#dependencies = dependencies;
  }

  async ensureStarted(): Promise<BackendConnection> {
    if (this.#connection && this.#process && !this.#process.killed) {
      return this.#connection;
    }

    if (this.#starting) {
      return this.#starting;
    }

    this.#starting = this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  async restart(): Promise<BackendConnection> {
    await this.stop();
    return await this.ensureStarted();
  }

  async stop(): Promise<void> {
    const child = this.#process;
    this.#process = null;
    this.#connection = null;

    if (!child || child.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  async #start(): Promise<BackendConnection> {
    const workspaceFolder = resolveWorkspaceFolder();
    const cwd = workspaceFolder?.uri.fsPath ?? os.homedir();
    const port = await this.#dependencies.findAvailablePort();
    const host = "127.0.0.1";
    const bootstrapToken = this.#dependencies.randomBytes(24).toString("hex");
    const t3Home = resolveT3Home();
    const command = resolveServerCommand(this.#context, cwd);
    const bootstrap: BackendBootstrap = {
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home,
      host,
      desktopBootstrapToken: bootstrapToken,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    };
    const args = [...command.args, "--bootstrap-fd", "3", "--auto-bootstrap-project-from-cwd", cwd];

    this.#dependencies.mkdirSync(t3Home, { recursive: true });
    this.#outputChannel.appendLine(`[backend] Starting: ${command.command} ${args.join(" ")}`);

    const child = this.#dependencies.spawn(command.command, args, {
      cwd: command.cwd,
      env: backendEnv(),
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.#process = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.#outputChannel.append(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#outputChannel.append(chunk.toString());
    });
    child.once("exit", (code, signal) => {
      this.#outputChannel.appendLine(
        `[backend] Exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (this.#process === child) {
        this.#process = null;
        this.#connection = null;
      }
    });

    const bootstrapPipe = child.stdio[3];
    if (!bootstrapPipe || !("write" in bootstrapPipe)) {
      child.kill();
      throw new Error("Failed to open backend bootstrap pipe.");
    }
    bootstrapPipe.end(JSON.stringify(bootstrap));

    const httpBaseUrl = `http://${host}:${port}`;
    const wsBaseUrl = `ws://${host}:${port}`;
    await waitForBackendReady(httpBaseUrl, this.#dependencies.fetch);
    const bearerToken = await exchangeBootstrapBearerSession(
      httpBaseUrl,
      bootstrapToken,
      this.#dependencies.fetch,
    );

    this.#connection = {
      httpBaseUrl,
      wsBaseUrl,
      bootstrapToken,
      bearerToken,
      cwd,
      t3Home,
    };
    return this.#connection;
  }
}

function resolveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    return vscode.workspace.getWorkspaceFolder(activeUri);
  }
  return vscode.workspace.workspaceFolders?.[0];
}

function resolveT3Home(): string {
  const configured = vscode.workspace.getConfiguration("t3code").get<string>("home")?.trim();
  if (configured) {
    return configured.replace(/^~(?=$|[/\\])/, os.homedir());
  }
  return path.join(os.homedir(), ".t3");
}

function resolveServerCommand(
  context: vscode.ExtensionContext,
  workspaceCwd: string,
): ResolvedServerCommand {
  const configuration = vscode.workspace.getConfiguration("t3code");
  const configuredCommand = configuration.get<string>("server.command")?.trim();
  const configuredArgs = configuration.get<readonly string[]>("server.args") ?? [];
  const configuredCwd = configuration.get<string>("server.cwd")?.trim();

  if (configuredCommand) {
    return {
      command: configuredCommand,
      args: configuredArgs,
      cwd: configuredCwd || workspaceCwd,
    };
  }

  const bundledEntry = path.join(context.extensionPath, "dist", "server", "bin.mjs");
  if (fs.existsSync(bundledEntry)) {
    return {
      command: process.execPath,
      args: [bundledEntry],
      cwd: workspaceCwd,
    };
  }

  const developmentRepoRoot = findDevelopmentRepoRoot(context.extensionPath, workspaceCwd);
  if (developmentRepoRoot) {
    return {
      command: "bun",
      args: ["--cwd", path.join(developmentRepoRoot, "apps/server"), "run", "dev", "--"],
      cwd: developmentRepoRoot,
    };
  }

  throw new Error(
    "Unable to resolve a T3 backend. Build the extension package or configure t3code.server.command.",
  );
}

function findDevelopmentRepoRoot(...candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    let current = path.resolve(candidate);
    while (true) {
      if (fs.existsSync(path.join(current, "apps/server/src/bin.ts"))) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return null;
}

function backendEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "T3CODE_PORT",
    "T3CODE_MODE",
    "T3CODE_NO_BROWSER",
    "T3CODE_HOST",
    "T3CODE_DESKTOP_WS_URL",
    "T3CODE_DESKTOP_LAN_ACCESS",
    "T3CODE_DESKTOP_LAN_HOST",
    "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
    "T3CODE_TAILSCALE_SERVE",
    "T3CODE_TAILSCALE_SERVE_PORT",
  ]) {
    delete env[name];
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Unable to allocate a local backend port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForBackendReady(
  httpBaseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  const readinessUrl = new URL(READINESS_PATH, httpBaseUrl);

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetchFn(readinessUrl, { signal: controller.signal });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the backend binds the port.
    } finally {
      clearTimeout(requestTimeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for T3 backend readiness at ${readinessUrl.toString()}.`);
}

async function exchangeBootstrapBearerSession(
  httpBaseUrl: string,
  bootstrapToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const bootstrapUrl = new URL("/api/auth/bootstrap/bearer", httpBaseUrl);
  const response = await fetchFn(bootstrapUrl, {
    body: JSON.stringify({ credential: bootstrapToken }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Failed to create VS Code backend bearer session (${response.status}).`);
  }

  const body = (await response.json()) as { readonly sessionToken?: unknown };
  if (typeof body.sessionToken !== "string" || body.sessionToken.length === 0) {
    throw new Error("Backend bearer session response did not include a session token.");
  }

  return body.sessionToken;
}
