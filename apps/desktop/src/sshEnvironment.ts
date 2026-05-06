import { NetService } from "@t3tools/shared/Net";
import type {
  AuthBearerBootstrapResult,
  DesktopSshEnvironmentBootstrap,
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
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  Random,
  Scope,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
  DISCONNECT_SSH_ENVIRONMENT_CHANNEL,
  DISCOVER_SSH_HOSTS_CHANNEL,
  ENSURE_SSH_ENVIRONMENT_CHANNEL,
  FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL,
  FETCH_SSH_SESSION_STATE_CHANNEL,
  ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
  RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
  SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
  SSH_PASSWORD_PROMPT_CHANNEL,
} from "./ipc/channels.ts";

export { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";

const DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;
const SSH_HANDLED_IPC_CHANNELS = [
  DISCOVER_SSH_HOSTS_CHANNEL,
  ENSURE_SSH_ENVIRONMENT_CHANNEL,
  DISCONNECT_SSH_ENVIRONMENT_CHANNEL,
  FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL,
  BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
  FETCH_SSH_SESSION_STATE_CHANNEL,
  ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
  RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
] as const;

interface DesktopSshEnvironmentManagerOptions {
  readonly passwordProvider?: (
    request: SshPasswordRequest,
  ) => Effect.Effect<string | null, unknown>;
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: () => RemoteT3RunnerOptions;
}

export function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

type DesktopSshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService;

export interface DesktopSshEnvironmentManagerShape {
  readonly discoverHosts: (input?: {
    readonly homeDir?: string;
  }) => Effect.Effect<
    readonly DesktopDiscoveredSshHost[],
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<DesktopSshEnvironmentBootstrap, unknown, DesktopSshEnvironmentEffectContext>;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, unknown, DesktopSshEnvironmentEffectContext>;
}

function makeDesktopSshPasswordPrompt(
  passwordProvider: DesktopSshEnvironmentManagerOptions["passwordProvider"],
): SshPasswordPromptShape {
  return {
    isAvailable: passwordProvider !== undefined,
    request: (request) => {
      if (!passwordProvider) {
        return Effect.succeed(null);
      }

      return passwordProvider(request).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new SshPasswordPromptError({
              message: "SSH password prompt failed.",
              cause: Cause.squash(cause),
            }),
          ),
        ),
      );
    },
  };
}

const makeDesktopSshEnvironmentManager = Effect.fn("desktop.ssh.manager.make")(function* (
  options: DesktopSshEnvironmentManagerOptions = {},
) {
  const manager = yield* SshEnvironmentManager;
  const bridge = yield* DesktopSshEnvironmentBridge;
  const passwordPrompt = SshPasswordPrompt.of(
    makeDesktopSshPasswordPrompt(options.passwordProvider ?? bridge.passwordProvider),
  );
  const withPasswordPrompt = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, SshPasswordPrompt>> =>
    effect.pipe(Effect.provideService(SshPasswordPrompt, passwordPrompt));

  return DesktopSshEnvironmentManager.of({
    discoverHosts: discoverDesktopSshHostsEffect,
    ensureEnvironment: (target, ensureOptions) =>
      withPasswordPrompt(manager.ensureEnvironment(target, ensureOptions)),
    disconnectEnvironment: (target) => withPasswordPrompt(manager.disconnectEnvironment(target)),
  });
});

export class DesktopSshEnvironmentManager extends Context.Service<
  DesktopSshEnvironmentManager,
  DesktopSshEnvironmentManagerShape
