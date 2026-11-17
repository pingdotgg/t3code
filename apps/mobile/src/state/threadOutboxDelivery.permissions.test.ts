import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { attachmentUploadError } from "@t3tools/client-runtime/state/attachment-uploads";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { threadOutboxRetryDelayMs, type QueuedThreadMessage } from "./thread-outbox-model";

type TestThreadShell = { readonly environmentId: string; readonly id: string; readonly bot?: true };

const state = vi.hoisted(() => ({
  draftText: "Keep this draft separate",
  cleanups: [] as Array<() => void>,
  delivery: null as {
    readonly drain: () => void;
    readonly dispose: () => void;
  } | null,
  start: vi.fn(),
  metadata: vi.fn(),
  runtime: vi.fn(),
  interaction: vi.fn(),
  prepare: vi.fn(),
  checkout: vi.fn(),
  modelUnavailable: vi.fn(() => false),
  familyMount: vi.fn(() => () => {}),
  threadShells: null as unknown as Atom.Writable<ReadonlyArray<TestThreadShell>>,
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  thread: {
    environmentId: "secondary",
    id: "thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
  },
  config: {
    shellThreadFamilies: false,
    providers: [{ instanceId: "codex", driver: "codex", models: [] }],
    environment: { capabilities: {} },
  },
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (_registry: unknown, command: (input: unknown) => unknown, input: unknown) =>
    command(input),
}));
vi.mock("./session", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  // A session's state is reduced to whether it grants the operate scope.
  const sessionStateAtom = Atom.family((_id: string) => Atom.make(false).pipe(Atom.keepAlive));
  const sessionHasScope = (granted: boolean, scope: string) =>
    granted && scope === AuthOrchestrationOperateScope;
  return {
    environmentSession: { sessionStateAtom },
    sessionHasScope,
    readEnvironmentScope: (environmentId: string, scope: string) =>
      sessionHasScope(appAtomRegistry.get(sessionStateAtom(environmentId)), scope),
  };
});
vi.mock("./projects", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentProjects: { projectsAtom: Atom.make([]) } };
});
vi.mock("./workspace", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    workspaceConnections: {
      environmentsAtom: Atom.make([{ environmentId: "secondary", connectionState: "connected" }]),
    },
  };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { configValueAtom: Atom.family((_id: string) => Atom.make(state.config)) },
    environmentServerConfigsAtom: Atom.make(new Map([["secondary", state.config]])),
  };
});
vi.mock("./threads", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  state.threadShells = Atom.make<ReadonlyArray<TestThreadShell>>([state.thread]).pipe(
    Atom.keepAlive,
  );
  const threadShell = Atom.family((key: string) =>
    Atom.make(
      (get) =>
        get(state.threadShells).find((shell) => `${shell.environmentId}:${shell.id}` === key) ??
        null,
    ),
  );
  return {
    threadEnvironment: {
      startTurn: state.start,
      updateMetadata: state.metadata,
      setRuntimeMode: state.runtime,
      setInteractionMode: state.interaction,
    },
    environmentThreadShells: {
      // Lists leave bot chats out, as the real atoms do; lookups by id still reach them.
      threadShellsAtom: Atom.make((get) => get(state.threadShells).filter((shell) => !shell.bot)),
      threadShellAtom: (ref: { readonly environmentId: string; readonly threadId: string }) =>
        threadShell(`${ref.environmentId}:${ref.threadId}`),
    },
    threadFamilies: {
      mount: state.familyMount,
      familyAtom: () => Atom.make(AsyncResult.success({})),
      refresh: vi.fn(),
    },
    environmentThreadDetails: { stateAtom: () => Atom.make(null) },
  };
});
vi.mock("./git", () => ({ gitEnvironment: { preparePullRequestThread: state.checkout } }));
vi.mock("../lib/modelOptions", () => ({ isModelSelectionUnavailable: state.modelUnavailable }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "abcd" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: state.prepare }));
vi.mock("./composer-attachment-uploads", () => ({ uploadComposerAttachmentShared: vi.fn() }));
vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  state.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => {},
      remove: async () => {},
    },
  });
  return {
    threadOutboxManager: state.manager,
    threadOutboxRevision: (id: MessageId) => state.manager.revisionOf(id),
    confirmThreadOutboxMessageQueued: (message: QueuedThreadMessage) =>
      state.manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
      state.manager.update(message, revision),
  };
});
vi.mock("./thread-outbox-removal", () => ({
  removeThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
    state.manager.remove(message, revision),
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdsAtom: Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
      Atom.keepAlive,
    ),
    retryingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    threadOutboxShellStatusesAtom: Atom.make(new Map([["secondary", "live"]])),
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    removeDeliveredCloudQueuedMessage: async () => {},
    appendComposerDraftAttachments: vi.fn(),
    flushComposerDrafts: vi.fn(async () => {}),
    getComposerDraftSnapshot: vi.fn(() => ({ text: state.draftText, attachments: [] })),
    mergeComposerDraftContent: vi.fn(async (_key: string, input: { text: string }) => {
      state.draftText += `\n${input.text}`;
    }),
    replaceComposerDraftAttachments: vi.fn(),
    setFreshSessionPending: vi.fn(),
    undoComposerDraftMerge: vi.fn(),
    updateComposerDraftSettings: vi.fn(),
    waitForComposerDraftsLoaded: vi.fn(),
  };
});

