import type {
  EnvironmentId,
  OrchestrationEvent,
  OrchestrationReadModel,
  ServerConfig,
  ServerLifecycleWelcomePayload,
  TerminalEvent,
} from "@t3tools/contracts";
import type { KnownEnvironment } from "@t3tools/client-runtime";

import {
  deriveReplayRetryDecision,
  type OrchestrationRecoveryReason,
} from "../../orchestrationRecovery";
import {
  createOrchestrationRecoveryCoordinator,
  type ReplayRetryTracker,
} from "../../orchestrationRecovery";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

const REPLAY_RECOVERY_RETRY_DELAY_MS = 100;
const MAX_NO_PROGRESS_REPLAY_RETRIES = 3;

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
  readonly applyEventBatch: (
    events: ReadonlyArray<OrchestrationEvent>,
    environmentId: EnvironmentId,
  ) => void;
  readonly syncSnapshot: (snapshot: OrchestrationReadModel, environmentId: EnvironmentId) => void;
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

function createSnapshotBootstrapController(input: {
  readonly isBootstrapped: () => boolean;
  readonly runSnapshotRecovery: (
    reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
  ) => Promise<void>;
}) {
  let inFlight: Promise<void> | null = null;

  return {
    ensureSnapshotRecovery(
      reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
    ): Promise<void> {
      if (input.isBootstrapped()) {
        return Promise.resolve();
      }

      if (inFlight !== null) {
        return inFlight;
      }

      const nextInFlight = input.runSnapshotRecovery(reason).finally(() => {
        if (inFlight === nextInFlight) {
          inFlight = null;
        }
      });
      inFlight = nextInFlight;
      return inFlight;
    },
  };
}

