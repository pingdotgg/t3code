import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("../lib/uuid", () => ({ uuidv4: () => "saved-edit" }));
import {
  ChatAttachmentId,
  CommandId,
  EnvironmentId,
  ComposerContextId,
  MessageId,
  RunId,
  type ChatAttachment,
} from "@t3tools/contracts";

import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";
import { queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  beginQueuedRunEdit,
  prepareQueuedRunEditDraft,
  canReuseQueuedRunEditDraft,
  recoverQueuedRunEdit,
  getQueuedRunEdit,
  forgetQueuedRunEdit,
  endQueuedRunEdit,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";
import { appAtomRegistry } from "./atom-registry";
import {
  composerDraftsAtom,
  decodePersistedComposerState,
  getComposerDraftSnapshot,
  replaceComposerDraftAttachments,
  removeComposerDraftAttachment,
  setComposerDraftText,
} from "./use-composer-drafts";

const image = (id: string) => ({
  type: "image" as const,
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
});

function edit(attachments: ReadonlyArray<ChatAttachment>): QueuedRunEdit {
  return {
    editId: CommandId.make("edit-1"),
    sequence: 1,
    runId: RunId.make("run-1"),
    messageId: MessageId.make("message-1"),
    originalText: "original",
    originalAttachmentIds: attachments.map((attachment) => attachment.id),
  };
}

describe("queued edit draft key", () => {
  it("keeps the environment readable so attachment uploads still resolve it", () => {
    const key = queuedEditDraftKey("env-1:thread-9", "run-3");

    expect(composerDraftEnvironmentId(key, [])).toBe("env-1");
  });
});

describe("resolveQueuedEditPayload", () => {
  it("restores owned edits after persisted draft hydration and across thread navigation", () => {
    vi.useFakeTimers();
    try {
      const first = "env:thread-reload";
      const second = "env:other-thread";
      appAtomRegistry.set(composerDraftsAtom, {});
      beginQueuedRunEdit(first, edit([]), []);
      setComposerDraftText(queuedEditDraftKey(first, "run-1"), "");
      beginQueuedRunEdit(second, { ...edit([]), editId: CommandId.make("edit-2") }, []);
      const restored = decodePersistedComposerState(
        JSON.parse(
          JSON.stringify({ schemaVersion: 1, drafts: appAtomRegistry.get(composerDraftsAtom) }),
        ),
      );
      appAtomRegistry.set(composerDraftsAtom, {});
      expect(getQueuedRunEdit(first)).toBeNull();
      appAtomRegistry.set(composerDraftsAtom, restored.drafts);
      expect(getQueuedRunEdit(first)?.editId).toBe("edit-1");
      expect(getQueuedRunEdit(second)?.editId).toBe("edit-2");
      expect(getComposerDraftSnapshot(queuedEditDraftKey(first, "run-1")).text).toBe("");
      recoverQueuedRunEdit(first);
      expect(
        appAtomRegistry.get(composerDraftsAtom)[queuedEditDraftKey(first, "run-1")],
      ).toBeUndefined();
      endQueuedRunEdit(first);
      expect(getQueuedRunEdit(first)).toBeNull();
      expect(getQueuedRunEdit(second)?.editId).toBe("edit-2");
    } finally {
      appAtomRegistry.set(composerDraftsAtom, {});
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps failed preparation owned across hydration and drops untouched content after release", async () => {
    vi.useFakeTimers();
    try {
      const threadKey = "env:failed-open";
      appAtomRegistry.set(composerDraftsAtom, {});
      const editing = edit([image("original-image")]);
      await expect(
        prepareQueuedRunEditDraft(threadKey, editing, async () => {
          throw new Error("offline");
        }),
      ).rejects.toThrow("offline");
      const restored = decodePersistedComposerState(
        JSON.parse(
          JSON.stringify({
            schemaVersion: 1,
            drafts: appAtomRegistry.get(composerDraftsAtom),
          }),
        ),
      );
      appAtomRegistry.set(composerDraftsAtom, restored.drafts);
      expect(getQueuedRunEdit(threadKey)?.editId).toBe(editing.editId);
      expect(
        getComposerDraftSnapshot(queuedEditDraftKey(threadKey, editing.runId)).queuedEdit
          ?.originalAttachmentIds,
      ).toEqual(["original-image"]);
      expect(recoverQueuedRunEdit(threadKey)).toBe(false);
      expect(getQueuedRunEdit(threadKey)).toBeNull();
      expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({});
    } finally {
      appAtomRegistry.set(composerDraftsAtom, {});
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps a replacement fallback edit when an old attachment import rejects", async () => {
    vi.useFakeTimers();
    try {
      const threadKey = "env:replaced-import";
      appAtomRegistry.set(composerDraftsAtom, {});
      const editing = { ...edit([image("original-image")]), editId: null };
      const read = Promise.withResolvers<never>();
      const preparation = prepareQueuedRunEditDraft(threadKey, editing, () => read.promise);
      const preparedEdit = getComposerDraftSnapshot(
        queuedEditDraftKey(threadKey, editing.runId),
      ).queuedEdit!;
      endQueuedRunEdit(threadKey);
      const replacement = { ...editing, originalAttachmentIds: [] };
      beginQueuedRunEdit(threadKey, replacement, []);
      const replacementKey = queuedEditDraftKey(threadKey, replacement.runId);
      setComposerDraftText(replacementKey, "Keep replacement edit");
      const draft = getComposerDraftSnapshot(replacementKey);
      read.reject(new Error("offline"));
      await expect(preparation).rejects.toThrow("offline");
      recoverQueuedRunEdit(threadKey, preparedEdit);
      expect(getQueuedRunEdit(threadKey)?.runId).toBe(replacement.runId);
      expect(getComposerDraftSnapshot(replacementKey)).toEqual(draft);
      expect(getComposerDraftSnapshot(replacementKey).queuedEdit?.ownership).toBe(
        draft.queuedEdit?.ownership,
      );
    } finally {
      appAtomRegistry.set(composerDraftsAtom, {});
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["text", "attachments"])(
    "keeps a retained edit separate from newer server %s",
    (change) => {
      vi.useFakeTimers();
      try {
        const threadKey = "env:stale-thread";
        const draftKey = queuedEditDraftKey(threadKey, "run-1");
        appAtomRegistry.set(composerDraftsAtom, {});
        beginQueuedRunEdit(threadKey, edit([]), []);
        setComposerDraftText(draftKey, "My older edit");
        forgetQueuedRunEdit(threadKey);
        beginQueuedRunEdit(threadKey, edit([]), []);
        expect(getComposerDraftSnapshot(draftKey).text).toBe("My older edit");
        forgetQueuedRunEdit(threadKey);
        const newer = {
          ...edit(change === "attachments" ? [image("new")] : []),
          originalText: change === "text" ? "New server text" : "original",
        };
        beginQueuedRunEdit(
          threadKey,
          newer,
          change === "attachments"
            ? [
                {
                  type: "image",
                  id: "new",
                  name: "new.png",
                  mimeType: "image/png",
                  sizeBytes: 10,
                  previewUri: "data:image/png;base64,YWJj",
                  dataUrl: "data:image/png;base64,YWJj",
                },
              ]
            : [],
        );
        expect(getComposerDraftSnapshot(draftKey).text).toBe(newer.originalText);
        expect(
          getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
        ).toEqual(change === "attachments" ? ["new"] : []);
        const retained = Object.entries(appAtomRegistry.get(composerDraftsAtom)).find(([key]) =>
          key.startsWith(`${draftKey}~saved~`),
        )?.[1];
        expect(retained?.text).toBe("My older edit");
        expect(retained?.queuedEdit?.ownership).toBeUndefined();
        const retainedKey = Object.keys(appAtomRegistry.get(composerDraftsAtom)).find((key) =>
          key.includes("~saved~"),
        )!;
        setComposerDraftText(retainedKey, "");
        expect(appAtomRegistry.get(composerDraftsAtom)[retainedKey]).toBeUndefined();
      } finally {
        appAtomRegistry.set(composerDraftsAtom, {});
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["attachment removal", "text edit"])(
    "recovers the selected attachments after %s and restart beside an occupied main draft",
    (change) => {
      vi.useFakeTimers();
      try {
        const threadKey = "env:thread";
        const editing = edit([image("first"), image("second")]);
        const draftKey = queuedEditDraftKey(threadKey, editing.runId);
        const main = { text: "Unrelated draft", attachments: [] };
        appAtomRegistry.set(composerDraftsAtom, { [threadKey]: main });
        beginQueuedRunEdit(
          threadKey,
          editing,
          [image("first"), image("second")].map((attachment) => ({
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUri: "data:image/png;base64,YWJj",
            dataUrl: "data:image/png;base64,YWJj",
            uploadedAttachmentId: attachment.id,
            uploadEnvironmentId: EnvironmentId.make("env"),
            source: {
              kind: "snap-shot" as const,
              capturedAt: "2026-10-19T00:00:00.000Z",
              appName: "Browser",
              windowTitle: "Test",
            },
          })),
        );
        if (change === "attachment removal") {
          replaceComposerDraftAttachments(
            draftKey,
            getComposerDraftSnapshot(draftKey).attachments.filter(
              (attachment) => attachment.id !== "first",
            ),
          );
          expect(getComposerDraftSnapshot(draftKey).text).toBe(editing.originalText);
        } else setComposerDraftText(draftKey, "edited");
        expect(recoverQueuedRunEdit(threadKey)).toBe(true);
        expect(getQueuedRunEdit(threadKey)).toBeNull();
        const restored = decodePersistedComposerState(
          JSON.parse(
            JSON.stringify({ schemaVersion: 1, drafts: appAtomRegistry.get(composerDraftsAtom) }),
          ),
        );
        expect(restored.drafts[threadKey]).toEqual(main);
        appAtomRegistry.set(composerDraftsAtom, restored.drafts);
        expect(
          canReuseQueuedRunEditDraft(
            threadKey,
            editing.runId,
            editing.originalText,
            editing.originalAttachmentIds.map((id) => ({ id })),
          ),
        ).toBe(true);
        expect(restored.drafts[draftKey]?.attachments.map((attachment) => attachment.id)).toEqual(
          change === "attachment removal" ? ["second"] : ["first", "second"],
        );
        expect(restored.drafts[draftKey]?.attachments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "second",
              uploadedAttachmentId: "second",
              uploadEnvironmentId: "env",
              source: expect.objectContaining({ kind: "snap-shot" }),
            }),
          ]),
        );
      } finally {
        appAtomRegistry.set(composerDraftsAtom, {});
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("keeps distinct stored context identities on save and removes references with their attachments", () => {
    vi.useFakeTimers();
    try {
      const threadKey = "env:binding";
      const draftKey = queuedEditDraftKey(threadKey, "run-1");
      const saved = [
        image("server-image"),
        { ...image("server-file"), type: "file" as const, mimeType: "application/pdf" },
      ];
      const records = saved.map((attachment, index) => ({
        version: 1 as const,
        contextId: ComposerContextId.make(`local-context-${index}`),
        ...(attachment.type === "file" ? { kind: "file" as const } : { kind: "image" as const }),
        label: attachment.name,
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      }));
      const originalText = records.map(formatComposerContextReference).join(" ");
      appAtomRegistry.set(composerDraftsAtom, {});
      beginQueuedRunEdit(
        threadKey,
        { ...edit(saved), originalText, context: { version: 1, records } },
        saved.map((attachment) => ({
          ...attachment,
          ...(attachment.type === "file"
            ? { type: "file" as const, fileUri: "file:///report.pdf" }
            : {
                type: "image" as const,
                previewUri: "data:image/png;base64,YWJj",
                dataUrl: "data:image/png;base64,YWJj",
              }),
        })),
      );
      const draft = getComposerDraftSnapshot(draftKey);
      expect(collectComposerContextReferences(draft.text)).toHaveLength(2);
      const kept = resolveQueuedEditPayload({
        draftContext: draft.context,
        draftAttachments: draft.attachments,
        uploaded: saved,
      });
      expect(kept.attachments).toEqual(saved);
      expect(kept.context?.records.map((record) => record.contextId)).toEqual(
        records.map((record) => record.contextId),
      );
      for (const attachment of saved) removeComposerDraftAttachment(draftKey, attachment.id);
      const removed = getComposerDraftSnapshot(draftKey);
      expect(collectComposerContextReferences(removed.text)).toEqual([]);
      expect(
        resolveQueuedEditPayload({
          draftContext: removed.context,
          draftAttachments: removed.attachments,
          uploaded: [],
        }),
      ).toEqual({ attachments: [], context: undefined });
    } finally {
      appAtomRegistry.set(composerDraftsAtom, {});
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
