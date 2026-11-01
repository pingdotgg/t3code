import { describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  restoreAttachmentOnlyBootstrapPrompt,
} from "@t3tools/shared/composerContextReferences";
import {
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  RunId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import {
  activeComposerDraftKey,
  beginQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  removeQueuedRunEditAttachment,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";
import { threadComposerErrorsAtom } from "./thread-composer-error";
import {
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
});

describe("beginQueuedRunEdit", () => {
  it.each(["", "Ultrathink:\n"])(
    "opens attachment-only edits without the placeholder and treats them as untouched (%j)",
    (prefix) => {
      const threadKey = `env-exit:attachment-only-${prefix.length}`;
      const original = {
        ...edit([image("kept")]),
        originalText: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      };
      const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>(
        [{ id: original.runId, status: "queued" }],
      );
      beginQueuedRunEdit(threadKey, original, runs);
      const draft = getComposerDraftSnapshot(queuedEditDraftKey(threadKey, original.runId));
      expect(draft.text).toBe(prefix.trimEnd());
      expect(
        restoreAttachmentOnlyBootstrapPrompt(draft.text, original.existingAttachments.length > 0),
      ).toBe(original.originalText);
      expect(getQueuedRunEdit(threadKey)).toEqual({ ...original, originalText: prefix.trimEnd() });
      appAtomRegistry.set(runs, [{ id: original.runId, status: "running" }]);
      expect(getQueuedRunEdit(threadKey)).toBeNull();
      expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBeUndefined();
    },
  );

  it("silently drops an untouched edit when its run starts", () => {
    const threadKey = "env-exit:thread-untouched";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    beginQueuedRunEdit(threadKey, edit([]), runs);

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("");
    expect(getComposerDraftSnapshot(queuedEditDraftKey(threadKey, runId)).text).toBe("");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBeUndefined();
  });

  it("recovers text after a server attachment was removed", async () => {
    await waitForComposerDraftsLoaded();
    const threadKey = "env-exit:thread-removed-recover";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    beginQueuedRunEdit(threadKey, edit([image("removed")]), runs);
    removeQueuedRunEditAttachment(threadKey, "removed");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);
    await flushComposerDrafts();

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("original");
    expect(getComposerDraftSnapshot(queuedEditDraftKey(threadKey, runId)).text).toBe("");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started. Your edit is back in the composer.",
    );
  });

  it("recovers changed text into an empty thread draft", async () => {
    await waitForComposerDraftsLoaded();
    const threadKey = "env-exit:thread-changed-recover";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    beginQueuedRunEdit(threadKey, edit([]), runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "revised");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);
    await flushComposerDrafts();

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("revised");
    expect(getComposerDraftSnapshot(queuedEditDraftKey(threadKey, runId)).text).toBe("");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started. Your edit is back in the composer.",
    );
  });

  it("ends a changed edit when its run starts, without the thread's composer mounted", () => {
    const threadKey = "env-exit:thread-exit";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    setComposerDraftText(threadKey, "other work");
    beginQueuedRunEdit(threadKey, edit([]), runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "changed");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("other work");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started, so the edit was discarded.",
    );
  });

  it("reports a cleared edit as discarded when the run starts", () => {
    const threadKey = "env-exit:thread-cleared";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    beginQueuedRunEdit(threadKey, edit([]), runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started, so the edit was discarded.",
    );
  });

  it("treats a removed server attachment as a change when the run starts", () => {
    const threadKey = "env-exit:thread-removed";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    setComposerDraftText(threadKey, "other work");
    beginQueuedRunEdit(threadKey, edit([image("kept")]), runs);
    removeQueuedRunEditAttachment(threadKey, "kept");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started, so the edit was discarded.",
    );
  });
});

describe("activeComposerDraftKey", () => {
  const threadKey = "env:thread";
  const editKey = queuedEditDraftKey(threadKey, RunId.make("run-1"));

  it("keeps a queued edit's draft while that edit is open", () => {
    expect(activeComposerDraftKey(threadKey, editKey, edit([]))).toBe(editKey);
  });

  it("falls back to the thread's draft once the edit has ended", () => {
    expect(activeComposerDraftKey(threadKey, editKey, null)).toBe(threadKey);
  });
});
