import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  cleanup: vi.fn(),
  clearDraft: vi.fn<typeof import("./use-composer-drafts").clearComposerDraft>(),
  flushDrafts: vi.fn<typeof import("./use-composer-drafts").flushComposerDrafts>(async () => {}),
  waitForDrafts: vi.fn<typeof import("./use-composer-drafts").waitForComposerDraftsLoaded>(
    async () => {},
  ),
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
}));

vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  harness.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => undefined,
      remove: async () => undefined,
    },
  });
  return { threadOutboxManager: harness.manager };
});

vi.mock("./use-composer-drafts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./use-composer-drafts")>();
  return {
    ...original,
    clearComposerDraft: harness.clearDraft,
    flushComposerDrafts: harness.flushDrafts,
    scheduleUnusedComposerAttachmentCleanup: harness.cleanup,
    waitForComposerDraftsLoaded: harness.waitForDrafts,
  };
});

import { appAtomRegistry } from "./atom-registry";
import { clearThreadOutboxEnvironment, removeThreadOutboxMessage } from "./thread-outbox-removal";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { composerDraftsAtom } from "./use-composer-drafts";

function queuedMessage(input: {
  readonly environmentId: string;
  readonly messageId: string;
  readonly fileUri: string;
  readonly creation?: true;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId),
    threadId: ThreadId.make(`thread-${input.messageId}`),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: "Review the report",
    attachments: [
      {
        id: `file-${input.messageId}`,
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: input.fileUri,
      },
    ],
    ...(input.creation
      ? {
          creation: {
            projectId: ProjectId.make(`project-${input.messageId}`),
            workspaceMode: "local" as const,
            branch: null,
            worktreePath: null,
          },
        }
      : {}),
    createdAt: "2026-08-24T12:00:00.000Z",
  };
}