export function createEnvironmentConnection(
  input: EnvironmentConnectionInput,
): EnvironmentConnection {
  const recovery = createOrchestrationRecoveryCoordinator();
  let replayRetryTracker: ReplayRetryTracker | null = null;
  const pendingDomainEvents: OrchestrationEvent[] = [];
  let flushPendingDomainEventsScheduled = false;
  const environmentId = input.knownEnvironment.environmentId;

  if (!environmentId) {
    throw new Error(
      `Known environment ${input.knownEnvironment.label} is missing its environmentId.`,
    );
  }

  let disposed = false;

  const observeEnvironmentIdentity = (nextEnvironmentId: EnvironmentId, source: string) => {
    if (environmentId !== nextEnvironmentId) {
      throw new Error(
        `Environment connection ${environmentId} changed identity to ${nextEnvironmentId} via ${source}.`,
      );
    }
  };

  const flushPendingDomainEvents = () => {
    flushPendingDomainEventsScheduled = false;
    if (disposed || pendingDomainEvents.length === 0) {
      return;
    }

    const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
    const nextEvents = recovery.markEventBatchApplied(events);
    if (nextEvents.length === 0) {
      return;
    }
    input.applyEventBatch(nextEvents, environmentId);
  };

  const schedulePendingDomainEventFlush = () => {
    if (flushPendingDomainEventsScheduled) {
      return;
    }

    flushPendingDomainEventsScheduled = true;
    queueMicrotask(flushPendingDomainEvents);
  };

  const runReplayRecovery = async (reason: "sequence-gap" | "resubscribe"): Promise<void> => {
    if (!recovery.beginReplayRecovery(reason)) {
      return;
    }

    const fromSequenceExclusive = recovery.getState().latestSequence;
    try {
      const events = await input.client.orchestration.replayEvents({ fromSequenceExclusive });
      if (!disposed) {
        const nextEvents = recovery.markEventBatchApplied(events);
        if (nextEvents.length > 0) {
          input.applyEventBatch(nextEvents, environmentId);
        }
      }
    } catch {
      replayRetryTracker = null;
      recovery.failReplayRecovery();
      await snapshotBootstrap.ensureSnapshotRecovery("replay-failed");
      return;
    }

    if (disposed) {
      return;
    }

    const replayCompletion = recovery.completeReplayRecovery();
    const retryDecision = deriveReplayRetryDecision({
      previousTracker: replayRetryTracker,
      completion: replayCompletion,
      recoveryState: recovery.getState(),
      baseDelayMs: REPLAY_RECOVERY_RETRY_DELAY_MS,
      maxNoProgressRetries: MAX_NO_PROGRESS_REPLAY_RETRIES,
    });
    replayRetryTracker = retryDecision.tracker;

    if (retryDecision.shouldRetry) {
      if (retryDecision.delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, retryDecision.delayMs);
        });
        if (disposed) {
          return;
        }
      }
      void runReplayRecovery(reason);
    } else if (replayCompletion.shouldReplay && import.meta.env.MODE !== "test") {
      console.warn(
        "[orchestration-recovery]",
        "Stopping replay recovery after no-progress retries.",
        {
          environmentId,
          state: recovery.getState(),
        },
      );
    }
  };

  const runSnapshotRecovery = async (
    reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
  ): Promise<void> => {
    const started = recovery.beginSnapshotRecovery(reason);
    if (!started) {
      return;
    }

    try {
      const snapshot = await input.client.orchestration.getSnapshot();
      if (!disposed) {
        input.syncSnapshot(snapshot, environmentId);
        if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
          void runReplayRecovery("sequence-gap");
        }
      }
    } catch (error) {
      recovery.failSnapshotRecovery();
      throw error;
    }
  };

  const snapshotBootstrap = createSnapshotBootstrapController({
    isBootstrapped: () => recovery.getState().bootstrapped,
    runSnapshotRecovery,
  });

  const unsubLifecycle = input.client.server.subscribeLifecycle(
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
  );

  const unsubConfig = input.client.server.subscribeConfig(
    (event: Parameters<Parameters<WsRpcClient["server"]["subscribeConfig"]>[0]>[0]) => {
      if (event.type !== "snapshot") {
        return;
      }
      observeEnvironmentIdentity(event.config.environment.environmentId, "server config snapshot");
      input.onConfigSnapshot?.(event.config);
    },
  );

  const unsubDomainEvent = input.client.orchestration.onDomainEvent(
    (event: Parameters<Parameters<WsRpcClient["orchestration"]["onDomainEvent"]>[0]>[0]) => {
      const action = recovery.classifyDomainEvent(event.sequence);
      if (action === "apply") {
        pendingDomainEvents.push(event);
        schedulePendingDomainEventFlush();
        return;
      }
      if (action === "recover") {
        flushPendingDomainEvents();
        void runReplayRecovery("sequence-gap");
      }
    },
    {
      onResubscribe: () => {
        if (disposed) {
          return;
        }
        flushPendingDomainEvents();
        void runReplayRecovery("resubscribe");
      },
    },
  );

  const unsubTerminalEvent = input.client.terminal.onEvent(
    (event: Parameters<Parameters<WsRpcClient["terminal"]["onEvent"]>[0]>[0]) => {
      input.applyTerminalEvent(event, environmentId);
    },
  );

  void snapshotBootstrap.ensureSnapshotRecovery("bootstrap").catch(() => undefined);

  const cleanup = () => {
    disposed = true;
    flushPendingDomainEventsScheduled = false;
    pendingDomainEvents.length = 0;
    unsubDomainEvent();
    unsubTerminalEvent();
    unsubLifecycle();
    unsubConfig();
  };

  return {
    kind: input.kind,
    environmentId,
    knownEnvironment: input.knownEnvironment,
    client: input.client,
    ensureBootstrapped: () => snapshotBootstrap.ensureSnapshotRecovery("bootstrap"),
    reconnect: async () => {
      await input.client.reconnect();
      await input.refreshMetadata?.();
      await snapshotBootstrap.ensureSnapshotRecovery("bootstrap");
    },
    dispose: async () => {
      cleanup();
      await input.client.dispose();
    },
  };
}
