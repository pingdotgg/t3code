import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PreparedTurnAttachments } from "../lib/attachmentUpload";

const harness = vi.hoisted(() => ({
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  removePersistedFile: vi.fn(async () => undefined),
  removeOutboxMessage: vi.fn(async (_message: QueuedThreadMessage) => undefined),
  prepareTurnAttachments: vi.fn<typeof import("../lib/attachmentUpload").prepareTurnAttachments>(),
  setPendingConnectionError: vi.fn(),
  draftFile: (() => {
    let document = "";
    let writeError: Error | null = null;
    return {
      setDocument(value: unknown) {
        document = JSON.stringify(value);
      },
      setWriteError(error: Error | null) {
        writeError = error;
      },
      Directory: class {
        create() {}
      },
      File: class {
        exists = true;
        parentDirectory = null;

        create() {}

        moveSync() {}

        async text() {
          return document;
        }

        write(value: string) {
          if (writeError) {
            throw writeError;
          }
          document = value;
        }
      },
    };
  })(),
}));

vi.mock("expo-file-system", () => ({
  Directory: harness.draftFile.Directory,
  File: harness.draftFile.File,
  Paths: { document: "/documents" },
}));

vi.mock("../lib/composerImages", () => ({
  removePersistedComposerAttachmentFile: harness.removePersistedFile,
  toUploadChatImageAttachments: () => [],
}));

vi.mock("../lib/uuid", () => ({
  uuidv4: () => "00000000-0000-4000-8000-000000000000",
  randomHex: () => "abcd",
}));

vi.mock("../lib/attachmentUpload", () => ({
  prepareTurnAttachments: harness.prepareTurnAttachments,
}));

vi.mock("./entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  useThreadShells: () => [],
}));

vi.mock("./threads", () => ({
  threadEnvironment: {},
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make<Record<string, boolean>>({}).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () => ({}),
    useThreadOutboxShellStatuses: () => new Map(),
  };
});

vi.mock("./use-remote-environment-registry", () => ({
  setPendingConnectionError: harness.setPendingConnectionError,
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));

vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  harness.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => [],
      write: async () => undefined,
      remove: (message) => harness.removeOutboxMessage(message),
    },
  });
  const manager = harness.manager;
  return {
    threadOutboxManager: manager,
    flushThreadOutbox: async () => undefined,
    ensureThreadOutboxLoaded: () => undefined,
    confirmThreadOutboxMessageQueued: (message: never) => manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: never, expectedRevision?: number) =>
      manager.update(message, expectedRevision),
    threadOutboxRevision: (messageId: never) => manager.revisionOf(messageId),
  };
});

import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import * as composerDrafts from "./use-composer-drafts";
import { editingQueuedMessageIdsAtom } from "./use-thread-outbox";
import {
  completeQueuedMessageDelivery,
  prepareQueuedMessageAttachments,
  recoverEditedCreationAfterDelivery,
  removeAcknowledgedExistingThreadMessage,
  restoreRejectedQueuedMessage,
} from "./use-thread-outbox-drain";

function queuedMessage(input: {
  readonly messageId: string;
  readonly text: string;
  readonly fileUri?: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.text,
    attachments: input.fileUri
      ? [
          {
            id: `file-${input.messageId}`,
            type: "file",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            fileUri: input.fileUri,
          },
        ]
      : [],
    createdAt: "2026-08-24T12:00:00.000Z",
  };
}

function withReusedFileUpload(
  message: QueuedThreadMessage,
  attachmentId: string,
): QueuedThreadMessage {
  return {
    ...message,
    attachments: message.attachments.map((attachment) =>
      attachment.type === "file"
        ? {
            ...attachment,
            uploadedAttachmentId: attachmentId,
            uploadEnvironmentId: message.environmentId,
          }
        : attachment,
    ),
  };
}

function remainingMessages(): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).flat();
}

beforeEach(() => {
  harness.draftFile.setDocument({ schemaVersion: 1, drafts: {} });
});

