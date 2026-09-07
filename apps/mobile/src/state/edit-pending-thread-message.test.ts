import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const state = vi.hoisted(() => ({
  dispatching: null as string | null,
  held: {} as Record<string, true>,
  draft: { text: "Existing draft", attachments: [] as { id: string }[] },
  confirm: vi.fn(async () => true),
  remove: vi.fn(async () => true),
  flush: vi.fn(async () => {}),
}));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "dispatching" ? state.dispatching : state.held),
  },
}));
vi.mock("./use-thread-outbox", () => ({
  dispatchingQueuedMessageIdAtom: "dispatching",
  editingQueuedMessageIdsAtom: "editing",
  holdEditingQueuedMessage: (id: string) => {
    state.held[id] = true;
  },
  releaseEditingQueuedMessage: (id: string) => {
    delete state.held[id];
  },
}));
vi.mock("./thread-outbox", () => ({
  confirmThreadOutboxMessageQueued: state.confirm,
  threadOutboxRevision: () => 1,
}));
vi.mock("./thread-outbox-removal", () => ({ removeThreadOutboxMessage: state.remove }));
vi.mock("./use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {},
  getComposerDraftSnapshot: () => state.draft,
  mergeComposerDraftContent: async (_key: string, message: QueuedThreadMessage) => {
    state.draft = {
      text: `${state.draft.text}\n\n${message.text}`,
      attachments: [...state.draft.attachments, ...message.attachments],
    };
  },
  updateComposerDraftSettings: () => {},
  flushComposerDrafts: state.flush,
  undoComposerDraftMerge: async (_key: string, snapshot: typeof state.draft) => {
    state.draft = snapshot;
  },
}));
import { editPendingThreadMessage } from "./edit-pending-thread-message";

const message: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  commandId: CommandId.make("command"),
  text: "Queued task",
  createdAt: "2026-09-06T10:00:00.000Z",
  attachments: [
    {
      id: "file",
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      fileUri: "file:///notes.txt",
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  state.dispatching = null;
  state.held = {};
  state.draft = { text: "Existing draft", attachments: [] };
  state.confirm.mockResolvedValue(true);
  state.remove.mockResolvedValue(true);
  state.flush.mockResolvedValue(undefined);
});
describe("editing a pending message", () => {
  it("locks delivery and persists text and attachments before removing the queued copy", async () => {
    state.confirm.mockImplementationOnce(async () => {
      expect(state.held[message.messageId]).toBe(true);
      return true;
    });
    state.remove.mockImplementationOnce(async () => {
      expect(state.flush).toHaveBeenCalled();
      expect(state.draft.text).toBe("Existing draft\n\nQueued task");
      expect(state.draft.attachments).toEqual(message.attachments);
      return true;
    });
    expect(await editPendingThreadMessage(message)).toBe(true);
    expect(state.held).toEqual({});
  });
  it("does not reclaim a message already being dispatched", async () => {
    state.dispatching = message.messageId;
    expect(await editPendingThreadMessage(message)).toBe(false);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.draft.text).toBe("Existing draft");
  });
  it("rolls back the draft if removing the queued message fails", async () => {
    state.remove.mockRejectedValueOnce(new Error("disk error"));
    await expect(editPendingThreadMessage(message)).rejects.toThrow("disk error");
    expect(state.draft).toEqual({ text: "Existing draft", attachments: [] });
    expect(state.held).toEqual({});
  });
  it("rolls back when a newer queue revision wins", async () => {
    state.remove.mockResolvedValueOnce(false);
    expect(await editPendingThreadMessage(message)).toBe(false);
    expect(state.draft.text).toBe("Existing draft");
  });
});
