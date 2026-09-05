import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
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

import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import {
  appendComposerDraftAttachments,
  archiveCloudComposerDrafts,
  clearComposerDraftContent,
  clearComposerDraftContentState,
  clearComposerDraftsEnvironment,
  ComposerDraftPersistenceError,
  composerDraftsAtom,
  composerCloudDraftsAtom,
  copyComposerDraftContentIfEmpty,
  copyComposerDraftContentState,
  decodePersistedComposerState,
  ensureComposerDraftsLoaded,
  type ComposerDraft,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContentState,
  releaseUnusedComposerAttachmentFiles,
  removeComposerDraftsForEnvironment,
  resetComposerDraftsLoadState,
  retainComposerAttachmentFileForPreview,
  restoreComposerDraftSnapshotState,
  restoreCloudComposerDrafts,
  setComposerDraftText,
  setComposerDraftAttachmentUpload,
  waitForComposerDraftsLoaded,
  setStickyComposerModelSelection,
  stickyComposerModelSelectionAtom,
  undoComposerDraftMerge,
  undoComposerDraftMergeState,
} from "./use-composer-drafts";

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
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  composerAttachmentCleanupMocks.remove.mockClear();
  composerAttachmentCleanupMocks.releaseUploads.mockReset();
  composerAttachmentCleanupMocks.releaseUploads.mockResolvedValue(undefined);
  incomingShareStorageMocks.load.mockReset();
  incomingShareStorageMocks.load.mockResolvedValue([]);
});

