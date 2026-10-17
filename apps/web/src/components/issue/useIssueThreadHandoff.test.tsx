// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ChatAttachmentId,
  EnvironmentId,
  IssueResolvedUrl,
  IssueTrackerKind,
  MessageId,
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AuthSessionState,
  type IssueDetail,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";

const state = vi.hoisted(() => ({
  newThread: vi.fn(),
  toast: vi.fn(),
  deniedEnvironment: "",
  launchError: null as Error | null,
  launchWait: null as Promise<void> | null,
  launchStarted: () => {},
  linkError: null as Error | null,
  resolveError: null as Error | null,
  resolvedProject: "",
  resolvedConnectionId: undefined as string | undefined,
  resolvedWritable: true,
  resolvedScope: "acme/web",
  resolveWait: null as Promise<void> | null,
  resolveStarted: () => {},
  calls: [] as Array<{ environmentId: string; method: string; input: Record<string, unknown> }>,
}));

vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.newThread }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast, close: vi.fn() } }));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: (environmentId: string) => environmentId !== state.deniedEnvironment,
}));
vi.mock("@t3tools/client-runtime/state/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@t3tools/client-runtime/state/session")>();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    ...original,
    createEnvironmentSessionAtoms: () => ({
      sessionStateAtom: Atom.family(() =>
        Atom.make(
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
            permissions: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          } satisfies AuthSessionState),
        ),
      ),
    }),
  };
});
vi.mock("~/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const Crypto = await import("effect/Crypto");
  const Option = await import("effect/Option");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const services = await import("@t3tools/client-runtime/connection");
  const decodeLaunch = Schema.decodeUnknownEffect(OrchestrationV2ThreadLaunchInput);
  const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);
  const decodeResolved = Schema.decodeUnknownEffect(IssueResolvedUrl);
  const call = (environmentId: EnvironmentId, method: string, input: Record<string, unknown>) =>
    Effect.gen(function* () {
      state.calls.push({ environmentId, method, input });
      if (method === ORCHESTRATION_V2_WS_METHODS.launchThread) {
        yield* decodeLaunch(input);
        state.launchStarted();
        if (state.launchWait) yield* Effect.promise(() => state.launchWait!);
        if (state.launchError) return yield* Effect.fail(state.launchError);
        return { sequence: 1 };
      }
      if (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand) {
        yield* decodeCommand(input);
        if (state.linkError) return yield* Effect.fail(state.linkError);
        return { sequence: 1 };
      }
      expect(method).toBe("issues.resolveUrl");
      state.resolveStarted();
      if (state.resolveWait) yield* Effect.promise(() => state.resolveWait!);
      if (state.resolveError) return yield* Effect.fail(state.resolveError);
      return yield* decodeResolved({
        projectId: state.resolvedProject || input.projectId,
        ...((state.resolvedConnectionId ?? input.connectionId) === undefined
          ? {}
          : { connectionId: state.resolvedConnectionId ?? input.connectionId }),
        tracker: "github",
        host: "github.com",
        scope: state.resolvedScope,
        key: "7",
        writable: state.resolvedWritable,
      });
    });
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(
          services.EnvironmentRegistry.EnvironmentRegistry,
          services.EnvironmentRegistry.EnvironmentRegistry.of({
            run: <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                const client = {
                  [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input: Record<string, unknown>) =>
                    call(environmentId, ORCHESTRATION_V2_WS_METHODS.launchThread, input),
                  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (input: Record<string, unknown>) =>
                    call(environmentId, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, input),
                  "issues.resolveUrl": (input: Record<string, unknown>) =>
                    call(environmentId, "issues.resolveUrl", input),
                } as unknown as RpcSession["client"];
                const session = yield* SubscriptionRef.make(Option.some({ client } as RpcSession));
                return yield* Effect.provideService(
                  effect,
                  services.EnvironmentSupervisor.EnvironmentSupervisor,
                  {
                    target: { environmentId },
                    session,
                  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
                );
              }),
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        ),
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      ),
    ),
  };
});
vi.mock("~/state/threads", async () => {
  const { createThreadEnvironmentAtoms } = await import("@t3tools/client-runtime/state/threads");
  const { connectionAtomRuntime } = await import("~/connection/runtime");
  const { Atom } = await import("effect/reactivity");
  return {
    threadEnvironment: createThreadEnvironmentAtoms(connectionAtomRuntime, () => Atom.make(null)),
  };
});

