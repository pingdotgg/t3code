import * as Crypto from "node:crypto";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@t3tools/shared/Net";
import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentTarget,
  DesktopSshPasswordPromptRequest,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import {
  SshPasswordPrompt,
  type SshPasswordPromptShape,
  type SshPasswordRequest,
} from "@t3tools/ssh/auth";
import { discoverSshHosts } from "@t3tools/ssh/config";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import {
  fetchLoopbackSshJson,
  SshEnvironmentManager,
  type RemoteT3RunnerOptions,
} from "@t3tools/ssh/tunnel";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";

export { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";

const DISCOVER_SSH_HOSTS_CHANNEL = "desktop:discover-ssh-hosts";
const ENSURE_SSH_ENVIRONMENT_CHANNEL = "desktop:ensure-ssh-environment";
const DISCONNECT_SSH_ENVIRONMENT_CHANNEL = "desktop:disconnect-ssh-environment";
const FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL = "desktop:fetch-ssh-environment-descriptor";
const BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL = "desktop:bootstrap-ssh-bearer-session";
const FETCH_SSH_SESSION_STATE_CHANNEL = "desktop:fetch-ssh-session-state";
const ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL = "desktop:issue-ssh-websocket-token";
const SSH_PASSWORD_PROMPT_CHANNEL = "desktop:ssh-password-prompt";
const RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL = "desktop:resolve-ssh-password-prompt";
const DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;
const SSH_PASSWORD_PROMPT_CANCELLED_RESULT = "ssh-password-prompt-cancelled";

interface DesktopSshEnvironmentManagerOptions {
  readonly passwordProvider?: (request: SshPasswordRequest) => Promise<string | null>;
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: () => RemoteT3RunnerOptions;
}

const sshRuntime = ManagedRuntime.make(
  Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
);

function createDesktopSshRuntime(
  passwordPrompt: SshPasswordPromptShape,
  scope: Scope.Scope,
  options: DesktopSshEnvironmentManagerOptions,
) {
  return ManagedRuntime.make(
    Layer.mergeAll(
      NodeServices.layer,
      NodeHttpClient.layerUndici,
      NetService.layer,
      Layer.succeed(Scope.Scope, scope),
      Layer.succeed(SshPasswordPrompt, SshPasswordPrompt.of(passwordPrompt)),
      SshEnvironmentManager.layer({
        ...(options.resolveCliPackageSpec === undefined
          ? {}
          : { resolveCliPackageSpec: options.resolveCliPackageSpec }),
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
      }),
    ),
  );
}

export async function discoverDesktopSshHosts(input?: {
  readonly homeDir?: string;
}): Promise<readonly DesktopDiscoveredSshHost[]> {
  return await sshRuntime.runPromise(discoverSshHosts(input ?? {}));
}

export class DesktopSshEnvironmentManager {
  private readonly runtime: ReturnType<typeof createDesktopSshRuntime>;
  private readonly scope: Scope.Scope;

  constructor(options: DesktopSshEnvironmentManagerOptions = {}) {
    const passwordPrompt: SshPasswordPromptShape = {
      isAvailable: options.passwordProvider !== undefined,
      request: (request) => {
        const passwordProvider = options.passwordProvider;
        if (!passwordProvider) {
          return Effect.succeed(null);
        }

        return Effect.tryPromise({
          try: () => passwordProvider(request),
          catch: (cause) =>
            new SshPasswordPromptError({
              message: cause instanceof Error ? cause.message : "SSH password prompt failed.",
              cause,
            }),
        });
      },
    };
    this.scope = Effect.runSync(Scope.make());
    this.runtime = createDesktopSshRuntime(passwordPrompt, this.scope, options);
  }

  async discoverHosts(): Promise<readonly DesktopDiscoveredSshHost[]> {
    return await discoverDesktopSshHosts();
  }

  async ensureEnvironment(
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) {
    return await this.runtime.runPromise(
      Effect.service(SshEnvironmentManager).pipe(
        Effect.flatMap((manager) => manager.ensureEnvironment(target, options)),
      ),
    );
  }

  async disconnectEnvironment(target: DesktopSshEnvironmentTarget): Promise<void> {
    await this.runtime.runPromise(
      Effect.service(SshEnvironmentManager).pipe(
        Effect.flatMap((manager) => manager.disconnectEnvironment(target)),
      ),
    );
  }

  async dispose(): Promise<void> {
    await this.runtime.runPromise(Scope.close(this.scope, Exit.void));
    await this.runtime.dispose();
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
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: () => RemoteT3RunnerOptions;
  readonly passwordPromptTimeoutMs?: number;
}

interface PendingSshPasswordPrompt {
  readonly resolve: (password: string | null) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export function isSshPasswordPromptCancellation(error: unknown): error is SshPasswordPromptError {
  const message = error instanceof SshPasswordPromptError ? error.message.toLowerCase() : "";
  return (
    error instanceof SshPasswordPromptError &&
    (message.includes("cancelled") || message.includes("timed out"))
  );
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
      ...(options.resolveCliPackageSpec === undefined
        ? {}
        : { resolveCliPackageSpec: options.resolveCliPackageSpec }),
      ...(options.resolveCliRunner === undefined
        ? {}
        : { resolveCliRunner: options.resolveCliRunner }),
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

      try {
        return await this.manager.ensureEnvironment(target, {
          issuePairingToken,
        });
      } catch (error) {
        if (isSshPasswordPromptCancellation(error)) {
          return {
            type: SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
            message: error.message,
          };
        }
        throw error;
      }
    });

    ipcMain.removeHandler(DISCONNECT_SSH_ENVIRONMENT_CHANNEL);
    ipcMain.handle(DISCONNECT_SSH_ENVIRONMENT_CHANNEL, async (_event, rawTarget) => {
      const target = getSafeDesktopSshTarget(rawTarget);
      if (!target) {
        throw new Error("Invalid desktop SSH target.");
      }

      await this.manager.disconnectEnvironment(target);
    });

    ipcMain.removeHandler(FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL);
    ipcMain.handle(FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, async (_event, rawHttpBaseUrl) =>
      sshRuntime.runPromise(
        fetchLoopbackSshJson<ExecutionEnvironmentDescriptor>({
          httpBaseUrl: rawHttpBaseUrl,
          pathname: "/.well-known/t3/environment",
        }),
      ),
    );

    ipcMain.removeHandler(BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL);
    ipcMain.handle(
      BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
      async (_event, rawHttpBaseUrl, rawCredential) =>
        sshRuntime.runPromise(
          fetchLoopbackSshJson<AuthBearerBootstrapResult>({
            httpBaseUrl: rawHttpBaseUrl,
            pathname: "/api/auth/bootstrap/bearer",
            method: "POST",
            body: { credential: rawCredential },
          }),
        ),
    );

    ipcMain.removeHandler(FETCH_SSH_SESSION_STATE_CHANNEL);
    ipcMain.handle(
      FETCH_SSH_SESSION_STATE_CHANNEL,
      async (_event, rawHttpBaseUrl, rawBearerToken) =>
        sshRuntime.runPromise(
          fetchLoopbackSshJson<AuthSessionState>({
            httpBaseUrl: rawHttpBaseUrl,
            pathname: "/api/auth/session",
            bearerToken: rawBearerToken,
          }),
        ),
    );

    ipcMain.removeHandler(ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL);
    ipcMain.handle(
      ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
      async (_event, rawHttpBaseUrl, rawBearerToken) =>
        sshRuntime.runPromise(
          fetchLoopbackSshJson<AuthWebSocketTokenResult>({
            httpBaseUrl: rawHttpBaseUrl,
            pathname: "/api/auth/ws-token",
            method: "POST",
            bearerToken: rawBearerToken,
          }),
        ),
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
          throw new Error("SSH password prompt expired. Try connecting again.");
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

  private async requestPasswordFromRenderer(input: SshPasswordRequest): Promise<string | null> {
    const window = this.options.getMainWindow();
    if (!window || window.isDestroyed()) {
      throw new Error("T3 Code window is not available for SSH authentication.");
    }

    const request: DesktopSshPasswordPromptRequest = {
      requestId: Crypto.randomUUID(),
      destination: input.destination,
      username: input.username,
      prompt: input.prompt,
      expiresAt: new Date(Date.now() + this.passwordPromptTimeoutMs).toISOString(),
    };

    return await new Promise<string | null>((resolve, reject) => {
      const rejectPrompt = (error: Error) => {
        clearTimeout(timeout);
        this.pendingPrompts.delete(request.requestId);
        reject(error);
      };
      const timeout = setTimeout(() => {
        this.pendingPrompts.delete(request.requestId);
        reject(new Error(`SSH authentication timed out for ${input.destination}.`));
      }, this.passwordPromptTimeoutMs);
      timeout.unref();

      this.pendingPrompts.set(request.requestId, { resolve, reject, timeout });

      try {
        if (window.isDestroyed()) {
          throw new Error("T3 Code window is not available for SSH authentication.");
        }
        window.webContents.send(SSH_PASSWORD_PROMPT_CHANNEL, request);
        if (window.isDestroyed()) {
          throw new Error("T3 Code window is not available for SSH authentication.");
        }
        if (window.isMinimized()) {
          window.restore();
        }
        if (window.isDestroyed()) {
          throw new Error("T3 Code window is not available for SSH authentication.");
        }
        window.focus();
      } catch (error) {
        rejectPrompt(
          error instanceof Error
            ? error
            : new Error("T3 Code window is not available for SSH authentication."),
        );
      }
    });
  }
}
