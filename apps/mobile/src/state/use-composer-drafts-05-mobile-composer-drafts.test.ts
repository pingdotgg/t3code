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
  it("hydrates selector state even when the message content is empty", () => {
    const hydrated = Object.entries(
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
    );
    expect(hydrated).toHaveLength(1);
    const [key, draft] = hydrated[0]!;

    expect(key).toMatch(/^new-task:[0-9a-z-]+$/);
    expect(draft).toEqual({
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
      project: {
        environmentId: "environment-1",
        projectId: "project-1",
        createdAt: expect.any(String),
      },
    });
  });
});