import {
  DraftId,
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  composerDraftHasUserContent,
  finalizePromotedDraftThreadByRef,
  restoreFailedBackgroundDraftThread,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { threadEnvironment } from "~/state/threads";
import { useIssueThreadHandoff, withIssueThreadHandoff } from "./useIssueThreadHandoff";

const environmentA = EnvironmentId.make("A");
const environmentB = EnvironmentId.make("B");
const projectA = ProjectId.make("project-A");
const projectB = ProjectId.make("project-B");
const draftId = DraftId.make("solve-draft");
const threadId = ThreadId.make("solve-thread");
const detail = {
  displayKey: "#7",
  title: "Fix it",
  url: "https://github.com/acme/web/issues/7",
} as IssueDetail;
const reference = {
  projectId: projectA,
  tracker: IssueTrackerKind.make("github"),
  scope: "acme/web",
  key: "7",
};
let root: Root;
let element: HTMLDivElement;
let handoff: ReturnType<typeof useIssueThreadHandoff>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Harness({ connectionId }: { connectionId?: string } = {}) {
  const current = useIssueThreadHandoff(environmentA, {
    ...reference,
    ...(connectionId === undefined ? {} : { connectionId }),
  });
  useEffect(() => {
    handoff = current;
  });
  return null;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  state.calls = [];
  state.toast.mockReset();
  state.deniedEnvironment = state.resolvedProject = "";
  state.resolvedConnectionId = undefined;
  state.resolvedWritable = true;
  state.resolvedScope = "acme/web";
  state.launchError = state.linkError = state.resolveError = null;
  state.launchWait = null;
  state.launchStarted = () => {};
  state.resolveWait = null;
  state.resolveStarted = () => {};
  state.newThread.mockReset().mockImplementation(() => {
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId("logical", scopeProjectRef(environmentA, projectA), draftId, {
        threadId,
      });
    return Promise.resolve({ draftId, threadId });
  });
  element = document.createElement("div");
  root = createRoot(element);
  await act(async () => {
    root.render(<Harness />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
});

async function solve(
  environmentId = environmentA,
  selection: "auto" | "manual" = "auto",
  issue = detail,
) {
  await act(async () => {
    await handoff.start(issue);
  });
  const projectId = environmentId === environmentA ? projectA : projectB;
  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
    projectRef: scopeProjectRef(environmentId, projectId),
    environmentSelection: selection,
    ...(selection === "auto" ? { loadBalancedEnvironmentId: environmentId } : {}),
  });
  return { environmentId, projectId, threadRef: scopeThreadRef(environmentId, threadId) };
}

function send(target: Awaited<ReturnType<typeof solve>>, targetThreadId = threadId) {
  const store = useComposerDraftStore.getState();
  const pending = store.getComposerDraft(draftId);
  const url = pending?.pendingIssueUrl;
  const text = store.getComposerDraft(draftId)?.prompt || "Retry solving the issue";
  const attachments = (store.getComposerDraft(draftId)?.files ?? []).map((file) => ({
    type: "file" as const,
    id: ChatAttachmentId.make(file.id),
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  }));
  store.clearComposerContent(draftId);
  return withIssueThreadHandoff(
    threadEnvironment.startTurn.run(appAtomRegistry, {
      environmentId: target.environmentId,
      input: {
        threadId: targetThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
        message: {
          messageId: MessageId.make("message"),
          role: "user",
          text,
          attachments,
        },
        bootstrap: {
          createThread: {
            projectId: target.projectId,
            title: "Solve",
            runtimeMode: "full-access",
            interactionMode: "default",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1" },
            branch: null,
            worktreePath: null,
            createdAt: "2026-10-14T20:00:00.000Z",
          },
        },
      },
    }),
    draftId,
    scopeThreadRef(target.environmentId, targetThreadId),
    target.projectId,
    url,
    pending ?? {},
  );
}

it.each([
  [environmentA, "auto"],
  [environmentB, "auto"],
  [environmentB, "manual"],
] as const)("links after promotion in %s with %s selection", async (environmentId, selection) => {
  const target = await solve(environmentId, selection);
  expect(state.calls).toEqual([]);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Work on issue #7: Fix it\nhttps://github.com/acme/web/issues/7",
  );
  expect((await send(target))._tag).toBe("Success");
  expect(state.calls.map(({ environmentId, method }) => [environmentId, method])).toEqual([
    [environmentId, ORCHESTRATION_V2_WS_METHODS.launchThread],
    [environmentId, "issues.resolveUrl"],
    [environmentId, ORCHESTRATION_V2_WS_METHODS.dispatchCommand],
  ]);
  expect(state.calls[1]?.input).toEqual({ projectId: target.projectId, url: detail.url });
  expect(state.calls[0]?.input.initialMessage).toMatchObject({
    text: "Work on issue #7: Fix it\nhttps://github.com/acme/web/issues/7",
  });
  expect(state.calls[2]?.input).toMatchObject({
    type: "thread.issue.link",
    threadId,
    projectId: target.projectId,
    host: "github.com",
    scope: "acme/web",
    key: "7",
    url: detail.url,
  });
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.pendingIssueUrl,
  ).toBeUndefined();
  expect(state.toast).not.toHaveBeenCalled();
});

