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
  it("keeps share-import receipts on otherwise contentless new-task drafts", () => {
    const receiptDraft: ComposerDraft = {
      text: "",
      attachments: [],
      importedShareIds: ["share-1"],
    };

    const stripped = Object.values(
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
    );
    expect(stripped).toHaveLength(1);
    expect(stripped[0]).toMatchObject({
      text: "",
      attachments: [],
      importedShareIds: ["share-1"],
      project: { environmentId: "environment-1", projectId: "project-1" },
    });
    expect(stripped[0]?.modelSelection).toBeUndefined();

    const kept = Object.values(
      decodePersistedComposerState({
        schemaVersion: 1,
        drafts: { "new-task:environment-1:project-1": receiptDraft },
      }).drafts,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject(receiptDraft);
  });
  it("migrates project-keyed new-task drafts to id keys with the project stamped in", () => {
    const now = "2026-09-05T12:00:00.000Z";
    const [key, draft] = migrateLegacyNewTaskDraft(
      "new-task:environment-1:project-1",
      { text: "keep me", attachments: [] },
      now,
    );

    expect(key).toMatch(/^new-task:[0-9a-z-]+$/);
    expect(draft).toEqual({
      text: "keep me",
      attachments: [],
      project: {
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
        createdAt: now,
      },
    });

    const stamped: ComposerDraft = {
      text: "x",
      attachments: [],
      project: {
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
        createdAt: now,
      },
    };
    expect(migrateLegacyNewTaskDraft("new-task:some-id", stamped, now)).toEqual([
      "new-task:some-id",
      stamped,
    ]);
    expect(migrateLegacyNewTaskDraft("environment-1:thread-1", DRAFT, now)).toEqual([
      "environment-1:thread-1",
      DRAFT,
    ]);
    expect(migrateLegacyNewTaskDraft("pending-task:message-1", DRAFT, now)).toEqual([
      "pending-task:message-1",
      DRAFT,
    ]);
  });
  it("keeps a freshly minted new-task draft bound until content arrives, then lists it per project", () => {
    const project = {
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    };
    const first = createNewTaskDraft(project);
    const second = createNewTaskDraft(project);
    expect(first).not.toBe(second);

    expect(appAtomRegistry.get(composerDraftsAtom)[first]?.project).toMatchObject(project);

    setComposerDraftText(first, "first idea");
    setComposerDraftText(second, "second idea");
    expect(findNewTaskDraftKeys(appAtomRegistry.get(composerDraftsAtom), project)).toEqual(
      expect.arrayContaining([first, second]),
    );

    clearComposerDraftContent(first, { clearModelSelection: true, clearWorkspaceSelection: true });
    expect(appAtomRegistry.get(composerDraftsAtom)[first]).toBeUndefined();
    expect(getComposerDraftSnapshot(second).text).toBe("second idea");
  });
  it("retargets a new-task draft to another project without losing its text", () => {
    const from = {
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    };
    const to = {
      environmentId: EnvironmentId.make("environment-2"),
      projectId: ProjectId.make("project-2"),
    };
    const key = createNewTaskDraft(from);
    setComposerDraftText(key, "moving house");
    appAtomRegistry.set(composerDraftsAtom, {
      ...appAtomRegistry.get(composerDraftsAtom),
      [key]: {
        ...getComposerDraftSnapshot(key),
        runtimeMode: "approval-required",
        workspaceSelection: { mode: "worktree", branch: "feature/a", worktreePath: null },
      },
    });
    const createdAt = getComposerDraftSnapshot(key).project?.createdAt;

    retargetNewTaskDraft(key, to);

    const moved = getComposerDraftSnapshot(key);
    expect(moved.text).toBe("moving house");
    expect(moved.runtimeMode).toBe("approval-required");

    expect(moved.workspaceSelection).toBeUndefined();
    expect(moved.project).toEqual({ ...to, createdAt });
    expect(findNewTaskDraftKeys(appAtomRegistry.get(composerDraftsAtom), from)).toEqual([]);
    expect(findNewTaskDraftKeys(appAtomRegistry.get(composerDraftsAtom), to)).toEqual([key]);
  });
  it("merges persisted option memory without replacing newer choices", async () => {
    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {},
      modelOptionMemory: {
        pi: {
          "xai/grok-4.6": [{ id: "thinking", value: "high" }],
          "openai/gpt-5.4": [{ id: "thinking", value: "medium" }],
        },
      },
    });
    appAtomRegistry.set(modelOptionMemoryAtom, {
      pi: { "xai/grok-4.6": [{ id: "thinking", value: "xhigh" }] },
    });

    ensureComposerDraftsLoaded();
    await waitForComposerDraftsLoaded();

    expect(appAtomRegistry.get(modelOptionMemoryAtom)).toEqual({
      pi: {
        "xai/grok-4.6": [{ id: "thinking", value: "xhigh" }],
        "openai/gpt-5.4": [{ id: "thinking", value: "medium" }],
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

    setComposerDraftText("new-task:environment-1:project-1", "New prompt");

    const flush = flushComposerDrafts();
    await vi.advanceTimersByTimeAsync(200);

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
});

