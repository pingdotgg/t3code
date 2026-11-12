import type { SharePayload } from "expo-sharing";

import { SerializedAsyncQueue } from "../../lib/serialized-async-queue";
import {
  hasIncomingShareContent,
  type IncomingShareDestination,
  type IncomingShareDraft,
} from "./incoming-share-model";

export interface IncomingShareInboxDependencies {
  readonly loadDrafts: () => Promise<ReadonlyArray<IncomingShareDraft>>;
  readonly writeDraft: (draft: IncomingShareDraft) => Promise<void>;
  readonly removeDraft: (shareId: string) => Promise<void>;
  readonly getPayloads: () => ReadonlyArray<SharePayload>;
  readonly clearPayloads: () => void;
  readonly buildDraft: (input: {
    readonly payloads: ReadonlyArray<SharePayload>;
    readonly id: string;
    readonly createdAt: string;
  }) => Promise<{
    readonly draft: IncomingShareDraft;
    readonly cleanup: () => Promise<void>;
    readonly rollback?: () => Promise<void>;
  }>;
  readonly cleanupReplayedPayloads?: (payloads: ReadonlyArray<SharePayload>) => Promise<void>;
  readonly idForPayloads: (payloads: ReadonlyArray<SharePayload>) => Promise<string>;
  readonly now: () => string;
  readonly onClearError?: (error: unknown) => void;
  readonly onCleanupError?: (error: unknown) => void;
}

function sortAndDedupeIncomingShares(
  drafts: ReadonlyArray<IncomingShareDraft>,
): ReadonlyArray<IncomingShareDraft> {
  const ids = new Set<string>();
  return [...drafts]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .filter((draft) => {
      if (ids.has(draft.id)) {
        return false;
      }
      ids.add(draft.id);
      return true;
    });
}

/** Serialization prevents stale loads or refreshes from restoring consumed items. */
export class IncomingShareInbox {
  private readonly operations = new SerializedAsyncQueue();

  constructor(private readonly dependencies: IncomingShareInboxDependencies) {}

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.operations.run(operation);
  }

  private clearNativePayloads(): void {
    try {
      this.dependencies.clearPayloads();
    } catch (error) {
      this.dependencies.onClearError?.(error);
    }
  }

  private async cleanup(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.dependencies.onCleanupError?.(error);
    }
  }

  refresh(options: { readonly ingestNative: boolean }): Promise<ReadonlyArray<IncomingShareDraft>> {
    return this.runExclusive(async () => {
      const loaded = await this.dependencies.loadDrafts();
      const persisted = sortAndDedupeIncomingShares(loaded);
      if (!options.ingestNative) {
        return persisted;
      }

      const payloads = this.dependencies.getPayloads();
      if (payloads.length === 0) {
        return persisted;
      }

      // Payload-derived ids reuse the inbox item after a crash between durable write and native acknowledgement.
      const shareId = await this.dependencies.idForPayloads(payloads);
      if (loaded.some((draft) => draft.id === shareId)) {
        if (this.dependencies.cleanupReplayedPayloads) {
          await this.cleanup(() => this.dependencies.cleanupReplayedPayloads!(payloads));
        }
        this.clearNativePayloads();
        return persisted;
      }

      const built = await this.dependencies.buildDraft({
        payloads,
        id: shareId,
        createdAt: this.dependencies.now(),
      });
      const { draft } = built;
      if (!hasIncomingShareContent(draft)) {
        await this.cleanup(built.cleanup);
        this.clearNativePayloads();
        throw new Error(
          draft.warnings[0] ?? "The shared content is not supported by the composer.",
        );
      }

      // Persist before clearing the native handoff so termination always leaves a recoverable copy.
      try {
        await this.dependencies.writeDraft(draft);
      } catch (error) {
        if (built.rollback) {
          await this.cleanup(built.rollback);
        }
        throw error;
      }
      await this.cleanup(built.cleanup);
      this.clearNativePayloads();
      return sortAndDedupeIncomingShares([draft, ...persisted]);
    });
  }

  consume(shareId: string): Promise<ReadonlyArray<IncomingShareDraft>> {
    return this.runExclusive(async () => {
      // Identical content can be shared intentionally; only stable payload-derived ids identify retries.
      await this.dependencies.removeDraft(shareId);
      return sortAndDedupeIncomingShares(await this.dependencies.loadDrafts());
    });
  }

  reserve(
    shareId: string,
    destination: IncomingShareDestination,
  ): Promise<ReadonlyArray<IncomingShareDraft>> {
    return this.runExclusive(async () => {
      const persisted = await this.dependencies.loadDrafts();
      const target = persisted.find((draft) => draft.id === shareId);
      if (!target) {
        throw new Error("The shared content is no longer available.");
      }
      if (target.destination) {
        if (
          target.destination.environmentId !== destination.environmentId ||
          target.destination.projectId !== destination.projectId
        ) {
          throw new Error("The shared content is already reserved for another project draft.");
        }
        return sortAndDedupeIncomingShares(persisted);
      }

      const reserved = { ...target, destination };
      await this.dependencies.writeDraft(reserved);
      return sortAndDedupeIncomingShares(
        persisted.map((draft) => (draft.id === shareId ? reserved : draft)),
      );
    });
  }

  releaseReservation(
    shareId: string,
    expectedDestination: IncomingShareDestination,
  ): Promise<ReadonlyArray<IncomingShareDraft>> {
    return this.runExclusive(async () => {
      const persisted = await this.dependencies.loadDrafts();
      const target = persisted.find((draft) => draft.id === shareId);
      if (!target) {
        return sortAndDedupeIncomingShares(persisted);
      }
      if (!target.destination) {
        return sortAndDedupeIncomingShares(persisted);
      }
      if (
        target.destination.environmentId !== expectedDestination.environmentId ||
        target.destination.projectId !== expectedDestination.projectId
      ) {
        throw new Error("The shared content reservation changed before it could be released.");
      }

      const { destination: _destination, ...unreserved } = target;
      await this.dependencies.writeDraft(unreserved);
      return sortAndDedupeIncomingShares(
        persisted.map((draft) => (draft.id === shareId ? unreserved : draft)),
      );
    });
  }
}
