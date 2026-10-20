import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
  endQueuedRunEdit,
  getQueuedRunEdit,
  recoverQueuedRunEdit,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";
import {
  clearComposerDraft,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";

vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    exists = false;
    create() {}
    write() {}
    moveSync() {}
  },
  Paths: { document: { uri: "file:///documents" } },
}));

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

  beforeEach(async () => {
    await waitForComposerDraftsLoaded();
  });

  afterEach(async () => {
    endQueuedRunEdit(threadKey);
    clearComposerDraft(threadKey);
    await flushComposerDrafts();
  });

  it("drops an untouched edit without restoring the sent message", async () => {
    beginQueuedRunEdit(threadKey, edit([]));

    const recovery = recoverQueuedRunEdit(threadKey, runId);
    await flushComposerDrafts();

    expect(getComposerDraftSnapshot(threadKey).text).toBe("");
    expect(getComposerDraftSnapshot(editKey).text).toBe("");
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(recovery).toBe("clean");
  });

  it("recovers a changed edit into an empty thread draft", async () => {
    beginQueuedRunEdit(threadKey, edit([]));
    setComposerDraftText(editKey, "revised");

    const recovery = recoverQueuedRunEdit(threadKey, runId);
    await flushComposerDrafts();

    expect(getComposerDraftSnapshot(threadKey).text).toBe("revised");
    expect(getComposerDraftSnapshot(editKey).text).toBe("");
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(recovery).toBe("kept");
  });

  it("preserves an occupied thread draft when discarding a changed edit", async () => {
    setComposerDraftText(threadKey, "unsent draft");
    beginQueuedRunEdit(threadKey, edit([]));
    setComposerDraftText(editKey, "revised");

    const recovery = recoverQueuedRunEdit(threadKey, runId);
    await flushComposerDrafts();

    expect(getComposerDraftSnapshot(threadKey).text).toBe("unsent draft");
    expect(getComposerDraftSnapshot(editKey).text).toBe("");
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(recovery).toBe("discarded");
  });
});
