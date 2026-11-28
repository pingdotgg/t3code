import {
  acknowledgedThreadMessagesAtom,
  pruneCaughtUpAcknowledgedThreadMessages,
} from "./acknowledged-thread-messages";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import type { PreparedTurnAttachments } from "../lib/attachmentUpload";

const harness = vi.hoisted(() => ({
  canOperate: true,
  threadState: null as unknown as import("effect/reactivity").Atom.Writable<{
    readonly data: import("effect/Option").Option<{
      readonly messages: ReadonlyArray<{ readonly id: string }>;
    }>;
    readonly sequence: number;
  }>,
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  removePersistedFile: vi.fn(async () => undefined),
  removeOutboxMessage: vi.fn(async (_message: QueuedThreadMessage) => undefined),
  prepareTurnAttachments: vi.fn<typeof import("../lib/attachmentUpload").prepareTurnAttachments>(),
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

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("expo-file-system", () => ({
  Directory: harness.draftFile.Directory,
  File: harness.draftFile.File,
  Paths: { document: "/documents" },
}));

vi.mock("../lib/composerImages", () => ({
  removePersistedComposerAttachmentFile: harness.removePersistedFile,
}));

vi.mock("../lib/uuid", () => ({
  uuidv4: () => "00000000-0000-4000-8000-000000000000",
  randomHex: () => "abcd",
}));

vi.mock("../lib/attachmentUpload", () => ({
  prepareTurnAttachments: harness.prepareTurnAttachments,
}));
vi.mock("./composer-attachment-uploads", () => ({ uploadComposerAttachmentShared: vi.fn() }));

vi.mock("./projects", () => ({ environmentProjects: {} }));

vi.mock("./workspace", () => ({ workspaceConnections: {} }));

vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { configValueAtom: Atom.family(() => Atom.make(null)) } };
});

vi.mock("./git", () => ({ gitEnvironment: {} }));

vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  harness.threadState = Atom.make({
    data: Option.none<{ readonly messages: ReadonlyArray<{ readonly id: string }> }>(),
    sequence: 0,
  }).pipe(Atom.keepAlive);
  return {
    threadEnvironment: {},
    environmentThreadDetails: { stateAtom: () => harness.threadState },
  };
});

vi.mock("./session", () => ({
  environmentSession: {},
  readEnvironmentScope: () => harness.canOperate,
  sessionHasScope: () => harness.canOperate,
}));

vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make<Record<string, boolean>>({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    retryingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    threadOutboxShellStatusesAtom: Atom.make(new Map()),
  };
});

vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  harness.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => undefined,
      remove: (message) => harness.removeOutboxMessage(message),
    },
  });
  const manager = harness.manager;
  return {
    threadOutboxManager: manager,
    flushThreadOutbox: async () => undefined,
    confirmThreadOutboxMessageQueued: (message: never) => manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: never, expectedRevision?: number) =>
      manager.update(message, expectedRevision),
    threadOutboxRevision: (messageId: never) => manager.revisionOf(messageId),
  };
});

import * as Option from "effect/Option";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { pendingThreadCreationOutcomesAtom } from "./pending-thread-creation";
import { clearThreadComposerError, threadComposerErrorsAtom } from "./thread-composer-error";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import * as composerDrafts from "./use-composer-drafts";
import { startComposerDraftOperation } from "./composerDraftOperations";
import { recoverFailedThreadDraft } from "./recover-failed-thread-draft";
import { editingQueuedMessageIdsAtom } from "./use-thread-outbox";
import {
  completeQueuedMessageDelivery,
  type DeliveryRetry,
  prepareQueuedMessageAttachments,
  recoverEditedCreationAfterDelivery,
  removeAcknowledgedExistingThreadMessage,
  restoreRejectedQueuedMessage,
} from "./threadOutboxDelivery";

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
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, []);
  appAtomRegistry.set(harness.threadState, { data: Option.none(), sequence: 0 });
  harness.canOperate = true;
  harness.draftFile.setDocument({ schemaVersion: 1, drafts: {} });
});

