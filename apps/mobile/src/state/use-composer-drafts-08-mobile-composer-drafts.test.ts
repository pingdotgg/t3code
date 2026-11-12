import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { createEnvironmentThreadShellAtoms } from "@t3tools/client-runtime/state/threads";
import {
  applyShellStreamEvent,
  createEnvironmentSnapshotAtom,
  EMPTY_SHELL_STATE,
  type EnvironmentShellState,
  type EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellSnapshot,
  type ModelSelection,
} from "@t3tools/contracts";
import { onTestFinished, vi } from "vite-plus/test";

const composerDraftFileMocks = vi.hoisted(() => {
  let document = JSON.stringify({ schemaVersion: 1, drafts: {} });
  let readError: Error | null = null;
  let writeError: Error | null = null;
  let releaseRead: (() => void) | null = null;
  let readBarrier = Promise.resolve();
  let nextWriteBarrier: Promise<void> | null = null;
  let onWrite: (() => void) | null = null;
  const writes: string[] = [];
  const readImage = vi.fn(async () => "YWJj");

  return {
    readImage,
    blockRead() {
      readBarrier = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseRead() {
      releaseRead?.();
      releaseRead = null;
    },
    getDocument() {
      return document;
    },
    setDocument(value: unknown) {
      document = JSON.stringify(value);
    },
    setReadError(error: Error | null) {
      readError = error;
    },
    setWriteError(error: Error | null) {
      writeError = error;
    },
    setNextWriteBarrier(barrier: Promise<void> | null) {
      nextWriteBarrier = barrier;
    },
    setOnWrite(callback: (() => void) | null) {
      onWrite = callback;
    },
    getWrites(): ReadonlyArray<string> {
      return writes;
    },
    resetWrites() {
      writes.length = 0;
    },
    Directory: class {
      create() {}

      list() {
        return [];
      }
    },
    File: class {
      exists = true;
      parentDirectory = null;

      create() {}

      moveSync() {}

      async text() {
        await readBarrier;
        if (readError) throw readError;
        return document;
      }

      async base64() {
        return readImage();
      }

      write(value: string) {
        if (writeError) {
          throw writeError;
        }
        if (nextWriteBarrier) {
          const barrier = nextWriteBarrier;
          nextWriteBarrier = null;
          return barrier.then(() => {
            document = value;
            writes.push(value);
            onWrite?.();
          });
        }
        document = value;
        writes.push(value);
        onWrite?.();
      }
    },
  };
});

const composerAttachmentCleanupMocks = vi.hoisted(() => ({
  remove: vi.fn(async () => undefined),
  releaseUploads: vi.fn(async () => undefined),
}));

const incomingShareStorageMocks = vi.hoisted(() => ({
  load: vi.fn<typeof import("../features/sharing/incoming-share-storage").loadIncomingShareDrafts>(
    async () => [],
  ),
}));

vi.mock("expo-file-system", () => ({
  Directory: composerDraftFileMocks.Directory,
  File: composerDraftFileMocks.File,
  Paths: { document: { uri: "file:///documents" } },
}));

vi.mock("../lib/composerImages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/composerImages")>()),
  removePersistedComposerAttachmentFile: composerAttachmentCleanupMocks.remove,
}));

vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "0000" }));
vi.mock("./assets", () => ({ assetEnvironment: {} }));
vi.mock("./attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: () => {
    throw new Error("Unexpected network query in the inline read test");
  },
  runAtomCommand: () => {
    throw new Error("Unexpected network command in the inline read test");
  },
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../lib/attachmentUpload", () => ({
  releasePendingAttachmentUploads: composerAttachmentCleanupMocks.releaseUploads,
}));

vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: incomingShareStorageMocks.load,
}));

