import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";

vi.mock("./use-composer-drafts", () => ({
  clearComposerDraft: vi.fn(),
  setComposerDraftContext: vi.fn(),
  setComposerDraftText: vi.fn(),
}));

import { beginQueuedRunEdit, endQueuedRunEdit, getQueuedRunEdit } from "./queued-run-edit";
import { submitComposer } from "./submit-composer";

const threadKey = "environment:thread";
const edit = () => ({
  runId: RunId.make("run"),
  messageId: MessageId.make("message"),
  originalText: "Teh",
  existingAttachments: [],
});

afterEach(() => endQueuedRunEdit(threadKey));

function pendingSubmission() {
  const correction = Promise.withResolvers<string>();
  let draft = "original draft";
  let active = true;
  const send = vi.fn(async () => {
    return getQueuedRunEdit(threadKey) === null ? MessageId.make("new-message") : null;
  });
  const result = submitComposer(
    threadKey,
    {
      focus() {},
      blur() {},
      setSelection() {},
      async prepareForSubmit(isCurrent) {
        const text = await correction.promise;
        if (!isCurrent()) return false;
        draft = text;
        return true;
      },
    },
    send,
    () => active,
  );
  return {
    correction,
    result,
    send,
    draft: () => draft,
    leave: () => {
      active = false;
    },
  };
}

describe("submitComposer", () => {
  it.each(["cancellation", "run-status recovery", "replacement edit"])(
    "does not overwrite the regular draft or submit after %s during preparation",
    async (change) => {
      beginQueuedRunEdit(threadKey, edit());
      const pending = pendingSubmission();
      endQueuedRunEdit(threadKey, { deferAttachmentCleanup: change === "run-status recovery" });
      if (change === "replacement edit") beginQueuedRunEdit(threadKey, edit());
      pending.correction.resolve("The");
      expect(await pending.result).toBeNull();
      expect(pending.draft()).toBe("original draft");
      expect(pending.send).not.toHaveBeenCalled();
    },
  );

  it("discards preparation after leaving the initiating draft", async () => {
    const pending = pendingSubmission();
    pending.leave();
    pending.correction.resolve("The");
    expect(await pending.result).toBeNull();
    expect(pending.draft()).toBe("original draft");
    expect(pending.send).not.toHaveBeenCalled();
  });

  it("rechecks edit identity before dispatch even after preparation succeeds", async () => {
    beginQueuedRunEdit(threadKey, edit());
    const send = vi.fn(async () => MessageId.make("new-message"));
    const result = submitComposer(
      threadKey,
      {
        focus() {},
        blur() {},
        setSelection() {},
        async prepareForSubmit() {
          queueMicrotask(() => endQueuedRunEdit(threadKey));
          return true;
        },
      },
      send,
      () => true,
    );
    expect(await result).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([false, undefined])("handles preparation result %s", async (prepared) => {
    const send = vi.fn(async () => MessageId.make("new-message"));
    const result = await submitComposer(
      threadKey,
      {
        focus() {},
        blur() {},
        setSelection() {},
        ...(prepared === false ? { prepareForSubmit: async () => false } : {}),
      },
      send,
      () => true,
    );
    expect(result).toBe(prepared === false ? null : "new-message");
    expect(send).toHaveBeenCalledTimes(prepared === false ? 0 : 1);
  });

  it("saves the corrected text when the edit is still current", async () => {
    beginQueuedRunEdit(threadKey, edit());
    const pending = pendingSubmission();
    pending.correction.resolve("The");
    expect(await pending.result).toBeNull();
    expect(pending.draft()).toBe("The");
    expect(pending.send).toHaveBeenCalledOnce();
  });

  it("submits a regular draft after accepting its correction", async () => {
    const pending = pendingSubmission();
    pending.correction.resolve("The");
    expect(await pending.result).toBe("new-message");
    expect(pending.draft()).toBe("The");
  });
});