afterEach(() => {
  appAtomRegistry.set(harness.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(composerDrafts.composerDraftsAtom, {});
  appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, { accountId: null, signedOut: {} });
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {});
  appAtomRegistry.set(threadComposerErrorsAtom, {});
  harness.draftFile.setWriteError(null);
  harness.removePersistedFile.mockClear();
  harness.removeOutboxMessage.mockClear();
  harness.prepareTurnAttachments.mockReset();
});

/** True once a delivery step handled its message, false when it asks to retry. */
const handled = (step: Effect.Effect<void, DeliveryRetry>) =>
  step.pipe(Effect.as(true), Effect.catchTags({ DeliveryRetry: () => Effect.succeed(false) }));

describe("thread outbox attachment preparation", () => {
  it.effect("keeps a denied message queued without starting its attachment upload", () =>
    Effect.gen(function* () {
      const message = queuedMessage({
        messageId: "denied-queued-message",
        text: "Keep this queued",
        fileUri: "file:///documents/keep.pdf",
      });
      yield* Effect.promise(() => harness.manager.enqueue(message));
      harness.prepareTurnAttachments.mockReturnValueOnce(
        Effect.succeed({
          status: "ready",
          attachments: [],
          draftAttachments: message.attachments,
          pendingAttachmentIds: [],
        }),
      );
      harness.canOperate = false;
      expect(yield* prepareQueuedMessageAttachments(message)).toEqual({
        status: "abandoned",
      });
      expect(harness.prepareTurnAttachments).not.toHaveBeenCalled();
      expect(remainingMessages()).toEqual([message]);
    }),
  );

  it.effect("abandons reused uploads when an editor saves changed text during verification", () =>
    Effect.gen(function* () {
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
      harness.prepareTurnAttachments.mockImplementationOnce(() =>
        Effect.promise(() => {
          preparationStarted.resolve();
          return preparationBarrier.promise;
        }),
      );
      yield* Effect.promise(() => harness.manager.enqueue(message));
      appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

      const preparation = yield* Effect.forkChild(prepareQueuedMessageAttachments(message), {
        startImmediately: true,
      });
      yield* Effect.promise(() => preparationStarted.promise);
      const edited = { ...message, text: "saved editor text" };
      yield* Effect.promise(() => harness.manager.update(edited));
      appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
      preparationBarrier.resolve({
        status: "ready",
        attachments: [],
        draftAttachments: message.attachments,
        pendingAttachmentIds: ["pending-reused-upload"],
      });

      expect(yield* Fiber.join(preparation)).toEqual({ status: "abandoned" });
      expect(remainingMessages()).toEqual([edited]);
    }),
  );

  it.effect("uses the known next revision after persisting uploaded references", () =>
    Effect.gen(function* () {
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
      harness.prepareTurnAttachments.mockImplementationOnce((input) =>
        Effect.gen(function* () {
          expect(yield* input.persistUploadedReferences!(uploadedAttachments)).toBe("persisted");
          return {
            status: "ready",
            attachments: [],
            draftAttachments: uploadedAttachments,
            pendingAttachmentIds: ["pending-new-upload"],
          } as const;
        }),
      );
      yield* Effect.promise(() => harness.manager.enqueue(message));
      const revision = harness.manager.revisionOf(message.messageId);

      const result = yield* prepareQueuedMessageAttachments(message);

      expect(result).toMatchObject({
        status: "ready",
        persistedMessage: { attachments: uploadedAttachments },
        deliveryRevision: revision + 1,
      });
      expect(harness.manager.revisionOf(message.messageId)).toBe(revision + 1);
    }),
  );

  it.effect("does not prepare a payload that was already replaced", () =>
    Effect.gen(function* () {
      const message = queuedMessage({ messageId: "message-stale-before-upload", text: "old" });
      yield* Effect.promise(() => harness.manager.enqueue(message));
      const edited = { ...message, text: "new" };
      yield* Effect.promise(() => harness.manager.update(edited));

      expect(yield* prepareQueuedMessageAttachments(message)).toEqual({
        status: "abandoned",
      });
      expect(harness.prepareTurnAttachments).not.toHaveBeenCalled();
      expect(remainingMessages()).toEqual([edited]);
    }),
  );
});

