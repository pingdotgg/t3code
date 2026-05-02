import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  flushQueuedTurnStoreStorage,
  type QueuedTurnDraft,
  useQueuedTurnStore,
} from "./queuedTurnStore";
import { type ComposerImageAttachment } from "./composerDraftStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

function makeImage(id: string): ComposerImageAttachment {
  const file = new File(["hello"], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

function makeQueuedTurn(overrides: Partial<QueuedTurnDraft> = {}): QueuedTurnDraft {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    text: overrides.text ?? "Queued follow-up",
    createdAt: overrides.createdAt ?? "2026-04-16T12:00:00.000Z",
    images: overrides.images ?? [makeImage("queued-image")],
    persistedAttachments: overrides.persistedAttachments ?? [
      {
        id: "queued-image",
        name: "queued-image.png",
        mimeType: "image/png",
        sizeBytes: 5,
        dataUrl: "data:image/png;base64,aGVsbG8=",
      },
    ],
    terminalContexts: overrides.terminalContexts ?? [
      {
        id: "ctx-1",
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-04-16T12:00:00.000Z",
        terminalId: "terminal-1",
        terminalLabel: "Main terminal",
        lineStart: 1,
        lineEnd: 3,
        text: "npm run test",
      },
    ],
    modelSelection:
      overrides.modelSelection ??
      ({
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
        options: [{ id: "reasoningEffort", value: "medium" }],
      } satisfies ModelSelection),
    promptEffort: overrides.promptEffort ?? "medium",
    runtimeMode: overrides.runtimeMode ?? "full-access",
    interactionMode: overrides.interactionMode ?? "default",
  };
}

afterEach(() => {
  useQueuedTurnStore.setState({ threadsByThreadKey: {} });
  flushQueuedTurnStoreStorage();
});

describe("queuedTurnStore", () => {
  it("enqueues and prepends queued turns in FIFO order", () => {
    const first = makeQueuedTurn({ id: "first", text: "First queued follow-up" });
    const second = makeQueuedTurn({ id: "second", text: "Second queued follow-up" });
    const head = makeQueuedTurn({ id: "head", text: "Prepended queued follow-up" });

    useQueuedTurnStore.getState().enqueue(THREAD_REF, first);
    useQueuedTurnStore.getState().enqueue(THREAD_REF, second);
    useQueuedTurnStore.getState().prepend(THREAD_REF, head);

    expect(
      useQueuedTurnStore
        .getState()
        .getQueue(THREAD_REF)
        .map((turn) => turn.id),
    ).toEqual(["head", "first", "second"]);
  });

  it("moves queued turns to a new index without dropping items", () => {
    const first = makeQueuedTurn({ id: "first", text: "First queued follow-up" });
    const second = makeQueuedTurn({ id: "second", text: "Second queued follow-up" });
    const third = makeQueuedTurn({ id: "third", text: "Third queued follow-up" });

    useQueuedTurnStore.getState().enqueue(THREAD_REF, first);
    useQueuedTurnStore.getState().enqueue(THREAD_REF, second);
    useQueuedTurnStore.getState().enqueue(THREAD_REF, third);

    useQueuedTurnStore.getState().move(THREAD_REF, "third", 0);
    expect(
      useQueuedTurnStore
        .getState()
        .getQueue(THREAD_REF)
        .map((turn) => turn.id),
    ).toEqual(["third", "first", "second"]);

    useQueuedTurnStore.getState().move(THREAD_REF, "first", 99);
    expect(
      useQueuedTurnStore
        .getState()
        .getQueue(THREAD_REF)
        .map((turn) => turn.id),
    ).toEqual(["third", "second", "first"]);
  });

  it("replaces queued text and removes queued turns when edited down to empty", () => {
    const queued = makeQueuedTurn({
      id: "queued",
      text: "Original queued text",
      images: [],
      persistedAttachments: [],
      terminalContexts: [],
    });
    useQueuedTurnStore.getState().enqueue(THREAD_REF, queued);

    useQueuedTurnStore.getState().replaceText(THREAD_REF, queued.id, "Updated queued text");
    expect(useQueuedTurnStore.getState().getQueue(THREAD_REF)[0]?.text).toBe("Updated queued text");

    useQueuedTurnStore.getState().replaceText(THREAD_REF, queued.id, "   ");
    expect(useQueuedTurnStore.getState().getQueue(THREAD_REF)).toEqual([]);
  });

  it("keeps attachment-only queued turns when the edited text becomes empty", () => {
    const queued = makeQueuedTurn({ id: "attachment-only", text: "Temporary text" });
    useQueuedTurnStore.getState().enqueue(THREAD_REF, queued);

    useQueuedTurnStore.getState().replaceText(THREAD_REF, queued.id, "   ");

    expect(useQueuedTurnStore.getState().getQueue(THREAD_REF)).toEqual([
      expect.objectContaining({
        id: "attachment-only",
        text: "",
      }),
    ]);
  });

  it("consumes without revoking the queued draft so callers can retry dispatch", () => {
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const queued = makeQueuedTurn({ id: "queued" });
    useQueuedTurnStore.getState().enqueue(THREAD_REF, queued);

    useQueuedTurnStore.getState().consume(THREAD_REF, queued.id);

    expect(useQueuedTurnStore.getState().getQueue(THREAD_REF)).toEqual([]);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    revokeObjectURL.mockRestore();
  });

  it("revokes blob previews when clearing an entire thread queue", () => {
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    useQueuedTurnStore.getState().enqueue(THREAD_REF, makeQueuedTurn({ id: "queued-1" }));
    useQueuedTurnStore.getState().enqueue(THREAD_REF, makeQueuedTurn({ id: "queued-2" }));

    useQueuedTurnStore.getState().clearThread(THREAD_REF);

    expect(useQueuedTurnStore.getState().getQueue(THREAD_REF)).toEqual([]);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    revokeObjectURL.mockRestore();
  });
});