import type { DraftComposerAttachment } from "../lib/composerImages";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { appAtomRegistry } from "./atom-registry";
import { startComposerDraftOperation } from "./composerDraftOperations";
import { threadOutboxManager } from "./thread-outbox";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  getComposerDraftAfterSelection,
  archiveCloudComposerDrafts,
  clearComposerDraftContent,
  clearComposerDraftContentState,
  subscribeComposerDraftModelReconciliation,
  clearComposerDraftsEnvironment,
  ComposerDraftPersistenceError,
  composerDraftsAtom,
  composerCloudDraftsAtom,
  createNewTaskDraft,
  createComposerDraftContextHistory,
  setComposerDraftContext,
  decodePersistedComposerState,
  ensureComposerDraftsLoaded,
  type ComposerDraft,
  findNewTaskDraftKeys,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContentState,
  migrateLegacyNewTaskDraft,
  modelOptionMemoryAtom,
  releaseUnusedComposerAttachmentFiles,
  removeComposerDraftsForEnvironment,
  replaceComposerDraftAttachments,
  resetComposerDraftsLoadState,
  restoreComposerDraftSnapshotState,
  restoreCloudComposerDrafts,
  retargetNewTaskDraft,
  setComposerDraftText,
  insertComposerDraftContext,
  insertComposerDraftText,
  rememberComposerDraftSelection,
  setComposerDraftAttachmentUpload,
  waitForComposerDraftsLoaded,
  setStickyComposerModelSelection,
  stickyComposerModelSelectionAtom,
  undoComposerDraftMergeState,
  updateComposerDraftSettings,
} from "./use-composer-drafts";
import { retainComposerAttachmentFileForPreview } from "../lib/composerAttachmentPreviewRetention";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};

afterEach(() => {
  vi.useRealTimers();
  resetComposerDraftsLoadState();
  composerDraftFileMocks.setDocument({ schemaVersion: 1, drafts: {} });
  composerDraftFileMocks.setReadError(null);
  composerDraftFileMocks.setWriteError(null);
  composerDraftFileMocks.setNextWriteBarrier(null);
  composerDraftFileMocks.setOnWrite(null);
  composerDraftFileMocks.resetWrites();
  composerDraftFileMocks.readImage.mockReset();
  composerDraftFileMocks.readImage.mockResolvedValue("YWJj");
  appAtomRegistry.set(composerDraftsAtom, {});
  appAtomRegistry.set(composerCloudDraftsAtom, { accountId: null, signedOut: {} });
  appAtomRegistry.set(stickyComposerModelSelectionAtom, null);
  appAtomRegistry.set(modelOptionMemoryAtom, {});
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  composerAttachmentCleanupMocks.remove.mockClear();
  composerAttachmentCleanupMocks.releaseUploads.mockReset();
  composerAttachmentCleanupMocks.releaseUploads.mockResolvedValue(undefined);
  incomingShareStorageMocks.load.mockReset();
  incomingShareStorageMocks.load.mockResolvedValue([]);
});

function contextDraft(start: number, count: number): ComposerDraft {
  const records = Array.from({ length: count }, (_, index) => ({
    version: 1 as const,
    contextId: ComposerContextId.make(`skill-${start + index}`),
    kind: "skill" as const,
    label: "Skill",
    name: "skill",
  }));
  return {
    text: records.map((record) => `[Skill](t3-context://v1/skill/${record.contextId})`).join(" "),
    context: { version: 1, records },
    attachments: [],
  };
}

function modelReconciliationHarness(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  initialStatus: EnvironmentShellStatus = "live",
) {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  onTestFinished(() => registry.dispose());
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const selectedThreadId = ThreadId.make("another-selected-thread");
  const initialSnapshot: OrchestrationV2ShellSnapshot = {
    ...v2ShellSnapshot,
    threads: [
      { ...v2ThreadShell, id: threadId },
      { ...v2ThreadShell, id: selectedThreadId },
    ],
  };
  const shellStateAtom = Atom.make<EnvironmentShellState>({
    ...EMPTY_SHELL_STATE,
    snapshot: Option.some(initialSnapshot),
    status: initialStatus,
  });
  const shellResultAtom = Atom.map(shellStateAtom, AsyncResult.success);
  const snapshotAtom = createEnvironmentSnapshotAtom(() => shellResultAtom)(environmentId);
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([
      [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ],
    ]),
  });
  const shells = createEnvironmentThreadShellAtoms({
    catalogValueAtom,
    snapshotAtom: () => snapshotAtom,
    hiddenThreadTagsAtom: () => Atom.make(null),
  });
  const selectedShell = shells.threadShellAtom({ environmentId, threadId: selectedThreadId });
  onTestFinished(registry.mount(selectedShell));
  onTestFinished(
    subscribeComposerDraftModelReconciliation({
      registry,
      threadShellAtom: shells.threadShellAtom,
      threadRefsAtom: shells.threadRefsAtom,
      shellStateAtom: () => shellResultAtom,
    }),
  );
  flush();
  return {
    flush,
    setStatus(status: EnvironmentShellStatus) {
      registry.set(shellStateAtom, { ...registry.get(shellStateAtom), status });
      flush();
    },
    update(changes: Partial<OrchestrationV2ThreadShell>, status?: EnvironmentShellStatus) {
      const state = registry.get(shellStateAtom);
      const snapshot = Option.getOrThrow(state.snapshot);
      registry.set(shellStateAtom, {
        ...state,
        status: status ?? state.status,
        snapshot: Option.some(
          applyShellStreamEvent(snapshot, {
            kind: "thread.updated",
            location: "active",
            sequence: snapshot.snapshotSequence + 1,
            thread: { ...snapshot.threads[0]!, ...changes },
          }),
        ),
      });
      flush();
      expect(registry.get(selectedShell)?.id).toBe(selectedThreadId);
    },
    model: () => registry.get(shells.threadShellAtom({ environmentId, threadId }))!.modelSelection,
  };
}