describe("thread outbox drain delivery cleanup", () => {
  it.effect(
    "drops caught-up acknowledged rows at the next delivery without subscribing to the thread",
    () =>
      Effect.gen(function* () {
        const first = queuedMessage({ messageId: "awaiting-echo", text: "Delivered" });
        const second = queuedMessage({ messageId: "next-delivery", text: "Also delivered" });
        yield* Effect.promise(() => harness.manager.enqueue(first));
        yield* Effect.promise(() => harness.manager.enqueue(second));

        expect(
          yield* completeQueuedMessageDelivery(
            first,
            harness.manager.revisionOf(first.messageId),
            7,
          ),
        ).toBe("removed");
        expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toEqual([
          { ...first, sequence: 7 },
        ]);

        // The thread applied the message, but its bounded window does not hold it.
        appAtomRegistry.set(harness.threadState, {
          data: Option.some({ messages: [{ id: "unrelated" }] }),
          sequence: 7,
        });
        expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toHaveLength(1);

        expect(
          yield* completeQueuedMessageDelivery(
            second,
            harness.manager.revisionOf(second.messageId),
            9,
          ),
        ).toBe("removed");
        expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toEqual([
          { ...second, sequence: 9 },
        ]);
      }),
  );

  it.effect(
    "drops an acknowledged row once the open thread catches up, so a reload cannot resurrect it",
    () =>
      Effect.gen(function* () {
        const message = queuedMessage({ messageId: "paged-out-later", text: "Delivered" });
        yield* Effect.promise(() => harness.manager.enqueue(message));
        yield* completeQueuedMessageDelivery(
          message,
          harness.manager.revisionOf(message.messageId),
          7,
        );

        pruneCaughtUpAcknowledgedThreadMessages(
          scopedThreadKey(message.environmentId, message.threadId),
          {
            sequence: 6,
            messages: [],
          },
        );
        expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toEqual([
          { ...message, sequence: 7 },
        ]);

        pruneCaughtUpAcknowledgedThreadMessages(
          scopedThreadKey(message.environmentId, message.threadId),
          {
            sequence: 7,
            messages: [],
          },
        );
        expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toEqual([]);
      }),
  );

  it.effect("removes an acknowledged outbox item even when the sign-out archive write fails", () =>
    Effect.gen(function* () {
      const message = queuedMessage({ messageId: "archive-write-failure", text: "Delivered" });
      yield* Effect.promise(() => harness.manager.enqueue(message));
      yield* Effect.promise(() =>
        composerDrafts.archiveCloudComposerDrafts("account-a", new Set([message.environmentId]), [
          message.environmentId,
        ]),
      );
      harness.draftFile.setWriteError(new Error("Draft storage unavailable"));

      expect(
        yield* completeQueuedMessageDelivery(
          message,
          harness.manager.revisionOf(message.messageId),
          undefined,
        ),
      ).toBe("removed");
      expect(remainingMessages()).toEqual([]);

      harness.draftFile.setWriteError(null);
      yield* Effect.promise(() => composerDrafts.flushComposerDrafts());
      appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, {
        accountId: null,
        signedOut: {},
      });
      composerDrafts.resetComposerDraftsLoadState();
      yield* Effect.promise(() => composerDrafts.restoreCloudComposerDrafts("account-a"));
      expect(remainingMessages()).toEqual([]);
    }),
  );

  it.effect.each([false, true])(
    "does not restore a message delivered after the sign-out snapshot (outbox already cleared: %s)",
    (cleared) =>
      Effect.gen(function* () {
        const message = queuedMessage({
          messageId: "delivered-during-sign-out",
          text: "Already delivered",
        });
        yield* Effect.promise(() => harness.manager.enqueue(message));
        const deliveryRevision = harness.manager.revisionOf(message.messageId);
        yield* Effect.promise(() =>
          composerDrafts.archiveCloudComposerDrafts("account-a", new Set([message.environmentId]), [
            message.environmentId,
          ]),
        );
        expect(
          appAtomRegistry.get(composerDrafts.composerCloudDraftsAtom).signedOut["account-a"]
            ?.queuedMessages,
        ).toEqual([message]);

        if (cleared) {
          yield* Effect.promise(() => harness.manager.clearEnvironment(message.environmentId));
        }
        expect(yield* completeQueuedMessageDelivery(message, deliveryRevision, undefined)).toBe(
          cleared ? "edited" : "removed",
        );

        appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, {
          accountId: null,
          signedOut: {},
        });
        composerDrafts.resetComposerDraftsLoadState();
        yield* Effect.promise(() => composerDrafts.restoreCloudComposerDrafts("account-a"));
        expect(remainingMessages()).toEqual([]);
      }),
  );

  it.effect("preserves an archived edit when an older payload finishes delivery", () =>
    Effect.gen(function* () {
      const message = queuedMessage({ messageId: "edited-during-sign-out", text: "Original" });
      yield* Effect.promise(() => harness.manager.enqueue(message));
      const deliveryRevision = harness.manager.revisionOf(message.messageId);
      const edited = { ...message, text: "Keep this edit" };
      yield* Effect.promise(() => harness.manager.update(edited));
      yield* Effect.promise(() =>
        composerDrafts.archiveCloudComposerDrafts("account-a", new Set([message.environmentId]), [
          message.environmentId,
        ]),
      );
      yield* Effect.promise(() => harness.manager.clearEnvironment(message.environmentId));
      expect(yield* completeQueuedMessageDelivery(message, deliveryRevision, undefined)).toBe(
        "edited",
      );
      yield* Effect.promise(() => composerDrafts.restoreCloudComposerDrafts("account-a"));
      expect(remainingMessages()).toEqual([edited]);
    }),
  );

  it.effect("retries only cleanup after an acknowledged send removal fails", () =>
    Effect.gen(function* () {
      const message = queuedMessage({ messageId: "message-acknowledged", text: "delivered" });
      const acknowledged = new Set([message.messageId]);
      harness.removeOutboxMessage.mockRejectedValueOnce(new Error("storage unavailable"));
      yield* Effect.promise(() => harness.manager.enqueue(message));

      expect(yield* handled(removeAcknowledgedExistingThreadMessage(message, acknowledged))).toBe(
        false,
      );
      expect(remainingMessages()).toEqual([message]);
      expect(acknowledged).toEqual(new Set([message.messageId]));

      expect(yield* handled(removeAcknowledgedExistingThreadMessage(message, acknowledged))).toBe(
        true,
      );
      expect(remainingMessages()).toEqual([]);
      expect(acknowledged).toEqual(new Set());
    }),
  );

  it.effect(
    "keeps an edited message and its files when delivery cleanup loses the revision race",
    () =>
      Effect.gen(function* () {
        const message = queuedMessage({
          messageId: "message-edited",
          text: "original",
          fileUri: "file:///documents/t3-composer-attachments/report.pdf",
        });
        yield* Effect.promise(() => harness.manager.enqueue(message));
        const deliveryRevision = harness.manager.revisionOf(message.messageId);
        const edited = { ...message, text: "edited while the turn delivered" };
        yield* Effect.promise(() => harness.manager.update(edited));

        expect(yield* completeQueuedMessageDelivery(message, deliveryRevision, undefined)).toBe(
          "edited",
        );

        expect(remainingMessages()).toEqual([edited]);
        expect(harness.removePersistedFile).not.toHaveBeenCalled();
      }),
  );

  it.effect("removes the delivered message when no edit was accepted", () =>
    Effect.gen(function* () {
      const message = queuedMessage({ messageId: "message-clean", text: "hello" });
      yield* Effect.promise(() => harness.manager.enqueue(message));
      const deliveryRevision = harness.manager.revisionOf(message.messageId);

      expect(yield* completeQueuedMessageDelivery(message, deliveryRevision, undefined)).toBe(
        "removed",
      );

      expect(remainingMessages()).toEqual([]);
      expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toEqual([message]);
    }),
  );

  it.effect("keeps a delivered message when its editor opens during storage removal", () =>
    Effect.gen(function* () {
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
      yield* Effect.promise(() => harness.manager.enqueue(message));
      const deliveryRevision = harness.manager.revisionOf(message.messageId);

      const cleanup = yield* Effect.forkChild(
        completeQueuedMessageDelivery(message, deliveryRevision, undefined),
        { startImmediately: true },
      );
      yield* Effect.promise(() => removeStarted.promise);
      appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });
      removeBarrier.resolve();

      expect(yield* Fiber.join(cleanup)).toBe("edited");
      expect(remainingMessages()).toEqual([message]);
      expect(harness.removePersistedFile).not.toHaveBeenCalled();
    }),
  );
});