afterEach(() => {
  appAtomRegistry.set(harness.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(composerDrafts.composerDraftsAtom, {});
  appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, { accountId: null, signedOut: {} });
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  harness.draftFile.setWriteError(null);
  harness.removePersistedFile.mockClear();
  harness.removeOutboxMessage.mockClear();
  harness.prepareTurnAttachments.mockReset();
  harness.setPendingConnectionError.mockClear();
});

describe("thread outbox attachment preparation", () => {
  it("abandons reused uploads when an editor saves changed text during verification", async () => {
    const message = withReusedFileUpload(
      queuedMessage({
        messageId: "message-reused-upload-race",
        text: "original text",
        fileUri: "file:///documents/t3-composer-attachments/reused.pdf",
      }),
      "pending-reused-upload",
    );
    const preparationStarted = Promise.withResolvers<void>();
    const preparationBarrier = Promise.withResolvers<PreparedTurnAttachments>();
    const releaseUploads = vi.fn(async () => undefined);
    harness.prepareTurnAttachments.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      return preparationBarrier.promise;
    });
    await harness.manager.enqueue(message);
    appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

    const preparation = prepareQueuedMessageAttachments(message);
    await preparationStarted.promise;
    const edited = { ...message, text: "saved editor text" };
    await harness.manager.update(edited);
    appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
    preparationBarrier.resolve({
      status: "ready",
      attachments: [],
      draftAttachments: message.attachments,
      pendingAttachmentIds: ["pending-reused-upload"],
      releaseUploads,
    });

    await expect(preparation).resolves.toEqual({ status: "abandoned" });
    expect(remainingMessages()).toEqual([edited]);
    expect(releaseUploads).not.toHaveBeenCalled();
  });

  it("keeps an unchanged queued payload ready after attachment reuse", async () => {
    const message = withReusedFileUpload(
      queuedMessage({
        messageId: "message-reused-upload-current",
        text: "unchanged text",
        fileUri: "file:///documents/t3-composer-attachments/current.pdf",
      }),
      "pending-reused-upload",
    );
    const releaseUploads = vi.fn(async () => undefined);
    harness.prepareTurnAttachments.mockResolvedValueOnce({
      status: "ready",
      attachments: [],
      draftAttachments: message.attachments,
      pendingAttachmentIds: ["pending-reused-upload"],
      releaseUploads,
    });
    await harness.manager.enqueue(message);
    const revision = harness.manager.revisionOf(message.messageId);
    appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

    await expect(prepareQueuedMessageAttachments(message)).resolves.toMatchObject({
      status: "ready",
      persistedMessage: message,
      deliveryRevision: revision,
    });
    expect(releaseUploads).not.toHaveBeenCalled();
  });

  it("uses the known next revision after persisting uploaded references", async () => {
    const message = queuedMessage({
      messageId: "message-new-upload-revision",
      text: "upload this file",
      fileUri: "file:///documents/t3-composer-attachments/new.pdf",
    });
    const uploadedAttachments = message.attachments.map((attachment) =>
      attachment.type === "file"
        ? {
            ...attachment,
            uploadedAttachmentId: "pending-new-upload",
            uploadEnvironmentId: message.environmentId,
          }
        : attachment,
    );
    harness.prepareTurnAttachments.mockImplementationOnce(async (input) => {
      expect(await input.persistUploadedReferences?.(uploadedAttachments)).toBe("persisted");
      return {
        status: "ready",
        attachments: [],
        draftAttachments: uploadedAttachments,
        pendingAttachmentIds: ["pending-new-upload"],
        releaseUploads: async () => undefined,
      };
    });
    await harness.manager.enqueue(message);
    const revision = harness.manager.revisionOf(message.messageId);

    const result = await prepareQueuedMessageAttachments(message);

    expect(result).toMatchObject({
      status: "ready",
      persistedMessage: { attachments: uploadedAttachments },
      deliveryRevision: revision + 1,
    });
    expect(harness.manager.revisionOf(message.messageId)).toBe(revision + 1);
  });

  it("does not prepare a payload that was already replaced", async () => {
    const message = queuedMessage({ messageId: "message-stale-before-upload", text: "old" });
    await harness.manager.enqueue(message);
    const edited = { ...message, text: "new" };
    await harness.manager.update(edited);

    await expect(prepareQueuedMessageAttachments(message)).resolves.toEqual({
      status: "abandoned",
    });
    expect(harness.prepareTurnAttachments).not.toHaveBeenCalled();
    expect(remainingMessages()).toEqual([edited]);
  });
});

