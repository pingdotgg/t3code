import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  ServerConfig,
  ServerLifecycleWelcomePayload,
  SidebarStateSnapshot,
  PinnedThreadKeysByProjectKey,
  TerminalEvent,
} from "@t3tools/contracts";
import type { KnownEnvironment } from "@t3tools/client-runtime";

import type { WsRpcClient } from "~/rpc/wsRpcClient";
import { registerSidebarStateClient } from "~/sidebarStateSync";

export interface EnvironmentConnection {
  readonly kind: "primary" | "saved";
  readonly environmentId: EnvironmentId;
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly ensureBootstrapped: () => Promise<void>;
  readonly refreshShellSnapshot: () => Promise<void>;
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
  readonly applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => void;
  readonly applySidebarStateSnapshot: (
    snapshot: SidebarStateSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  readonly readLegacyPinnedThreads: (environmentId: EnvironmentId) => PinnedThreadKeysByProjectKey;
  readonly markLegacySidebarPinsMigrated: (environmentId: EnvironmentId) => void;
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
  let resolve: (() => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  let promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    wait: () => promise,
    resolve: () => {
      resolve?.();
      resolve = null;
      reject = null;
    },
    reject: (error: unknown) => {
      void promise.catch(() => undefined);
      reject?.(error);
      resolve = null;
      reject = null;
    },
    reset: () => {
      promise = new Promise<void>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
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
  let clientDisposed = false;
  let fatalError: Error | null = null;
  let latestShellStreamSequence: number | null = null;
  const bootstrapGate = createBootstrapGate();
  const unsubscribers: Array<() => void> = [];
  if (input.kind === "primary") {
    const sidebarStateRegistration = registerSidebarStateClient({
      environmentId,
      getState: input.client.sidebar.getState,
      updateState: input.client.sidebar.updateState,
      applySnapshot: (snapshot) => input.applySidebarStateSnapshot(snapshot, environmentId),
      readLegacyPins: () => input.readLegacyPinnedThreads(environmentId),
      markLegacyPinsMigrated: () => input.markLegacySidebarPinsMigrated(environmentId),
    });
    unsubscribers.push(sidebarStateRegistration.dispose);

    const unsubSidebarState = input.client.sidebar.onState(sidebarStateRegistration.handleSnapshot);
    unsubscribers.push(unsubSidebarState);
  }

  const cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const unsubscribe of unsubscribers.toReversed()) {
      unsubscribe();
    }
    unsubscribers.length = 0;
  };

  const failConnection = (error: Error) => {
    if (disposed) {
      return;
    }
    fatalError = error;
    bootstrapGate.reject(error);
    cleanup();
    clientDisposed = true;
    void input.client.dispose();
  };

  const observeEnvironmentIdentity = (
    nextEnvironmentId: EnvironmentId,
    source: string,
  ): boolean => {
    if (environmentId !== nextEnvironmentId) {
      failConnection(
        new Error(
          `Environment connection ${environmentId} changed identity to ${nextEnvironmentId} via ${source}.`,
        ),
      );
      return false;
    }
    return true;
  };

  const unsubLifecycle = input.client.server.subscribeLifecycle(
    (event: Parameters<Parameters<WsRpcClient["server"]["subscribeLifecycle"]>[0]>[0]) => {
      if (event.type !== "welcome") {
        return;
      }
      if (
        !observeEnvironmentIdentity(
          event.payload.environment.environmentId,
          "server lifecycle welcome",
        )
      ) {
        return;
      }
      input.onWelcome?.(event.payload);
    },
  );
  unsubscribers.push(unsubLifecycle);

  const unsubConfig = input.client.server.subscribeConfig(
    (event: Parameters<Parameters<WsRpcClient["server"]["subscribeConfig"]>[0]>[0]) => {
      if (event.type !== "snapshot") {
        return;
      }
      if (
        !observeEnvironmentIdentity(
          event.config.environment.environmentId,
          "server config snapshot",
        )
      ) {
        return;
      }
      input.onConfigSnapshot?.(event.config);
    },
  );
  unsubscribers.push(unsubConfig);

  const unsubShell = input.client.orchestration.subscribeShell(
    (item: Parameters<Parameters<WsRpcClient["orchestration"]["subscribeShell"]>[0]>[0]) => {
      if (item.kind === "snapshot") {
        latestShellStreamSequence = item.snapshot.snapshotSequence;
        input.syncShellSnapshot(item.snapshot, environmentId);
        bootstrapGate.resolve();
        return;
      }
      latestShellStreamSequence =
        latestShellStreamSequence === null
          ? item.sequence
          : Math.max(latestShellStreamSequence, item.sequence);
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
  unsubscribers.push(unsubShell);

  const unsubTerminalEvent = input.client.terminal.onEvent(
    (event: Parameters<Parameters<WsRpcClient["terminal"]["onEvent"]>[0]>[0]) => {
      input.applyTerminalEvent(event, environmentId);
    },
  );
  unsubscribers.push(unsubTerminalEvent);

  return {
    kind: input.kind,
    environmentId,
    knownEnvironment: input.knownEnvironment,
    client: input.client,
    ensureBootstrapped: () => (fatalError ? Promise.reject(fatalError) : bootstrapGate.wait()),
    refreshShellSnapshot: async () => {
      if (fatalError) {
        throw fatalError;
      }
      if (disposed) {
        throw new Error(`Environment connection ${environmentId} is disposed.`);
      }
      const snapshot = await input.client.orchestration.getShellSnapshot();
      if (
        latestShellStreamSequence !== null &&
        snapshot.snapshotSequence < latestShellStreamSequence
      ) {
        return;
      }
      input.syncShellSnapshot(snapshot, environmentId);
    },
    reconnect: async () => {
      if (fatalError) {
        throw fatalError;
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
      if (!clientDisposed) {
        clientDisposed = true;
        await input.client.dispose();
      }
    },
  };
}
