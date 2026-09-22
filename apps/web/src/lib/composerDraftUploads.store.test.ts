import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../composerDraftStore";

const mocks = vi.hoisted(() => ({
  releaseDraftAttachments: vi.fn(),
}));

vi.mock("./attachmentUploadQueue", () => ({
  releaseDraftAttachments: mocks.releaseDraftAttachments,
}));

import { discardComposerDraft } from "./composerDraftUploads";

function resetComposerDraftStore(): void {
  useComposerDraftStore.setState({
    backgroundSubmissionThreadKeys: {},
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyActiveProvider: null,
    stickyModelSelectionByProvider: {},
  });
}

describe("discardComposerDraft with the composer store", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const threadId = ThreadId.make("thread-1");
  const threadRef = scopeThreadRef(environmentId, threadId);
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
  const draftId = DraftId.make("draft-1");

  beforeEach(() => {
    resetComposerDraftStore();
    mocks.releaseDraftAttachments.mockReset();
  });

  afterEach(() => {
    resetComposerDraftStore();
  });

  it("releases and clears scoped and matching draft-session records", () => {
    const imageFile = new File(["image"], "image.png", { type: "image/png" });
    const image: ComposerImageAttachment = {
      file: imageFile,
      id: "image-1",
      mimeType: imageFile.type,
      name: imageFile.name,
      previewUrl: "data:image/png;base64,aW1hZ2U=",
      sizeBytes: imageFile.size,
      type: "image",
    };
    const videoFile = new File(["video"], "video.mp4", { type: "video/mp4" });
    const video: ComposerFileAttachment = {
      file: videoFile,
      id: "video-1",
      mimeType: videoFile.type,
      name: videoFile.name,
      sizeBytes: videoFile.size,
      type: "file",
    };
    const store = useComposerDraftStore.getState();
    store.addImage(threadRef, image);
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.addFiles(draftId, [video]);

    const directKey = scopedThreadKey(threadRef);
    expect(useComposerDraftStore.getState().draftsByThreadKey[directKey]).toBeDefined();
    expect(useComposerDraftStore.getState().draftsByThreadKey[draftId]).toBeDefined();

    discardComposerDraft(threadRef);

    expect(mocks.releaseDraftAttachments.mock.calls).toEqual([[[image]], [[video]]]);
    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadKey[directKey]).toBeUndefined();
    expect(state.draftsByThreadKey[draftId]).toBeUndefined();
    expect(state.getDraftSession(draftId)).toBeNull();
    expect(state.getDraftThreadByProjectRef(projectRef)).toBeNull();
  });

  it("releases a session-only draft exactly once through its scoped thread", () => {
    const videoFile = new File(["video"], "video.mp4", { type: "video/mp4" });
    const video: ComposerFileAttachment = {
      file: videoFile,
      id: "video-1",
      mimeType: videoFile.type,
      name: videoFile.name,
      sizeBytes: videoFile.size,
      type: "file",
    };
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.addFiles(draftId, [video]);

    discardComposerDraft(threadRef);

    expect(mocks.releaseDraftAttachments).toHaveBeenCalledTimes(1);
    expect(mocks.releaseDraftAttachments).toHaveBeenCalledWith([video]);
    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadKey[draftId]).toBeUndefined();
    expect(state.getDraftSession(draftId)).toBeNull();
    expect(state.getDraftThreadByProjectRef(projectRef)).toBeNull();
  });
});
