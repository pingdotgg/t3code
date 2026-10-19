import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage });
});
afterAll(() => vi.unstubAllGlobals());
import {
  DraftId,
  useComposerDraftStore,
  partializeComposerDraftStoreState,
  hydrateImagesFromPersisted,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  prepareQueuedEditPayload,
  prepareQueuedMessageEditDraft,
  recoverQueuedMessageEdit,
  releaseQueuedMessageEditDraft,
} from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const edit = {
  editId: CommandId.make("edit-1"),
  sequence: 1,
  runId: RunId.make("run-1"),
  messageId: MessageId.make("message-1"),
};

const file: ComposerFileAttachment = {
  type: "file",
  id: "file:report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
  file: new File(["report"], "report.pdf", { type: "application/pdf" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "image:screen",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const emptyContent = {
  images: [],
  files: [],
  terminalContexts: [],
  reviewComments: [],
  previewAnnotations: [],
  threadContexts: [],
};
const payloadEdit = { ...edit, sourceText: "", originalText: "", originalAttachmentIds: [] };
const uploadedFile = {
  type: "file" as const,
  id: "upload:report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditPayload({
      edit: payloadEdit,
      content: { ...emptyContent, images, files: [file] },
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments.attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditPayload({
        edit: payloadEdit,
        content: { ...emptyContent, images: [image], files: [file] },
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("Retry or remove");
  });

  it("keeps file-only edits when another client starts the queued run", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    store.addFiles(editTarget, [file]);
    expect(
      recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "Original message" }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([file]);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("preserves uploaded file references when a remote queue advance interrupts the edit", () => {
    const store = useComposerDraftStore.getState();
    const uploaded = {
      ...file,
      file: null,
      uploadedAttachmentId: uploadedFile.id,
      uploadEnvironmentId: environmentId,
    };
    store.addFiles(editTarget, [uploaded]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([uploaded]);
  });

  it("does not overwrite a separate draft when the queued run leaves", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.addFiles(editTarget, [file]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe(
      "retained",
    );
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)?.files).toEqual([file]);
  });

  it("restores ownership and dirty content through draft hydration, then releases locally", async () => {
    const store = useComposerDraftStore.getState();
    await prepareQueuedMessageEditDraft({
      editTarget,
      edit,
      environmentId,
      text: "Original",
      attachments: [],
      readImage: async () => {
        throw new Error("unused");
      },
    });
    store.setPrompt(editTarget, "");
    store.setPrompt(threadTarget, "Separate draft");
    const persisted = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    const merge = useComposerDraftStore.persist.getOptions().merge!;
    useComposerDraftStore.setState(merge(persisted, useComposerDraftStore.getState()));
    expect(store.getComposerDraft(editTarget)?.queuedEdit?.ownership).toEqual({
      editId: edit.editId,
      sequence: 1,
    });
    expect(store.getComposerDraft(editTarget)?.prompt).toBe("");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    releaseQueuedMessageEditDraft(editTarget);
    expect(store.getComposerDraft(editTarget)).toBeNull();
    expect(
      partializeComposerDraftStoreState(useComposerDraftStore.getState()).draftsByThreadKey[
        editTarget
      ],
    ).toBeUndefined();
  });

  it("retains the acquired hold through attachment failure and reload until Cancel succeeds", async () => {
    const store = useComposerDraftStore.getState();
    await expect(
      prepareQueuedMessageEditDraft({
        editTarget,
        edit,
        environmentId,
        text: "Original",
        attachments: [
          {
            type: "image",
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
          },
        ],
        readImage: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    // Cleanup cannot reach the server while offline, so ownership must survive reload.
    const persisted = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    useComposerDraftStore.setState(
      useComposerDraftStore.persist.getOptions().merge!(
        persisted,
        useComposerDraftStore.getState(),
      ),
    );
    const draft = store.getComposerDraft(editTarget)!;
    expect(draft.queuedEdit?.ownership).toEqual({ editId: edit.editId, sequence: edit.sequence });
    await expect(
      prepareQueuedEditPayload({
        edit: draft.queuedEdit!,
        content: draft,
        readImage: async () => {
          throw new Error("unused");
        },
        uploadFiles: async () => [],
      }),
    ).rejects.toThrow("attachment could not be restored");
    // The normal Cancel path clears the draft only after the token's release succeeds.
    store.clearComposerContent(editTarget);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("recovers text typed while failed image preparation was pending after release", async () => {
    const store = useComposerDraftStore.getState();
    let rejectFetch!: (error: Error) => void;
    const fetch = new Promise<never>((_resolve, reject) => {
      rejectFetch = reject;
    });
    const preparation = prepareQueuedMessageEditDraft({
      editTarget,
      edit,
      environmentId,
      text: "Original",
      attachments: [image],
      readImage: () => fetch,
    });
    const preparedEdit = store.getComposerDraft(editTarget)!.queuedEdit!;
    store.setPrompt(editTarget, "Keep what I typed during loading");
    rejectFetch(new Error("offline"));
    await expect(preparation).rejects.toThrow("offline");
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: preparedEdit.originalText,
        originalAttachmentIds: preparedEdit.originalAttachmentIds,
        expectedEdit: preparedEdit,
      }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Keep what I typed during loading");
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("leaves a replacement fallback edit intact after an old preparation fails", async () => {
    const store = useComposerDraftStore.getState();
    let rejectFetch!: (error: Error) => void;
    const fetch = new Promise<never>((_resolve, reject) => {
      rejectFetch = reject;
    });
    const preparation = prepareQueuedMessageEditDraft({
      editTarget,
      edit: { ...edit, editId: null },
      environmentId,
      text: "Original",
      attachments: [image],
      readImage: () => fetch,
    });
    const preparedEdit = store.getComposerDraft(editTarget)!.queuedEdit!;
    store.clearComposerContent(editTarget);
    await prepareQueuedMessageEditDraft({
      editTarget,
      edit: { ...edit, editId: null },
      environmentId,
      text: "Original",
      attachments: [],
      readImage: async () => {
        throw new Error("unused");
      },
    });
    store.setPrompt(editTarget, "Replacement edit");
    const replacement = store.getComposerDraft(editTarget);
    rejectFetch(new Error("offline"));
    await expect(preparation).rejects.toThrow("offline");
    recoverQueuedMessageEdit({
      editTarget,
      threadTarget,
      originalText: preparedEdit.originalText,
      originalAttachmentIds: preparedEdit.originalAttachmentIds,
      expectedEdit: preparedEdit,
    });
    expect(store.getComposerDraft(editTarget)).toBe(replacement);
    expect(store.getComposerDraft(threadTarget)).toBeNull();
  });

  it.each(["text", "attachments"])(
    "retains an older dirty edit separately when server %s changes",
    async (change) => {
      const store = useComposerDraftStore.getState();
      const prepare = (text: string, attachments: (typeof uploadedFile)[]) =>
        prepareQueuedMessageEditDraft({
          editTarget,
          edit,
          environmentId,
          text,
          attachments,
          readImage: async () => {
            throw new Error("unused");
          },
        });
      await prepare("Original", []);
      store.setPrompt(editTarget, "My older edit");
      releaseQueuedMessageEditDraft(editTarget);
      await prepare("Original", []);
      expect(store.getComposerDraft(editTarget)?.prompt).toBe("My older edit");
      releaseQueuedMessageEditDraft(editTarget);
      await prepare(
        change === "text" ? "New server text" : "Original",
        change === "attachments" ? [uploadedFile] : [],
      );
      const fresh = store.getComposerDraft(editTarget)!;
      expect(fresh.prompt).toContain(change === "text" ? "New server text" : "Original");
      expect(fresh.files.map((file) => file.id)).toEqual(
        change === "attachments" ? [uploadedFile.id] : [],
      );
      const retained = Object.entries(useComposerDraftStore.getState().draftsByThreadKey).find(
        ([key]) => key.startsWith(`${editTarget}:saved:`),
      )?.[1];
      expect(retained?.prompt).toBe("My older edit");
      expect(retained?.queuedEdit?.ownership).toBeUndefined();
      const retainedKey = Object.keys(useComposerDraftStore.getState().draftsByThreadKey).find(
        (key) => key.startsWith(editTarget + ":saved:"),
      )!;
      store.setPrompt(DraftId.make(retainedKey), "");
      expect(store.getComposerDraft(DraftId.make(retainedKey))).toBeNull();
    },
  );

  it.each(["attachment removal", "text edit"])(
    "recovers the selected server attachments after %s and restart",
    async (change) => {
      const store = useComposerDraftStore.getState();
      const first = {
        type: "image" as const,
        id: "saved:first",
        name: "first.png",
        mimeType: "image/png",
        sizeBytes: 5,
      };
      const second = { ...first, id: "saved:second", name: "second.png" };
      const savedFile = { ...uploadedFile, id: "saved:file" };
      const attachments = [first, second, savedFile];
      await prepareQueuedMessageEditDraft({
        editTarget,
        edit,
        environmentId,
        text: "Original message",
        attachments,
        readImage: async (attachment) => ({
          file: new File(["image"], attachment.name, { type: attachment.mimeType }),
          dataUrl: "data:image/png;base64,aW1hZ2U=",
        }),
      });
      const originalText = store.getComposerDraft(editTarget)!.prompt;
      store.setPrompt(threadTarget, "Unrelated main draft");
      if (change === "attachment removal") {
        store.removeImage(editTarget, first.id);
        expect(store.getComposerDraft(editTarget)?.prompt).toBe(originalText);
      } else store.setPrompt(editTarget, `${originalText} edited`);
      expect(
        recoverQueuedMessageEdit({
          editTarget,
          threadTarget,
          originalText,
          originalAttachmentIds: attachments.map((attachment) => attachment.id),
        }),
      ).toBe("retained");
      const persisted = JSON.parse(
        JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
      );
      expect(
        persisted.draftsByThreadKey["queued-edit:test"].attachments.map(
          (attachment: { id: string }) => attachment.id,
        ),
      ).toEqual(change === "attachment removal" ? [second.id] : [first.id, second.id]);
      expect(
        hydrateImagesFromPersisted(persisted.draftsByThreadKey["queued-edit:test"].attachments).map(
          (attachment) => attachment.id,
        ),
      ).toEqual(change === "attachment removal" ? [second.id] : [first.id, second.id]);
      expect(persisted.draftsByThreadKey["queued-edit:test"].files).toEqual([
        expect.objectContaining({ attachmentId: savedFile.id, environmentId }),
      ]);
      expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Unrelated main draft");
    },
  );
  it("saves bound existing image and file references, then removes them without orphaning text", async () => {
    const store = useComposerDraftStore.getState();
    const savedImage = {
      type: "image" as const,
      id: "server-image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 5,
      source: {
        kind: "snap-shot" as const,
        capturedAt: "2026-10-19T00:00:00.000Z",
        appName: "Browser",
        windowTitle: "Test",
      },
    };
    const savedFile = { ...uploadedFile, id: "server-file" };
    const attachments = [savedFile, savedImage];
    const records = attachments.map((attachment, index) => ({
      version: 1 as const,
      ...(attachment.type === "file" ? { kind: "file" as const } : { kind: "image" as const }),
      contextId: ComposerContextId.make(`local-context-${index}`),
      label: attachment.name,
      attachmentId: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    }));
    const text = records.map(formatComposerContextReference).join(" ");
    await prepareQueuedMessageEditDraft({
      editTarget,
      edit: { ...edit, context: { version: 1, records } },
      environmentId,
      text,
      attachments,
      readImage: async () => ({ file: image.file, dataUrl: "data:image/png;base64,aW1hZ2U=" }),
    });
    const readImage = vi.fn(async () => "data:image/png;base64,aW1hZ2U=");
    const save = () => {
      const draft = store.getComposerDraft(editTarget)!;
      return prepareQueuedEditPayload({
        edit: draft.queuedEdit!,
        content: draft,
        readImage,
        uploadFiles: async (files) =>
          files.map((file) => ({ ...savedFile, id: file.uploadedAttachmentId! })),
      });
    };
    store.setPrompt(editTarget, store.getComposerDraft(editTarget)!.prompt + " edited");
    const kept = await save();
    expect(readImage).not.toHaveBeenCalled();
    expect(kept.attachments).toEqual(attachments);
    expect(kept.attachments.map((attachment) => attachment.id)).toEqual([
      savedFile.id,
      savedImage.id,
    ]);
    const refs = collectComposerContextReferences(store.getComposerDraft(editTarget)!.prompt);
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(
        kept.context.records.find((record) => record.contextId === ref.contextId),
      ).toMatchObject({
        attachmentId: ref.kind === "image" ? savedImage.id : savedFile.id,
      });
    }
    const savedText = store.getComposerDraft(editTarget)!.prompt;
    store.clearComposerContent(editTarget);
    await prepareQueuedMessageEditDraft({
      editTarget,
      edit: { ...edit, context: kept.context },
      environmentId,
      text: savedText,
      attachments: kept.attachments,
      readImage: async () => ({ file: image.file, dataUrl: "data:image/png;base64,aW1hZ2U=" }),
    });
    store.removeImage(editTarget, savedImage.id);
    store.removeFile(editTarget, savedFile.id);
    const persisted = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    const merge = useComposerDraftStore.persist.getOptions().merge!;
    useComposerDraftStore.setState(merge(persisted, useComposerDraftStore.getState()));
    const removed = await save();
    expect(removed.attachments).toEqual([]);
    expect(removed.context.records).toEqual([]);
    expect(collectComposerContextReferences(store.getComposerDraft(editTarget)!.prompt)).toEqual(
      [],
    );
  });

  it("rejects an image lost during persistence but saves an intentional removal after hydration", async () => {
    const store = useComposerDraftStore.getState();
    const saved = {
      type: "image" as const,
      id: "server-image",
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    };
    const prepare = () =>
      prepareQueuedMessageEditDraft({
        editTarget,
        edit,
        environmentId,
        text: "Original",
        attachments: [saved],
        readImage: async () => ({ file: image.file, dataUrl: "data:image/png;base64,aW1hZ2U=" }),
      });
    await prepare();
    store.setPrompt(threadTarget, "Occupied draft");
    // Simulate the quota verifier omitting the image while retaining owned edit metadata.
    const persisted = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    persisted.draftsByThreadKey[editTarget].attachments = [];
    const merge = useComposerDraftStore.persist.getOptions().merge!;
    useComposerDraftStore.setState(merge(persisted, useComposerDraftStore.getState()));
    const save = () => {
      const draft = store.getComposerDraft(editTarget)!;
      return prepareQueuedEditPayload({
        edit: draft.queuedEdit!,
        content: draft,
        readImage: async () => "unused",
        uploadFiles: async () => [],
      });
    };
    await expect(save()).rejects.toThrow("attachment could not be restored");
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "Original",
        originalAttachmentIds: [saved.id],
      }),
    ).toBe("clean");
    expect(store.getComposerDraft(editTarget)).toBeNull();
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Occupied draft");
    // Missing content cannot be reused as an intentional selection when reopening.
    await prepare();
    expect(store.getComposerDraft(editTarget)?.images.map((image) => image.id)).toEqual([saved.id]);
    store.removeImage(editTarget, saved.id);
    const removed = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    useComposerDraftStore.setState(merge(removed, useComposerDraftStore.getState()));
    expect((await save()).attachments).toEqual([]);
    await prepare();
    expect(store.getComposerDraft(editTarget)?.images).toEqual([]);
  });
});