import { appAtomRegistry } from "./atom-registry";
import { environmentSession } from "./session";
import { dispatchingQueuedMessageIdsAtom, editingQueuedMessageIdsAtom } from "./use-thread-outbox";

const sendingMessageIds = () => Object.keys(appAtomRegistry.get(dispatchingQueuedMessageIdsAtom));
import { createThreadOutboxDelivery } from "./threadOutboxDelivery";
import { workspaceConnections } from "./workspace";

const message = (overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
  commandId: CommandId.make("command"),
  messageId: MessageId.make("message"),
  text: "Keep this queued",
  attachments: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  ...overrides,
});
const remaining = () =>
  Object.values(appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom)).flat();

function setOperateGrant(environmentId: string, granted: boolean): void {
  // The mocked session atom holds the grant itself (see the ./session mock).
  const sessionAtom = environmentSession.sessionStateAtom(EnvironmentId.make(environmentId));
  appAtomRegistry.set(sessionAtom as unknown as Atom.Writable<boolean>, granted);
}

function runDrain() {
  const settled = Promise.withResolvers<void>();
  const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdsAtom, (ids) => {
    if (Object.keys(ids).length === 0) settled.resolve();
  });
  startDelivery();
  return settled.promise.finally(release);
}

/** Starts the service once per test; later calls run another drain pass. */
function startDelivery(): void {
  if (state.delivery !== null) {
    state.delivery.drain();
    return;
  }
  const delivery = createThreadOutboxDelivery();
  state.delivery = delivery;
  state.cleanups.push(() => {
    delivery.dispose();
    state.delivery = null;
  });
}