it.each([
  [environmentA, undefined],
  [environmentA, "Account/B"],
  [environmentB, "Account/B"],
] as const)(
  "links a readable external issue without tracker-write access in %s (account=%s)",
  async (environmentId, connectionId) => {
    state.resolvedWritable = false;
    state.resolvedScope = "acme/external";
    if (environmentId === environmentB) state.resolvedConnectionId = "Destination/C";
    const external = {
      ...detail,
      writable: false,
      url: "https://github.com/acme/external/issues/7",
    };
    await act(async () =>
      root.render(<Harness {...(connectionId === undefined ? {} : { connectionId })} />),
    );
    const target = await solve(environmentId, "auto", external);
    expect(state.newThread).toHaveBeenCalledExactlyOnceWith(
      scopeProjectRef(environmentA, projectA),
    );
    expect(state.calls).toEqual([]);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
      prompt: "Work on issue #7: Fix it\nhttps://github.com/acme/external/issues/7",
      pendingIssueUrl: external.url,
      pendingIssueEnvironmentId: environmentA,
      ...(connectionId === undefined ? {} : { pendingIssueConnectionId: connectionId }),
    });
    expect((await send(target))._tag).toBe("Success");
    expect(state.calls.map(({ method }) => method)).toEqual([
      ORCHESTRATION_V2_WS_METHODS.launchThread,
      "issues.resolveUrl",
      ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    ]);
    const selected = environmentId === environmentA ? connectionId : undefined;
    expect(state.calls[1]).toEqual({
      environmentId,
      method: "issues.resolveUrl",
      input: {
        projectId: target.projectId,
        url: external.url,
        ...(selected === undefined ? {} : { connectionId: selected }),
      },
    });
    expect(state.calls[2]?.input).toMatchObject({
      type: "thread.issue.link",
      projectId: target.projectId,
      host: "github.com",
      scope: "acme/external",
      key: "7",
      url: external.url,
    });
    expect(state.calls[2]?.input.connectionId).toBe(
      environmentId === environmentA ? selected : "Destination/C",
    );
    expect(
      useComposerDraftStore.getState().getComposerDraft(draftId)?.pendingIssueUrl,
    ).toBeUndefined();
    expect(state.toast).not.toHaveBeenCalled();
  },
);

