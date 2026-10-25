import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useImperativeHandle, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useQueuedRunEdit } from "./useQueuedRunEdit";

interface RunStatus {
  readonly id: RunId;
  readonly status: string;
}

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editQueuedRun: vi.fn<(value: unknown) => Promise<{ readonly _tag: "Success" | "Failure" }>>(),
    // The projection's runs per thread, written by each test to stand in for the server.
    threadRuns: Atom.family((_key: string) =>
      Atom.make<ReadonlyArray<RunStatus> | null>(null).pipe(Atom.keepAlive),
    ),
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.editQueuedRun,
}));

const runsKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const key = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;
  return {
    threadEnvironment: {
      snapshotAtom: () => Atom.make(null),
      editQueuedRun: {},
    },
    environmentThreadDetails: {
      statusAtom: () => Atom.make("ready"),
      quietThreadAtom: (ref: ScopedThreadRef) =>
        Atom.make((get) => {
          const runs = get(mocks.threadRuns(key(ref)));
          return runs === null ? null : { projection: { runs } };
        }),
    },
    environmentThreadShells: {
      threadShellAtom: () => Atom.make(null),
    },
  };
});

const ENV = EnvironmentId.make("env-1");
const THREAD_A: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-a") };
const THREAD_B: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-b") };
const RUN = RunId.make("run-1");

type HookResult = ReturnType<typeof useQueuedRunEdit>;

function projection(runs: ReadonlyArray<RunStatus>) {
  return { runs, messages: [] } as unknown as ThreadStructure;
}

function setRuns(ref: ScopedThreadRef, status: string) {
  appAtomRegistry.set(mocks.threadRuns(runsKey(ref)), [{ id: RUN, status }]);
}

function Harness(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runStatus: string;
  readonly hookRef: RefObject<HookResult | null>;
}) {
  const result = useQueuedRunEdit({
    environmentId: ENV,
    routeThreadRef: props.threadRef,
    threadDraftTarget: props.threadRef,
    activeThreadId: props.threadRef.threadId,
    serverProjection: projection([{ id: RUN, status: props.runStatus }]),
    promptRef: { current: "" },
    composerRef: { current: null },
  });
  useImperativeHandle(props.hookRef, () => result);
  return null;
}

function view(threadRef: ScopedThreadRef, runStatus: string, hook: { current: HookResult | null }) {
  return (
    <AppAtomRegistryProvider>
      <Harness threadRef={threadRef} runStatus={runStatus} hookRef={hook} />
    </AppAtomRegistryProvider>
  );
}

function setup() {
  mocks.editQueuedRun.mockReset();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  setRuns(THREAD_A, "queued");
  setRuns(THREAD_B, "queued");
  return { hook: { current: null as HookResult | null } };
}

function requireHook(hook: { current: HookResult | null }): HookResult {
  if (hook.current === null) throw new Error("hook did not render");
  return hook.current;
}

async function beginChangedEdit(hook: { current: HookResult | null }) {
  await act(() =>
    requireHook(hook).beginEdit({
      runId: RUN,
      messageId: MessageId.make("message-1"),
      text: "original",
      attachments: [],
    }),
  );
  await act(() =>
    useComposerDraftStore.getState().setPrompt(requireHook(hook).draftTarget, "changed"),
  );
}

const promptOf = (ref: ScopedThreadRef) =>
  useComposerDraftStore.getState().getComposerDraft(ref)?.prompt ?? "";

describe("useQueuedRunEdit", () => {
  it("keeps an open edit when the user leaves the thread and comes back", async () => {
    const { hook } = setup();
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);

    await screen.rerender(view(THREAD_B, "queued", hook));
    expect(requireHook(hook).isEditing).toBe(false);
    await screen.rerender(view(THREAD_A, "queued", hook));

    expect(requireHook(hook).editingRunId).toBe(RUN);
    expect(
      useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget)?.prompt,
    ).toBe("changed");
  });

  it("moves a changed edit into the thread draft when its run starts while the user is away", async () => {
    const { hook } = setup();
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);

    await screen.rerender(view(THREAD_B, "queued", hook));
    expect(promptOf(THREAD_A)).toBe("");
    await act(() => setRuns(THREAD_A, "running"));

    expect(promptOf(THREAD_A)).toBe("changed");
  });

  it("does not copy a saved edit into the thread draft when the run starts mid-save", async () => {
    const { hook } = setup();
    let finishSave: (result: { readonly _tag: "Success" }) => void = () => {};
    mocks.editQueuedRun.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);

    // Not inside act(): act would hold the projection update until the save settles.
    const saved = requireHook(hook).saveEdit(
      {
        prompt: "changed",
        images: [],
        files: [],
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: [],
        threadContexts: [],
      },
      () => {},
    );
    await vi.waitFor(() => expect(mocks.editQueuedRun).toHaveBeenCalledOnce());
    // The server applied the edit and then started the run; the projection
    // reports the start before the edit's acknowledgement arrives.
    await act(() => setRuns(THREAD_A, "running"));
    await screen.rerender(view(THREAD_A, "running", hook));
    finishSave({ _tag: "Success" });
    await act(() => saved);

    expect(requireHook(hook).isEditing).toBe(false);
    expect(promptOf(THREAD_A)).toBe("");
  });
});
