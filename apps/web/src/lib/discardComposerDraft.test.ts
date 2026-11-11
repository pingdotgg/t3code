import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ComposerImageAttachment,
  DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { showThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import { discardComposerDraft } from "./discardComposerDraft";

vi.mock("./attachmentUploadQueue", () => ({ releaseDraftAttachments: vi.fn() }));
vi.mock("../hooks/showThreadUndoNotice", () => ({ showThreadUndoNotice: vi.fn() }));

const environmentId = EnvironmentId.make("environment-local");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const draftId = DraftId.make("draft-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

function undoNotice() {
  const options = vi.mocked(showThreadUndoNotice).mock.calls.at(-1)?.[0];
  if (!options) throw new Error("Undo notice is missing");
  return options;
}

function imagePreview(name = "image.png") {
  const file = new File(["image bytes"], name, { type: "image/png" });
  const previewUrl = URL.createObjectURL(file);
  return {
    image: {
      type: "image",
      id: name,
      name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
      previewUrl,
    } satisfies ComposerImageAttachment,
    [Symbol.dispose]() {
      URL.revokeObjectURL(previewUrl);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});

describe("discardComposerDraft", () => {
  it("restores a discarded new-thread draft with its project mapping and a usable preview", async () => {
    using preview = imagePreview();
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId);
    store.setPrompt(draftId, "half-written prompt");
    store.addImage(draftId, preview.image);
    const before = useComposerDraftStore.getState();

    discardComposerDraft(draftId);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
    await expect(fetch(preview.image.previewUrl)).rejects.toThrow();

    await undoNotice().undo();
    const after = useComposerDraftStore.getState();
    expect(after.getDraftSession(draftId)).toEqual(before.getDraftSession(draftId));
    expect(after.getComposerDraft(draftId)?.prompt).toBe("half-written prompt");
    expect(after.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual(
      before.logicalProjectDraftThreadKeyByLogicalProjectKey,
    );
    const restoredUrl = after.getComposerDraft(draftId)!.images[0]!.previewUrl;
    try {
      expect(await (await fetch(restoredUrl)).text()).toBe("image bytes");
    } finally {
      URL.revokeObjectURL(restoredUrl);
    }
  });

  it("releases a discarded existing-thread preview when Undo is committed", async () => {
    using preview = imagePreview();
    useComposerDraftStore.getState().addImage(threadRef, preview.image);

    discardComposerDraft(threadRef);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.images ?? []).toEqual([]);
    expect(await (await fetch(preview.image.previewUrl)).text()).toBe("image bytes");

    undoNotice().commit?.();
    await expect(fetch(preview.image.previewUrl)).rejects.toThrow();
  });

  it("keeps newer draft content and releases the discarded preview when Undo is refused", async () => {
    using oldPreview = imagePreview("old.png");
    using newPreview = imagePreview("new.png");
    useComposerDraftStore.getState().addImage(threadRef, oldPreview.image);
    discardComposerDraft(threadRef);
    useComposerDraftStore.getState().setPrompt(threadRef, "new reply");
    useComposerDraftStore.getState().addImage(threadRef, newPreview.image);

    const result = await undoNotice().undo();
    expect(result._tag).toBe("Failure");
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe("new reply");
    await expect(fetch(oldPreview.image.previewUrl)).rejects.toThrow();
    expect(await (await fetch(newPreview.image.previewUrl)).text()).toBe("image bytes");
  });

  it("keeps an existing-thread preview usable after successful Undo", async () => {
    using preview = imagePreview();
    useComposerDraftStore.getState().addImage(threadRef, preview.image);
    discardComposerDraft(threadRef);

    const result = await undoNotice().undo();
    expect(result._tag).toBe("Success");
    const restored = useComposerDraftStore.getState().getComposerDraft(threadRef)!.images[0]!;
    expect(restored.previewUrl).toBe(preview.image.previewUrl);
    expect(await (await fetch(restored.previewUrl)).text()).toBe("image bytes");
  });
});
