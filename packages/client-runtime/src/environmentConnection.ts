import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  ServerConfig,
  ServerLifecycleWelcomePayload,
  TerminalEvent,
} from "@t3tools/contracts";

import type { KnownEnvironment } from "./knownEnvironment.ts";
import type { WsRpcClient } from "./wsRpcClient.ts";

export interface EnvironmentConnection {
  readonly kind: "primary" | "saved";
  readonly environmentId: EnvironmentId;
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly ensureBootstrapped: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly dispose: () => Promise<void>;
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
  readonly applyTerminalEvent?: (event: TerminalEvent, environmentId: EnvironmentId) => void;
}

export interface EnvironmentConnectionInput extends OrchestrationHandlers {
  readonly kind: "primary" | "saved";
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly refreshMetadata?: () => Promise<void>;
  readonly onConfigSnapshot?: (config: ServerConfig) => void;
  readonly onWelcome?: (payload: ServerLifecycleWelcomePayload) => void;
  readonly onShellResubscribe?: (environmentId: EnvironmentId) => void;
}

export interface EnvironmentConnectionAttempt {
  readonly environmentId: EnvironmentId;
  readonly isCurrent: () => boolean;
}

export class EnvironmentConnectionAttemptCancelledError extends Error {
  constructor(environmentId: EnvironmentId) {
    super(`Environment connection attempt ${environmentId} was cancelled.`);
    this.name = "EnvironmentConnectionAttemptCancelledError";
  }
}

export function createEnvironmentConnectionAttemptRegistry() {
  const attempts = new Map<EnvironmentId, symbol>();

  return {
    begin: (environmentId: EnvironmentId): EnvironmentConnectionAttempt => {
      const id = Symbol(environmentId);
      attempts.set(environmentId, id);
      return {
        environmentId,
        isCurrent: () => attempts.get(environmentId) === id,
      };
    },
    cancel: (environmentId: EnvironmentId): void => {
      attempts.delete(environmentId);
    },
    clear: (): void => {
      attempts.clear();
    },
  };
}

export class EnvironmentConnectionDisposedError extends Error {
  constructor(environmentId: EnvironmentId) {
    super(`Environment connection ${environmentId} was disposed before it finished bootstrapping.`);
    this.name = "EnvironmentConnectionDisposedError";
  }
}

function createBootstrapGate() {
  let resolve: (() => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  const makePromise = () => {
    const nextPromise = new Promise<void>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    void nextPromise.catch(() => undefined);
    return nextPromise;
  };
  let promise = makePromise();

  return {
    wait: () => promise,
    resolve: () => {
      resolve?.();
      resolve = null;
      reject = null;
    },
    reject: (error: unknown) => {
      reject?.(error);
      resolve = null;
      reject = null;
    },
    reset: () => {
      promise = makePromise();
    },
  };
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
    ? input.client.server.subscribeLifecycle((event) => {
        if (disposed || event.type !== "welcome") {
          return;
        }

        observeEnvironmentIdentity(
          event.payload.environment.environmentId,
          "server lifecycle welcome",
        );
        input.onWelcome?.(event.payload);
      })
    : () => undefined;

  const unsubConfig = shouldObserveConfig
    ? input.client.server.subscribeConfig((event) => {
        if (disposed || event.type !== "snapshot") {
          return;
        }

        observeEnvironmentIdentity(
          event.config.environment.environmentId,
          "server config snapshot",
        );
        input.onConfigSnapshot?.(event.config);
      })
    : () => undefined;

  const unsubShell = input.client.orchestration.subscribeShell(
    (item) => {
      if (disposed) {
        return;
      }

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
        input.onShellResubscribe?.(environmentId);
      },
    },
  );

  const unsubTerminalEvent = input.applyTerminalEvent
    ? input.client.terminal.onEvent((event) => {
        if (!disposed) {
          input.applyTerminalEvent?.(event, environmentId);
        }
      })
    : () => undefined;

  const cleanup = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    bootstrapGate.reject(new EnvironmentConnectionDisposedError(environmentId));
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
    ensureBootstrapped: () =>
      disposed
        ? Promise.reject(new EnvironmentConnectionDisposedError(environmentId))
        : bootstrapGate.wait(),
    reconnect: async () => {
      if (disposed) {
        throw new EnvironmentConnectionDisposedError(environmentId);
      }

      bootstrapGate.reset();
      try {
        await input.client.reconnect();
        await input.refreshMetadata?.();
        await bootstrapGate.wait();
      } catch (error) {
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
