import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getComposerDraft: vi.fn(),
  releaseDraftAttachments: vi.fn(),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: mocks.getComposerDraft,
    }),
  },
}));

vi.mock("./attachmentUploadQueue", () => ({
  releaseDraftAttachments: mocks.releaseDraftAttachments,
}));

import { releaseComposerDraftUploads } from "./composerDraftUploads";

describe("releaseComposerDraftUploads", () => {
  beforeEach(() => {
    mocks.getComposerDraft.mockReset();
    mocks.releaseDraftAttachments.mockReset();
  });

  it("releases every pending draft attachment upload", () => {
    const images = [{ id: "image-1" }, { id: "image-2" }];
    const files = [{ id: "file-1" }];
    mocks.getComposerDraft.mockReturnValue({ images, files });

    releaseComposerDraftUploads({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(mocks.releaseDraftAttachments).toHaveBeenCalledWith([...images, ...files]);
  });

  it("does nothing when the thread has no composer draft", () => {
    mocks.getComposerDraft.mockReturnValue(null);

    releaseComposerDraftUploads({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(mocks.releaseDraftAttachments).not.toHaveBeenCalled();
  });
});
