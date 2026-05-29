import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  ServerConfig,
  ServerLifecycleWelcomePayload,
  TerminalEvent,
} from "@t3tools/contracts";
import type { KnownEnvironment } from "@t3tools/client-runtime";

import type { WsRpcClient } from "~/rpc/wsRpcClient";
import { recordResumeDiagnostic } from "./resumeDiagnostics";

export interface EnvironmentConnection {
  readonly kind: "primary" | "saved";
  readonly environmentId: EnvironmentId;
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly ensureBootstrapped: () => Promise<void>;
  readonly reconnect: (options?: EnvironmentReconnectOptions) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface EnvironmentReconnectOptions {
  readonly shellBootstrapTimeoutMs?: number;
  readonly reason?: string;
}

export class EnvironmentShellBootstrapTimeoutError extends Error {
  readonly environmentId: EnvironmentId;
  readonly timeoutMs: number;

  constructor(environmentId: EnvironmentId, timeoutMs: number) {
    super(
      `Environment ${environmentId} shell bootstrap timed out after ${timeoutMs.toString()}ms.`,
    );
    this.name = "EnvironmentShellBootstrapTimeoutError";
    this.environmentId = environmentId;
    this.timeoutMs = timeoutMs;
  }
}

export function isEnvironmentShellBootstrapTimeoutError(
  error: unknown,
): error is EnvironmentShellBootstrapTimeoutError {
  return error instanceof EnvironmentShellBootstrapTimeoutError;
}

interface OrchestrationHandlers {
  readonly applyShellEvent: (
    event: OrchestrationShellStreamEvent,
    environmentId: EnvironmentId,
  ) => void;
  readonly syncShellSnapshot: (
    snapshot: OrchestrationShellSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  readonly applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => void;
}

interface EnvironmentConnectionInput extends OrchestrationHandlers {
  readonly kind: "primary" | "saved";
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly refreshMetadata?: () => Promise<void>;
  readonly onConfigSnapshot?: (config: ServerConfig) => void;
  readonly onWelcome?: (payload: ServerLifecycleWelcomePayload) => void;
}

function createBootstrapGate() {
  let isOpen = false;
  const waiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }>();

  return {
    wait: () => {
      if (isOpen) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        waiters.add({ resolve, reject });
      });
    },
    resolve: () => {
      isOpen = true;
      const currentWaiters = [...waiters];
      waiters.clear();
      for (const waiter of currentWaiters) {
        waiter.resolve();
      }
    },
    reject: (error: unknown) => {
      isOpen = false;
      const currentWaiters = [...waiters];
      waiters.clear();
      for (const waiter of currentWaiters) {
        waiter.reject(error);
      }
    },
    reset: () => {
      isOpen = false;
    },
  };
}

function formatReconnectDiagnosticError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return new Promise<T>((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    timeoutId = setTimeout(() => {
      timeoutId = null;
      reject(createError());
    }, timeoutMs);

    promise.then(
      (value) => {
        clear();
        resolve(value);
      },
      (error) => {
        clear();
        reject(error);
      },
    );
  });
}