afterEach(() => {
  appAtomRegistry.set(harness.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(composerDraftsAtom, {});
  harness.cleanup.mockClear();
  harness.clearDraft.mockClear();
  harness.flushDrafts.mockReset();
  harness.flushDrafts.mockResolvedValue(undefined);
  harness.waitForDrafts.mockReset();
  harness.waitForDrafts.mockResolvedValue(undefined);
});

describe("thread outbox removal", () => {
  it("releases a removed message's attachment files with the removal itself", async () => {
    const message = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-1",
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    });
    await harness.manager.enqueue(message);

    await removeThreadOutboxMessage(message);

    expect(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(harness.cleanup).toHaveBeenCalledExactlyOnceWith(message.attachments);
  });

  it("keeps an edited message and its files when a revision-checked removal loses", async () => {
    const message = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-edited",
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
      creation: true,
    });
    await harness.manager.enqueue(message);
    const revision = harness.manager.revisionOf(message.messageId);
    const edited = { ...message, text: "edited while restoring" };
    await harness.manager.update(edited);

    await expect(removeThreadOutboxMessage(message, revision)).resolves.toBe(false);

    expect(harness.cleanup).not.toHaveBeenCalled();
    expect(harness.waitForDrafts).not.toHaveBeenCalled();
    expect(harness.clearDraft).not.toHaveBeenCalled();
    expect(harness.flushDrafts).not.toHaveBeenCalled();
    const remaining = Object.values(
      appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom),
    ).flat();
    expect(remaining).toEqual([edited]);
  });

  it("clears a removed pending task draft and includes its editor-only files", async () => {
    const message = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-pending",
      fileUri: "file:///documents/t3-composer-attachments/queued.pdf",
      creation: true,
    });
    const editorOnlyFile = {
      id: "file-editor-only",
      type: "file" as const,
      name: "editor-only.pdf",
      mimeType: "application/pdf",
      sizeBytes: 84,
      fileUri: "file:///documents/t3-composer-attachments/editor-only.pdf",
    };
    const draftKey = `pending-task:${message.messageId}`;
    appAtomRegistry.set(composerDraftsAtom, {
      [draftKey]: { text: "edited", attachments: [editorOnlyFile] },
    });
    await harness.manager.enqueue(message);

    await expect(removeThreadOutboxMessage(message)).resolves.toBe(true);

    expect(harness.waitForDrafts).toHaveBeenCalledOnce();
    expect(harness.clearDraft).toHaveBeenCalledExactlyOnceWith(draftKey, {
      deferAttachmentCleanup: true,
    });
    expect(harness.flushDrafts).toHaveBeenCalledOnce();
    expect(harness.cleanup).toHaveBeenCalledExactlyOnceWith([
      ...message.attachments,
      editorOnlyFile,
    ]);
    expect(harness.flushDrafts.mock.invocationCallOrder[0]).toBeLessThan(
      harness.cleanup.mock.invocationCallOrder[0]!,
    );
  });

  it("does not flush composer drafts when a removed creation has no editor draft", async () => {
    const message = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-without-editor-draft",
      fileUri: "file:///documents/t3-composer-attachments/queued.pdf",
      creation: true,
    });
    await harness.manager.enqueue(message);

    await expect(removeThreadOutboxMessage(message)).resolves.toBe(true);

    expect(harness.waitForDrafts).toHaveBeenCalledOnce();
    expect(harness.clearDraft).not.toHaveBeenCalled();
    expect(harness.flushDrafts).not.toHaveBeenCalled();
    expect(harness.cleanup).toHaveBeenCalledExactlyOnceWith(message.attachments);
  });

  it("releases only the cleared environment's queued attachment files", async () => {
    const cleared = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-cleared",
      fileUri: "file:///documents/t3-composer-attachments/cleared.pdf",
    });
    const kept = queuedMessage({
      environmentId: "environment-2",
      messageId: "message-kept",
      fileUri: "file:///documents/t3-composer-attachments/kept.pdf",
    });
    await harness.manager.enqueue(cleared);
    await harness.manager.enqueue(kept);

    await clearThreadOutboxEnvironment(cleared.environmentId);

    expect(harness.cleanup).toHaveBeenCalledExactlyOnceWith(cleared.attachments);
    const remaining = Object.values(
      appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom),
    ).flat();
    expect(remaining.map((message) => message.messageId)).toEqual([kept.messageId]);
  });

  it("clears only removed pending drafts and keeps drafts for live messages", async () => {
    const cleared = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-cleared-pending",
      fileUri: "file:///documents/t3-composer-attachments/cleared-pending.pdf",
      creation: true,
    });
    const replaced = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-replaced-pending",
      fileUri: "file:///documents/t3-composer-attachments/replaced-pending.pdf",
      creation: true,
    });
    const kept = queuedMessage({
      environmentId: "environment-2",
      messageId: "message-kept-pending",
      fileUri: "file:///documents/t3-composer-attachments/kept-pending.pdf",
      creation: true,
    });
    const replacement = { ...replaced, text: "replacement queued while drafts hydrate" };
    const editorOnlyFile = {
      id: "file-cleared-editor",
      type: "file" as const,
      name: "cleared-editor.pdf",
      mimeType: "application/pdf",
      sizeBytes: 84,
      fileUri: "file:///documents/t3-composer-attachments/cleared-editor.pdf",
    };
    const hydrationStarted = Promise.withResolvers<void>();
    const hydrationBarrier = Promise.withResolvers<void>();
    harness.waitForDrafts.mockImplementationOnce(async () => {
      hydrationStarted.resolve();
      await hydrationBarrier.promise;
    });
    const clearedDraftKey = `pending-task:${cleared.messageId}`;
    appAtomRegistry.set(composerDraftsAtom, {
      [clearedDraftKey]: { text: "edited", attachments: [editorOnlyFile] },
      [`pending-task:${replaced.messageId}`]: { text: "replacement", attachments: [] },
      [`pending-task:${kept.messageId}`]: { text: "other environment", attachments: [] },
    });
    await Promise.all([
      harness.manager.enqueue(cleared),
      harness.manager.enqueue(replaced),
      harness.manager.enqueue(kept),
    ]);

    const clearing = clearThreadOutboxEnvironment(cleared.environmentId);
    await hydrationStarted.promise;
    const replacing = harness.manager.enqueue(replacement);
    hydrationBarrier.resolve();
    await clearing;
    await replacing;

    expect(harness.clearDraft).toHaveBeenCalledExactlyOnceWith(clearedDraftKey, {
      deferAttachmentCleanup: true,
    });
    expect(harness.cleanup).toHaveBeenCalledExactlyOnceWith([
      ...cleared.attachments,
      ...replaced.attachments,
      editorOnlyFile,
    ]);
    const remaining = Object.values(
      appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom),
    ).flat();
    expect(remaining).toEqual(expect.arrayContaining([replacement, kept]));
  });

  it("keeps removal successful when pending draft persistence fails", async () => {
    const message = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-draft-flush-fails",
      fileUri: "file:///documents/t3-composer-attachments/queued.pdf",
      creation: true,
    });
    const flushError = new Error("composer storage unavailable");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    harness.flushDrafts.mockRejectedValueOnce(flushError);
    appAtomRegistry.set(composerDraftsAtom, {
      [`pending-task:${message.messageId}`]: { text: "edited", attachments: [] },
    });
    await harness.manager.enqueue(message);

    try {
      await expect(removeThreadOutboxMessage(message)).resolves.toBe(true);

      expect(harness.clearDraft).toHaveBeenCalledOnce();
      expect(harness.cleanup).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        "[thread-outbox] failed to clean up removed pending task drafts",
        flushError,
      );
      expect(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    } finally {
      warning.mockRestore();
    }
  });
});