it("keeps the issue after failed creation and links on retry with a replacement thread", async () => {
  const target = await solve(environmentB);
  const draft = useComposerDraftStore.getState().getDraftSession(draftId)!;
  state.launchError = new Error("Create failed");
  expect((await send(target))._tag).toBe("Failure");
  expect(state.calls).toHaveLength(1);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.pendingIssueUrl).toBe(
    detail.url,
  );
  const retryThreadId = ThreadId.make("retry-thread");
  restoreFailedBackgroundDraftThread(draftId, draft, retryThreadId);
  state.launchError = null;
  expect((await send(target, retryThreadId))._tag).toBe("Success");
  expect(state.calls.at(-1)?.input.threadId).toBe(retryThreadId);
});

it.each([
  ["background", "none"],
  ["manual", "none"],
  ["active", "none"],
  ["background", "url"],
  ["manual", "url"],
  ["active", "url"],
  ["background", "prompt"],
  ["manual", "prompt"],
  ["background", "attachment"],
  ["manual", "attachment"],
] as const)("recovers %s Solve sends while preserving newer %s content", async (mode, newer) => {
  const target = await solve(environmentB);
  const store = useComposerDraftStore.getState();
  const file = new File(["original notes"], "notes.txt", { type: "text/plain" });
  store.addFiles(draftId, [
    {
      type: "file",
      id: "submitted-file",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    },
  ]);
  const submitted = store.getComposerDraft(draftId)!;
  const draft = store.getDraftSession(draftId)!;
  const launched = deferred();
  const release = deferred();
  state.launchStarted = launched.resolve;
  state.launchWait = release.promise;
  state.launchError = new Error("Create failed");
  if (mode === "background") beginBackgroundDraftSubmissionByRef(target.threadRef);
  const sending = send(target, mode === "manual" ? ThreadId.make("model-thread") : threadId);
  await launched.promise;
  if (mode !== "active") {
    if (mode === "background") store.markDraftThreadPromoting(draftId, target.threadRef);
    store.setLogicalProjectDraftThreadId(
      "logical",
      scopeProjectRef(environmentB, projectB),
      DraftId.make("fresh-draft"),
    );
    store.setPrompt(DraftId.make("fresh-draft"), "Work in the fresh composer");
  }
  if (newer === "url") store.setPendingIssueUrl(draftId, "https://github.com/acme/web/issues/8");
  if (newer === "prompt") store.setPrompt(draftId, "New work");
  if (newer === "attachment")
    store.addFiles(draftId, [{ ...submitted.files[0]!, id: "new-file", name: "new-notes.txt" }]);
  const beforeRecovery = store.getComposerDraft(draftId);
  expect(composerDraftHasUserContent(beforeRecovery)).toBe(true);
  release.resolve();
  expect((await sending)._tag).toBe("Failure");
  if (mode === "background") {
    restoreFailedBackgroundDraftThread(draftId, draft, ThreadId.make("retry-thread"));
    clearBackgroundDraftSubmissionByRef(target.threadRef);
  }
  expect(store.restoreSubmittedDraft(draftId, submitted)).toBe(newer === "none");
  const restored = store.getComposerDraft(draftId);
  if (newer === "none") {
    expect(restored?.prompt).toBe(submitted.prompt);
    expect(restored?.files).toEqual(submitted.files);
    expect(restored?.pendingIssueUrl).toBe(detail.url);
  } else {
    expect(restored).toBe(beforeRecovery);
  }
  if (mode !== "active")
    expect(store.getComposerDraft(DraftId.make("fresh-draft"))?.prompt).toBe(
      "Work in the fresh composer",
    );
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toMatchObject({
    environmentId: environmentB,
    input: {
      projectId: projectB,
      initialMessage: {
        text: submitted.prompt,
        attachments: [{ id: "submitted-file", name: "notes.txt" }],
      },
    },
  });
});