describe("thread outbox delivered creation recovery", () => {
  it.effect("keeps an edit accepted while the older payload is persisted to the draft", () =>
    Effect.gen(function* () {
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
        yield* Effect.promise(() => harness.manager.enqueue(message));
        const recovery = yield* Effect.forkChild(
          handled(recoverEditedCreationAfterDelivery(message)),
          { startImmediately: true },
        );
        yield* Effect.promise(() => mergeCompleted.promise);

        const newer = { ...message, text: "edited while recovery persisted the draft" };
        yield* Effect.promise(() => harness.manager.update(newer));

        releaseRecovery.resolve();
        expect(yield* Fiber.join(recovery)).toBe(false);

        expect(remainingMessages()).toEqual([newer]);
        expect(
          composerDrafts.getComposerDraftSnapshot(`${message.environmentId}:${message.threadId}`),
        ).toMatchObject({ text: message.text, attachments: [] });
        expect(harness.removePersistedFile).not.toHaveBeenCalled();
      } finally {
        releaseRecovery.resolve();
        mergeSpy.mockRestore();
      }
    }),
  );

  it.effect("leaves recovery to an editor that opens while the draft persists", () =>
    Effect.gen(function* () {
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
        yield* Effect.promise(() => harness.manager.enqueue(message));
        const recovery = yield* Effect.forkChild(
          handled(recoverEditedCreationAfterDelivery(message)),
          { startImmediately: true },
        );
        yield* Effect.promise(() => mergeCompleted.promise);
        appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

        releaseRecovery.resolve();
        expect(yield* Fiber.join(recovery)).toBe(true);

        expect(remainingMessages()).toEqual([message]);
        expect(
          composerDrafts.getComposerDraftSnapshot(`${message.environmentId}:${message.threadId}`),
        ).toMatchObject({ text: message.text, attachments: [] });
        expect(harness.removePersistedFile).not.toHaveBeenCalled();
      } finally {
        releaseRecovery.resolve();
        mergeSpy.mockRestore();
      }
    }),
  );

  it.effect("retries a failed removal without duplicating recovered draft content", () =>
    Effect.gen(function* () {
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
        yield* Effect.promise(() => harness.manager.enqueue(message));

        expect(yield* handled(recoverEditedCreationAfterDelivery(message))).toBe(false);
        expect(remainingMessages()).toEqual([message]);

        expect(yield* handled(recoverEditedCreationAfterDelivery(message))).toBe(true);

        const draft = composerDrafts.getComposerDraftSnapshot(draftKey);
        expect(draft.text).toBe(message.text);
        expect(draft.attachments).toEqual(message.attachments);
        expect(remainingMessages()).toEqual([]);
        expect(harness.removePersistedFile).not.toHaveBeenCalled();
      } finally {
        removeSpy.mockRestore();
      }
    }),
  );

  it.effect("keeps the queue entry when the recovered draft cannot persist", () =>
    Effect.gen(function* () {
      const message = queuedMessage({
        messageId: "message-recovery-persistence",
        text: "recover after persistence returns",
      });
      yield* Effect.promise(() => harness.manager.enqueue(message));
      harness.draftFile.setWriteError(new Error("disk full"));

      expect(yield* handled(recoverEditedCreationAfterDelivery(message))).toBe(false);

      expect(remainingMessages()).toEqual([message]);
    }),
  );
});

