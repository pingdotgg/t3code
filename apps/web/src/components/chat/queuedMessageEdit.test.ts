import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { jiraContextRecord } from "@t3tools/shared/composerContextExternalLinks";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { jiraContextReference } from "../../lib/composerContextRecords";
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
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
    store.addFiles(editTarget, [file]);
    expect(
      recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "Original message" }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([file]);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("reports a removed queued attachment as an edit when the run leaves", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "Original message",
        removedExistingAttachment: true,
      }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    store.clearComposerContent(threadTarget);
    // An attachment-only message leaves nothing to put back in the composer.
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "",
        removedExistingAttachment: true,
      }),
    ).toBe("discarded");
    expect(store.getComposerDraft(threadTarget)).toBeNull();
  });

  it("does not overwrite a separate draft when the queued run leaves", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.addFiles(editTarget, [file]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe(
      "discarded",
    );
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("moves referenced Jira context with a kept queued edit", () => {
    const store = useComposerDraftStore.getState();
    const issue = jiraContextRecord({
      key: "T3-9",
      summary: "Carry me",
      url: "https://acme.atlassian.net/browse/T3-9",
    });
    const prompt = `fix ${formatInlineContextReference(jiraContextReference(issue))}`;
    store.setPrompt(editTarget, prompt);
    store.addJiraContexts(editTarget, [issue]);
    expect(
      recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "Original message" }),
    ).toBe("kept");
    const recovered = store.getComposerDraft(threadTarget);
    expect(recovered?.jiraContexts).toEqual([issue]);
    expect(recovered?.prompt).toContain(issue.url);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });
});
