import { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  questionAttachmentDraftId,
  questionAttachmentDraftPrefix,
  changeQuestionAttachmentPreparation,
  clearQuestionAttachmentDraft,
  useQuestionAttachmentPreparation,
} from "./questionAttachments";

const release = vi.hoisted(() => vi.fn());
vi.mock("./lib/attachmentUploadQueue", () => ({ releaseDraftAttachments: release }));
const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const requestId = ApprovalRequestId.make("request-1");
beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useQuestionAttachmentPreparation.setState({ counts: {} });
  release.mockClear();
});
it("keeps question files separate from the normal draft and other questions", () => {
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const store = useComposerDraftStore.getState();
  const first = questionAttachmentDraftId(environmentId, threadId, requestId, "first");
  const second = questionAttachmentDraftId(environmentId, threadId, requestId, "second");
  store.setPrompt({ environmentId, threadId }, "Unsent prompt");
  const image = {
    type: "image" as const,
    id: "image-1",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 5,
    previewUrl: "blob:question-image",
    file: new File(["image"], "image.png", { type: "image/png" }),
  };
  store.addImages(first, [image]);
  store.addFiles(second, [
    {
      type: "file",
      id: "file-1",
      name: "spec.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      file: new File(["spec"], "spec.txt", { type: "text/plain" }),
    },
  ]);
  changeQuestionAttachmentPreparation(first, 1);
  expect(store.getComposerDraft(first)?.images).toHaveLength(1);
  expect(store.getComposerDraft(second)?.files).toHaveLength(1);
  clearQuestionAttachmentDraft(first);
  expect(store.getComposerDraft(first)).toBeNull();
  expect(store.getComposerDraft(second)?.files).toHaveLength(1);
  expect(store.getComposerDraft({ environmentId, threadId })?.prompt).toBe("Unsent prompt");
  expect(useQuestionAttachmentPreparation.getState().counts[first]).toBeUndefined();
  expect(release).toHaveBeenCalledWith([image]);
  expect(revoke).toHaveBeenCalledWith(image.previewUrl);
  revoke.mockRestore();
});
it("scopes provider request ids to their environment and thread", () => {
  const keys = [
    questionAttachmentDraftId(environmentId, threadId, requestId, "q"),
    questionAttachmentDraftId(EnvironmentId.make("environment-2"), threadId, requestId, "q"),
    questionAttachmentDraftId(environmentId, ThreadId.make("thread-2"), requestId, "q"),
  ];
  expect(new Set(keys).size).toBe(3);
});
it("does not match drafts belonging to threads with a shared id prefix", () => {
  const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
  expect(
    questionAttachmentDraftId(environmentId, threadId, requestId, "q").startsWith(prefix),
  ).toBe(true);
  for (const suffix of ["-extra", ":extra", "/extra", "%extra"]) {
    expect(
      questionAttachmentDraftId(
        environmentId,
        ThreadId.make(`${threadId}${suffix}`),
        requestId,
        "q",
      ).startsWith(prefix),
    ).toBe(false);
  }
});

it("does not clear another environment whose id contains a question prefix", () => {
  const otherEnvironment = EnvironmentId.make(
    `${environmentId}:question-${encodeURIComponent(JSON.stringify(threadId))}-nested`,
  );
  const otherKey = questionAttachmentDraftId(otherEnvironment, threadId, requestId, "q");
  const ownKey = questionAttachmentDraftId(environmentId, threadId, requestId, "q");
  const store = useComposerDraftStore.getState();
  store.setPrompt(otherKey, "Keep this answer");
  store.setPrompt(ownKey, "Discard this answer");
  const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
  for (const key of [ownKey, otherKey]) {
    if (key.startsWith(prefix)) clearQuestionAttachmentDraft(key);
  }
  expect(store.getComposerDraft(ownKey)).toBeNull();
  expect(store.getComposerDraft(otherKey)?.prompt).toBe("Keep this answer");
});
