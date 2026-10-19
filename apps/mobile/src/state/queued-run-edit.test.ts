import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";
import { submitComposer } from "./submit-composer";

vi.mock("./use-composer-drafts", () => ({
  clearComposerDraft: vi.fn(),
  setComposerDraftContext: vi.fn(),
  setComposerDraftText: vi.fn(),
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

describe("submitting with a pending native correction", () => {
  const threadKey = "environment:thread";

  afterEach(() => endQueuedRunEdit(threadKey));

  it.each(["draft", "queued edit"])(
    "reads the corrected %s only after preparation finishes",
    async (kind) => {
      if (kind === "queued edit") beginQueuedRunEdit(threadKey, edit([]));
      const correction = Promise.withResolvers<string>();
      let text = "Teh";
      const submitted: string[] = [];
      const send = vi.fn(async () => {
        submitted.push(text);
        text = "";
        return MessageId.make("sent-message");
      });
      const result = submitComposer(
        threadKey,
        {
          focus() {},
          blur() {},
          setSelection() {},
          async prepareForSubmit() {
            text = await correction.promise;
            return true;
          },
        },
        send,
        () => true,
      );

      expect(send).not.toHaveBeenCalled();
      correction.resolve("The");
      expect(await result).toBe("sent-message");
      expect(submitted).toEqual(["The"]);
      expect(text).toBe("");
    },
  );

  it.each(["cancelled edit", "replacement edit", "inactive draft"])(
    "blocks submission for %s even when native preparation succeeds",
    async (change) => {
      if (change !== "inactive draft") beginQueuedRunEdit(threadKey, edit([]));
      const preparation = Promise.withResolvers<boolean>();
      let active = true;
      const send = vi.fn(async () => MessageId.make("unexpected-send"));
      const result = submitComposer(
        threadKey,
        {
          focus() {},
          blur() {},
          setSelection() {},
          prepareForSubmit: () => preparation.promise,
        },
        send,
        () => active,
      );

      if (change === "inactive draft") {
        active = false;
      } else {
        endQueuedRunEdit(threadKey);
        if (change === "replacement edit") beginQueuedRunEdit(threadKey, edit([]));
      }
      const replacement = getQueuedRunEdit(threadKey);
      preparation.resolve(true);

      expect(await result).toBeNull();
      expect(send).not.toHaveBeenCalled();
      expect(getQueuedRunEdit(threadKey)).toBe(replacement);
    },
  );
});