it.each(["permission", "binding", "resolve", "link"])(
  "retains pending context and offers retry after %s failure",
  async (failure) => {
    const target = await solve(environmentB);
    if (failure === "permission") state.deniedEnvironment = environmentB;
    if (failure === "binding") state.resolvedProject = projectA;
    if (failure === "resolve") state.resolveError = new Error("Configure this tracker first");
    if (failure === "link") state.linkError = new Error("Link failed");
    expect((await send(target))._tag).toBe("Success");
    finalizePromotedDraftThreadByRef(target.threadRef);
    expect(
      useComposerDraftStore.getState().getComposerDraft(target.threadRef)?.pendingIssueUrl,
    ).toBe(detail.url);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not link the thread to this issue",
        actionProps: expect.objectContaining({ children: "Retry" }),
      }),
    );
    expect(
      state.calls.filter(({ method }) => method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand),
    ).toHaveLength(failure === "link" ? 1 : 0);
    state.deniedEnvironment = state.resolvedProject = "";
    state.resolveError = state.linkError = null;
    const retry = state.toast.mock.calls[0]![0].actionProps.onClick;
    await retry();
    expect(
      useComposerDraftStore.getState().getComposerDraft(target.threadRef)?.pendingIssueUrl,
    ).toBeUndefined();
    expect(state.calls.at(-1)).toMatchObject({
      environmentId: environmentB,
      input: { threadId, projectId: projectB },
    });
  },
);

it("ignores an old Retry after the destination holds a newer issue", async () => {
  const target = await solve(environmentB);
  state.linkError = new Error("Link failed");
  await send(target);
  finalizePromotedDraftThreadByRef(target.threadRef);
  const newerUrl = "https://github.com/acme/web/issues/8";
  useComposerDraftStore.getState().setPendingIssueUrl(target.threadRef, newerUrl);
  const callsBeforeRetry = state.calls.length;
  await state.toast.mock.calls[0]![0].actionProps.onClick();
  expect(state.calls).toHaveLength(callsBeforeRetry);
  expect(useComposerDraftStore.getState().getComposerDraft(target.threadRef)?.pendingIssueUrl).toBe(
    newerUrl,
  );
});

it.each([false, true])(
  "keeps newer context after a late completion with revoked grants = %s",
  async (revoked) => {
    const target = await solve(environmentB);
    const started = deferred();
    const release = deferred();
    state.resolveStarted = started.resolve;
    state.resolveWait = release.promise;
    const sending = send(target);
    await started.promise;
    finalizePromotedDraftThreadByRef(target.threadRef);
    useComposerDraftStore
      .getState()
      .setPendingIssueUrl(target.threadRef, "https://github.com/acme/web/issues/8");
    if (revoked) state.deniedEnvironment = environmentB;
    release.resolve();
    await sending;
    expect(state.calls).toHaveLength(revoked ? 2 : 3);
    expect(
      useComposerDraftStore.getState().getComposerDraft(target.threadRef)?.pendingIssueUrl,
    ).toContain("/8");
  },
);

it("retains the source issue for multiple model retries and links each created thread", async () => {
  const target = await solve(environmentB);
  const first = ThreadId.make("model-one");
  const second = ThreadId.make("model-two");
  await send(target, first);
  state.launchError = new Error("Second creation failed");
  await send(target, second);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.pendingIssueUrl).toBe(
    detail.url,
  );
  state.launchError = null;
  await send(target, second);
  expect(
    state.calls
      .filter(({ method }) => method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand)
      .map(({ input }) => input.threadId),
  ).toEqual([first, second]);
});

it("does not consume a reused draft after its destination changes during linking", async () => {
  const target = await solve(environmentB);
  const started = deferred();
  const release = deferred();
  state.resolveStarted = started.resolve;
  state.resolveWait = release.promise;
  const sending = send(target);
  await started.promise;
  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
    projectRef: scopeProjectRef(environmentA, projectA),
    environmentSelection: "manual",
  });
  release.resolve();
  await sending;
  expect(state.calls.at(-1)).toMatchObject({
    environmentId: environmentB,
    input: { projectId: projectB, threadId },
  });
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.pendingIssueUrl).toBe(
    detail.url,
  );
});