describe("thread outbox recovery rollback", () => {
  it("reopens a rejected task with setup edits and every attachment, even above the send cap", async () => {
    const message = queuedMessage({ messageId: "failed-setup", text: "Original prompt" });
    const sourceKey = `${message.environmentId}:${message.threadId}`;
    const targetKey = "new-task:restored-failed-setup";
    const files = Array.from(
      { length: 10 },
      (_, index) =>
        queuedMessage({
          messageId: `attachment-${index}`,
          text: "",
          fileUri: `file:///file-${index}`,
        }).attachments[0]!,
    );
    appAtomRegistry.set(composerDrafts.composerDraftsAtom, {
      [targetKey]: { text: message.text, attachments: files.slice(0, 8) },
      [sourceKey]: { text: "Please include tests", attachments: files.slice(8) },
    });
    await recoverFailedThreadDraft(message);
    expect(composerDrafts.getComposerDraftSnapshot(targetKey)).toMatchObject({
      text: "Original prompt\n\nPlease include tests",
      attachments: files,
    });
    expect(composerDrafts.getComposerDraftSnapshot(sourceKey)).toMatchObject({
      text: "",
      attachments: [],
    });
    await recoverFailedThreadDraft(message);
    expect(composerDrafts.getComposerDraftSnapshot(targetKey).text).toBe(
      "Original prompt\n\nPlease include tests",
    );
  });

  it("keeps a late attachment and its reference when recovery fills the context limit", async () => {
    const message: QueuedThreadMessage = {
      ...queuedMessage({ messageId: "failed-full-context", text: "Original prompt" }),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
      },
    };
    const sourceKey = `${message.environmentId}:${message.threadId}`;
    const targetKey = "new-task:restored-failed-full-context";
    await composerDrafts.waitForComposerDraftsLoaded();
    const contextDraft = (start: number) => {
      const records = Array.from({ length: 100 }, (_, index) => ({
        version: 1 as const,
        contextId: ComposerContextId.make(`skill-${start + index}`),
        kind: "skill" as const,
        label: "Skill",
        name: "skill",
      }));
      return {
        text: records
          .map((record) => `[Skill](t3-context://v1/skill/${record.contextId})`)
          .join(" "),
        context: { version: 1 as const, records },
        attachments: [],
      };
    };
    appAtomRegistry.set(composerDrafts.composerDraftsAtom, {
      [targetKey]: contextDraft(0),
      [sourceKey]: contextDraft(100),
    });
    const saving = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const write = harness.draftFile.File.prototype.write;
    const writeSpy = vi
      .spyOn(harness.draftFile.File.prototype, "write")
      .mockImplementationOnce(async function (value) {
        write(value);
        saving.resolve();
        await resume.promise;
      });
    const attachment = {
      id: "late-paste",
      type: "file" as const,
      name: "pasted.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      fileUri: "file:///pasted.txt",
    };
    try {
      const recovering = recoverFailedThreadDraft(message);
      await saving.promise;
      composerDrafts.appendComposerDraftAttachments(sourceKey, [attachment], {
        appendReference: true,
      });
      resume.resolve();
      await recovering;
      const restored = composerDrafts.getComposerDraftSnapshot(targetKey);
      expect(restored.attachments).toContainEqual(attachment);
      expect(restored.context?.records).toHaveLength(201);
      const fileRecord = restored.context?.records.find(
        (record) => "attachmentId" in record && record.attachmentId === attachment.id,
      );
      expect(fileRecord).toBeDefined();
      expect(restored.text).toContain(`/${fileRecord!.contextId})`);
      expect(composerDrafts.getComposerDraftSnapshot(sourceKey).attachments).toEqual([]);
    } finally {
      resume.resolve();
      writeSpy.mockRestore();
      await composerDrafts.flushComposerDrafts();
    }
  });

  it("cancels a paste that finishes preparing after recovery returns", async () => {
    const message = queuedMessage({ messageId: "failed-unfinished-paste", text: "Original" });
    const sourceKey = `${message.environmentId}:${message.threadId}`;
    appAtomRegistry.set(composerDrafts.composerDraftsAtom, {
      [sourceKey]: { text: "Follow-up", attachments: [] },
    });
    const paste = startComposerDraftOperation(sourceKey);
    try {
      await recoverFailedThreadDraft(message);
      expect(paste.signal.aborted).toBe(true);
    } finally {
      paste.finish();
      await composerDrafts.flushComposerDrafts();
    }
  });

  it("keeps setup edits recoverable when saving their recovery draft fails", async () => {
    const message = queuedMessage({ messageId: "failed-save", text: "Original prompt" });
    const sourceKey = `${message.environmentId}:${message.threadId}`;
    appAtomRegistry.set(composerDrafts.composerDraftsAtom, {
      "new-task:restored-failed-save": { text: message.text, attachments: [] },
      [sourceKey]: { text: "Follow-up", attachments: [] },
    });
    harness.draftFile.setWriteError(new Error("disk full"));
    await expect(recoverFailedThreadDraft(message)).rejects.toThrow("Composer draft persistence");
    expect(composerDrafts.getComposerDraftSnapshot(sourceKey).text).toBe("Follow-up");
    harness.draftFile.setWriteError(null);
    await recoverFailedThreadDraft(message);
    expect(composerDrafts.getComposerDraftSnapshot("new-task:restored-failed-save").text).toBe(
      "Original prompt\n\nFollow-up",
    );
  });

  it.effect("restores a rejected new task as its own draft for the project", () =>
    Effect.gen(function* () {
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
      yield* Effect.promise(() => harness.manager.enqueue(message));

      expect(yield* restoreRejectedQueuedMessage(message, "rejected by server")).toBe("restored");

      expect(
        composerDrafts.getComposerDraftSnapshot(`new-task:restored-${message.messageId}`),
      ).toMatchObject({
        text: message.text,
        attachments: message.attachments,
        modelSelection: message.modelSelection,
        project: {
          environmentId: message.environmentId,
          projectId: message.creation!.projectId,
          createdAt: message.createdAt,
        },
      });
      expect(remainingMessages()).toEqual([]);
      expect(appAtomRegistry.get(threadComposerErrorsAtom)).toEqual({});
      expect(
        appAtomRegistry.get(pendingThreadCreationOutcomesAtom)[
          `${message.environmentId}:${message.threadId}`
        ],
      ).toEqual({ kind: "failed", message, reason: "rejected by server" });
    }),
  );

  it.effect("keeps the draft unchanged when a standalone goal command is rejected", () =>
    Effect.gen(function* () {
      const message: QueuedThreadMessage = {
        ...queuedMessage({ messageId: "goal-rejected", text: "/goal clear" }),
        restoreToDraft: false,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
      };
      const threadKey = `${message.environmentId}:${message.threadId}`;
      appAtomRegistry.set(composerDrafts.composerDraftsAtom, {
        [threadKey]: { text: "Keep my draft", attachments: [], runtimeMode: "approval-required" },
      });
      const draft = composerDrafts.getComposerDraftSnapshot(threadKey);
      yield* Effect.promise(() => harness.manager.enqueue(message));
      expect(yield* restoreRejectedQueuedMessage(message, "rejected")).toBe("restored");
      expect(composerDrafts.getComposerDraftSnapshot(threadKey)).toEqual(draft);
      expect(remainingMessages()).toEqual([]);
      expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]).toEqual({
        message: "rejected",
        messageId: message.messageId,
      });
    }),
  );

  it.effect("does not record a creation outcome for a rejected follow-up message", () =>
    Effect.gen(function* () {
      const message = queuedMessage({ messageId: "message-followup-restore", text: "follow up" });
      yield* Effect.promise(() => harness.manager.enqueue(message));

      expect(yield* restoreRejectedQueuedMessage(message, "rejected")).toBe("restored");

      expect(appAtomRegistry.get(pendingThreadCreationOutcomesAtom)).toEqual({});
      expect(
        appAtomRegistry.get(threadComposerErrorsAtom)[
          `${message.environmentId}:${message.threadId}`
        ],
      ).toEqual({ message: "rejected", messageId: message.messageId });
    }),
  );

  it.effect("leaves no error when the restored text is resent before recovery finishes", () =>
    Effect.gen(function* () {
      const message = queuedMessage({ messageId: "message-resent", text: "resend me" });
      const threadKey = `${message.environmentId}:${message.threadId}`;
      yield* Effect.promise(() => harness.manager.enqueue(message));
      const unsubscribe = appAtomRegistry.subscribe(composerDrafts.composerDraftsAtom, (drafts) => {
        if (drafts[threadKey]?.text === "resend me") {
          unsubscribe();
          clearThreadComposerError(threadKey);
          void composerDrafts.clearComposerDraftContent(threadKey);
        }
      });

      expect(yield* restoreRejectedQueuedMessage(message, "rejected")).toBe("restored");

      expect(appAtomRegistry.get(threadComposerErrorsAtom)).toEqual({});
    }),
  );

  it.effect("withdraws the error when an edit makes the recovery back out", () =>
    Effect.gen(function* () {
      const message = queuedMessage({ messageId: "message-edited-mid-recovery", text: "edit me" });
      const threadKey = `${message.environmentId}:${message.threadId}`;
      yield* Effect.promise(() => harness.manager.enqueue(message));
      const unsubscribe = appAtomRegistry.subscribe(composerDrafts.composerDraftsAtom, (drafts) => {
        if (drafts[threadKey]?.text === "edit me") {
          unsubscribe();
          appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });
        }
      });

      expect(yield* restoreRejectedQueuedMessage(message, "rejected")).toBe("deferred");

      expect(appAtomRegistry.get(threadComposerErrorsAtom)).toEqual({});
      expect(remainingMessages()).toEqual([message]);
    }),
  );

  it.effect("rolls a failed recovery merge back so the retry cannot duplicate the text", () =>
    Effect.gen(function* () {
      const message = queuedMessage({ messageId: "message-restore", text: "queued text" });
      const draftKey = `${message.environmentId}:${message.threadId}`;
      appAtomRegistry.set(composerDrafts.composerDraftsAtom, {
        [draftKey]: { text: "typed offline", attachments: [] },
      });
      yield* Effect.promise(() => harness.manager.enqueue(message));

      harness.draftFile.setWriteError(new Error("disk full"));
      expect(yield* restoreRejectedQueuedMessage(message, "too large")).toBe("retry");

      expect(composerDrafts.getComposerDraftSnapshot(draftKey).text).toBe("typed offline");
      expect(remainingMessages()).toEqual([message]);

      harness.draftFile.setWriteError(null);
      expect(yield* restoreRejectedQueuedMessage(message, "too large")).toBe("restored");

      expect(composerDrafts.getComposerDraftSnapshot(draftKey).text).toBe(
        "typed offline\n\nqueued text",
      );
      expect(remainingMessages()).toEqual([]);
      expect(appAtomRegistry.get(threadComposerErrorsAtom)[draftKey]?.message).toBe("too large");
    }),
  );
});