export function createEnvironmentConnection(
  input: EnvironmentConnectionInput,
): EnvironmentConnection {
  const environmentId = input.knownEnvironment.environmentId;

  if (!environmentId) {
    throw new Error(
      `Known environment ${input.knownEnvironment.label} is missing its environmentId.`,
    );
  }

  let disposed = false;
  const bootstrapGate = createBootstrapGate();
  const shouldObserveLifecycle = input.kind === "saved" || input.onWelcome !== undefined;
  const shouldObserveConfig = input.kind === "saved" || input.onConfigSnapshot !== undefined;

  const observeEnvironmentIdentity = (nextEnvironmentId: EnvironmentId, source: string) => {
    if (environmentId !== nextEnvironmentId) {
      throw new Error(
        `Environment connection ${environmentId} changed identity to ${nextEnvironmentId} via ${source}.`,
      );
    }
  };

  const unsubLifecycle = shouldObserveLifecycle
    ? input.client.server.subscribeLifecycle(
        (event: Parameters<Parameters<WsRpcClient["server"]["subscribeLifecycle"]>[0]>[0]) => {
          if (event.type !== "welcome") {
            return;
          }
          observeEnvironmentIdentity(
            event.payload.environment.environmentId,
            "server lifecycle welcome",
          );
          input.onWelcome?.(event.payload);
        },
      )
    : () => undefined;

  const unsubConfig = shouldObserveConfig
    ? input.client.server.subscribeConfig(
        (event: Parameters<Parameters<WsRpcClient["server"]["subscribeConfig"]>[0]>[0]) => {
          if (event.type !== "snapshot") {
            return;
          }
          observeEnvironmentIdentity(
            event.config.environment.environmentId,
            "server config snapshot",
          );
          input.onConfigSnapshot?.(event.config);
        },
      )
    : () => undefined;

  const unsubShell = input.client.orchestration.subscribeShell(
    (item: Parameters<Parameters<WsRpcClient["orchestration"]["subscribeShell"]>[0]>[0]) => {
      if (item.kind === "snapshot") {
        input.syncShellSnapshot(item.snapshot, environmentId);
        bootstrapGate.resolve();
        return;
      }
      input.applyShellEvent(item, environmentId);
    },
    {
      onResubscribe: () => {
        if (disposed) {
          return;
        }
        bootstrapGate.reset();
      },
    },
  );

  const unsubTerminalEvent = input.client.terminal.onEvent(
    (event: Parameters<Parameters<WsRpcClient["terminal"]["onEvent"]>[0]>[0]) => {
      input.applyTerminalEvent(event, environmentId);
    },
  );

  const cleanup = () => {
    disposed = true;
    unsubShell();
    unsubTerminalEvent();
    unsubLifecycle();
    unsubConfig();
  };

  return {
    kind: input.kind,
    environmentId,
    knownEnvironment: input.knownEnvironment,
    client: input.client,
    ensureBootstrapped: () => bootstrapGate.wait(),
    reconnect: async (options) => {
      const startedAt = Date.now();
      let phase:
        | "transport-reconnect"
        | "metadata-refresh"
        | "metadata-refresh:skipped"
        | "shell-bootstrap-wait" = "transport-reconnect";
      const recordPhaseStart = (nextPhase: typeof phase) => {
        phase = nextPhase;
        recordResumeDiagnostic("environment-reconnect-phase", {
          reason: `${nextPhase}:start`,
          env: environmentId,
          data: {
            phase: nextPhase,
            totalElapsedMs: Date.now() - startedAt,
          },
        });
        return Date.now();
      };
      const recordPhaseComplete = (completedPhase: typeof phase, phaseStartedAt: number) => {
        recordResumeDiagnostic("environment-reconnect-phase", {
          reason: `${completedPhase}:complete`,
          env: environmentId,
          data: {
            phase: completedPhase,
            elapsedMs: Date.now() - phaseStartedAt,
            totalElapsedMs: Date.now() - startedAt,
          },
        });
      };

      bootstrapGate.reset();
      try {
        let phaseStartedAt = recordPhaseStart("transport-reconnect");
        await input.client.reconnect();
        recordPhaseComplete("transport-reconnect", phaseStartedAt);

        if (input.refreshMetadata) {
          phaseStartedAt = recordPhaseStart("metadata-refresh");
          await input.refreshMetadata();
          recordPhaseComplete("metadata-refresh", phaseStartedAt);
        } else {
          phase = "metadata-refresh:skipped";
          recordResumeDiagnostic("environment-reconnect-phase", {
            reason: "metadata-refresh:skipped",
            env: environmentId,
            data: {
              phase,
              totalElapsedMs: Date.now() - startedAt,
            },
          });
        }

        phaseStartedAt = recordPhaseStart("shell-bootstrap-wait");
        const shellBootstrapTimeoutMs = options?.shellBootstrapTimeoutMs;
        const shellBootstrapWait =
          shellBootstrapTimeoutMs === undefined
            ? bootstrapGate.wait()
            : withTimeout(
                bootstrapGate.wait(),
                shellBootstrapTimeoutMs,
                () =>
                  new EnvironmentShellBootstrapTimeoutError(environmentId, shellBootstrapTimeoutMs),
              );
        await shellBootstrapWait;
        recordPhaseComplete("shell-bootstrap-wait", phaseStartedAt);
      } catch (error) {
        if (isEnvironmentShellBootstrapTimeoutError(error)) {
          recordResumeDiagnostic("environment-reconnect-phase", {
            reason: "shell-bootstrap-wait:timeout",
            env: environmentId,
            data: {
              phase: "shell-bootstrap-wait",
              totalElapsedMs: Date.now() - startedAt,
              timeoutMs: error.timeoutMs,
              reconnectReason: options?.reason ?? null,
            },
          });
        }
        recordResumeDiagnostic("environment-reconnect-phase", {
          reason: `${phase}:error`,
          env: environmentId,
          data: {
            phase,
            totalElapsedMs: Date.now() - startedAt,
            error: formatReconnectDiagnosticError(error),
          },
        });
        bootstrapGate.reject(error);
        throw error;
      }
    },
    dispose: async () => {
      cleanup();
      await input.client.dispose();
    },
  };
}