describe("mobile composer drafts", () => {
  it("restores the pre-merge snapshot when the draft is untouched since the merge", () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = { text: "typed before", attachments: [] };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [],
      runtimeMode: "approval-required",
    };

    expect(undoComposerDraftMergeState({ [draftKey]: merged }, draftKey, snapshot, merged)).toEqual(
      { [draftKey]: snapshot },
    );
    expect(
      undoComposerDraftMergeState(
        { [draftKey]: merged },
        draftKey,
        { text: "", attachments: [] },
        merged,
      ),
    ).toEqual({});
  });
  it("returns merge-written settings to the snapshot but keeps user-edited ones", () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = {
      text: "typed before",
      attachments: [],
      runtimeMode: "approval-required",
      interactionMode: "default",
    };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [],
      runtimeMode: "full-access",
      interactionMode: "default",
    };

    const edited: ComposerDraft = {
      text: "typed EDITED before\n\nqueued text",
      attachments: [],
      runtimeMode: "full-access",
      interactionMode: "plan",
    };

    expect(undoComposerDraftMergeState({ [draftKey]: edited }, draftKey, snapshot, merged)).toEqual(
      {
        [draftKey]: {
          text: "typed EDITED before",
          attachments: [],
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      },
    );
  });
  it("takes out only what the merge inserted when the user edited during it", () => {
    const draftKey = "environment-1:thread-1";
    const keptAttachment = {
      id: "kept",
      type: "file" as const,
      name: "kept.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      fileUri: "file:///documents/t3-composer-attachments/kept.pdf",
    };
    const insertedAttachment = {
      id: "inserted",
      type: "file" as const,
      name: "inserted.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      fileUri: "file:///documents/t3-composer-attachments/inserted.pdf",
    };
    const userAttachment = { ...keptAttachment, id: "user-added" };
    const snapshot: ComposerDraft = { text: "typed before", attachments: [keptAttachment] };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [keptAttachment, insertedAttachment],
    };

    const edited: ComposerDraft = {
      text: "typed EDITED before\n\nqueued text",
      attachments: [keptAttachment, insertedAttachment, userAttachment],
    };

    expect(undoComposerDraftMergeState({ [draftKey]: edited }, draftKey, snapshot, merged)).toEqual(
      {
        [draftKey]: {
          text: "typed EDITED before",
          attachments: [keptAttachment, userAttachment],
        },
      },
    );

    const rewritten: ComposerDraft = {
      text: "totally rewritten",
      attachments: [insertedAttachment],
    };
    expect(
      undoComposerDraftMergeState({ [draftKey]: rewritten }, draftKey, snapshot, merged),
    ).toEqual({
      [draftKey]: { text: "totally rewritten", attachments: [] },
    });
  });
  it("keeps text appended after a merge when rolling it back", () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = { text: "typed before", attachments: [] };
    const content = { text: "queued text", attachments: [] };
    const merged = mergeComposerDraftContentState({ [draftKey]: snapshot }, draftKey, content)[
      draftKey
    ]!;
    const edited: ComposerDraft = {
      ...merged,
      text: `${merged.text}\n\nuser follow-up`,
    };

    const rolledBack = undoComposerDraftMergeState(
      { [draftKey]: edited },
      draftKey,
      snapshot,
      merged,
    );

    expect(rolledBack[draftKey]?.text).toBe("typed before\n\nuser follow-up");
    const retried = mergeComposerDraftContentState(rolledBack, draftKey, content);
    expect(retried[draftKey]?.text.match(/queued text/g)).toHaveLength(1);
  });
  it("spares a file re-owned between the sweep's scan and its deletion", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const fileFor = (id: string) => ({
      id,
      type: "file" as const,
      name: `${id}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: `file:///documents/t3-composer-attachments/${id}.pdf`,
    });
    const first = fileFor("file-first");
    const reowned = fileFor("file-reowned");

    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      appAtomRegistry.set(composerDraftsAtom, {
        "environment-1:thread-1": { text: "restored", attachments: [reowned] },
      });
    });

    await releaseUnusedComposerAttachmentFiles([first, reowned]);

    expect(composerAttachmentCleanupMocks.remove.mock.calls).toEqual([[first.fileUri]]);
  });
  it("keeps attachment files and uploads after a recovered message leaves an incomplete outbox", async () => {
    vi.resetModules();
    const drafts = await import("./use-composer-drafts");
    const { threadOutboxManager: manager } = await import("./thread-outbox");
    const { expoThreadOutboxStorage: storage, ThreadOutboxStorageError } =
      await import("./thread-outbox-storage");
    const { removeThreadOutboxMessage } = await import("./thread-outbox-removal");
    const { appAtomRegistry: registry } = await import("./atom-registry");
    onTestFinished(() => registry.dispose());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warning.mockRestore());
    const file = {
      id: "file-partial-outbox",
      type: "file" as const,
      name: "shared.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/shared.pdf",
      uploadEnvironmentId: EnvironmentId.make("environment-1"),
      uploadedAttachmentId: "pending-partial-outbox",
    };
    const readable = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("message-readable"),
      commandId: CommandId.make("command-readable"),
      text: "Send the readable message",
      attachments: [file],
      createdAt: "2026-09-04T00:00:00.000Z",
    };
    const saved = new Map([[readable.messageId, readable]]);
    let unreadable = true;
    const load = vi.spyOn(storage, "load").mockImplementation(async () => ({
      messages: [...saved.values()],
      errors: unreadable
        ? [
            new ThreadOutboxStorageError({
              operation: "read-message",
              environmentId: null,
              threadId: null,
              messageId: null,
              fileName: "unreadable.json",
              cause: new Error("unreadable record"),
            }),
          ]
        : [],
    }));
    const remove = vi.spyOn(storage, "remove").mockImplementation(async (message) => {
      saved.delete(message.messageId);
    });
    onTestFinished(() => {
      load.mockRestore();
      remove.mockRestore();
    });

    await expect(manager.load()).resolves.toBe(false);
    await expect(manager.confirmQueued(readable)).resolves.toBe(true);
    await expect(removeThreadOutboxMessage(readable)).resolves.toBe(true);
    await drafts.releaseUnusedComposerAttachmentFiles([file]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    expect(composerAttachmentCleanupMocks.releaseUploads).not.toHaveBeenCalled();

    const recovered = {
      ...readable,
      environmentId: EnvironmentId.make("environment-2"),
      messageId: MessageId.make("message-recovered"),
      commandId: CommandId.make("command-recovered"),
    };
    saved.set(recovered.messageId, recovered);
    unreadable = false;
    await expect(manager.load()).resolves.toBe(true);
    await drafts.releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    expect(composerAttachmentCleanupMocks.releaseUploads).not.toHaveBeenCalled();

    await removeThreadOutboxMessage(recovered);
    await drafts.releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
    expect(composerAttachmentCleanupMocks.releaseUploads).toHaveBeenCalledWith(
      file.uploadEnvironmentId,
      [file.uploadedAttachmentId],
    );
  });
  it("hydrates persisted drafts before a cold-start sweep deletes their files", async () => {
    const file = {
      id: "file-cold-start",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {
        "environment-1:thread-1": { text: "Persisted draft", attachments: [file] },
      },
    });
    vi.resetModules();
    const fresh = await import("./use-composer-drafts");
    const freshRegistry = (await import("./atom-registry")).appAtomRegistry;

    await fresh.releaseUnusedComposerAttachmentFiles([file]);

    expect(freshRegistry.get(fresh.composerDraftsAtom)).toEqual({
      "environment-1:thread-1": {
        text: "Persisted draft [report.pdf](t3-context://v1/file/file-cold-start) ",
        attachments: [file],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: file.id,
              kind: "file",
              label: file.name,
              attachmentId: file.id,
              name: file.name,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
            },
          ],
        },
      },
    });
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
  });
});