it.each([
  [environmentA, false],
  [environmentB, false],
  [environmentB, true],
] as const)(
  "keeps the source account only within its environment %s (foreign destination %s)",
  async (environmentId, foreign) => {
    await act(async () => root.render(<Harness connectionId="Account/B" />));
    const target = await solve(environmentId);
    state.resolvedProject = foreign ? projectA : "";
    await send(target);
    const resolve = state.calls.find((call) => call.method === "issues.resolveUrl")!;
    expect(resolve.input).toEqual({
      projectId: target.projectId,
      url: detail.url,
      ...(environmentId === environmentA ? { connectionId: "Account/B" } : {}),
    });
    const linked = state.calls.find(
      (call) => call.method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    );
    if (foreign) {
      expect(linked).toBeUndefined();
      expect(
        useComposerDraftStore.getState().getComposerDraft(target.threadRef)
          ?.pendingIssueConnectionId,
      ).toBe("Account/B");
      return;
    }
    expect(linked!.input.connectionId).toBe(
      environmentId === environmentA ? "Account/B" : undefined,
    );
  },
);

it("does not clear or retry a newer selector at the same issue URL", async () => {
  const target = await solve(environmentA);
  const store = useComposerDraftStore.getState();
  const context = { pendingIssueEnvironmentId: environmentA, pendingIssueConnectionId: "A" };
  store.setPendingIssueUrl(draftId, detail.url, context);
  state.linkError = new Error("retry");
  await send(target);
  store.setPendingIssueUrl(target.threadRef, detail.url, {
    ...context,
    pendingIssueConnectionId: "B",
  });
  const count = state.calls.length;
  await state.toast.mock.calls.at(-1)![0].actionProps.onClick();
  expect(state.calls).toHaveLength(count);
});

it("keeps a newer account at the same URL after older linking completes", async () => {
  const target = await solve(environmentA);
  const store = useComposerDraftStore.getState();
  const context = { pendingIssueEnvironmentId: environmentA, pendingIssueConnectionId: "A" };
  store.setPendingIssueUrl(draftId, detail.url, context);
  const started = deferred();
  const release = deferred();
  state.resolveStarted = started.resolve;
  state.resolveWait = release.promise;
  const sending = send(target);
  await started.promise;
  finalizePromotedDraftThreadByRef(target.threadRef);
  store.setPendingIssueUrl(target.threadRef, detail.url, {
    ...context,
    pendingIssueConnectionId: "B",
  });
  release.resolve();
  await sending;
  expect(store.getComposerDraft(target.threadRef)?.pendingIssueConnectionId).toBe("B");
});

it.each(["missing", "fallback"])(
  "retains an unavailable selected account for retry without a default-account write (%s)",
  async (kind) => {
    const target = await solve(environmentA);
    const store = useComposerDraftStore.getState();
    store.setPendingIssueUrl(draftId, detail.url, {
      pendingIssueEnvironmentId: environmentA,
      pendingIssueConnectionId: "B",
    });
    state.resolveError = kind === "missing" ? new Error("Account B missing") : null;
    state.resolvedConnectionId = kind === "fallback" ? "A" : undefined;
    await send(target);
    expect(
      state.calls.filter((call) => call.method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand),
    ).toEqual([]);
    expect(store.getComposerDraft(target.threadRef)?.pendingIssueConnectionId).toBe("B");
    state.resolveError = null;
    state.resolvedConnectionId = undefined;
    await state.toast.mock.calls.at(-1)![0].actionProps.onClick();
    expect(
      state.calls
        .filter((call) => call.method === "issues.resolveUrl")
        .map((call) => call.input.connectionId),
    ).toEqual(["B", "B"]);
    expect(store.getComposerDraft(target.threadRef)?.pendingIssueUrl).toBeUndefined();
  },
);
