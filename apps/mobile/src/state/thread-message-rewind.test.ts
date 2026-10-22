import { describe, expect, it, vi } from "vite-plus/test";
import {
  CheckpointId,
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  work: vi.fn(),
  confirm: vi.fn(),
  permission: vi.fn(),
  targets: vi.fn(),
  supports: vi.fn(),
  prepare: vi.fn(),
  fits: vi.fn(),
  merge: vi.fn(),
  release: vi.fn(),
  error: vi.fn(),
  command: vi.fn(),
  wait: vi.fn(),
}));
vi.mock("./atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "request" }));
vi.mock("./presentation", () => ({
  environmentPresentations: { presentationAtom: () => presentationAtom },
}));
vi.mock("./server", () => ({ serverEnvironment: { configValueAtom: () => configAtom } }));
vi.mock("./session", () => ({ readEnvironmentScope: mocks.permission }));
vi.mock("./threads", () => ({
  environmentThreadDetails: { stateAtom: () => detailAtom },
  threadEnvironment: { revertCheckpoint: {} },
}));
vi.mock("./queued-run-edit", () => ({ getQueuedRunEdit: () => edit }));
vi.mock("./thread-outbox", () => ({
  threadOutboxManager: {
    get queuedMessagesByThreadKeyAtom() {
      return outboxAtom;
    },
  },
}));
vi.mock("./thread-composer-error", () => ({
  clearThreadComposerError: vi.fn(),
  setThreadComposerError: mocks.error,
}));
vi.mock("./use-composer-drafts", () => ({
  get composerContextImportsAtom() {
    return importsAtom;
  },
  getComposerDraftSnapshot: () => draft,
  mergeComposerDraftContent: mocks.merge,
  releaseUnusedComposerAttachmentFiles: mocks.release,
  waitForComposerDraftsLoaded: async () => {},
}));
vi.mock("../lib/composerContextClipboard", () => ({
  assertRewindContentFits: mocks.fits,
  prepareRewindComposerContent: mocks.prepare,
}));
vi.mock("@t3tools/client-runtime/state/thread-checkpoints", () => ({
  deriveMessageRevertTargets: mocks.targets,
  supportsThreadRollback: mocks.supports,
  waitForThreadRollback: mocks.wait,
}));
vi.mock("@t3tools/client-runtime/state/thread-execution", () => ({
  deriveThreadRuntime: mocks.runtime,
  deriveRunlessWorkStartedAt: mocks.work,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.command,
  squashAtomCommandFailure: (result: { error: Error }) => result.error,
}));

import { appAtomRegistry } from "./atom-registry";
import { rewindUserMessage } from "./thread-message-rewind";
import { rewindingThreadKeysAtom, sendingThreadKeysAtom } from "./thread-composer-operations";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const messageId = MessageId.make("message");
const checkpoint = {
  id: CheckpointId.make("checkpoint"),
  scopeId: CheckpointScopeId.make("scope"),
  appRunOrdinal: 3,
};
const message = {
  type: "user_message",
  messageId,
  runId: RunId.make("run-8"),
  text: "Restore me",
  attachments: [],
};
const detailAtom = Atom.make({
  history: { hasMoreHistory: false },
  data: Option.some({
    thread: { providerInstanceId: "codex" },
    visibleTurnItems: [{ visibility: "local", item: message }],
  }),
});
const presentationAtom = Atom.make({ connection: { phase: "connected" } });
const configAtom = Atom.make({ providers: [{ instanceId: "codex" }] });
const importsAtom = Atom.make<Record<string, boolean>>({});
const outboxAtom = Atom.make<Record<string, unknown[]>>({});
let draft = { text: "Unsent draft", attachments: [] as unknown[] };
let edit: object | null = null;

function setup() {
  vi.clearAllMocks();
  draft = { text: "Unsent draft", attachments: [] };
  edit = null;
  appAtomRegistry.set(rewindingThreadKeysAtom, new Set());
  appAtomRegistry.set(sendingThreadKeysAtom, new Set());
  appAtomRegistry.set(presentationAtom, { connection: { phase: "connected" } });
  appAtomRegistry.set(outboxAtom, {});
  appAtomRegistry.set(importsAtom, {});
  mocks.runtime.mockReturnValue(null);
  mocks.work.mockReturnValue(null);
  mocks.permission.mockReturnValue(true);
  mocks.supports.mockReturnValue(true);
  mocks.targets.mockReturnValue(new Map([[messageId, checkpoint]]));
  mocks.confirm.mockResolvedValue(false);
  mocks.prepare.mockResolvedValue({
    text: message.text,
    attachments: [{ id: "owned", fileUri: "file:///owned" }],
  });
  mocks.command.mockResolvedValue({ _tag: "Success" });
  mocks.wait.mockImplementation(async ({ revert }: { revert: () => Promise<void> }) => revert());
  mocks.merge.mockImplementation(async (_key: string, content: typeof draft) => {
    draft = {
      ...draft,
      text: `${draft.text}\n\n${content.text}`,
      attachments: [...draft.attachments, ...content.attachments],
    };
  });
  mocks.release.mockResolvedValue(undefined);
}

describe("mobile message rewind", () => {
  it("retains a persisted recovery copy when rollback completion is uncertain", async () => {
    setup();
    mocks.wait.mockImplementationOnce(async ({ revert }: { revert: () => Promise<void> }) => {
      await revert();
      throw new Error("Timed out waiting for the thread to rewind.");
    });
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    expect(draft.text).toBe("Unsent draft\n\nRestore me");
    expect(draft.attachments).toEqual([{ id: "owned", fileUri: "file:///owned" }]);
    expect(mocks.merge.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.command.mock.invocationCallOrder[0]!,
    );
  });
  it("saves the draft before rollback and waits for persisted completion with the selected checkpoint and file mode", async () => {
    setup();
    const receipt = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<void>();
    mocks.wait.mockImplementation(async ({ revert }: { revert: () => Promise<void> }) => {
      await revert();
      receipt.resolve();
      await completion.promise;
    });
    const waiting = rewindUserMessage(threadRef, messageId, mocks.confirm);
    await receipt.promise;
    expect(draft.text).toBe("Unsent draft\n\nRestore me");
    expect(mocks.merge).toHaveBeenCalledOnce();
    expect(appAtomRegistry.get(rewindingThreadKeysAtom).has("env:thread")).toBe(true);
    expect(mocks.command.mock.calls[0]?.[2]).toMatchObject({
      environmentId: "env",
      input: {
        threadId: "thread",
        checkpointId: "checkpoint",
        scopeId: "scope",
        turnCount: 3,
        restoreFiles: false,
      },
    });
    completion.resolve();
    expect(await waiting).toBe(true);
    expect(draft.text).toBe("Unsent draft\n\nRestore me");
    expect(appAtomRegistry.get(rewindingThreadKeysAtom).size).toBe(0);
  });

  it("retains the recovery draft on persisted failure", async () => {
    setup();
    mocks.wait.mockRejectedValueOnce(new Error("Provider rollback failed"));
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    expect(draft.text).toBe("Unsent draft\n\nRestore me");
    expect(draft.attachments).toEqual([{ id: "owned", fileUri: "file:///owned" }]);
    expect(mocks.release).toHaveBeenCalledWith([{ id: "owned", fileUri: "file:///owned" }]);
    expect(mocks.error).toHaveBeenCalledWith(
      "env:thread",
      expect.stringContaining("Your prompt and attachments are saved in the composer"),
    );
  });

  it("does not dispatch a rollback until the recovery draft is durable", async () => {
    setup();
    const saving = Promise.withResolvers<void>();
    const persisted = Promise.withResolvers<void>();
    mocks.merge.mockImplementationOnce(async () => {
      saving.resolve();
      await persisted.promise;
    });
    const waiting = rewindUserMessage(threadRef, messageId, mocks.confirm);
    await saving.promise;
    expect(mocks.command).not.toHaveBeenCalled();
    persisted.resolve();
    expect(await waiting).toBe(true);
  });

  it("does not dispatch when saving the recovery draft fails", async () => {
    setup();
    mocks.merge.mockRejectedValueOnce(new Error("Disk full"));
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("env:thread", "Disk full");
  });

  it("rechecks permission after saving the recovery draft", async () => {
    setup();
    mocks.merge.mockImplementationOnce(async () => {
      mocks.permission.mockReturnValue(false);
    });
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it("does not dispatch on failed imports or cap overflow", async () => {
    setup();
    mocks.prepare.mockRejectedValueOnce(new Error("Missing attachment"));
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    expect(mocks.command).not.toHaveBeenCalled();
    mocks.fits.mockImplementationOnce(() => {
      throw new Error("Attachment cap");
    });
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("locks duplicate actions across confirmations and rechecks permission afterward", async () => {
    setup();
    const confirmation = Promise.withResolvers<boolean | null>();
    mocks.confirm.mockReturnValueOnce(confirmation.promise);
    const waiting = rewindUserMessage(threadRef, messageId, mocks.confirm);
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    mocks.permission.mockReturnValue(false);
    confirmation.resolve(true);
    expect(await waiting).toBe(false);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("supports cancelling and restoring files", async () => {
    setup();
    mocks.confirm.mockResolvedValueOnce(null);
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    expect(mocks.prepare).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValueOnce(true);
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(true);
    expect(mocks.command.mock.calls[0]?.[2]).toMatchObject({ input: { restoreFiles: true } });
  });

  it("blocks disconnected, unpermitted, unsupported, sending, pending and queued-edit threads", async () => {
    setup();
    mocks.permission.mockReturnValue(false);
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    mocks.permission.mockReturnValue(true);
    mocks.supports.mockReturnValue(false);
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    mocks.supports.mockReturnValue(true);
    appAtomRegistry.set(presentationAtom, { connection: { phase: "connecting" } });
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    appAtomRegistry.set(presentationAtom, { connection: { phase: "connected" } });
    appAtomRegistry.set(sendingThreadKeysAtom, new Set(["env:thread"]));
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    appAtomRegistry.set(sendingThreadKeysAtom, new Set());
    appAtomRegistry.set(outboxAtom, { "env:thread": [{}] });
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    appAtomRegistry.set(outboxAtom, {});
    edit = {};
    expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});

it("rechecks the checkpoint after attachment preparation and releases unused files", async () => {
  setup();
  mocks.prepare.mockImplementationOnce(async () => {
    mocks.targets.mockReturnValue(new Map());
    return { text: message.text, attachments: [{ id: "prepared", fileUri: "file:///prepared" }] };
  });
  expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledWith([{ id: "prepared", fileUri: "file:///prepared" }]);
  expect(draft.text).toBe("Unsent draft");
});

it("blocks running threads, background work and in-flight context imports", async () => {
  setup();
  mocks.runtime.mockReturnValue({ status: "running" });
  expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
  mocks.runtime.mockReturnValue(null);
  mocks.work.mockReturnValue("2026-10-21T00:00:00.000Z");
  expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
  mocks.work.mockReturnValue(null);
  appAtomRegistry.set(importsAtom, { "env:thread": true });
  expect(await rewindUserMessage(threadRef, messageId, mocks.confirm)).toBe(false);
  expect(mocks.confirm).not.toHaveBeenCalled();
});