describe("thread outbox drain delivery cleanup", () => {
  it("removes an acknowledged outbox item even when the sign-out archive write fails", async () => {
    const message = queuedMessage({ messageId: "archive-write-failure", text: "Delivered" });
    await harness.manager.enqueue(message);
    await composerDrafts.archiveCloudComposerDrafts("account-a", new Set([message.environmentId]));
    harness.draftFile.setWriteError(new Error("Draft storage unavailable"));

    await expect(
      completeQueuedMessageDelivery(message, harness.manager.revisionOf(message.messageId)),
    ).resolves.toBe("removed");
    expect(remainingMessages()).toEqual([]);

    harness.draftFile.setWriteError(null);
    await composerDrafts.flushComposerDrafts();
    appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, { accountId: null, signedOut: {} });
    composerDrafts.resetComposerDraftsLoadState();
    await composerDrafts.restoreCloudComposerDrafts("account-a");
    expect(remainingMessages()).toEqual([]);
  });

  it.each([false, true])(
    "does not restore a message delivered after the sign-out snapshot (outbox already cleared: %s)",
    async (cleared) => {
      const message = queuedMessage({
        messageId: "delivered-during-sign-out",
        text: "Already delivered",
      });
      await harness.manager.enqueue(message);
      const deliveryRevision = harness.manager.revisionOf(message.messageId);
      await composerDrafts.archiveCloudComposerDrafts(
        "account-a",
        new Set([message.environmentId]),
      );
      expect(
        appAtomRegistry.get(composerDrafts.composerCloudDraftsAtom).signedOut["account-a"]
          ?.queuedMessages,
      ).toEqual([message]);

      if (cleared) await harness.manager.clearEnvironment(message.environmentId);
      await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe(
        cleared ? "edited" : "removed",
      );

      // Restart before signing back in: the archived copy must be removed on disk too.
      appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, {
        accountId: null,
        signedOut: {},
      });
      composerDrafts.resetComposerDraftsLoadState();
      await composerDrafts.restoreCloudComposerDrafts("account-a");
      expect(remainingMessages()).toEqual([]);
    },
  );

  it("preserves an archived edit when an older payload finishes delivery", async () => {
    const message = queuedMessage({ messageId: "edited-during-sign-out", text: "Original" });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);
    const edited = { ...message, text: "Keep this edit" };
    await harness.manager.update(edited);
    await composerDrafts.archiveCloudComposerDrafts("account-a", new Set([message.environmentId]));
    await harness.manager.clearEnvironment(message.environmentId);
    await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe("edited");
    await composerDrafts.restoreCloudComposerDrafts("account-a");
    expect(remainingMessages()).toEqual([edited]);
  });

  it("retries only cleanup after an acknowledged send removal fails", async () => {
    const message = queuedMessage({ messageId: "message-acknowledged", text: "delivered" });
    const acknowledged = new Set([message.messageId]);
    harness.removeOutboxMessage.mockRejectedValueOnce(new Error("storage unavailable"));
    await harness.manager.enqueue(message);

    await expect(removeAcknowledgedExistingThreadMessage(message, acknowledged)).resolves.toBe(
      false,
    );
    expect(remainingMessages()).toEqual([message]);
    expect(acknowledged).toEqual(new Set([message.messageId]));

    await expect(removeAcknowledgedExistingThreadMessage(message, acknowledged)).resolves.toBe(
      true,
    );
    expect(remainingMessages()).toEqual([]);
    expect(acknowledged).toEqual(new Set());
  });

  it("keeps an edited message and its files when delivery cleanup loses the revision race", async () => {
    const message = queuedMessage({
      messageId: "message-edited",
      text: "original",
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);
    const edited = { ...message, text: "edited while the turn delivered" };
    await harness.manager.update(edited);

    await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe("edited");

    expect(remainingMessages()).toEqual([edited]);
    expect(harness.removePersistedFile).not.toHaveBeenCalled();
  });

  it("removes the delivered message when no edit was accepted", async () => {
    const message = queuedMessage({ messageId: "message-clean", text: "hello" });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);

    await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe("removed");

    expect(remainingMessages()).toEqual([]);
  });

  it("keeps a delivered message when its editor opens during storage removal", async () => {
    const message = queuedMessage({
      messageId: "message-editor-removal-race",
      text: "keep editor changes",
      fileUri: "file:///documents/t3-composer-attachments/editor-race.pdf",
    });
    const removeStarted = Promise.withResolvers<void>();
    const removeBarrier = Promise.withResolvers<void>();
    harness.removeOutboxMessage.mockImplementationOnce(async () => {
      removeStarted.resolve();
      await removeBarrier.promise;
    });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);

    const cleanup = completeQueuedMessageDelivery(message, deliveryRevision);
    await removeStarted.promise;
    appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });
    removeBarrier.resolve();

    await expect(cleanup).resolves.toBe("edited");
    expect(remainingMessages()).toEqual([message]);
    expect(harness.removePersistedFile).not.toHaveBeenCalled();
  });
});

