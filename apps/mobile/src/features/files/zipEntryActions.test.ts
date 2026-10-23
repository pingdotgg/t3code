import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ZipPreviewEntry } from "@t3tools/client-runtime/zip-preview";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  createAttachment: vi.fn(),
  removeFile: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../../lib/attachmentDownload", () => ({
  writeGeneratedAttachmentFile: async () => ({
    uri: "file:///cache/cart.ts",
    share: vi.fn(),
    dispose: mocks.dispose,
  }),
}));
vi.mock("../../lib/composerImages", () => ({
  createComposerFileAttachment: mocks.createAttachment,
  removePersistedComposerAttachmentFile: mocks.removeFile,
}));
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    exists = false;
    create() {}
    write() {}
    moveSync() {}
  },
  Paths: { document: { uri: "file:///documents" } },
}));

import type { DraftComposerFileAttachment } from "../../lib/composerImages";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  questionAttachmentDraftKey,
  questionAttachmentDraftPrefix,
  questionAttachmentPreparationAtom,
} from "../../state/question-attachments";
import {
  clearComposerDraft,
  composerDraftsAtom,
  flushComposerDrafts,
  type ComposerDraft,
} from "../../state/use-composer-drafts";
import { addZipEntryToDraft } from "./zipEntryActions";

const entry: ZipPreviewEntry = {
  path: "src/lib/cart.ts",
  name: "cart.ts",
  isDirectory: false,
  sizeBytes: 2,
  mimeType: "text/plain",
};
const archive = { readFileForSave: async () => new Uint8Array([1, 2]) };
const attachment: DraftComposerFileAttachment = {
  id: "a",
  type: "file",
  name: "cart.ts",
  mimeType: "text/plain",
  sizeBytes: 2,
  fileUri: "file:///documents/a-cart.ts",
};
const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const draftKey = "environment-1:thread-1";
const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
const questionKey = (requestId: string, questionId: string) =>
  questionAttachmentDraftKey(environmentId, threadId, requestId, questionId);
const files = (count: number): ComposerDraft => ({
  text: "",
  attachments: Array.from({ length: count }, (_, index) => ({
    ...attachment,
    id: `existing-${index}`,
    fileUri: `file:///documents/existing-${index}.ts`,
  })),
});

function setup(drafts: Record<string, ComposerDraft>) {
  appAtomRegistry.set(composerDraftsAtom, drafts);
  appAtomRegistry.set(questionAttachmentPreparationAtom, {});
  mocks.createAttachment.mockReset().mockResolvedValue(attachment);
  mocks.removeFile.mockReset().mockResolvedValue(undefined);
  mocks.dispose.mockReset();
  onTestFinished(async () => {
    await flushComposerDrafts();
    appAtomRegistry.set(composerDraftsAtom, {});
    appAtomRegistry.set(questionAttachmentPreparationAtom, {});
  });
}

describe("addZipEntryToDraft", () => {
  it("does not change the draft and removes the copy when Back cancels during the copy", async () => {
    const drafts = { [draftKey]: { text: "Keep this draft", attachments: [] } };
    setup(drafts);
    const controller = new AbortController();
    const copying = Promise.withResolvers<void>();
    const copied = Promise.withResolvers<DraftComposerFileAttachment>();
    mocks.createAttachment.mockImplementation(() => {
      copying.resolve();
      return copied.promise;
    });
    const adding = addZipEntryToDraft({
      archive,
      entry,
      draftKey,
      questionPrefix: null,
      maxBytes: 1024,
      signal: controller.signal,
    });
    const rejected = expect(adding).rejects.toMatchObject({ name: "AbortError" });
    await copying.promise;
    controller.abort();
    copied.resolve(attachment);
    await rejected;

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual(drafts);
    expect(mocks.removeFile).toHaveBeenCalledWith(attachment.fileUri);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("allows 100 files across two questions, excludes other requests, and rejects file 101", async () => {
    const firstKey = questionKey("request-1", "question-1");
    const key = questionKey("request-1", "question-2");
    const otherKey = questionKey("request-2", "question-1");
    const drafts = {
      [firstKey]: files(60),
      [key]: files(39),
      [otherKey]: files(30),
      [draftKey]: files(5),
    };
    setup(drafts);
    const input = {
      archive,
      entry,
      draftKey: key,
      questionPrefix: prefix,
      maxBytes: 1024,
      signal: new AbortController().signal,
    };

    await addZipEntryToDraft(input);

    const full = appAtomRegistry.get(composerDraftsAtom);
    expect(full).toEqual({
      ...drafts,
      [key]: { text: "", attachments: [...drafts[key]!.attachments, attachment] },
    });
    const rejectedAttachment = { ...attachment, id: "b", fileUri: "file:///documents/b-cart.ts" };
    mocks.createAttachment.mockResolvedValueOnce(rejectedAttachment);
    const removed = Promise.withResolvers<void>();
    mocks.removeFile.mockImplementationOnce(async () => removed.resolve());

    await expect(addZipEntryToDraft(input)).rejects.toThrow(
      "This message already has as many attachments as it can hold.",
    );
    await removed.promise;

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual(full);
    expect(mocks.removeFile).toHaveBeenCalledWith(rejectedAttachment.fileUri);
    expect(appAtomRegistry.get(questionAttachmentPreparationAtom)[key]).toBe(0);
  });

  it("does not recreate a question draft resolved on another client during the copy", async () => {
    const key = questionKey("request-1", "question-1");
    const otherKey = questionKey("request-2", "question-1");
    const retained = { [otherKey]: { text: "Keep this answer", attachments: [] } };
    setup({ ...retained, [key]: { text: "Answer in progress", attachments: [] } });
    const copying = Promise.withResolvers<void>();
    const copied = Promise.withResolvers<DraftComposerFileAttachment>();
    mocks.createAttachment.mockImplementation(() => {
      copying.resolve();
      return copied.promise;
    });
    const adding = addZipEntryToDraft({
      archive,
      entry,
      draftKey: key,
      questionPrefix: prefix,
      maxBytes: 1024,
      signal: new AbortController().signal,
    });
    const rejected = expect(adding).rejects.toThrow("This question was already answered.");
    await copying.promise;
    expect(appAtomRegistry.get(questionAttachmentPreparationAtom)[key]).toBe(1);
    clearComposerDraft(key);
    appAtomRegistry.set(questionAttachmentPreparationAtom, {});
    copied.resolve(attachment);
    await rejected;

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual(retained);
    expect(mocks.removeFile).toHaveBeenCalledWith(attachment.fileUri);
    expect(appAtomRegistry.get(questionAttachmentPreparationAtom)).toEqual({});
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("adds a composer file with a context reference outside question drafts", async () => {
    setup({ [draftKey]: { text: "Review", attachments: [] } });

    await addZipEntryToDraft({
      archive,
      entry,
      draftKey,
      questionPrefix: null,
      maxBytes: 1024,
      signal: new AbortController().signal,
    });

    expect(appAtomRegistry.get(composerDraftsAtom)[draftKey]).toEqual({
      text: "Review [cart.ts](t3-context://v1/file/a) ",
      attachments: [attachment],
      context: {
        version: 1,
        records: [
          {
            version: 1,
            contextId: "a",
            kind: "file",
            label: "cart.ts",
            attachmentId: "a",
            name: "cart.ts",
            mimeType: "text/plain",
            sizeBytes: 2,
          },
        ],
      },
    });
    expect(mocks.removeFile).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
