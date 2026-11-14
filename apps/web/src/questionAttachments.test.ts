import {
  makeThreadRequestsResolvedAnnouncer,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  ApprovalRequestId,
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  ensureInlineContextReferences,
  formatInlineContextReference,
} from "./lib/composerContextReferences";
import {
  fileContextReference,
  imageContextReference,
  threadContextReference,
} from "./lib/composerContextRecords";
import {
  questionAttachmentDraftId,
  countQuestionAttachments,
  questionAttachmentDraftPrefix,
  changeQuestionAttachmentPreparation,
  clearQuestionAttachmentDraft,
  usePendingUserInputAnswers,
  useQuestionAttachmentPreparation,
} from "./questionAttachments";

const release = vi.hoisted(() => vi.fn());
vi.mock("./lib/attachmentUploadQueue", () => ({ releaseDraftAttachments: release }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("./components/ui/toast", () => ({ toastManager: { add: toast } }));
const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const requestId = ApprovalRequestId.make("request-1");
beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useQuestionAttachmentPreparation.setState({ counts: {} });
  usePendingUserInputAnswers.setState({}, true);
  release.mockClear();
  toast.mockClear();
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
  usePendingUserInputAnswers.setState({
    [userInputDraftKey(environmentId, threadId, resolved)]: { first: { customAnswer: "Sent" } },
  });

  // The thread's projection synchronizes with only `pending` left, e.g. after
  // `resolved` was answered on another device while no composer showed it.
  makeThreadRequestsResolvedAnnouncer(
    environmentId,
    threadId,
  )([
    { id: pending, status: "pending" },
    { id: resolved, status: "resolved" },
  ]);

  expect(store.getComposerDraft(keep)?.prompt).toBe("Answer context");
  expect(store.getComposerDraft(drop)).toBeNull();
  expect(store.getComposerDraft(elsewhere)?.prompt).toBe("Answer context");
  expect(useQuestionAttachmentPreparation.getState().counts[drop]).toBeUndefined();
  // An answered question's text was sent, so it does not come back as a draft.
  expect(store.getComposerDraft({ environmentId, threadId })).toBeNull();
  expect(usePendingUserInputAnswers.getState()).toEqual({});
});

const textFile = (id: string) => ({
  type: "file" as const,
  id,
  name: `${id}.txt`,
  mimeType: "text/plain",
  sizeBytes: 5,
  file: new File(["notes"], `${id}.txt`, { type: "text/plain" }),
});

// Stop cancels an open question; a provider timeout expires it. Neither sends the answer.
it.each(["cancelled", "expired"] as const)(
  "returns typed answers, their thread chips, and attachments to the thread draft when a question is %s",
  (status) => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const store = useComposerDraftStore.getState();
    const request = RuntimeRequestId.make("stopped");
    const first = questionAttachmentDraftId(environmentId, threadId, request, "first");
    // Answered only by its attachment: no typed text is stored for it.
    const fourth = questionAttachmentDraftId(environmentId, threadId, request, "fourth");
    const reference = threadContextRecord(
      { environmentId, threadId: ThreadId.make("reference-thread") },
      "Reference work",
    );
    const answer = `Purple, like ${formatInlineContextReference(threadContextReference(reference))}`;
    store.setPrompt({ environmentId, threadId }, "Earlier draft");
    store.setThreadContexts(first, [reference]);
    const file = textFile("notes");
    store.addFiles(first, [file]);
    const image = {
      type: "image" as const,
      id: "unsent-question-image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 5,
      previewUrl: "blob:unsent-question-image",
      file: new File(["image"], "screen.png", { type: "image/png" }),
    };
    store.addImages(fourth, [image]);
    usePendingUserInputAnswers.setState({
      [userInputDraftKey(environmentId, threadId, request)]: {
        first: { customAnswer: answer },
        second: { customAnswer: "  " },
        third: { customAnswer: "Also this" },
      },
    });

    makeThreadRequestsResolvedAnnouncer(environmentId, threadId)([{ id: request, status }]);

    expect(store.getComposerDraft({ environmentId, threadId })).toMatchObject({
      prompt: ensureInlineContextReferences(`Earlier draft\n\n${answer}\n\nAlso this`, [
        fileContextReference(file),
        imageContextReference(image),
      ]),
      threadContexts: [reference],
      files: [file],
      images: [image],
    });
    expect(usePendingUserInputAnswers.getState()).toEqual({});
    expect(store.getComposerDraft(first)).toBeNull();
    expect(store.getComposerDraft(fourth)).toBeNull();
    // The thread draft owns the upload and preview URL now.
    expect(release.mock.calls.flat(2)).toEqual([]);
    expect(revoke).not.toHaveBeenCalledWith(image.previewUrl);
    expect(toast).not.toHaveBeenCalled();
    revoke.mockRestore();
  },
);

it("names and releases the question attachments a full thread draft cannot take", () => {
  const store = useComposerDraftStore.getState();
  const request = RuntimeRequestId.make("stopped");
  const question = questionAttachmentDraftId(environmentId, threadId, request, "first");
  const draftFiles = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, index) =>
    textFile(`draft-${index}`),
  );
  store.addFiles({ environmentId, threadId }, draftFiles);
  const [fits, overflows] = [textFile("fits"), textFile("overflows")];
  store.addFiles(question, [fits, overflows]);

  makeThreadRequestsResolvedAnnouncer(
    environmentId,
    threadId,
  )([{ id: request, status: "cancelled" }]);

  expect(store.getComposerDraft({ environmentId, threadId })?.files).toEqual([...draftFiles, fits]);
  expect(store.getComposerDraft(question)).toBeNull();
  expect(release).toHaveBeenCalledExactlyOnceWith([overflows]);
  expect(toast).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: "warning",
      description: expect.stringContaining(overflows.name),
    }),
  );
});
