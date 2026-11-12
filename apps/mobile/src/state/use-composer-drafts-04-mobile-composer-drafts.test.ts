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
  it("retains offline image bytes and newer edits when an early upload finishes", async () => {
    const key = "environment-1:thread-1";
    const image = {
      id: "photo",
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "file:///photo.png",
    };
    const second = { ...image, id: "second", name: "second.png" };
    const uploaded = {
      ...image,
      uploadedAttachmentId: "pending-photo",
      uploadEnvironmentId: EnvironmentId.make("environment-1"),
    };
    composerDraftFileMocks.setDocument({ schemaVersion: 1, drafts: {} });
    appendComposerDraftAttachments(key, [image]);
    setComposerDraftText(key, "Edited while uploading");
    appendComposerDraftAttachments(key, [second]);
    expect(setComposerDraftAttachmentUpload(key, uploaded)).toBe(true);
    await flushComposerDrafts();

    appAtomRegistry.set(composerDraftsAtom, {});
    resetComposerDraftsLoadState();
    await waitForComposerDraftsLoaded();
    expect(getComposerDraftSnapshot(key)).toMatchObject({
      text: "Edited while uploading",
      attachments: [uploaded, second],
    });
    expect(setComposerDraftAttachmentUpload(key, { ...uploaded, id: "removed-photo" })).toBe(false);
    expect(getComposerDraftSnapshot(key).attachments).toHaveLength(2);
  });
  it.each(["file", "image"] as const)(
    "keeps signed-out %s attachments through cleanup and restart, and restores only the owning account",
    async (type) => {
      const load = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
      onTestFinished(() => load.mockRestore());
      await waitForComposerDraftsLoaded();
      const environmentId = EnvironmentId.make("cloud-environment");
      const key = `${environmentId}:thread-1`;
      const name = type === "image" ? "notes.png" : "notes.pdf";
      const metadata = {
        id: "local-notes",
        name,
        mimeType: type === "image" ? "image/png" : "application/pdf",
        sizeBytes: 42,
        fileUri: `file:///documents/t3-composer-attachments/${name}`,
        uploadEnvironmentId: environmentId,
        uploadedAttachmentId: "pending-notes",
      };
      const file =
        type === "image"
          ? { ...metadata, type, previewUri: metadata.fileUri }
          : { ...metadata, type };
      const queued = {
        environmentId,
        threadId: ThreadId.make("thread-2"),
        messageId: MessageId.make("queued-1"),
        commandId: CommandId.make("command-1"),
        text: "Send later",
        attachments: [file],
        createdAt: "2026-08-31T12:00:00.000Z",
      };
      appAtomRegistry.set(composerDraftsAtom, {
        [key]: { text: "Unsent notes", attachments: [file] },
        "direct-environment:thread-1": DRAFT,
        "pending-task:queued-1": { text: "Edited queued task", attachments: [file] },
      });
      appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, { queued: [queued] });
      await archiveCloudComposerDrafts("account-a", new Set([environmentId]), [
        environmentId,
        EnvironmentId.make("direct-environment"),
      ]);
      expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({
        "direct-environment:thread-1": DRAFT,
      });

      appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
      await clearComposerDraftsEnvironment(environmentId);
      await releaseUnusedComposerAttachmentFiles([file]);
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
      expect(composerAttachmentCleanupMocks.releaseUploads).not.toHaveBeenCalled();

      appAtomRegistry.set(composerDraftsAtom, {});
      appAtomRegistry.set(composerCloudDraftsAtom, { accountId: null, signedOut: {} });
      resetComposerDraftsLoadState();
      await waitForComposerDraftsLoaded();
      await restoreCloudComposerDrafts("account-b");
      expect(getComposerDraftSnapshot(key).attachments).toEqual([]);
      expect(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)).toEqual({});
      const enqueue = vi.spyOn(threadOutboxManager, "enqueue").mockResolvedValue();
      onTestFinished(() => enqueue.mockRestore());
      await restoreCloudComposerDrafts("account-a");
      expect(getComposerDraftSnapshot(key)).toEqual(
        type === "image"
          ? { text: "Unsent notes", attachments: [file] }
          : {
              text: "Unsent notes [notes.pdf](t3-context://v1/file/local-notes) ",
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
      );
      expect(getComposerDraftSnapshot("pending-task:queued-1").text).toBe(
        type === "image"
          ? "Edited queued task"
          : "Edited queued task [notes.pdf](t3-context://v1/file/local-notes) ",
      );
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(queued);
      expect(appAtomRegistry.get(composerCloudDraftsAtom).signedOut).toEqual({});
      const persisted = decodePersistedComposerState(
        JSON.parse(composerDraftFileMocks.getDocument()),
      );
      expect(persisted.drafts[key]?.attachments).toEqual([file]);
      expect(persisted.cloudDrafts.accountId).toBe("account-a");
    },
  );
  it("fails sign-out preservation before cleanup if a durable backup cannot be written", async () => {
    const load = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => load.mockRestore());
    await waitForComposerDraftsLoaded();
    appAtomRegistry.set(composerDraftsAtom, { "environment-1:thread-1": DRAFT });
    composerDraftFileMocks.setWriteError(new Error("Storage is full"));
    await expect(
      archiveCloudComposerDrafts("account-a", new Set([EnvironmentId.make("environment-1")]), [
        EnvironmentId.make("environment-1"),
      ]),
    ).rejects.toThrow();
    expect(
      appAtomRegistry.get(composerCloudDraftsAtom).signedOut["account-a"]?.drafts[
        "environment-1:thread-1"
      ],
    ).toEqual(DRAFT);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    composerDraftFileMocks.setWriteError(null);
    await archiveCloudComposerDrafts(null, new Set([EnvironmentId.make("environment-1")]), [
      EnvironmentId.make("environment-1"),
    ]);
    expect(
      decodePersistedComposerState(JSON.parse(composerDraftFileMocks.getDocument())).cloudDrafts
        .signedOut["account-a"]?.drafts["environment-1:thread-1"],
    ).toEqual(DRAFT);
  });
  it.each(["file", "image"] as const)(
    "keeps a removed %s until both preview and a share copy finish",
    async (type) => {
      const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
      onTestFinished(() => outboxLoad.mockRestore());
      const name = type === "image" ? "photo.png" : "recording.mp4";
      const fileName = `33333333-3333-4333-8333-333333333333-${name}`;
      const metadata = {
        id: "file-preview",
        name,
        mimeType: type === "image" ? "image/png" : "video/mp4",
        sizeBytes: 42,
        fileUri: `file:///private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`,
      };
      const file =
        type === "image"
          ? { ...metadata, type, previewUri: metadata.fileUri }
          : { ...metadata, type };
      const currentFile = {
        ...file,
        fileUri: `file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents/t3-composer-attachments/${fileName}`,
      };
      const releasePlayback = retainComposerAttachmentFileForPreview(file);
      const releaseShareCopy = retainComposerAttachmentFileForPreview(currentFile);
      onTestFinished(releasePlayback);
      onTestFinished(releaseShareCopy);

      await releaseUnusedComposerAttachmentFiles([currentFile]);
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

      releasePlayback();
      releasePlayback();
      await releaseUnusedComposerAttachmentFiles([file]);
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

      const deleted = Promise.withResolvers<void>();
      composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
        deleted.resolve();
        return undefined;
      });
      releaseShareCopy();
      await deleted.promise;

      expect(composerAttachmentCleanupMocks.remove.mock.calls).toEqual([[currentFile.fileUri]]);
    },
  );
  it("preserves a preview opened while cleanup is checking the incoming inbox", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-opening-preview",
      type: "file" as const,
      name: "recording.mp4",
      mimeType: "video/mp4",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/recording.mp4",
    };
    const ownershipReadStarted = Promise.withResolvers<void>();
    const ownershipRead = Promise.withResolvers<[]>();
    incomingShareStorageMocks.load.mockImplementationOnce(() => {
      ownershipReadStarted.resolve();
      return ownershipRead.promise;
    });

    const cleanup = releaseUnusedComposerAttachmentFiles([file]);
    await ownershipReadStarted.promise;
    const release = retainComposerAttachmentFileForPreview(file);
    onTestFinished(release);
    ownershipRead.resolve([]);
    await cleanup;
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    const deleted = Promise.withResolvers<void>();
    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      deleted.resolve();
      return undefined;
    });
    release();
    await deleted.promise;
    expect(composerAttachmentCleanupMocks.remove.mock.calls).toEqual([[file.fileUri]]);
  });
  it("removes an unreferenced local file and its pending upload", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const environmentId = EnvironmentId.make("environment-1");
    const file = {
      id: "file-discarded",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/discarded.pdf",
      uploadedAttachmentId: "pending-discarded",
      uploadEnvironmentId: environmentId,
    };

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
    expect(composerAttachmentCleanupMocks.releaseUploads).toHaveBeenCalledWith(environmentId, [
      "pending-discarded",
    ]);
  });
  it("keeps a pending upload referenced through another local file", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const environmentId = EnvironmentId.make("environment-1");
    const discarded = {
      id: "file-discarded-copy",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/discarded-copy.pdf",
      uploadedAttachmentId: "pending-shared",
      uploadEnvironmentId: environmentId,
    };
    const retained = {
      ...discarded,
      id: "file-retained-copy",
      fileUri: "file:///documents/t3-composer-attachments/retained-copy.pdf",
    };
    appAtomRegistry.set(composerDraftsAtom, {
      "environment-1:thread-1": { text: "Keep this copy", attachments: [retained] },
    });

    await releaseUnusedComposerAttachmentFiles([discarded]);

    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(discarded.fileUri);
    expect(composerAttachmentCleanupMocks.releaseUploads).not.toHaveBeenCalled();
  });
});