describe("mobile composer drafts", () => {
  // Hydration is one-shot per module instance and the attachment sweep now
  // triggers it too, so this test must observe it before any sweep test runs.
  it("waits for persisted drafts before copying content between projects", async () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const unrelatedKey = "environment-1:thread-1";
    const source = { text: "Current task", attachments: [] } satisfies ComposerDraft;
    const target = { text: "Persisted target", attachments: [] } satisfies ComposerDraft;
    const unrelated = { text: "Keep me", attachments: [] } satisfies ComposerDraft;

    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {
        [targetKey]: target,
        [unrelatedKey]: unrelated,
      },
    });
    composerDraftFileMocks.blockRead();
    appAtomRegistry.set(composerDraftsAtom, { [sourceKey]: source });

    const copy = copyComposerDraftContentIfEmpty(sourceKey, targetKey);
    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({ [sourceKey]: source });

    composerDraftFileMocks.releaseRead();
    await copy;

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({
      [sourceKey]: source,
      [targetKey]: target,
      [unrelatedKey]: unrelated,
    });
  });

  it("hydrates generic file attachments from their saved local paths", () => {
    const file = {
      id: "file-1",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/report.pdf",
    };

    expect(
      decodePersistedComposerState({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": { text: "Review this file", attachments: [file] },
        },
      }).drafts,
    ).toEqual({
      "environment-1:thread-1": { text: "Review this file", attachments: [file] },
    });
  });

  it("releases videos rejected by the live draft limit and keeps accepted files", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const cleanup = Promise.withResolvers<void>();
    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      cleanup.resolve();
    });
    const makeAttachment = (id: string) => ({
      id,
      type: "file" as const,
      name: `${id}.mov`,
      mimeType: "video/quicktime",
      sizeBytes: 42,
      fileUri: `file:///documents/t3-composer-attachments/${id}.mov`,
    });
    const draftKey = "new-task:environment-1:project-cap";
    const existing = Array.from({ length: 7 }, (_, index) => makeAttachment(`held-${index}`));
    appAtomRegistry.set(composerDraftsAtom, {
      [draftKey]: { text: "send this", attachments: existing },
    });

    const rejected = appendComposerDraftAttachments(draftKey, [
      makeAttachment("incoming-1"),
      makeAttachment("incoming-2"),
    ]);

    expect(rejected).toBe(1);
    const draft = appAtomRegistry.get(composerDraftsAtom)[draftKey];
    expect(draft?.attachments).toHaveLength(8);
    expect(draft?.attachments.at(-1)?.id).toBe("incoming-1");
    await cleanup.promise;
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledExactlyOnceWith(
      makeAttachment("incoming-2").fileUri,
    );

    // Restore paths bypass the cap so a failed send never drops its files.
    const overflowRejected = appendComposerDraftAttachments(
      draftKey,
      [makeAttachment("restored-1")],
      { allowOverflow: true },
    );
    expect(overflowRejected).toBe(0);
    expect(appAtomRegistry.get(composerDraftsAtom)[draftKey]?.attachments).toHaveLength(9);
  });

  it("keeps shared attachment files until every draft releases them", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-1",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    appAtomRegistry.set(composerDraftsAtom, {
      source: { text: "First draft", attachments: [file] },
      copied: { text: "Second draft", attachments: [file] },
    });

    await releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    appAtomRegistry.set(composerDraftsAtom, {
      copied: { text: "Second draft", attachments: [file] },
    });
    await releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    appAtomRegistry.set(composerDraftsAtom, {});
    await releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
  });

  it("retains a referenced file-backed image and releases it once unreferenced", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const image = {
      id: "image-1",
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      fileUri: "file:///documents/t3-composer-attachments/photo.png",
      previewUri: "file:///documents/t3-composer-attachments/photo.png",
    };
    appAtomRegistry.set(composerDraftsAtom, {
      "environment-1:thread-1": { text: "look at this", attachments: [image] },
    });

    await releaseUnusedComposerAttachmentFiles([image]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    // A queued outbox message must keep the bytes alive after the draft clears.
    appAtomRegistry.set(composerDraftsAtom, {});
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
      "environment-1:thread-1": [
        {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("queued-image"),
          commandId: CommandId.make("command-image"),
          text: "look at this",
          attachments: [image],
          createdAt: "2026-08-31T12:00:00.000Z",
        },
      ],
    });
    await releaseUnusedComposerAttachmentFiles([image]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
    await releaseUnusedComposerAttachmentFiles([image]);
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledExactlyOnceWith(image.fileUri);
  });

  it("keeps an image through an inline read after its draft is removed", async () => {
    const { prepareTurnAttachments } =
      await vi.importActual<typeof import("../lib/attachmentUpload")>("../lib/attachmentUpload");
    const image = {
      id: "image-reading",
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      fileUri: "file:///documents/t3-composer-attachments/photo.png",
      previewUri: "file:///documents/t3-composer-attachments/photo.png",
    };
    const readStarted = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let imageExists = true;
    composerDraftFileMocks.readImage.mockImplementation(async () => {
      readStarted.resolve();
      await read.promise;
      if (!imageExists) throw new Error("The image was deleted during its read");
      return "YWJj";
    });
    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      imageExists = false;
      removed.resolve();
    });
    appendComposerDraftAttachments("environment-1:thread-1", [image]);
    await flushComposerDrafts();
    const preparing = prepareTurnAttachments({
      environmentId: EnvironmentId.make("environment-1"),
      attachments: [image],
    });
    onTestFinished(async () => {
      read.resolve();
      await preparing.catch(() => undefined);
    });
    await readStarted.promise;
    clearComposerDraftContent("environment-1:thread-1", { deferAttachmentCleanup: true });
    await releaseUnusedComposerAttachmentFiles([image]);
    expect(imageExists).toBe(true);

    read.resolve();
    const prepared = await preparing;
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.attachments).toEqual([
      {
        type: "image",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,YWJj",
      },
    ]);
    await removed.promise;
    expect(imageExists).toBe(false);
  });

  it("keeps a failed-send draft's pending upload for retry", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-failed-send",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/failed-send.pdf",
      uploadedAttachmentId: "pending-failed-send",
      uploadEnvironmentId: EnvironmentId.make("environment-1"),
    };
    appAtomRegistry.set(composerDraftsAtom, {
      "environment-1:thread-1": { text: "Retry this send", attachments: [file] },
    });

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    expect(composerAttachmentCleanupMocks.releaseUploads).not.toHaveBeenCalled();
  });

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

  it("cleans up an unreferenced image upload even when there is no local file URI", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const environmentId = EnvironmentId.make("environment-1");
    await releaseUnusedComposerAttachmentFiles([
      {
        id: "photo",
        type: "image",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,YWJj",
        previewUri: "file:///photo.png",
        uploadedAttachmentId: "pending-photo",
        uploadEnvironmentId: environmentId,
      },
    ]);
    expect(composerAttachmentCleanupMocks.releaseUploads).toHaveBeenCalledWith(environmentId, [
      "pending-photo",
    ]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
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
      await archiveCloudComposerDrafts("account-a", new Set([environmentId]));
      expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({
        "direct-environment:thread-1": DRAFT,
      });
      // The registry can remove the active outbox and drafts after the backup lands.
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
      expect(getComposerDraftSnapshot(key)).toEqual({ text: "Unsent notes", attachments: [file] });
      expect(getComposerDraftSnapshot("pending-task:queued-1").text).toBe("Edited queued task");
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
      archiveCloudComposerDrafts("account-a", new Set([EnvironmentId.make("environment-1")])),
    ).rejects.toThrow();
    expect(
      appAtomRegistry.get(composerCloudDraftsAtom).signedOut["account-a"]?.drafts[
        "environment-1:thread-1"
      ],
    ).toEqual(DRAFT);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    composerDraftFileMocks.setWriteError(null);
    await archiveCloudComposerDrafts(null, new Set([EnvironmentId.make("environment-1")]));
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

  it("completes local cleanup when pending upload deletion fails", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    onTestFinished(() => warning.mockRestore());
    composerAttachmentCleanupMocks.releaseUploads.mockRejectedValueOnce(
      new Error("environment disconnected"),
    );
    const file = {
      id: "file-delete-failed",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/delete-failed.pdf",
      uploadedAttachmentId: "pending-delete-failed",
      uploadEnvironmentId: EnvironmentId.make("environment-1"),
    };

    await expect(releaseUnusedComposerAttachmentFiles([file])).resolves.toBeUndefined();

    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
    expect(warning).toHaveBeenCalledWith(
      "[composer-attachments] could not remove pending upload",
      expect.objectContaining({ attachmentId: "pending-delete-failed" }),
    );
  });

  it("keeps local attachment files while an outbox message still needs them", async () => {
    const file = {
      id: "file-queued",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
      "environment-1:thread-1": [
        {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          commandId: CommandId.make("command-1"),
          text: "Review the report",
          attachments: [file],
          createdAt: "2026-08-24T12:00:00.000Z",
        },
      ],
    });

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
  });

  it("loads persisted outbox messages before deciding an attachment file is unused", async () => {
    const file = {
      id: "file-persisted",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    const load = vi.spyOn(threadOutboxManager, "load").mockImplementation(async () => {
      appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
        "environment-1:thread-1": [
          {
            environmentId: EnvironmentId.make("environment-1"),
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("message-persisted"),
            commandId: CommandId.make("command-persisted"),
            text: "Review the report",
            attachments: [file],
            createdAt: "2026-08-24T12:00:00.000Z",
          },
        ],
      });
      return true;
    });

    try {
      await releaseUnusedComposerAttachmentFiles([file]);

      expect(load).toHaveBeenCalledOnce();
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("keeps a file until its incoming share is consumed", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-incoming",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/incoming.pdf",
    };
    incomingShareStorageMocks.load
      .mockResolvedValueOnce([
        {
          schemaVersion: 1,
          id: "share-1",
          createdAt: "2026-08-28T12:00:00.000Z",
          text: "Review this file",
          attachments: [file],
          warnings: [],
        },
      ])
      .mockResolvedValueOnce([]);

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(incomingShareStorageMocks.load).toHaveBeenLastCalledWith({ strict: true });
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(incomingShareStorageMocks.load).toHaveBeenCalledTimes(2);
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
  });

  it("does not delete files when incoming share ownership cannot be loaded", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-incoming-unknown",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/incoming-unknown.pdf",
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    incomingShareStorageMocks.load.mockRejectedValueOnce(new Error("inbox unavailable"));
    onTestFinished(() => warning.mockRestore());

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(incomingShareStorageMocks.load).toHaveBeenCalledWith({ strict: true });
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
  });

  it.each(["draft", "outbox", "inbox"] as const)(
    "preserves relocated files still referenced by a persisted %s",
    async (owner) => {
      const fileName = "33333333-3333-4333-8333-333333333333-report.pdf";
      const oldFile = {
        id: "file-relocated",
        type: "file" as const,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: `file:///private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`,
      };
      const currentFile = {
        ...oldFile,
        fileUri: `file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents/t3-composer-attachments/${fileName}`,
      };
      const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
      onTestFinished(() => outboxLoad.mockRestore());
      if (owner === "draft") {
        composerDraftFileMocks.setDocument({
          schemaVersion: 1,
          drafts: { "environment-1:thread-1": { text: "Saved draft", attachments: [oldFile] } },
        });
        resetComposerDraftsLoadState();
      } else if (owner === "outbox") {
        outboxLoad.mockImplementation(async () => {
          appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
            "environment-1:thread-1": [
              {
                environmentId: EnvironmentId.make("environment-1"),
                threadId: ThreadId.make("thread-1"),
                messageId: MessageId.make("message-relocated"),
                commandId: CommandId.make("command-relocated"),
                text: "Queued draft",
                attachments: [oldFile],
                createdAt: "2026-08-28T12:00:00.000Z",
              },
            ],
          });
          return true;
        });
      } else {
        incomingShareStorageMocks.load.mockResolvedValue([
          {
            schemaVersion: 1,
            id: "share-relocated",
            createdAt: "2026-08-28T12:00:00.000Z",
            text: "Incoming file",
            attachments: [oldFile],
            warnings: [],
          },
        ]);
      }

      await releaseUnusedComposerAttachmentFiles([currentFile]);

      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

      appAtomRegistry.set(composerDraftsAtom, {});
      appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
      outboxLoad.mockResolvedValue(true);
      incomingShareStorageMocks.load.mockResolvedValue([]);
      await releaseUnusedComposerAttachmentFiles([currentFile]);

      expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(currentFile.fileUri);
    },
  );

  it("does not delete attachment files when the draft removal cannot be saved", async () => {
    const file = {
      id: "file-unsaved",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    setComposerDraftText("environment-1:thread-1", "Unsaved draft");
    composerDraftFileMocks.setWriteError(new Error("storage unavailable"));

    try {
      await expect(releaseUnusedComposerAttachmentFiles([file])).rejects.toBeInstanceOf(
        ComposerDraftPersistenceError,
      );
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    } finally {
      composerDraftFileMocks.setWriteError(null);
    }
  });

  it("rejects persisted images without image bytes or a file URI", () => {
    expect(() =>
      decodePersistedComposerState({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": {
            text: "Saved image",
            attachments: [
              {
                id: "image-1",
                type: "image",
                name: "photo.png",
                mimeType: "image/png",
                sizeBytes: 3,
                previewUri: "file:///photo.png",
              },
            ],
          },
        },
      }),
    ).toThrow();
  });

  it("hydrates selector state even when the message content is empty", () => {
    expect(
      decodePersistedComposerState({
        schemaVersion: 1,
        drafts: {
          "new-task:environment-1:project-1": {
            text: "",
            attachments: [],
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            workspaceSelection: {
              mode: "worktree",
              branch: "main",
              worktreePath: null,
            },
          },
        },
      }).drafts,
    ).toEqual({
      "new-task:environment-1:project-1": {
        text: "",
        attachments: [],
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspaceSelection: {
          mode: "worktree",
          branch: "main",
          worktreePath: null,
        },
      },
    });
  });

  it("keeps legacy content-only drafts and rejects invalid selector state", () => {
    expect(
      decodePersistedComposerState({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": DRAFT,
        },
      }).drafts,
    ).toEqual({
      "environment-1:thread-1": DRAFT,
    });

    expect(() =>
      decodePersistedComposerState({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": {
            ...DRAFT,
            runtimeMode: "sometimes-safe",
          },
        },
      }),
    ).toThrow();
  });

  it("keeps share-import receipts on otherwise contentless new-task drafts", () => {
    const receiptDraft: ComposerDraft = {
      text: "",
      attachments: [],
      importedShareIds: ["share-1"],
    };
    // The stale-model strip must not touch receipt-bearing drafts, and the
    // empty filter must keep them — or the same share would re-import after
    // restart.
    expect(
      decodePersistedComposerState({
        schemaVersion: 1,
        drafts: {
          "new-task:environment-1:project-1": {
            ...receiptDraft,
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
            },
          },
        },
      }).drafts,
    ).toEqual({
      "new-task:environment-1:project-1": {
        text: "",
        attachments: [],
        importedShareIds: ["share-1"],
      },
    });

    expect(
      decodePersistedComposerState({
        schemaVersion: 1,
        drafts: { "new-task:environment-1:project-1": receiptDraft },
      }).drafts,
    ).toEqual({ "new-task:environment-1:project-1": receiptDraft });
  });

  it("hydrates the global sticky model selection", () => {
    expect(
      decodePersistedComposerState({
        schemaVersion: 1,
        drafts: {},
        stickyModelSelection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
        },
      }).stickyModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("waits for hydration before persisting the latest composer state", async () => {
    vi.useFakeTimers();
    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {
        "environment-1:thread-1": DRAFT,
      },
      stickyModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
    });
    composerDraftFileMocks.blockRead();
    composerDraftFileMocks.resetWrites();

    ensureComposerDraftsLoaded();
    await Promise.resolve();
    // The read is blocked, hydration is pending.
    setComposerDraftText("new-task:environment-1:project-1", "New prompt");
    await vi.advanceTimersByTimeAsync(200);

    // Write should still be deferred — hydration has not resolved.
    expect(composerDraftFileMocks.getWrites()).toHaveLength(0);

    composerDraftFileMocks.releaseRead();
    // Let the loadPromise settle and chain into the deferred persist.
    await vi.runAllTimersAsync();

    expect(JSON.parse(composerDraftFileMocks.getWrites()[0]!)).toEqual({
      schemaVersion: 1,
      drafts: {
        "environment-1:thread-1": DRAFT,
        "new-task:environment-1:project-1": {
          text: "New prompt",
          attachments: [],
        },
      },
      stickyModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
    });
  });

  it("flush waits for pending hydration instead of clobbering disk", async () => {
    vi.useFakeTimers();
    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {
        "environment-1:thread-1": DRAFT,
      },
      stickyModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
    });
    composerDraftFileMocks.blockRead();
    composerDraftFileMocks.resetWrites();

    ensureComposerDraftsLoaded();
    await Promise.resolve();
    // An edit lands before hydration finishes; its debounced write is gated
    // behind the blocked read.
    setComposerDraftText("new-task:environment-1:project-1", "New prompt");

    const flush = flushComposerDrafts();
    await vi.advanceTimersByTimeAsync(200);
    // The flush must not have written the pre-hydration snapshot over disk.
    expect(composerDraftFileMocks.getWrites()).toHaveLength(0);

    composerDraftFileMocks.releaseRead();
    await flush;

    const written = JSON.parse(composerDraftFileMocks.getDocument());
    expect(written.drafts["environment-1:thread-1"]).toEqual(DRAFT);
    expect(written.drafts["new-task:environment-1:project-1"]).toEqual({
      text: "New prompt",
      attachments: [],
    });
    expect(written.stickyModelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it.each(["read", "decode"] as const)(
    "preserves saved drafts and attachment files when the draft %s fails",
    async (failure) => {
      vi.useFakeTimers();
      const file = {
        id: "saved-file",
        type: "file" as const,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: "file:///documents/t3-composer-attachments/report.pdf",
      };
      composerDraftFileMocks.setDocument({
        schemaVersion: failure === "decode" ? 999 : 1,
        drafts: { "environment-1:saved": { text: "Saved draft", attachments: [file] } },
      });
      const original = composerDraftFileMocks.getDocument();
      if (failure === "read") {
        composerDraftFileMocks.setReadError(new Error("storage unavailable"));
      }

      await expect(releaseUnusedComposerAttachmentFiles([file])).rejects.toMatchObject({
        operation: failure,
      });
      setComposerDraftText("environment-1:new", "Keep my new edits too");
      await expect(flushComposerDrafts()).rejects.toMatchObject({ operation: failure });

      expect(composerDraftFileMocks.getDocument()).toBe(original);
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    },
  );

  it("retries a failed debounced read on final flush without dropping saved drafts or new edits", async () => {
    vi.useFakeTimers();
    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: { "environment-1:saved": DRAFT },
    });
    const original = composerDraftFileMocks.getDocument();
    composerDraftFileMocks.setReadError(new Error("storage unavailable"));
    setComposerDraftText("environment-1:new", "New edits");
    await vi.advanceTimersByTimeAsync(200);
    expect(composerDraftFileMocks.getDocument()).toBe(original);

    composerDraftFileMocks.setReadError(null);
    await flushComposerDrafts();

    expect(JSON.parse(composerDraftFileMocks.getDocument()).drafts).toEqual({
      "environment-1:saved": DRAFT,
      "environment-1:new": { text: "New edits", attachments: [] },
    });
  });

  it("serializes environment cleanup after an older queued write", async () => {
    vi.useFakeTimers();
    composerDraftFileMocks.setDocument({ schemaVersion: 1, drafts: {} });
    composerDraftFileMocks.resetWrites();
    let releaseFirstWrite!: () => void;
    const firstWriteBarrier = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    composerDraftFileMocks.setNextWriteBarrier(firstWriteBarrier);
    let writeCount = 0;
    const bothWritesCommitted = new Promise<void>((resolve) => {
      composerDraftFileMocks.setOnWrite(() => {
        writeCount += 1;
        if (writeCount === 2) {
          resolve();
        }
      });
    });

    appAtomRegistry.set(composerDraftsAtom, {
      "environment-1:thread-1": DRAFT,
      "environment-2:thread-2": { text: "keep", attachments: [] },
    });
    setStickyComposerModelSelection({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    });
    await vi.advanceTimersByTimeAsync(200);

    const clear = clearComposerDraftsEnvironment(EnvironmentId.make("environment-1"));
    await Promise.resolve();
    // Cleanup write is queued behind the still-blocked debounced write.
    expect(composerDraftFileMocks.getWrites()).toHaveLength(0);

    releaseFirstWrite();
    await clear;
    await bothWritesCommitted;

    expect(JSON.parse(composerDraftFileMocks.getDocument())).toEqual({
      schemaVersion: 1,
      drafts: {
        "environment-2:thread-2": { text: "keep", attachments: [] },
      },
      stickyModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
    });
  });

  it("clears sent content without clearing the selected model or workspace", () => {
    const draftKey = "environment-1:thread-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      importedShareIds: ["share-1"],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
      },
    };

    expect(clearComposerDraftContentState({ [draftKey]: draft }, draftKey)).toEqual({
      [draftKey]: {
        modelSelection: draft.modelSelection,
        workspaceSelection: draft.workspaceSelection,
        text: "",
        attachments: [],
      },
    });
  });

  it("drops draft-local model and workspace selections after sending a new task", () => {
    const draftKey = "new-task:environment-1:project-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: false,
      },
    };

    expect(
      clearComposerDraftContentState({ [draftKey]: draft }, draftKey, {
        clearModelSelection: true,
        clearWorkspaceSelection: true,
      }),
    ).toEqual({});
  });

  it("reads the latest selector state synchronously for send", () => {
    const draftKey = "environment-1:thread-1";
    const selectedDraft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    };
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: selectedDraft });

    expect(getComposerDraftSnapshot(draftKey)).toEqual(selectedDraft);
  });

  it("carries unfinished content to a newly selected project without overwriting its settings", () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const source: ComposerDraft = {
      text: "Keep this task",
      attachments: [],
      importedShareIds: ["share-1"],
      workspaceSelection: {
        mode: "worktree",
        branch: "feature/source",
        worktreePath: null,
      },
    };
    const target: ComposerDraft = {
      text: "",
      attachments: [],
      runtimeMode: "approval-required",
    };

    expect(
      copyComposerDraftContentState(
        { [sourceKey]: source, [targetKey]: target },
        sourceKey,
        targetKey,
      ),
    ).toEqual({
      [sourceKey]: source,
      [targetKey]: {
        ...target,
        text: source.text,
        attachments: source.attachments,
        importedShareIds: source.importedShareIds,
      },
    });
  });

  it("does not overwrite unfinished content already stored for the selected project", () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const drafts: Record<string, ComposerDraft> = {
      [sourceKey]: { text: "Source task", attachments: [] },
      [targetKey]: { text: "Target task", attachments: [] },
    };

    expect(copyComposerDraftContentState(drafts, sourceKey, targetKey)).toBe(drafts);
  });

  it("merges shared content into a project draft without duplicating retries", () => {
    const draftKey = "new-task:environment-1:project-1";
    const sharedAttachment = {
      id: "share-1:image:0",
      type: "image" as const,
      name: "Screenshot.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
    };
    const existing: Record<string, ComposerDraft> = {
      [draftKey]: { text: "Existing context", attachments: [] },
    };
    const content = {
      text: "Shared note",
      attachments: [sharedAttachment],
      sourceShareId: "share-1",
    };

    const merged = mergeComposerDraftContentState(existing, draftKey, content);
    expect(merged[draftKey]).toMatchObject({
      text: "Existing context\n\nShared note",
      attachments: [sharedAttachment],
      importedShareIds: ["share-1"],
    });
    expect(mergeComposerDraftContentState(merged, draftKey, content)).toBe(merged);

    const edited = {
      ...merged,
      [draftKey]: { ...merged[draftKey]!, text: "User edited the imported context" },
    };
    expect(mergeComposerDraftContentState(edited, draftKey, content)).toBe(edited);
  });

  it("preserves existing images when shared content exceeds the draft attachment limit", () => {
    const draftKey = "new-task:environment-1:project-1";
    const image = (id: string) => ({
      id,
      type: "image" as const,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
    });
    const existingImage = image("existing");
    const sharedImages = Array.from({ length: 8 }, (_, index) => image(`shared-${index}`));

    const merged = mergeComposerDraftContentState(
      { [draftKey]: { text: "", attachments: [existingImage] } },
      draftKey,
      { text: "", attachments: sharedImages },
    );

    expect(merged[draftKey]?.attachments).toHaveLength(8);
    expect(merged[draftKey]?.attachments[0]).toEqual(existingImage);
    expect(merged[draftKey]?.attachments.at(-1)?.id).toBe("shared-6");
  });

  it("restores the exact draft captured before an interrupted share import", () => {
    const draftKey = "new-task:environment-1:project-1";
    const beforeImport: ComposerDraft = {
      text: "Existing context",
      attachments: [],
      runtimeMode: "approval-required",
    };
    const imported: ComposerDraft = {
      ...beforeImport,
      text: "Existing context\n\nShared note",
      importedShareIds: ["share-1"],
    };

    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, beforeImport),
    ).toEqual({ [draftKey]: beforeImport });
    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, {
        text: "",
        attachments: [],
      }),
    ).toEqual({});
  });

  it("removes only drafts owned by the selected environment", () => {
    const environmentId = EnvironmentId.make("environment-cloud");
    const retainedEnvironmentId = EnvironmentId.make("environment-local");

    expect(
      removeComposerDraftsForEnvironment(
        {
          [`${environmentId}:thread-cloud`]: DRAFT,
          [`new-task:${environmentId}:project-cloud`]: DRAFT,
          [`${retainedEnvironmentId}:thread-local`]: DRAFT,
          [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
        },
        environmentId,
      ),
    ).toEqual({
      [`${retainedEnvironmentId}:thread-local`]: DRAFT,
      [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
    });
  });

  it("lands a still-debounced draft write when flushed", async () => {
    const draftKey = "environment-1:thread-1";
    setComposerDraftText(draftKey, "typed right before the restart");

    await flushComposerDrafts();

    expect(JSON.parse(composerDraftFileMocks.getDocument())).toMatchObject({
      drafts: { [draftKey]: { text: "typed right before the restart" } },
    });
  });

  it("propagates a flush write failure instead of resolving as saved", async () => {
    const draftKey = "environment-1:thread-1";
    setComposerDraftText(draftKey, "unsaved");
    composerDraftFileMocks.setWriteError(new Error("storage unavailable"));

    try {
      await expect(flushComposerDrafts()).rejects.toBeInstanceOf(ComposerDraftPersistenceError);
    } finally {
      composerDraftFileMocks.setWriteError(null);
    }
  });

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

  it("persists an async merge rollback with the sticky model selection", async () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = { text: "typed before", attachments: [] };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [],
    };
    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: { [draftKey]: merged },
      stickyModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
    });

    await undoComposerDraftMerge(draftKey, snapshot, merged);

    expect(JSON.parse(composerDraftFileMocks.getDocument())).toEqual({
      schemaVersion: 1,
      drafts: { [draftKey]: snapshot },
      stickyModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
    });
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
    // The user edited the text (forcing the partial undo) and also switched
    // interaction mode, but never touched the merge-written runtime mode.
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
    // The user rewrote the leading text and attached a file mid-recovery.
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

    // Edits that broke the merged suffix keep their text untouched; only the
    // inserted attachments still come out.
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
    // A restore re-owns the second file while the first deletion is in
    // flight, after the sweep already decided both were unused.
    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      appAtomRegistry.set(composerDraftsAtom, {
        "environment-1:thread-1": { text: "restored", attachments: [reowned] },
      });
    });

    await releaseUnusedComposerAttachmentFiles([first, reowned]);

    expect(composerAttachmentCleanupMocks.remove.mock.calls).toEqual([[first.fileUri]]);
  });

  // These final tests use fresh module instances for independent hydration.
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
      "environment-1:thread-1": { text: "Persisted draft", attachments: [file] },
    });
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
  });
});
