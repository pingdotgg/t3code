import { makeThreadRequestsResolvedAnnouncer } from "@t3tools/client-runtime/state/thread-requests";
import { ApprovalRequestId, EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  questionAttachmentDraftId,
  countQuestionAttachments,
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

it("counts files, images, and pending preparation across the shared question budget", () => {
  const first = questionAttachmentDraftId(environmentId, threadId, requestId, "first");
  const second = questionAttachmentDraftId(environmentId, threadId, requestId, "second");
  const other = questionAttachmentDraftId(
    EnvironmentId.make("other"),
    threadId,
    requestId,
    "first",
  );
  const store = useComposerDraftStore.getState();
  store.addFiles(
    second,
    Array.from({ length: 6 }, (_, index) => ({
      type: "file" as const,
      id: `file-${index}`,
      name: `spec-${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: 4,
      file: new File(["spec"], `spec-${index}.txt`),
    })),
  );
  store.addImages(first, [
    {
      type: "image",
      id: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 5,
      previewUrl: "blob:count-test",
      file: new File(["image"], "image.png"),
    },
  ]);
  changeQuestionAttachmentPreparation(second, 1);
  changeQuestionAttachmentPreparation(other, 8);
  expect(countQuestionAttachments([first, second])).toBe(8);
  expect(countQuestionAttachments([second])).toBe(7);
  changeQuestionAttachmentPreparation(second, -1);
  expect(countQuestionAttachments([first, second])).toBe(7);
});

it("clears attachment drafts for requests the thread resolved, wherever they were answered", () => {
  const store = useComposerDraftStore.getState();
  const pending = RuntimeRequestId.make("pending");
  const resolved = RuntimeRequestId.make("resolved");
  const otherThread = ThreadId.make("thread-2");
  const keep = questionAttachmentDraftId(environmentId, threadId, pending, "first");
  const drop = questionAttachmentDraftId(environmentId, threadId, resolved, "first");
  const elsewhere = questionAttachmentDraftId(environmentId, otherThread, resolved, "first");
  for (const key of [keep, drop, elsewhere]) store.setPrompt(key, "Answer context");
  changeQuestionAttachmentPreparation(drop, 1);

  // The thread's projection synchronizes with only `pending` left, e.g. after
  // `resolved` was answered on another device while no composer showed it.
  makeThreadRequestsResolvedAnnouncer(environmentId, threadId)([pending]);

  expect(store.getComposerDraft(keep)?.prompt).toBe("Answer context");
  expect(store.getComposerDraft(drop)).toBeNull();
  expect(store.getComposerDraft(elsewhere)?.prompt).toBe("Answer context");
  expect(useQuestionAttachmentPreparation.getState().counts[drop]).toBeUndefined();
});
