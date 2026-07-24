import {
  type EnvironmentId,
  type PinnedThreadKeysByProjectKey,
  type SidebarStateMutation,
  type SidebarStateSnapshot,
} from "@t3tools/contracts";
import { isTransportConnectionErrorMessage } from "./rpc/transportError";

interface SidebarStateClient {
  readonly getState: () => Promise<SidebarStateSnapshot>;
  readonly updateState: (mutation: SidebarStateMutation) => Promise<SidebarStateSnapshot>;
  readonly applySnapshot: (snapshot: SidebarStateSnapshot) => void;
  readonly readLegacyPins: () => PinnedThreadKeysByProjectKey;
  readonly markLegacyPinsMigrated: () => void;
  pendingMutations: number;
  mutationTail: Promise<void>;
  migrationStarted: boolean;
  latestSnapshot: SidebarStateSnapshot | null;
  snapshotGeneration: number;
  retryReady: boolean;
  transportUnavailable: boolean;
}

let primaryClient: {
  readonly environmentId: EnvironmentId;
  readonly client: SidebarStateClient;
} | null = null;
const pendingRegistrationMutations: Array<{
  readonly mutation: SidebarStateMutation;
  readonly onSuccess?: () => void;
}> = [];

function reportSyncFailure(error: unknown): void {
  console.error("Failed to synchronize sidebar pins.", error);
}

function isTransportFailure(error: unknown): boolean {
  return isTransportConnectionErrorMessage(
    error instanceof Error && error.message.trim().length > 0 ? error.message : String(error),
  );
}

function rememberSnapshot(client: SidebarStateClient, snapshot: SidebarStateSnapshot): void {
  if (client.latestSnapshot === null || snapshot.revision >= client.latestSnapshot.revision) {
    client.latestSnapshot = snapshot;
  }
}

function isActiveClient(client: SidebarStateClient): boolean {
  return primaryClient?.client === client;
}

function queuePendingMutation(mutation: SidebarStateMutation, onSuccess?: () => void): void {
  pendingRegistrationMutations.push({
    mutation,
    ...(onSuccess ? { onSuccess } : {}),
  });
}

function flushPendingMutations(): void {
  if (!primaryClient) {
    return;
  }
  for (const pending of pendingRegistrationMutations.splice(0)) {
    enqueueMutation(pending.mutation, pending.onSuccess);
  }
}

function resumeRetryQueueIfReady(client: SidebarStateClient): void {
  if (!isActiveClient(client) || !client.retryReady || client.pendingMutations > 0) {
    return;
  }
  client.retryReady = false;
  client.transportUnavailable = false;
  flushPendingMutations();
}

function enqueueMutation(mutation: SidebarStateMutation, onSuccess?: () => void): void {
  if (!primaryClient) {
    queuePendingMutation(mutation, onSuccess);
    return;
  }
  const { client } = primaryClient;

  client.pendingMutations += 1;
  client.mutationTail = client.mutationTail
    .catch(() => undefined)
    .then(async () => {
      if (client.transportUnavailable) {
        client.pendingMutations -= 1;
        queuePendingMutation(mutation, onSuccess);
        if (primaryClient && primaryClient.client !== client) {
          flushPendingMutations();
        } else {
          resumeRetryQueueIfReady(client);
        }
        return;
      }
      const snapshotGenerationAtStart = client.snapshotGeneration;
      try {
        const snapshot = await client.updateState(mutation);
        onSuccess?.();
        rememberSnapshot(client, snapshot);
        client.pendingMutations -= 1;
        if (isActiveClient(client) && client.pendingMutations === 0 && client.latestSnapshot) {
          client.applySnapshot(client.latestSnapshot);
        }
      } catch (error) {
        client.pendingMutations -= 1;
        reportSyncFailure(error);
        if (isTransportFailure(error)) {
          client.transportUnavailable = true;
          client.retryReady ||= client.snapshotGeneration > snapshotGenerationAtStart;
          queuePendingMutation(mutation, onSuccess);
          if (primaryClient && primaryClient.client !== client) {
            flushPendingMutations();
          } else {
            resumeRetryQueueIfReady(client);
          }
          return;
        }
        if (isActiveClient(client) && client.pendingMutations === 0) {
          try {
            const snapshot = await client.getState();
            if (!isActiveClient(client)) {
              return;
            }
            rememberSnapshot(client, snapshot);
            client.applySnapshot(snapshot);
          } catch (refreshError) {
            reportSyncFailure(refreshError);
          }
        }
      }
    });
}

export function dispatchSetThreadPinned(
  projectKey: string,
  threadKey: string,
  pinned: boolean,
): void {
  enqueueMutation({
    mutationId: globalThis.crypto.randomUUID(),
    type: "set-pinned",
    projectKey,
    threadKey,
    pinned,
  });
}

export function dispatchReorderPinnedThreads(
  projectKey: string,
  draggedThreadKey: string,
  targetThreadKey: string,
): void {
  enqueueMutation({
    mutationId: globalThis.crypto.randomUUID(),
    type: "reorder-pinned",
    projectKey,
    draggedThreadKey,
    targetThreadKey,
  });
}

export function registerSidebarStateClient(input: {
  readonly environmentId: EnvironmentId;
  readonly getState: () => Promise<SidebarStateSnapshot>;
  readonly updateState: (mutation: SidebarStateMutation) => Promise<SidebarStateSnapshot>;
  readonly applySnapshot: (snapshot: SidebarStateSnapshot) => void;
  readonly readLegacyPins: () => PinnedThreadKeysByProjectKey;
  readonly markLegacyPinsMigrated: () => void;
}): {
  readonly handleSnapshot: (snapshot: SidebarStateSnapshot) => void;
  readonly dispose: () => void;
} {
  const client: SidebarStateClient = {
    ...input,
    pendingMutations: 0,
    mutationTail: Promise.resolve(),
    migrationStarted: false,
    latestSnapshot: null,
    snapshotGeneration: 0,
    retryReady: false,
    transportUnavailable: false,
  };
  primaryClient = { environmentId: input.environmentId, client };
  flushPendingMutations();

  return {
    handleSnapshot: (snapshot) => {
      client.snapshotGeneration += 1;
      rememberSnapshot(client, snapshot);
      if (client.transportUnavailable) {
        client.retryReady = true;
        resumeRetryQueueIfReady(client);
      }
      if (!client.migrationStarted) {
        client.migrationStarted = true;
        const legacyPins = client.readLegacyPins();
        if (Object.keys(legacyPins).length > 0) {
          enqueueMutation(
            {
              mutationId: globalThis.crypto.randomUUID(),
              type: "import-pins",
              pinnedThreadKeysByProjectKey: legacyPins,
            },
            client.markLegacyPinsMigrated,
          );
          return;
        }
        client.markLegacyPinsMigrated();
      }
      if (!client.transportUnavailable) {
        flushPendingMutations();
      }
      if (client.pendingMutations === 0 && client.latestSnapshot) {
        client.applySnapshot(client.latestSnapshot);
      }
    },
    dispose: () => {
      if (primaryClient?.client === client) {
        primaryClient = null;
      }
    },
  };
}
