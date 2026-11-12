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
  it("inserts context at the saved caret and retains its payload through persistence and restore", () => {
    const draftKey = "context-environment:context-thread";
    const record = {
      version: 1 as const,
      kind: "terminal" as const,
      contextId: ComposerContextId.make("context-terminal"),
      label: "Build output",
      terminalId: "main",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "Build failed",
    };
    const reference = "[Build output](t3-context://v1/terminal/context-terminal)";
    setComposerDraftText(draftKey, "Fix this next");
    rememberComposerDraftSelection(draftKey, "Fix this next", { start: 4, end: 8 });
    insertComposerDraftContext(draftKey, {
      text: reference,
      context: { version: 1, records: [record] },
    });
    const draft = getComposerDraftSnapshot(draftKey);
    expect(draft.text).toBe(`Fix ${reference} next`);
    const decoded = decodePersistedComposerState(
      JSON.parse(JSON.stringify({ schemaVersion: 1, drafts: { [draftKey]: draft } })),
    ).drafts[draftKey];
    expect(decoded?.context?.records).toEqual([record]);
    const restored = mergeComposerDraftContentState(
      { [draftKey]: { text: "Additional work", attachments: [] } },
      draftKey,
      decoded!,
    );
    expect(restored[draftKey]?.text).toContain(reference);
    expect(restored[draftKey]?.context?.records).toEqual([record]);
    expect(clearComposerDraftContentState(restored, draftKey)[draftKey]?.context).toBeUndefined();
    setComposerDraftText(draftKey, "Fix next");
    expect(getComposerDraftSnapshot(draftKey).context).toBeUndefined();
  });
  it("keeps each draft's caret when another composer moves its own caret", () => {
    const threadKey = "caret-environment:caret-thread";
    const newTaskKey = "caret-environment:new-task:caret-draft";
    setComposerDraftText(threadKey, "Fix this next");
    setComposerDraftText(newTaskKey, "Another task");
    rememberComposerDraftSelection(threadKey, "Fix this next", { start: 4, end: 8 });
    rememberComposerDraftSelection(newTaskKey, "Another task", { start: 2, end: 2 });
    insertComposerDraftContext(threadKey, {
      text: "[Build output](t3-context://v1/terminal/caret-terminal)",
      context: {
        version: 1,
        records: [
          {
            version: 1,
            kind: "terminal",
            contextId: ComposerContextId.make("caret-terminal"),
            label: "Build output",
            terminalId: "main",
            terminalLabel: "Terminal",
            lineStart: 1,
            lineEnd: 1,
            text: "Build failed",
          },
        ],
      },
    });
    expect(getComposerDraftSnapshot(threadKey).text).toBe(
      "Fix [Build output](t3-context://v1/terminal/caret-terminal) next",
    );
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
    const existing = Array.from({ length: 99 }, (_, index) => makeAttachment(`held-${index}`));
    appAtomRegistry.set(composerDraftsAtom, {
      [draftKey]: { text: "send this", attachments: existing },
    });

    const rejected = appendComposerDraftAttachments(draftKey, [
      makeAttachment("incoming-1"),
      makeAttachment("incoming-2"),
    ]);

    expect(rejected).toBe(1);
    const draft = appAtomRegistry.get(composerDraftsAtom)[draftKey];
    expect(draft?.attachments).toHaveLength(100);
    expect(draft?.attachments.at(-1)?.id).toBe("incoming-1");
    await cleanup.promise;
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledExactlyOnceWith(
      makeAttachment("incoming-2").fileUri,
    );

    const overflowRejected = appendComposerDraftAttachments(
      draftKey,
      [makeAttachment("restored-1")],
      { allowOverflow: true },
    );
    expect(overflowRejected).toBe(0);
    expect(appAtomRegistry.get(composerDraftsAtom)[draftKey]?.attachments).toHaveLength(101);
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
});