>()("@t3tools/desktop/DesktopSshEnvironmentManager") {
  static readonly layer = (options: DesktopSshEnvironmentManagerOptions = {}) =>
    Layer.effect(DesktopSshEnvironmentManager, makeDesktopSshEnvironmentManager(options)).pipe(
      Layer.provide(
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
  readonly passwordPromptTimeoutMs?: number;
}

interface PendingSshPasswordPrompt {
  readonly deferred: Deferred.Deferred<string | null, Error>;
  readonly timeoutFiber: Fiber.Fiber<void, never>;
}

export function isSshPasswordPromptCancellation(error: unknown): error is SshPasswordPromptError {
  const message = error instanceof SshPasswordPromptError ? error.message.toLowerCase() : "";
  return (
    error instanceof SshPasswordPromptError &&
    (message.includes("cancelled") || message.includes("timed out"))
  );
}

export interface DesktopSshEnvironmentBridgeShape {
  readonly installPasswordPromptScope: (scope: Scope.Closeable) => Effect.Effect<void>;
  readonly passwordProvider: (request: SshPasswordRequest) => Effect.Effect<string | null, Error>;
  readonly registerIpcHandlers: (
    ipcMain: DesktopSshBridgeIpcMain,
  ) => Effect.Effect<
    void,
    never,
    Scope.Scope | DesktopSshEnvironmentManager | DesktopSshEnvironmentEffectContext
  >;
  readonly cancelPendingPasswordPromptsEffect: (reason: string) => Effect.Effect<void>;
  readonly disposeEffect: () => Effect.Effect<void>;
}

function clearDesktopSshIpcHandlers(ipcMain: DesktopSshBridgeIpcMain): void {
  for (const channel of SSH_HANDLED_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

/**
 * Wires the SSH environment manager to Electron IPC, owning the renderer-facing
 * password prompt state so `main.ts` only needs to register, cancel, and dispose.
 */
function makeDesktopSshEnvironmentBridge(
  options: DesktopSshEnvironmentBridgeOptions,
): DesktopSshEnvironmentBridgeShape {
  let passwordPromptScope: Option.Option<Scope.Closeable> = Option.none();
  const pendingPrompts = new Map<string, PendingSshPasswordPrompt>();
  const passwordPromptTimeoutMs =
    options.passwordPromptTimeoutMs ?? DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS;
  let disposed = false;

  const cancelPendingPasswordPromptsEffect = (reason: string): Effect.Effect<void> => {
    const prompts = Array.from(pendingPrompts);
    pendingPrompts.clear();
    return Effect.forEach(
      prompts,
      ([, pending]) =>
        Fiber.interrupt(pending.timeoutFiber).pipe(
          Effect.ignore,
          Effect.andThen(Deferred.fail(pending.deferred, new Error(reason))),
          Effect.asVoid,
        ),
      { discard: true },
    ).pipe(Effect.asVoid);
  };

  const resolvePasswordPromptEffect = (
    rawRequestId: unknown,
    rawPassword: unknown,
  ): Effect.Effect<void, Error> => {
    if (typeof rawRequestId !== "string" || rawRequestId.trim().length === 0) {
      return Effect.fail(new Error("Invalid SSH password prompt id."));
    }
    if (rawPassword !== null && typeof rawPassword !== "string") {
      return Effect.fail(new Error("Invalid SSH password prompt response."));
    }

    const pending = pendingPrompts.get(rawRequestId);
    if (!pending) {
      return Effect.fail(new Error("SSH password prompt expired. Try connecting again."));
    }

    pendingPrompts.delete(rawRequestId);
    return Fiber.interrupt(pending.timeoutFiber).pipe(
      Effect.ignore,
      Effect.andThen(Deferred.succeed(pending.deferred, rawPassword)),
      Effect.asVoid,
    );
  };

  const requestPasswordFromRendererEffect = (
    input: SshPasswordRequest,
  ): Effect.Effect<string | null, Error> => {
    const scope = Option.getOrUndefined(passwordPromptScope);
    if (scope === undefined) {
      return Effect.fail(new Error("SSH password prompt scope has not been initialized."));
    }

    return Effect.gen(function* () {
      const window = options.getMainWindow();
      if (!window || window.isDestroyed()) {
        return yield* Effect.fail(
          new Error("T3 Code window is not available for SSH authentication."),
        );
      }

      const requestId = yield* Random.nextUUIDv4;
      const now = yield* DateTime.now;
      const request: DesktopSshPasswordPromptRequest = {
        requestId,
        destination: input.destination,
        username: input.username,
        prompt: input.prompt,
        expiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: passwordPromptTimeoutMs })),
      };
      const deferred = yield* Deferred.make<string | null, Error>();
      const timeoutFiber = yield* Effect.sleep(Duration.millis(passwordPromptTimeoutMs)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            pendingPrompts.delete(request.requestId);
          }),
        ),
        Effect.andThen(
          Deferred.fail(
            deferred,
            new Error(`SSH authentication timed out for ${input.destination}.`),
          ),
        ),
        Effect.asVoid,
        Effect.forkIn(scope),
      );

      pendingPrompts.set(request.requestId, { deferred, timeoutFiber });

      yield* Effect.try({
        try: () => {
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
        },
        catch: (error) =>
          error instanceof Error
            ? error
            : new Error("T3 Code window is not available for SSH authentication."),
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(error).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                pendingPrompts.delete(request.requestId);
              }).pipe(Effect.andThen(Fiber.interrupt(timeoutFiber).pipe(Effect.ignore))),
            ),
          ),
        ),
      );

      return yield* Deferred.await(deferred).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pendingPrompts.delete(request.requestId);
          }).pipe(Effect.andThen(Fiber.interrupt(timeoutFiber).pipe(Effect.ignore))),
        ),
      );
    });
  };

  return {
    installPasswordPromptScope: (scope) =>
      Effect.sync(() => {
        passwordPromptScope = Option.some(scope);
      }),
    passwordProvider: requestPasswordFromRendererEffect,
    registerIpcHandlers: (ipcMain) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const context = yield* Effect.context<
            DesktopSshEnvironmentManager | DesktopSshEnvironmentEffectContext
          >();
          const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
            Effect.runPromiseWith(context as unknown as Context.Context<R>)(effect);

          yield* Effect.sync(() => {
            clearDesktopSshIpcHandlers(ipcMain);

            ipcMain.handle(DISCOVER_SSH_HOSTS_CHANNEL, () =>
              runEffect(
                Effect.gen(function* () {
                  const manager = yield* DesktopSshEnvironmentManager;
                  return yield* manager.discoverHosts();
                }),
              ),
            );

            ipcMain.handle(
              ENSURE_SSH_ENVIRONMENT_CHANNEL,
              async (_event, rawTarget, rawOptions) => {
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
                  return await runEffect(
                    Effect.gen(function* () {
                      const manager = yield* DesktopSshEnvironmentManager;
                      return yield* manager.ensureEnvironment(target, {
                        issuePairingToken,
                      });
                    }),
                  );
                } catch (error) {
                  if (isSshPasswordPromptCancellation(error)) {
                    return {
                      type: SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
                      message: error.message,
                    };
                  }
                  throw error;
                }
              },
            );

            ipcMain.handle(DISCONNECT_SSH_ENVIRONMENT_CHANNEL, async (_event, rawTarget) => {
              const target = getSafeDesktopSshTarget(rawTarget);
              if (!target) {
                throw new Error("Invalid desktop SSH target.");
              }

              await runEffect(
                Effect.gen(function* () {
                  const manager = yield* DesktopSshEnvironmentManager;
                  yield* manager.disconnectEnvironment(target);
                }),
              );
            });

            ipcMain.handle(
              FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL,
              async (_event, rawHttpBaseUrl) =>
                runEffect(
                  fetchLoopbackSshJson<ExecutionEnvironmentDescriptor>({
                    httpBaseUrl: rawHttpBaseUrl,
                    pathname: "/.well-known/t3/environment",
                  }),
                ),
            );

            ipcMain.handle(
              BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
              async (_event, rawHttpBaseUrl, rawCredential) =>
                runEffect(
                  fetchLoopbackSshJson<AuthBearerBootstrapResult>({
                    httpBaseUrl: rawHttpBaseUrl,
                    pathname: "/api/auth/bootstrap/bearer",
                    method: "POST",
                    body: { credential: rawCredential },
                  }),
                ),
            );

            ipcMain.handle(
              FETCH_SSH_SESSION_STATE_CHANNEL,
              async (_event, rawHttpBaseUrl, rawBearerToken) =>
                runEffect(
                  fetchLoopbackSshJson<AuthSessionState>({
                    httpBaseUrl: rawHttpBaseUrl,
                    pathname: "/api/auth/session",
                    bearerToken: rawBearerToken,
                  }),
                ),
            );

            ipcMain.handle(
              ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
              async (_event, rawHttpBaseUrl, rawBearerToken) =>
                runEffect(
                  fetchLoopbackSshJson<AuthWebSocketTokenResult>({
                    httpBaseUrl: rawHttpBaseUrl,
                    pathname: "/api/auth/ws-token",
                    method: "POST",
                    bearerToken: rawBearerToken,
                  }),
                ),
            );

            ipcMain.handle(
              RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
              async (_event, rawRequestId, rawPassword) => {
                await runEffect(resolvePasswordPromptEffect(rawRequestId, rawPassword));
              },
            );
          });
        }),
        () => Effect.sync(() => clearDesktopSshIpcHandlers(ipcMain)),
      ).pipe(Effect.asVoid),
    cancelPendingPasswordPromptsEffect,
    disposeEffect: () => {
      if (disposed) return Effect.void;
      disposed = true;
      const scope = passwordPromptScope;
      passwordPromptScope = Option.none();
      return cancelPendingPasswordPromptsEffect("SSH environment bridge disposed.").pipe(
        Effect.andThen(
          Option.match(scope, {
            onNone: () => Effect.void,
            onSome: (scope) => Scope.close(scope, Exit.void),
          }),
        ),
        Effect.ignore,
      );
    },
  };
}

export class DesktopSshEnvironmentBridge extends Context.Service<
  DesktopSshEnvironmentBridge,
  DesktopSshEnvironmentBridgeShape
>()("@t3tools/desktop/DesktopSshEnvironmentBridge") {
  static readonly layer = (options: DesktopSshEnvironmentBridgeOptions) =>
    Layer.succeed(
      DesktopSshEnvironmentBridge,
      DesktopSshEnvironmentBridge.of(makeDesktopSshEnvironmentBridge(options)),
    );
}
