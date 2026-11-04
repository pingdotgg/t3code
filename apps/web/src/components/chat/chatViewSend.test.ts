import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { buildMessageContext, threadContextReference } from "../../lib/composerContextRecords";
import { rewindToMessage } from "./chatViewSend";

vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readPreparedConnection: () => ({ httpBaseUrl: "http://localhost" }),
}));
vi.mock("../ChatView.logic", () => ({
  prepareRevertedMessageAttachments: async () => [],
  waitForRevertedMessage: async (
    _ref: unknown,
    _count: unknown,
    _id: unknown,
    revert: () => Promise<void>,
  ) => revert(),
}));

it("restores sent thread mentions without duplicating references or changing the draft after a failed rewind", async () => {
  const environmentId = EnvironmentId.make("mention-env");
  const threadId = ThreadId.make("mention-source");
  const target = DraftId.make("mention-rewind");
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  const record = threadContextRecord(
    { environmentId, threadId: ThreadId.make("mention-target") },
    "Target thread",
  );
  const text = `Wait for ${formatInlineContextReference(threadContextReference(record))} to merge`;
  const context = buildMessageContext({
    terminalContexts: [],
    reviewComments: [],
    previewAnnotations: [],
    attachments: [],
    threadContexts: [record],
  });
  const message = {
    id: MessageId.make("mention-message"),
    role: "user" as const,
    text,
    context,
    runId: null,
    streaming: false,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
  store.setPrompt(target, "Existing draft");
  const input = {
    message,
    environmentId,
    routeThreadRef: { environmentId, threadId },
    threadId,
    turnCount: 0,
    restoreFiles: false,
    checkpoint: undefined,
    draftTarget: target,
    composerHasPendingAttachments: false,
    createAssetUrl: async () => {
      throw new Error("No attachments expected");
    },
    revertThreadCheckpoint: async () => AsyncResult.success(undefined),
  };
  expect(
    await rewindToMessage({
      ...input,
      revertThreadCheckpoint: async () => {
        throw new Error("Rewind rejected");
      },
    }),
  ).toEqual({ error: "Rewind rejected" });
  expect(store.getComposerDraft(target)?.prompt).toBe("Existing draft");
  expect(store.getComposerDraft(target)?.threadContexts).toEqual([]);
  expect(await rewindToMessage(input)).toEqual({
    error: null,
    prompt: `Existing draft\n\n${text}`,
  });
  const draft = store.getComposerDraft(target);
  expect(draft?.threadContexts).toEqual([record]);
  const savedContext = buildMessageContext({
    terminalContexts: [],
    reviewComments: [],
    previewAnnotations: [],
    attachments: [],
    threadContexts: draft?.threadContexts ?? [],
  });
  expect(savedContext?.records).toEqual(context?.records);
  store.clearComposerContent(target);
  expect(
    await rewindToMessage({ ...input, message: { ...message, context: savedContext } }),
  ).toEqual({ error: null, prompt: text });
  expect(store.getComposerDraft(target)?.threadContexts).toEqual([record]);
});

it("keeps a missing thread reference unresolved instead of fabricating its metadata", async () => {
  const environmentId = EnvironmentId.make("missing-env");
  const threadId = ThreadId.make("source");
  const target = DraftId.make("missing-thread-rewind");
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  const text = "See [Deleted thread](t3-context://v1/thread/deleted-thread)";
  const result = await rewindToMessage({
    message: {
      id: MessageId.make("missing-message"),
      role: "user",
      text,
      runId: null,
      streaming: false,
      createdAt: "2026-11-04T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
    },
    environmentId,
    routeThreadRef: { environmentId, threadId },
    threadId,
    turnCount: 0,
    restoreFiles: false,
    checkpoint: undefined,
    draftTarget: target,
    composerHasPendingAttachments: false,
    createAssetUrl: async () => {
      throw new Error("No attachments expected");
    },
    revertThreadCheckpoint: async () => AsyncResult.success(undefined),
  });
  expect(result).toEqual({ error: null, prompt: text });
  expect(store.getComposerDraft(target)?.threadContexts).toEqual([]);
});