beforeEach(() => {
  setOperateGrant("primary", true);
  setOperateGrant("secondary", false);
  state.draftText = "Keep this draft separate";
  state.config.shellThreadFamilies = false;
  state.modelUnavailable.mockReset().mockReturnValue(false);
  state.familyMount.mockReset().mockReturnValue(() => {});
  appAtomRegistry.set(state.threadShells, [state.thread]);
  appAtomRegistry.set(state.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(dispatchingQueuedMessageIdsAtom, {});
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  for (const command of [
    state.start,
    state.metadata,
    state.runtime,
    state.interaction,
    state.checkout,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  }
  state.start.mockResolvedValue(AsyncResult.success({}));
  state.prepare.mockReset().mockImplementation(({ attachments }) =>
    Effect.succeed({
      status: "ready",
      attachments: [],
      draftAttachments: attachments,
      pendingAttachmentIds: [],
    }),
  );
});

describe("queued PR checkout", () => {
  const queuedPullRequest = () =>
    message({
      threadId: ThreadId.make("new-pr-thread"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      creation: {
        projectId: ProjectId.make("project"),
        projectCwd: "/repo",
        workspaceMode: "worktree",
        branch: "fork/feature",
        worktreePath: null,
        pullRequestReference: "https://github.com/acme/repo/pull/123",
      },
    });
  const preparedCheckout = {
    branch: "pr-123",
    worktreePath: "/repo/.t3/worktrees/pr-123",
    isOnPullRequestHead: true,
  };

  it("waits for the provider's PR checkout and launches in that worktree", async () => {
    setOperateGrant("secondary", true);
    await state.manager.enqueue(queuedPullRequest());
    const started = Promise.withResolvers<void>();
    const checkout =
      Promise.withResolvers<AsyncResult.AsyncResult<typeof preparedCheckout, Error>>();
    state.checkout.mockImplementationOnce(() => {
      started.resolve();
      return checkout.promise;
    });
    const drained = runDrain();
    await started.promise;
    expect(state.start).not.toHaveBeenCalled();
    expect(state.checkout).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { cwd: "/repo", reference: "https://github.com/acme/repo/pull/123", mode: "worktree" },
    });
    checkout.resolve(AsyncResult.success(preparedCheckout));
    await drained;
    expect(state.start).toHaveBeenCalledOnce();
    const bootstrap = state.start.mock.calls[0]?.[0].input.bootstrap;
    expect(bootstrap.createThread).toMatchObject({
      branch: "pr-123",
      worktreePath: preparedCheckout.worktreePath,
    });
    expect(bootstrap.prepareWorktree).toBeUndefined();
    expect(remaining()).toEqual([]);
  });

  it("keeps the PR source queued on a transport failure without starting the agent", async () => {
    setOperateGrant("secondary", true);
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    state.checkout.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
    );
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("stops launch if operation access is revoked while checking out the PR", async () => {
    setOperateGrant("secondary", true);
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    state.checkout.mockImplementationOnce(async () => {
      setOperateGrant("secondary", false);
      return AsyncResult.success(preparedCheckout);
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("does not launch a stale task edited while the PR checkout was running", async () => {
    setOperateGrant("secondary", true);
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    const edited = { ...queued, text: "Updated instructions" };
    state.checkout.mockImplementationOnce(async () => {
      await state.manager.update(edited);
      return AsyncResult.success(preparedCheckout);
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([edited]);
  });
});
afterEach(() => {
  state.cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("queued task operation access", () => {
  it("parks a connected read-only target, then delivers its unchanged queue after a grant", async () => {
    const queued = message();
    await state.manager.enqueue(queued);
    startDelivery();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
    setOperateGrant("secondary", true);
    await runDrain();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("delivers a queued bot chat message, though thread lists leave bot chats out", async () => {
    setOperateGrant("secondary", true);
    appAtomRegistry.set(state.threadShells, [
      state.thread,
      { ...state.thread, id: "bot", bot: true },
    ]);
    await state.manager.enqueue(message({ threadId: ThreadId.make("bot") }));
    await runDrain();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("backs off instead of redelivering at once when a delivery hits a defect", async () => {
    setOperateGrant("secondary", true);
    const queued = message();
    await state.manager.enqueue(queued);
    // Awaited steps catch their own failures, so a defect in the delivery's own code is what
    // rejects a delivery.
    state.modelUnavailable.mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    await runDrain();
    expect(state.modelUnavailable).toHaveBeenCalledOnce();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(sendingMessageIds()).toEqual([]);
    expect(remaining()).toEqual([queued]);
  });

  it("starts one delivery when mounting a thread family changes the rows mid-pass", async () => {
    setOperateGrant("secondary", true);
    state.config.shellThreadFamilies = true;
    const subAgentThread = { ...state.thread, id: "sub-agent" };
    // A cached family merges its rows into the shell list as soon as it is mounted.
    state.familyMount.mockImplementationOnce(() => {
      appAtomRegistry.set(state.threadShells, [state.thread, subAgentThread]);
      return () => {};
    });
    const queued = message({ threadId: ThreadId.make("sub-agent") });
    startDelivery();
    appAtomRegistry.set(editingQueuedMessageIdsAtom, { [queued.messageId]: true });
    await state.manager.enqueue(queued);
    const delivered = Promise.withResolvers<void>();
    const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdsAtom, (ids) => {
      if (Object.keys(ids).length === 0) delivered.resolve();
    });
    // Ending the edit wakes the thread through a registry notification, the path on which the
    // mount's synchronous row change wakes it again while it is deciding.
    appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
    await delivered.promise.finally(release);
    expect(state.familyMount).toHaveBeenCalledOnce();
    // One fiber took the message: a second would have prepared it again.
    expect(state.prepare).toHaveBeenCalledOnce();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("stops the remaining settings and turn commands when an earlier update loses access", async () => {
    setOperateGrant("secondary", true);
    const queued = message({
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "different-model" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    await state.manager.enqueue(queued);
    state.runtime.mockImplementationOnce(async () => {
      setOperateGrant("secondary", false);
      return AsyncResult.success(undefined);
    });
    await runDrain();
    expect(state.runtime).toHaveBeenCalledOnce();
    expect(state.interaction).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it.each([
    { isCreation: false, accepted: false },
    { isCreation: true, accepted: true },
  ])(
    "preserves a rejected queue but removes an accepted turn after access loss (new task: $isCreation, accepted: $accepted)",
    async ({ isCreation, accepted }) => {
      setOperateGrant("secondary", true);
      const queued = message(
        isCreation
          ? {
              threadId: ThreadId.make("new-thread"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              creation: {
                projectId: ProjectId.make("project"),
                projectCwd: "/repo",
                workspaceMode: "local",
                branch: null,
                worktreePath: null,
              },
            }
          : {},
      );
      await state.manager.enqueue(queued);
      const started = Promise.withResolvers<void>();
      const delivery =
        Promise.withResolvers<AsyncResult.AsyncResult<{ readonly sequence?: number }, Error>>();
      state.start.mockImplementationOnce(() => {
        started.resolve();
        return delivery.promise;
      });
      const drained = runDrain();
      await started.promise;
      setOperateGrant("secondary", false);
      delivery.resolve(
        accepted
          ? AsyncResult.success({})
          : AsyncResult.failure(Cause.fail(new Error("This connection cannot control this task."))),
      );
      await drained;

      expect(remaining()).toEqual(accepted ? [] : [queued]);
      expect(state.draftText).toBe("Keep this draft separate");
      if (!accepted) {
        setOperateGrant("secondary", true);
        await runDrain();
        expect(state.start).toHaveBeenCalledTimes(2);
        expect(remaining()).toEqual([]);
        expect(state.draftText).toBe("Keep this draft separate");
      }
    },
  );

  it.each([
    { isCreation: false, uploadFails: false },
    { isCreation: true, uploadFails: false },
    { isCreation: false, uploadFails: true },
    { isCreation: true, uploadFails: true },
  ])(
    "keeps the message queued after upload revocation (new task: $isCreation, upload fails: $uploadFails)",
    async ({ isCreation, uploadFails }) => {
      setOperateGrant("secondary", true);
      const queued = message(
        isCreation
          ? {
              threadId: ThreadId.make("new-thread"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              creation: {
                projectId: ProjectId.make("project"),
                projectCwd: "/repo",
                workspaceMode: "local",
                branch: null,
                worktreePath: null,
              },
            }
          : {},
      );
      await state.manager.enqueue(queued);
      state.prepare.mockImplementationOnce(({ attachments }) =>
        Effect.suspend(() => {
          setOperateGrant("secondary", false);
          return uploadFails
            ? Effect.fail(
                attachmentUploadError(new Error("This connection cannot upload attachments.")),
              )
            : Effect.succeed({
                status: "ready",
                attachments: [],
                draftAttachments: attachments,
                pendingAttachmentIds: [],
              });
        }),
      );
      await runDrain();
      expect(state.prepare).toHaveBeenCalledOnce();
      expect(state.start).not.toHaveBeenCalled();
      expect(remaining()).toEqual([queued]);
    },
  );
});

describe("queued task whose launch reply is lost", () => {
  const queuedTask = (creation: Partial<NonNullable<QueuedThreadMessage["creation"]>> = {}) =>
    message({
      threadId: ThreadId.make("new-thread"),
      text: "My dictated idea",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      creation: {
        projectId: ProjectId.make("project"),
        projectCwd: "/repo",
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
        ...creation,
      },
    });

  /** The server creates the thread, but the launch reply is lost; the thread then shows up. */
  async function loseLaunchReply(queued: QueuedThreadMessage, edit?: string): Promise<void> {
    setOperateGrant("secondary", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.cleanups.push(() => vi.useRealTimers());
    await state.manager.enqueue(queued);
    state.start.mockImplementationOnce(async () => {
      if (edit !== undefined) await state.manager.update({ ...queued, text: edit });
      return AsyncResult.failure(Cause.fail(new Error("Socket is not connected")));
    });
    await runDrain();
    expect(remaining()).toHaveLength(1);
    appAtomRegistry.set(state.threadShells, [state.thread, { ...state.thread, id: "new-thread" }]);
  }

  async function fireRetry(): Promise<void> {
    const settled = Promise.withResolvers<void>();
    const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdsAtom, (ids) => {
      if (Object.keys(ids).length === 0) settled.resolve();
    });
    vi.advanceTimersByTime(threadOutboxRetryDelayMs(1));
    await settled.promise.finally(release);
  }

  it("resends an unedited launch instead of handing its text back", async () => {
    await loseLaunchReply(queuedTask());
    await fireRetry();

    expect(state.draftText).toBe("Keep this draft separate");
    // The resend reuses the launch's command and message ids, so the server replays it.
    const [first, resent] = state.start.mock.calls.map(([call]) => call.input);
    expect(state.start).toHaveBeenCalledTimes(2);
    expect(resent.commandId).toBe(first.commandId);
    expect(resent.message.messageId).toBe(first.message.messageId);
    expect(remaining()).toEqual([]);
  });

  it("hands back a task edited while its launch was in flight", async () => {
    await loseLaunchReply(queuedTask(), "Edited idea");
    await fireRetry();

    expect(state.draftText).toBe("Keep this draft separate\nEdited idea");
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("holds the resend while operation access is missing", async () => {
    await loseLaunchReply(queuedTask());
    setOperateGrant("secondary", false);
    vi.advanceTimersByTime(threadOutboxRetryDelayMs(1));
    expect(sendingMessageIds()).toEqual([]);
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toHaveLength(1);

    setOperateGrant("secondary", true);
    await runDrain();
    expect(state.start).toHaveBeenCalledTimes(2);
    expect(state.draftText).toBe("Keep this draft separate");
    expect(remaining()).toEqual([]);
  });

  it("resends a pull request task in its launched worktree without checking out again", async () => {
    state.checkout.mockResolvedValueOnce(
      AsyncResult.success({
        branch: "pr-123",
        worktreePath: "/repo/.t3/worktrees/pr-123",
        isOnPullRequestHead: true,
      }),
    );
    await loseLaunchReply(
      queuedTask({
        workspaceMode: "worktree",
        branch: "fork/feature",
        pullRequestReference: "https://github.com/acme/repo/pull/123",
      }),
    );
    await fireRetry();

    expect(state.checkout).toHaveBeenCalledOnce();
    const [first, resent] = state.start.mock.calls.map(([call]) => call.input);
    expect(resent.bootstrap.createThread.worktreePath).toBe("/repo/.t3/worktrees/pr-123");
    expect(resent.bootstrap).toEqual(first.bootstrap);
    expect(remaining()).toEqual([]);
  });
});

describe("compaction before a queued send", () => {
  const compactTurn = {
    commandId: "command:compact",
    message: {
      messageId: "message:compact",
      role: "user",
      text: "/compact",
      attachments: [],
      idleCompaction: "onReturn",
    },
    dispatchMode: "queue",
  };

  it("queues /compact ahead of the message and resends the same /compact on a retry", async () => {
    setOperateGrant("secondary", true);
    const queued = message({ compactBeforeSend: true, dispatchMode: "queue" });
    await state.manager.enqueue(queued);
    state.start
      .mockResolvedValueOnce(AsyncResult.success({}))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))));
    await runDrain();
    expect(remaining()).toEqual([queued]);

    // A restarted app delivers the persisted message again.
    state.cleanups.splice(0).forEach((cleanup) => cleanup());
    await runDrain();
    expect(state.start.mock.calls.map(([call]) => call.input)).toEqual([
      expect.objectContaining(compactTurn),
      expect.objectContaining({ commandId: "command", dispatchMode: "queue" }),
      expect.objectContaining(compactTurn),
      expect.objectContaining({ commandId: "command", dispatchMode: "queue" }),
    ]);
    expect(remaining()).toEqual([]);
  });

  it("holds the message when its /compact cannot be sent", async () => {
    setOperateGrant("secondary", true);
    const queued = message({ compactBeforeSend: true, dispatchMode: "queue" });
    await state.manager.enqueue(queued);
    state.start.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
    );
    await runDrain();
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.start.mock.calls[0]?.[0].input).toMatchObject(compactTurn);
    expect(remaining()).toEqual([queued]);
  });
});

describe("queued delivery timing", () => {
  /** Runs `change`, then resolves once the delivery it starts has settled. */
  async function deliveryAfter(change: () => void): Promise<void> {
    const started = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdsAtom, (ids) => {
      if (Object.keys(ids).length > 0) started.resolve();
      else settled.resolve();
    });
    change();
    await started.promise;
    await settled.promise.finally(release);
  }

  it("starts a thread's next message only after its interrupted send has finished", async () => {
    setOperateGrant("secondary", true);
    const firstStarted = Promise.withResolvers<void>();
    const finishFirst = Promise.withResolvers<AsyncResult.AsyncResult<object, never>>();
    state.start.mockImplementationOnce(async () => {
      firstStarted.resolve();
      return finishFirst.promise;
    });
    const first = message();
    await state.manager.enqueue(first);
    startDelivery();
    await firstStarted.promise;
    // The queue empties under the running send, then the thread gets its next message.
    await state.manager.remove(first);
    const allDelivered = Promise.withResolvers<void>();
    const release = appAtomRegistry.subscribe(state.manager.queuedMessagesByThreadKeyAtom, () => {
      if (remaining().length === 0) allDelivered.resolve();
    });
    await state.manager.enqueue(
      message({ messageId: MessageId.make("next"), commandId: CommandId.make("next-command") }),
    );
    // The next message waits; only the interrupted send is still marked as sending.
    expect(sendingMessageIds()).toEqual(["message"]);
    expect(state.start).toHaveBeenCalledOnce();
    finishFirst.resolve(AsyncResult.success({}));
    await allDelivered.promise.finally(release);
    expect(state.start).toHaveBeenCalledTimes(2);
  });

  it("sends another thread's message while one thread's send is still running", async () => {
    setOperateGrant("secondary", true);
    const other = { ...state.thread, id: "other" };
    appAtomRegistry.set(state.threadShells, [state.thread, other]);
    const slowStarted = Promise.withResolvers<void>();
    const finishSlow = Promise.withResolvers<AsyncResult.AsyncResult<object, never>>();
    state.start.mockImplementation(async ({ input }: { input: { threadId: string } }) => {
      if (input.threadId !== "thread") return AsyncResult.success({});
      slowStarted.resolve();
      return finishSlow.promise;
    });
    /** Resolves once only these message ids are still queued. */
    const queuedBecomes = (ids: ReadonlyArray<string>) => {
      const reached = Promise.withResolvers<void>();
      const release = appAtomRegistry.subscribe(state.manager.queuedMessagesByThreadKeyAtom, () => {
        if (
          remaining()
            .map((queued) => queued.messageId)
            .join() === ids.join()
        ) {
          reached.resolve();
        }
      });
      return reached.promise.finally(release);
    };
    await state.manager.enqueue(message());
    startDelivery();
    await slowStarted.promise;
    const otherDelivered = queuedBecomes(["message"]);
    await state.manager.enqueue(
      message({
        threadId: ThreadId.make("other"),
        messageId: MessageId.make("other-message"),
        commandId: CommandId.make("other-command"),
      }),
    );
    await otherDelivered;
    const allDelivered = queuedBecomes([]);
    finishSlow.resolve(AsyncResult.success({}));
    await allDelivered;
    expect(state.start).toHaveBeenCalledTimes(2);
  });

  it("sends at once when its environment reconnects instead of waiting out the backoff", async () => {
    setOperateGrant("secondary", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.cleanups.push(() => vi.useRealTimers());
    const environments = workspaceConnections.environmentsAtom as unknown as Atom.Writable<
      ReadonlyArray<{ environmentId: string; connectionState: string }>
    >;
    const connected = [{ environmentId: "secondary", connectionState: "connected" }];
    state.cleanups.push(() => appAtomRegistry.set(environments, connected));
    await state.manager.enqueue(message());
    state.start.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
    );
    await runDrain();
    expect(state.start).toHaveBeenCalledOnce();

    appAtomRegistry.set(environments, [
      { environmentId: "secondary", connectionState: "disconnected" },
    ]);
    await deliveryAfter(() => appAtomRegistry.set(environments, connected));
    expect(state.start).toHaveBeenCalledTimes(2);
    expect(remaining()).toEqual([]);
  });
});