describe("thread outbox delivered creation recovery", () => {
  it("keeps an edit accepted while the older payload is persisted to the draft", async () => {
    const message = queuedMessage({
      messageId: "message-recovery-race",
      text: "original queued text",
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    });
    const originalMergeComposerDraftContent = composerDrafts.mergeComposerDraftContent;
    const mergeCompleted = Promise.withResolvers<void>();
    const releaseRecovery = Promise.withResolvers<void>();
    const mergeSpy = vi
      .spyOn(composerDrafts, "mergeComposerDraftContent")
      .mockImplementation(async (draftKey, content) => {
        const result = await originalMergeComposerDraftContent(draftKey, content);
        mergeCompleted.resolve();
        await releaseRecovery.promise;
        return result;
      });

    try {
      await harness.manager.enqueue(message);
      const recovery = recoverEditedCreationAfterDelivery(message);
      await mergeCompleted.promise;

      const newer = { ...message, text: "edited while recovery persisted the draft" };
      await harness.manager.update(newer);

      releaseRecovery.resolve();
      await expect(recovery).resolves.toBe(false);

      expect(remainingMessages()).toEqual([newer]);
      expect(
        composerDrafts.getComposerDraftSnapshot(`${message.environmentId}:${message.threadId}`),
      ).toMatchObject({ text: message.text, attachments: [] });
      expect(harness.removePersistedFile).not.toHaveBeenCalled();
    } finally {
      releaseRecovery.resolve();
      mergeSpy.mockRestore();
    }
  });

  it("leaves recovery to an editor that opens while the draft persists", async () => {
    const message = queuedMessage({
      messageId: "message-recovery-editor",
      text: "recover this text",
      fileUri: "file:///documents/t3-composer-attachments/editor.pdf",
    });
    const originalMergeComposerDraftContent = composerDrafts.mergeComposerDraftContent;
    const mergeCompleted = Promise.withResolvers<void>();
    const releaseRecovery = Promise.withResolvers<void>();
    const mergeSpy = vi
      .spyOn(composerDrafts, "mergeComposerDraftContent")
      .mockImplementation(async (draftKey, content) => {
        const result = await originalMergeComposerDraftContent(draftKey, content);
        mergeCompleted.resolve();
        await releaseRecovery.promise;
        return result;
      });

    try {
      await harness.manager.enqueue(message);
      const recovery = recoverEditedCreationAfterDelivery(message);
      await mergeCompleted.promise;
      appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

      releaseRecovery.resolve();
      await expect(recovery).resolves.toBe(true);

      expect(remainingMessages()).toEqual([message]);
      expect(
        composerDrafts.getComposerDraftSnapshot(`${message.environmentId}:${message.threadId}`),
      ).toMatchObject({ text: message.text, attachments: [] });
      expect(harness.removePersistedFile).not.toHaveBeenCalled();
    } finally {
      releaseRecovery.resolve();
      mergeSpy.mockRestore();
    }
  });

  it("retries a failed removal without duplicating recovered draft content", async () => {
    const message = queuedMessage({
      messageId: "message-recovery-removal",
      text: "recover once",
      fileUri: "file:///documents/t3-composer-attachments/retry.pdf",
    });
    const draftKey = `${message.environmentId}:${message.threadId}`;
    const removeSpy = vi
      .spyOn(harness.manager, "remove")
      .mockRejectedValueOnce(new Error("storage unavailable"));

    try {
      await harness.manager.enqueue(message);

      await expect(recoverEditedCreationAfterDelivery(message)).resolves.toBe(false);
      expect(remainingMessages()).toEqual([message]);

      await expect(recoverEditedCreationAfterDelivery(message)).resolves.toBe(true);

      const draft = composerDrafts.getComposerDraftSnapshot(draftKey);
      expect(draft.text).toBe(message.text);
      expect(draft.attachments).toEqual(message.attachments);
      expect(remainingMessages()).toEqual([]);
      expect(harness.removePersistedFile).not.toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("keeps the queue entry when the recovered draft cannot persist", async () => {
    const message = queuedMessage({
      messageId: "message-recovery-persistence",
      text: "recover after persistence returns",
    });
    await harness.manager.enqueue(message);
    harness.draftFile.setWriteError(new Error("disk full"));

    await expect(recoverEditedCreationAfterDelivery(message)).resolves.toBe(false);

    expect(remainingMessages()).toEqual([message]);
  });
});

describe("thread outbox recovery rollback", () => {
  it("restores a rejected new task into its durable project draft", async () => {
    const message: QueuedThreadMessage = {
      ...queuedMessage({ messageId: "message-creation-restore", text: "new task text" }),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
      },
    };
    await harness.manager.enqueue(message);

    await expect(restoreRejectedQueuedMessage(message, "rejected by server")).resolves.toBe(
      "restored",
    );

    expect(
      composerDrafts.getComposerDraftSnapshot(
        `new-task:${message.environmentId}:${message.creation!.projectId}`,
      ),
    ).toMatchObject({
      text: message.text,
      attachments: message.attachments,
      modelSelection: message.modelSelection,
    });
    expect(remainingMessages()).toEqual([]);
    expect(harness.setPendingConnectionError).toHaveBeenCalledWith("rejected by server");
  });

  it("rolls a failed recovery merge back so the retry cannot duplicate the text", async () => {
    const message = queuedMessage({ messageId: "message-restore", text: "queued text" });
    const draftKey = `${message.environmentId}:${message.threadId}`;
    appAtomRegistry.set(composerDrafts.composerDraftsAtom, {
      [draftKey]: { text: "typed offline", attachments: [] },
    });
    await harness.manager.enqueue(message);

    harness.draftFile.setWriteError(new Error("disk full"));
    await expect(restoreRejectedQueuedMessage(message, "too large")).resolves.toBe("retry");

    // The merge was rolled back and the message stayed queued for the retry.
    expect(composerDrafts.getComposerDraftSnapshot(draftKey).text).toBe("typed offline");
    expect(remainingMessages()).toEqual([message]);

    harness.draftFile.setWriteError(null);
    await expect(restoreRejectedQueuedMessage(message, "too large")).resolves.toBe("restored");

    // The recovered text landed exactly once and the message left the queue.
    expect(composerDrafts.getComposerDraftSnapshot(draftKey).text).toBe(
      "typed offline\n\nqueued text",
    );
    expect(remainingMessages()).toEqual([]);
    expect(harness.setPendingConnectionError).toHaveBeenCalledWith("too large");
  });
});
