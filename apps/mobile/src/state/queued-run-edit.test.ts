import { describe, expect, it } from "vite-plus/test";
import {
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  RunId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";
import { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  beginQueuedRunEdit,
  getQueuedRunEdit,
  recoverQueuedRunEdit,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";
import { getComposerDraftSnapshot, setComposerDraftText } from "./use-composer-drafts";

const image = (id: string): ChatAttachment => ({
  type: "image",
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
});

function edit(attachments: ReadonlyArray<ChatAttachment>): QueuedRunEdit {
  return {
    runId: RunId.make("run-1"),
    messageId: MessageId.make("message-1"),
    originalText: "original",
    existingAttachments: attachments,
  };
}

function context(attachmentIds: ReadonlyArray<string>): OrchestrationMessageContext {
  return {
    version: 1,
    records: attachmentIds.map((attachmentId, index) => ({
      version: 1,
      kind: "image",
      contextId: ComposerContextId.make(`ctx-${index}`),
      label: `${attachmentId}.png`,
      attachmentId,
      name: `${attachmentId}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
    })),
  };
}

describe("queued edit draft key", () => {
  it("keeps the environment readable so attachment uploads still resolve it", () => {
    const key = queuedEditDraftKey("env-1:thread-9", "run-3");

    expect(isQueuedEditDraftKey(key)).toBe(true);
    expect(isQueuedEditDraftKey("env-1:thread-9")).toBe(false);
    expect(composerDraftEnvironmentId(key, [])).toBe("env-1");
  });
});

describe("resolveQueuedEditPayload", () => {
  it("resends the kept server attachments ahead of the newly uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: undefined,
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept", "uploaded"]);
  });

  it("rebinds context records from the draft's ids to the uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["draft-1"]),
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.context?.records).toEqual([
      expect.objectContaining({ attachmentId: "uploaded" }),
    ]);
  });

  it("drops the record of an attachment the user removed", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: context(["kept", "gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept"]);
    expect(payload.context?.records).toEqual([expect.objectContaining({ attachmentId: "kept" })]);
  });

  it("returns no context when every record lost its attachment", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments).toEqual([]);
    expect(payload.context).toBeUndefined();
  });
});

describe("recoverQueuedRunEdit", () => {
  const threadKey = "env:thread-recover";
  const runId = RunId.make("run-1");
  const editKey = queuedEditDraftKey(threadKey, runId);

  it("drops an untouched edit without restoring the sent message", () => {
    beginQueuedRunEdit(threadKey, edit([]));

    expect(recoverQueuedRunEdit(threadKey, runId)).toBe("clean");
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("");
    expect(getComposerDraftSnapshot(editKey).text).toBe("");
  });

  it("discards a changed edit when the thread draft already has content", () => {
    setComposerDraftText(threadKey, "unsent draft");
    beginQueuedRunEdit(threadKey, edit([]));
    setComposerDraftText(editKey, "revised");

    expect(recoverQueuedRunEdit(threadKey, runId)).toBe("discarded");
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("unsent draft");
    setComposerDraftText(threadKey, "");
  });

  it("ignores a run the composer is no longer editing", () => {
    beginQueuedRunEdit(threadKey, edit([]));

    expect(recoverQueuedRunEdit(threadKey, RunId.make("run-2"))).toBeNull();
    expect(getQueuedRunEdit(threadKey)?.runId).toBe(runId);
    expect(recoverQueuedRunEdit(threadKey, runId)).toBe("clean");
  });
});
