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
  it("restores and persists both full cloud and live context drafts", async () => {
    const load = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => load.mockRestore());
    await waitForComposerDraftsLoaded();
    const key = "environment-1:restored";
    appAtomRegistry.set(composerDraftsAtom, { [key]: contextDraft(0, 200) });
    appAtomRegistry.set(composerCloudDraftsAtom, {
      accountId: null,
      signedOut: { account: { drafts: { [key]: contextDraft(200, 200) }, queuedMessages: [] } },
    });
    await restoreCloudComposerDrafts("account");
    expect(getComposerDraftSnapshot(key).context?.records).toHaveLength(400);
    const reloaded = decodePersistedComposerState(JSON.parse(composerDraftFileMocks.getDocument()));
    expect(reloaded.drafts[key]?.context?.records).toHaveLength(400);
    expect(reloaded.cloudDrafts.signedOut).toEqual({});
  });
  it.each([
    { name: "notes.txt", mimeType: "text/plain" },
    { name: "document-photo.png", mimeType: "image/png" },
    { name: "recording.mp4", mimeType: "video/mp4" },
  ])(
    "removes $name after its last reference is deleted, while retaining native images",
    async ({ name, mimeType }) => {
      const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
      onTestFinished(() => outboxLoad.mockRestore());
      const cleanup = Promise.withResolvers<void>();
      composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
        cleanup.resolve();
      });
      const key = "environment-1:remove-context-files";
      const file = {
        id: "file-1",
        type: "file" as const,
        name,
        mimeType,
        sizeBytes: 4,
        fileUri: `file:///${name}`,
      };
      const image = {
        ...file,
        id: "image-1",
        type: "image" as const,
        name: "image.png",
        mimeType: "image/png",
        fileUri: "file:///image.png",
        previewUri: "file:///image.png",
      };
      appendComposerDraftAttachments(key, [file, image], { appendReference: true });
      const fileLink = formatComposerContextReference(
        getComposerDraftSnapshot(key).context!.records[0]!,
      );
      setComposerDraftText(key, `${fileLink} ${fileLink}`);
      expect(getComposerDraftSnapshot(key).attachments).toEqual([file, image]);
      setComposerDraftText(key, fileLink);
      expect(getComposerDraftSnapshot(key).attachments).toEqual([file, image]);
      expect(
        countComposerDraftAttachmentsAfterSelection(key, {
          text: fileLink,
          start: 0,
          end: fileLink.length,
        }),
      ).toBe(1);
      setComposerDraftText(key, "plain text");
      expect(getComposerDraftSnapshot(key).attachments).toEqual([image]);
      await cleanup.promise;
    },
  );
  it("rejects attachments atomically when no context slots remain", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const cleanup = Promise.withResolvers<void>();
    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      cleanup.resolve();
    });
    const key = "environment-1:full-context";
    const records = Array.from({ length: 200 }, (_, index) => ({
      version: 1 as const,
      contextId: `ctx-${index}` as never,
      kind: "skill" as const,
      label: "Skill",
      name: "skill",
    }));
    appAtomRegistry.set(composerDraftsAtom, {
      [key]: {
        text: records
          .map((record) => `[Skill](t3-context://v1/skill/${record.contextId})`)
          .join(" "),
        context: { version: 1, records },
        attachments: [],
      },
    });
    const before = getComposerDraftSnapshot(key);
    expect(
      appendComposerDraftAttachments(
        key,
        [
          {
            id: "overflow",
            type: "file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            fileUri: "file:///overflow.txt",
          },
        ],
        { appendReference: true },
      ),
    ).toBe(1);
    expect(getComposerDraftSnapshot(key)).toEqual(before);
    await cleanup.promise;
  });
  it.each(["environment-1:thread", "environment-1:new-task:draft"])(
    "preserves the captured paste selection across async writes in %s",
    async (key) => {
      const file = {
        id: "paste",
        type: "file" as const,
        name: "pasted-text.txt",
        mimeType: "text/plain",
        sizeBytes: 40_000,
        fileUri: "file:///paste.txt",
      };
      setComposerDraftText(key, "before selected after");
      const insertion = captureComposerDraftInsertion(key, { start: 7, end: 15 });
      const write = Promise.withResolvers<typeof file>();
      const pending = write.promise.then((attachment) =>
        appendComposerDraftAttachments(key, [attachment], { appendReference: true, insertion }),
      );
      rememberComposerDraftSelection(key, insertion.text, { start: 0, end: 6 });
      rememberComposerDraftSelection("another-draft", "unrelated", { start: 0, end: 9 });
      write.resolve(file);
      expect(await pending).toBe(0);
      const draft = getComposerDraftSnapshot(key);
      expect(draft.text).toBe("before [pasted-text.txt](t3-context://v1/file/paste) after");
      expect(draft.attachments).toEqual([file]);
    },
  );
  it("preserves edits made while a paste is pending instead of deleting stale offsets", async () => {
    const key = "environment-1:typing-during-paste";
    setComposerDraftText(key, "old selection");
    const insertion = captureComposerDraftInsertion(key, { start: 0, end: 13 });
    const write = Promise.withResolvers<void>();
    const pending = write.promise.then(() => insertComposerDraftText(key, " pasted", insertion));
    setComposerDraftText(key, "keep newly typed text");
    write.resolve();
    await pending;
    expect(getComposerDraftSnapshot(key).text).toBe("keep newly typed text pasted");
  });
  it.each(["attachment", "context", "imported context"])(
    "releases a selected file when replaced by %s",
    async (kind) => {
      const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
      onTestFinished(() => outboxLoad.mockRestore());
      const cleanup = Promise.withResolvers<void>();
      composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
        cleanup.resolve();
        return undefined;
      });
      const key = "environment-1:replace-file";
      const files = Array.from({ length: 100 }, (_, index) => ({
        id: `file-${index}`,
        type: "file" as const,
        name: `notes-${index}.txt`,
        mimeType: "text/plain",
        sizeBytes: 4,
        fileUri: `file:///notes-${index}.txt`,
      }));
      appendComposerDraftAttachments(key, files, { appendReference: true });
      const firstLink = "[notes-0.txt](t3-context://v1/file/file-0)";
      const insertion = captureComposerDraftInsertion(key, { start: 0, end: firstLink.length });
      expect(countComposerDraftAttachmentsAfterSelection(key, insertion)).toBe(99);
      expect(getComposerDraftAfterSelection(key, insertion).context?.records).toHaveLength(99);
      const replacement = { ...files[0]!, id: "replacement", fileUri: "file:///replacement.txt" };
      if (kind === "attachment") {
        expect(
          appendComposerDraftAttachments(key, [replacement], { appendReference: true, insertion }),
        ).toBe(0);
      } else if (kind === "imported context") {
        const record = {
          version: 1 as const,
          kind: "file" as const,
          contextId: ComposerContextId.make("replacement"),
          attachmentId: replacement.id,
          label: replacement.name,
          name: replacement.name,
          mimeType: replacement.mimeType,
          sizeBytes: replacement.sizeBytes,
        };
        expect(
          insertComposerDraftContext(
            key,
            {
              text: formatComposerContextReference(record),
              context: { version: 1, records: [record] },
              attachments: [replacement],
            },
            insertion,
          ),
        ).toBe(true);
        expect(getComposerDraftSnapshot(key).attachments).toHaveLength(100);
        expect(getComposerDraftSnapshot(key).context?.records).toContainEqual(record);
        expect(getComposerDraftSnapshot(key).text).toBe(
          `${formatComposerContextReference(record)}${insertion.text.slice(firstLink.length)}`,
        );
      } else {
        insertComposerDraftContext(
          key,
          { text: "replacement", context: { version: 1, records: [] } },
          insertion,
        );
      }
      const draft = getComposerDraftSnapshot(key);
      expect(draft.attachments.map((file) => file.id)).not.toContain("file-0");
      expect(draft.attachments.slice(0, 99)).toEqual(files.slice(1));
      expect(draft.context?.records.some((record) => record.contextId === "file-0")).toBe(false);
      await cleanup.promise;
      expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(files[0]!.fileUri);
    },
  );
  it("rejects an imported file atomically when edits during import use up its replacement slot", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const cleanup = Promise.withResolvers<void>();
    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      cleanup.resolve();
      return undefined;
    });
    const key = "environment-1:concurrent-import";
    const files = Array.from({ length: 100 }, (_, index) => ({
      id: `existing-${index}`,
      type: "file" as const,
      name: `notes-${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: 4,
      fileUri: `file:///notes-${index}.txt`,
    }));
    appendComposerDraftAttachments(key, files, { appendReference: true });
    const firstLink = "[notes-0.txt](t3-context://v1/file/existing-0)";
    const insertion = captureComposerDraftInsertion(key, { start: 0, end: firstLink.length });
    setComposerDraftText(key, `New edit ${insertion.text}`);
    const edited = getComposerDraftSnapshot(key);
    const imported = { ...files[0]!, id: "imported", fileUri: "file:///imported.txt" };
    const record = {
      version: 1 as const,
      kind: "file" as const,
      contextId: ComposerContextId.make("imported"),
      attachmentId: imported.id,
      label: imported.name,
      name: imported.name,
      mimeType: imported.mimeType,
      sizeBytes: imported.sizeBytes,
    };
    expect(
      insertComposerDraftContext(
        key,
        {
          text: formatComposerContextReference(record),
          context: { version: 1, records: [record] },
          attachments: [imported],
        },
        insertion,
      ),
    ).toBe(false);
    expect(getComposerDraftSnapshot(key)).toEqual(edited);
    await cleanup.promise;
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(imported.fileUri);
  });
  it("retains a file when replacing only one of its repeated references", () => {
    const key = "environment-1:repeat-reference";
    const file = {
      id: "repeat",
      type: "file" as const,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      fileUri: "file:///repeat.txt",
    };
    appendComposerDraftAttachments(key, [file], { appendReference: true });
    const link = getComposerDraftSnapshot(key).text;
    setComposerDraftText(key, `${link} ${link}`);
    const insertion = captureComposerDraftInsertion(key, { start: 0, end: link.length });
    expect(countComposerDraftAttachmentsAfterSelection(key, insertion)).toBe(1);
    insertComposerDraftContext(
      key,
      { text: "replaced", context: { version: 1, records: [] } },
      insertion,
    );
    expect(getComposerDraftSnapshot(key).attachments).toEqual([file]);
    expect(getComposerDraftSnapshot(key).text).toBe(`replaced ${link}`);
  });
});

