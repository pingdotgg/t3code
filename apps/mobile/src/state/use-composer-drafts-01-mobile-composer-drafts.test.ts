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
  it.each([false, true])(
    "restores visible file chips from legacy drafts (archived: %s)",
    async (archived) => {
      const file = {
        type: "file" as const,
        id: "legacy-file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        fileUri: "file:///notes.txt",
      };
      const image = { ...file, id: "photo", name: "photo.png", mimeType: "image/png" };
      const video = { ...file, id: "video", name: "clip.mp4", mimeType: "video/mp4" };
      const legacy = { text: "Review these", attachments: [file, image, video] };
      const document = {
        schemaVersion: 1,
        drafts: archived ? {} : { thread: legacy },
        ...(archived
          ? { signedOutDrafts: { account: { drafts: { thread: legacy }, queuedMessages: [] } } }
          : {}),
      };
      const decoded = decodePersistedComposerState(document);
      const restored = archived
        ? decoded.cloudDrafts.signedOut.account?.drafts.thread
        : decoded.drafts.thread;
      expect(restored?.text).toBe("Review these [notes.txt](t3-context://v1/file/legacy-file) ");
      expect(restored?.attachments).toEqual(legacy.attachments);
      expect(restored?.context?.records).toEqual([
        expect.objectContaining({ kind: "file", attachmentId: file.id }),
      ]);
      expect(
        decodePersistedComposerState({ schemaVersion: 1, drafts: { thread: restored } }).drafts
          .thread,
      ).toEqual(restored);
      appAtomRegistry.set(composerDraftsAtom, { thread: restored! });
      setComposerDraftText("thread", "Review these");
      expect(getComposerDraftSnapshot("thread").attachments).toEqual([image, video]);
      await releaseUnusedComposerAttachmentFiles([file]);
    },
  );
  it("restores a missing file reference without duplicating its record or replacing another record's id", () => {
    const file = {
      type: "file" as const,
      id: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      fileUri: "file:///notes.txt",
    };
    const existing = {
      version: 1,
      contextId: "original",
      kind: "file",
      label: file.name,
      attachmentId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    };
    const skill = { version: 1, contextId: "file", kind: "skill", label: "Skill", name: "skill" };
    for (const records of [[existing, skill], [skill]]) {
      const restored = decodePersistedComposerState({
        schemaVersion: 1,
        drafts: {
          thread: { text: "", attachments: [file], context: { version: 1, records } },
        },
      }).drafts.thread;
      expect(restored?.context?.records).toHaveLength(2);
      expect(restored?.context?.records).toContainEqual(skill);
      expect(restored?.text).toBe(
        `[notes.txt](t3-context://v1/file/${records.length === 2 ? "original" : "file_2"}) `,
      );
    }
  });
  it.each([false, true])(
    "restores deleted file chips and releases undo history (uploaded: %s)",
    async (uploaded) => {
      const key = "environment:undo-file";
      const file = {
        type: "file" as const,
        id: "undo-file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        fileUri: "file:///documents/t3-composer-attachments/undo-file.txt",
        ...(uploaded
          ? {
              uploadedAttachmentId: "pending-upload",
              uploadEnvironmentId: EnvironmentId.make("environment"),
            }
          : {}),
      };
      appendComposerDraftAttachments(key, [file], { appendReference: true });
      const original = getComposerDraftSnapshot(key);
      const history = createComposerDraftContextHistory();
      const changeText = (text: string) => {
        const restored = history.restore(text, getComposerDraftSnapshot(key));
        setComposerDraftText(key, text);
        setComposerDraftContext(key, restored.context);
        appendComposerDraftAttachments(key, restored.attachments, { allowOverflow: true });
      };
      try {
        changeText("");
        expect(getComposerDraftSnapshot(key).attachments).toEqual([]);
        await releaseUnusedComposerAttachmentFiles([file]);
        expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalledWith(file.fileUri);
        changeText(original.text);
        expect(getComposerDraftSnapshot(key).context).toEqual(original.context);
        expect(getComposerDraftSnapshot(key).attachments).toEqual([
          { ...file, uploadedAttachmentId: undefined, uploadEnvironmentId: undefined },
        ]);
        changeText("");
      } finally {
        history.dispose();
      }
      await releaseUnusedComposerAttachmentFiles([file]);
      expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
    },
  );
  it("retains a pick matching cached state until the live shell confirms it", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const key = `${environmentId}:${threadId}`;
    const h = modelReconciliationHarness(environmentId, threadId, "cached");
    const pick = h.model();
    updateComposerDraftSettings(key, { modelSelection: pick });
    h.flush();
    const before = getComposerDraftSnapshot(key);
    expect(before.modelSelection).toEqual(pick);

    for (const status of ["empty", "synchronizing", "cached"] as const) {
      h.setStatus(status);
      expect(getComposerDraftSnapshot(key)).toEqual(before);
    }
    h.update({ modelSelection: { ...pick, model: "remote-model" } }, "live");
    expect(getComposerDraftSnapshot(key)).toEqual(before);
    h.update({ modelSelection: pick }, "synchronizing");
    expect(getComposerDraftSnapshot(key)).toEqual(before);
    h.setStatus("live");
    expect(appAtomRegistry.get(composerDraftsAtom)[key]).toBeUndefined();
  });
  it("releases an inactive thread pick only after its queued model becomes durable", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const key = `${environmentId}:${threadId}`;
    const pick = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
    setComposerDraftText(key, "keep this unsent follow-up");
    appendComposerDraftAttachments(
      key,
      [
        {
          type: "file",
          id: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
          fileUri: "file:///notes.txt",
        },
      ],
      { appendReference: true },
    );
    updateComposerDraftSettings(key, {
      modelSelection: pick,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    const before = getComposerDraftSnapshot(key);
    const remoteKey = `environment-remote:${threadId}`;
    updateComposerDraftSettings(remoteKey, { modelSelection: pick });
    const remoteBefore = getComposerDraftSnapshot(remoteKey);
    const h = modelReconciliationHarness(environmentId, threadId);

    h.update({ status: "queued" });
    expect(getComposerDraftSnapshot(key)).toEqual(before);
    h.update({
      status: "running",
      modelSelection: { ...pick, options: [{ id: "fastMode", value: false }] },
    });
    expect(getComposerDraftSnapshot(key)).toEqual({ ...before, modelSelection: undefined });
    expect(getComposerDraftSnapshot(remoteKey)).toEqual(remoteBefore);

    h.update({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
    });
    expect(getComposerDraftSnapshot(key).modelSelection ?? h.model()).toEqual(h.model());
    expect(getComposerDraftSnapshot(key)).toEqual({ ...before, modelSelection: undefined });
  });
  it("retains an unavailable provider pick through differing durable model updates", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const key = `${environmentId}:${threadId}`;
    const pick: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex-secondary"),
      model: "gpt-5.5",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    };
    updateComposerDraftSettings(key, { modelSelection: pick });
    const before = getComposerDraftSnapshot(key);
    const h = modelReconciliationHarness(environmentId, threadId);
    expect(getComposerDraftSnapshot(key)).toEqual(before);
    for (const modelSelection of [
      { ...pick, instanceId: ProviderInstanceId.make("codex") },
      { ...pick, model: "gpt-5.4" },
      { ...pick, options: [{ id: "reasoningEffort", value: "high" }] },
      {
        ...pick,
        options: [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ],
      },
    ]) {
      h.update({ modelSelection });
      expect(getComposerDraftSnapshot(key)).toEqual(before);
    }
    h.update({ modelSelection: { ...pick, options: pick.options!.toReversed() } });
    expect(appAtomRegistry.get(composerDraftsAtom)[key]).toBeUndefined();
  });
  it("drops chips and records for attachments a replace no longer keeps", () => {
    const key = "new-task:draft-1";
    const kept = {
      type: "file" as const,
      id: "kept-file",
      name: "kept.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      fileUri: "file:///kept.txt",
    };
    const dropped = {
      type: "file" as const,
      id: "dropped-file",
      name: "dropped.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      fileUri: "file:///dropped.txt",
    };
    appendComposerDraftAttachments(key, [kept, dropped], { appendReference: true });

    const before = getComposerDraftSnapshot(key);
    expect(before.text).toContain("dropped.txt");
    expect(before.context?.records).toHaveLength(2);

    replaceComposerDraftAttachments(key, [kept]);

    const after = getComposerDraftSnapshot(key);
    expect(after.attachments.map((attachment) => attachment.id)).toEqual([kept.id]);
    expect(after.text).not.toContain("dropped.txt");
    expect(after.context?.records.map((record) => record.contextId)).toEqual([
      before.context?.records[0]?.contextId,
    ]);
  });
  it("keeps over-limit recovery context reloadable without losing other drafts", () => {
    const key = "environment-1:recovery";
    const merged = mergeComposerDraftContentState(
      { [key]: contextDraft(0, 200), other: DRAFT },
      key,
      contextDraft(200, 200),
    );
    expect(merged[key]?.context?.records).toHaveLength(400);
    const reloaded = decodePersistedComposerState(
      JSON.parse(JSON.stringify({ schemaVersion: 1, drafts: merged })),
    ).drafts;
    expect(reloaded[key]).toEqual(merged[key]);
    expect(reloaded.other).toEqual(DRAFT);
  });
  it("prunes unreferenced context during a content merge", () => {
    const existing = contextDraft(0, 2);
    const incoming = contextDraft(2, 2);
    const merged = mergeComposerDraftContentState(
      { key: { ...existing, text: "[Skill](t3-context://v1/skill/skill-0)" } },
      "key",
      { ...incoming, text: "[Skill](t3-context://v1/skill/skill-2)" },
    );
    expect(merged.key?.context?.records.map((record) => record.contextId)).toEqual([
      "skill-0",
      "skill-2",
    ]);
  });
});

