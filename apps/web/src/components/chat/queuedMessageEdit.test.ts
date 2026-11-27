import {
  ChatAttachmentId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectFactId,
  RunId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { projectKnowledgeContextRecord } from "@t3tools/client-runtime/projectKnowledge";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { submitQueuedRunEdit } from "./useQueuedRunEdit";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { readAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { environmentContextRecord, responseContextRecord } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import {
  matchRestorableQueuedAttachment,
  prepareQueuedEditAttachments,
  recoverQueuedMessageEdit,
} from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const originalModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "original-model",
};
const changedModelSelection = { ...originalModelSelection, model: "changed-model" };
const originalMessage = {
  editTarget,
  threadTarget,
  originalText: "Original message",
  originalReplyTo: null,
};
const reply = responseContextRecord({
  citation: {
    version: 1,
    environmentId,
    threadId: ThreadId.make("thread:edit"),
    messageId: MessageId.make("message:answer"),
    text: "Done.",
    start: 0,
    end: 5,
    prefix: "",
    suffix: "",
  },
  itemId: TurnItemId.make("item:answer"),
  subagents: [],
});
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
const uploadedFile = {
  type: "file" as const,
  id: "upload:report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  it("saves newly attached knowledge references in the queued message context", async () => {
    const record = projectKnowledgeContextRecord({
      environmentId,
      projectId: ProjectId.make("project"),
      selections: [{ kind: "fact", factId: ProjectFactId.make("fact"), revision: 1 }],
      maxBytes: 48000,
    });
    const editQueuedRun = vi.fn().mockResolvedValue({ _tag: "Success", value: undefined });
    const error = await submitQueuedRunEdit({
      environmentId,
      draftTarget: editTarget,
      editing: {
        threadId: threadTarget.threadId,
        runId: RunId.make("run"),
        messageId: MessageId.make("message"),
        originalText: "Original message",
        followsThreadSelection: true,
        originalAttachments: [],
        existingAttachments: [],
      },
      content: {
        prompt: "Edited with project memory",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        images: [],
        files: [],
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: [],
        threadContexts: [],
        knowledgeContexts: [record],
        environmentContexts: [],
      },
      editQueuedRun,
      draftChanged: () => false,
    });
    expect(error).toBeNull();
    expect(editQueuedRun.mock.calls[0]?.[0].input.edit.context.records).toEqual([record]);
  });

  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [],
      images,
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditAttachments({
        existingAttachments: [],
        images: [image],
        files: [file],
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("Retry or remove");
  });

  it("keeps file-only edits when another client starts the queued run", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    const elsewhere: ComposerFileAttachment = {
      ...uploadedFile,
      id: "file:elsewhere",
      name: "elsewhere.pdf",
      file: null,
      uploadedAttachmentId: "upload:elsewhere",
      uploadEnvironmentId: EnvironmentId.make("other-environment"),
    };
    store.addFiles(editTarget, [file, elsewhere]);
    expect(recoverQueuedMessageEdit(originalMessage)).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    // An upload this environment cannot reach comes back as a file to reattach, not a dropped chip.
    const { uploadedAttachmentId: _id, uploadEnvironmentId: _env, ...reattach } = elsewhere;
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([file, reattach]);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("keeps the mentions and reply of a kept edit in the thread draft", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Edited message");
    const thread = threadContextRecord(
      scopeThreadRef(environmentId, ThreadId.make("thread:other")),
      "Other",
    );
    const machine = environmentContextRecord(EnvironmentId.make("environment-vps"), "vps");
    store.addThreadContexts(editTarget, [thread]);
    store.addEnvironmentContexts(editTarget, [machine]);
    store.setReplyTo(editTarget, reply);
    const editedPrompt = store.getComposerDraft(editTarget)!.prompt;
    expect(recoverQueuedMessageEdit(originalMessage)).toBe("kept");
    expect(store.getComposerDraft(editTarget)).toBeNull();
    expect(store.getComposerDraft(threadTarget)).toMatchObject({
      prompt: editedPrompt,
      threadContexts: [thread],
      environmentContexts: [machine],
      replyTo: reply,
    });
  });

  it.each([
    {
      edit: "changed model",
      originalReplyTo: null,
      replyTo: null,
      modelSelection: changedModelSelection,
      result: "kept",
    },
    {
      edit: "unchanged model",
      originalReplyTo: null,
      replyTo: null,
      modelSelection: originalModelSelection,
      result: "clean",
    },
    {
      edit: "added reply",
      originalReplyTo: null,
      replyTo: reply,
      originalText: "",
      result: "kept",
    },
    { edit: "removed reply", originalReplyTo: reply, replyTo: null, result: "kept" },
    {
      edit: "unchanged reply",
      originalReplyTo: reply,
      replyTo: structuredClone(reply),
      result: "clean",
    },
  ])(
    "reports $result for a queued edit with $edit",
    ({ originalReplyTo, replyTo, originalText = "Original message", modelSelection, result }) => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(editTarget, originalText);
      store.setReplyTo(editTarget, replyTo);
      if (modelSelection) store.setModelSelection(editTarget, modelSelection, { explicit: true });
      expect(
        recoverQueuedMessageEdit({
          editTarget,
          threadTarget,
          originalText,
          originalReplyTo,
          originalModelSelection,
        }),
      ).toBe(result);
      if (result === "kept" && modelSelection) {
        expect(
          store.getComposerDraft(threadTarget)?.modelSelectionByProvider[modelSelection.instanceId],
        ).toEqual(modelSelection);
      }
      expect(store.getComposerDraft(editTarget)).toBeNull();
      expect(store.getComposerDraft(threadTarget)).toEqual(
        result === "kept" ? expect.objectContaining({ prompt: originalText, replyTo }) : null,
      );
    },
  );

  it("reports a removed queued attachment as an edit when the run leaves", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    expect(
      recoverQueuedMessageEdit({
        ...originalMessage,
        removedExistingAttachment: true,
      }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    store.clearComposerContent(threadTarget);
    // An attachment-only message leaves nothing to put back in the composer.
    expect(
      recoverQueuedMessageEdit({
        ...originalMessage,
        originalText: "",
        removedExistingAttachment: true,
      }),
    ).toBe("discarded");
    expect(store.getComposerDraft(threadTarget)).toBeNull();
  });

  it("strips existing queued attachment references when recovering an edit into the thread draft", () => {
    const store = useComposerDraftStore.getState();
    const chip = formatInlineContextReference({
      kind: "image",
      contextId: "image_queued-1",
      label: "image.png",
    });
    store.setPrompt(editTarget, `Check ${chip} closely`);
    expect(
      recoverQueuedMessageEdit({
        ...originalMessage,
        originalText: `Check ${chip}`,
        existingAttachmentContextIds: ["image_queued-1"],
      }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Check closely");
    expect(store.getComposerDraft(editTarget)).toBeNull();

    store.clearComposerContent(threadTarget);
    store.setPrompt(editTarget, chip);
    expect(
      recoverQueuedMessageEdit({
        ...originalMessage,
        originalText: `${chip} note`,
        existingAttachmentContextIds: ["image_queued-1"],
      }),
    ).toBe("discarded");
    expect(store.getComposerDraft(threadTarget)).toBeNull();
  });

  it("matches a removed queued attachment for same-environment paste while rejecting other environments or payloads", () => {
    const fileId = ChatAttachmentId.make("server-file-1");
    const contextId = ComposerContextId.make("file_local-1");
    const removedAttachment = {
      type: "file" as const,
      id: fileId,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    const record = {
      version: 1 as const,
      kind: "file" as const,
      contextId,
      label: "notes.txt",
      attachmentId: fileId,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };

    expect(
      matchRestorableQueuedAttachment({
        environmentId,
        sourceEnvironmentId: environmentId,
        record,
        removedQueuedAttachments: [{ attachment: removedAttachment, contextIds: [contextId] }],
      }),
    ).toEqual({ attachment: removedAttachment, contextId });

    expect(
      matchRestorableQueuedAttachment({
        environmentId,
        sourceEnvironmentId: EnvironmentId.make("other-environment"),
        record,
        removedQueuedAttachments: [{ attachment: removedAttachment, contextIds: [contextId] }],
      }),
    ).toBeNull();

    expect(
      matchRestorableQueuedAttachment({
        environmentId,
        sourceEnvironmentId: environmentId,
        record: { ...record, attachmentId: ChatAttachmentId.make("different-file") },
        removedQueuedAttachments: [{ attachment: removedAttachment, contextIds: [contextId] }],
      }),
    ).toBeNull();
  });

  it("does not overwrite a separate draft when the queued run leaves", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.addFiles(editTarget, [file]);
    useAttachmentUploadStore.setState({
      uploadsByImageId: {
        [file.id]: { status: "ready", environmentId, attachmentId: uploadedFile.id },
      },
    });
    expect(recoverQueuedMessageEdit({ ...originalMessage, originalText: "" })).toBe("discarded");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)).toBeNull();
    expect(readAttachmentUpload(file.id)).toBeUndefined();
  });
});
