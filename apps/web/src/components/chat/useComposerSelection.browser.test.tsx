import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({
  setModelSelection: null as ((value: unknown) => Promise<AtomCommandResult<void, unknown>>) | null,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => (value: unknown) => mocks.setModelSelection?.(value)) as never,
}));

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: ((ref: { threadId: string }) => shellAtom(ref.threadId)) as never,
    },
  };
});

import { act, render } from "../../../test/render";
import { deriveEffectiveComposerModelState, useComposerDraftStore } from "../../composerDraftStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { useComposerSelection } from "./useComposerSelection";

// Kept alive so a shell set before the hook mounts is still there when it saves a pick.
const shellAtom = Atom.family((_threadId: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));

function setup() {
  const setModelSelection = vi.fn<(value: unknown) => Promise<AtomCommandResult<void, unknown>>>();
  mocks.setModelSelection = setModelSelection;
  return { setModelSelection };
}

const environmentId = EnvironmentId.make("environment-local");
const cursor = ProviderInstanceId.make("cursor");
const stored = createModelSelection(cursor, "claude-opus-5-5", [{ id: "effort", value: "medium" }]);

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: cursor,
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "auto-smart", name: "Auto", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  },
];

// The hook reads only the thread's identity and stored selection.
function cursorThread(id: string) {
  return { environmentId, id: ThreadId.make(id), modelSelection: stored } as EnvironmentThreadShell;
}

function Picker(props: {
  thread: EnvironmentThreadShell;
  runtime: Parameters<typeof useComposerSelection>[0]["activeRuntime"];
  model?: string;
}) {
  const { onProviderModelSelectStable } = useComposerSelection({
    environmentId,
    composerDraftTarget: scopeThreadRef(environmentId, props.thread.id),
    draftThread: null,
    activeThread: props.thread,
    activeRuntime: props.runtime,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: providers,
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: true,
    multipleModelSelections: null,
    runtimeMode: "full-access",
    isLocalDraftThread: false,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: () => {},
    setPendingServerThreadStartFromOriginByThreadId: () => {},
    scheduleComposerFocus: () => {},
    setThreadRuntimeMode: async () => AsyncResult.success(undefined),
    runInProgress: false,
  });
  return (
    <button
      type="button"
      onClick={() => onProviderModelSelectStable(cursor, props.model ?? stored.model)}
    >
      Pick the model
    </button>
  );
}

it("keeps a Cursor thread's stored model and options when the user re-picks its unavailable row", async () => {
  setup();
  const thread = cursorThread("thread-cursor");
  await using _screen = await render(<Picker thread={thread} runtime={null} />);
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(environmentId, thread.id));
    expect(draft?.modelSelectionByProvider[cursor] ?? thread.modelSelection).toEqual(stored);
  });
});

it("switches back to the thread's stored model while the session runs on another instance", async () => {
  setup();
  const thread = cursorThread("thread-cursor-handoff");
  const runtime = { providerInstanceId: ProviderInstanceId.make("codex") } as Parameters<
    typeof useComposerSelection
  >[0]["activeRuntime"];
  await using _screen = await render(<Picker thread={thread} runtime={runtime} />);
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(environmentId, thread.id));
    expect(draft?.activeProvider).toBe(cursor);
    expect(
      deriveEffectiveComposerModelState({
        draft,
        providers,
        selectedProvider: ProviderDriverKind.make("cursor"),
        selectedInstanceId: cursor,
        threadModelSelection: thread.modelSelection,
        projectModelSelection: null,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ selectedModel: stored.model, modelOptions: { [cursor]: stored.options } });
  });
});

it("saves a re-picked model again when its first save failed", async () => {
  const { setModelSelection } = setup();
  setModelSelection
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))))
    .mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-cursor-retry");
  appAtomRegistry.set(shellAtom(thread.id), thread);
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} model="auto-smart" />
    </AppAtomRegistryProvider>,
  );
  const pick = page.getByRole("button", { name: "Pick the model" });
  await pick.click();
  await vi.waitFor(() => expect(setModelSelection).toHaveBeenCalledTimes(1));
  await pick.click();

  const autoSave = expect.objectContaining({
    input: {
      threadId: thread.id,
      modelSelection: expect.objectContaining({ instanceId: cursor, model: "auto-smart" }),
    },
  });
  await vi.waitFor(() => expect(setModelSelection.mock.calls).toEqual([[autoSave], [autoSave]]));
});

const env = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const threadRef = scopeThreadRef(env, threadId);

const mockActiveThread = {
  environmentId: env,
  id: threadId,
  projectId: "proj-1" as never,
  title: "Test Thread",
  providerInstanceId: "codex" as never,
  modelSelection: { instanceId: "codex" as never, model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: null as never,
  forkedFrom: null,
  linkOrigin: null,
  delegatedFrom: null,
  activeProviderThreadId: null,
  latestRun: null,
  runtime: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
} as unknown as EnvironmentThreadShell;

interface TestHarnessProps {
  readonly isLocalDraftThread?: boolean;
  readonly runInProgress?: boolean;
  readonly activeThread?: EnvironmentThreadShell;
  readonly setThreadRuntimeMode: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
      readonly createdAt?: string;
    };
  }) => Promise<unknown>;
  readonly onReady: (hook: ReturnType<typeof useComposerSelection>) => void;
}

function TestHarness(props: TestHarnessProps) {
  const hook = useComposerSelection({
    environmentId: env,
    composerDraftTarget: threadRef,
    draftThread: null,
    activeThread: props.activeThread ?? mockActiveThread,
    activeRuntime: null,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: [],
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: false,
    multipleModelSelections: null,
    runtimeMode: "full-access",
    isLocalDraftThread: props.isLocalDraftThread ?? false,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: vi.fn(),
    setPendingServerThreadStartFromOriginByThreadId: vi.fn(),
    scheduleComposerFocus: vi.fn(),
    setThreadRuntimeMode: props.setThreadRuntimeMode as never,
    runInProgress: props.runInProgress ?? false,
  });

  props.onReady(hook);
  return null;
}

function clearRuntimeModeDraft() {
  useComposerDraftStore.getState().setRuntimeMode(threadRef, null);
  return {
    [Symbol.dispose]() {
      useComposerDraftStore.getState().setRuntimeMode(threadRef, null);
    },
  };
}

describe("useComposerSelection runtime mode persistence", () => {
  it("persists runtime mode change immediately to the server on an existing thread", async () => {
    using _cleanup = clearRuntimeModeDraft();
    const setThreadRuntimeMode = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    let hook!: ReturnType<typeof useComposerSelection>;

    await using _screen = await render(
      <TestHarness
        setThreadRuntimeMode={setThreadRuntimeMode}
        onReady={(h) => {
          hook = h;
        }}
      />,
    );

    await act(() => {
      hook.handleRuntimeModeChangeStable("approval-required");
    });

    expect(setThreadRuntimeMode).toHaveBeenCalledTimes(1);
    expect(setThreadRuntimeMode).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        input: expect.objectContaining({
          threadId,
          runtimeMode: "approval-required",
        }),
      }),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.runtimeMode).toBe(
      "approval-required",
    );
  });

  it("reverts the draft runtime mode and alerts when persisting to the server fails", async () => {
    using _cleanup = clearRuntimeModeDraft();
    const setThreadRuntimeMode = vi
      .fn()
      .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Network disconnect"))));
    let hook!: ReturnType<typeof useComposerSelection>;

    await using _screen = await render(
      <TestHarness
        setThreadRuntimeMode={setThreadRuntimeMode}
        onReady={(h) => {
          hook = h;
        }}
      />,
    );
    using toastSpy = vi.spyOn(toastManager, "add");

    await act(async () => {
      hook.handleRuntimeModeChangeStable("approval-required");
    });

    await vi.waitFor(() => {
      expect(
        useComposerDraftStore.getState().getComposerDraft(threadRef)?.runtimeMode ?? null,
      ).toBeNull();
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to update permission mode",
      }),
    );
  });

  it("rolls back only the selection whose save failed, even when a newer one has the same mode", async () => {
    using _cleanup = clearRuntimeModeDraft();
    let rejectFirst!: (res: unknown) => void;
    const firstPromise = new Promise((resolve) => {
      rejectFirst = resolve;
    });
    const setThreadRuntimeMode = vi
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    let hook!: ReturnType<typeof useComposerSelection>;

    const harness = (runInProgress: boolean) => (
      <TestHarness
        runInProgress={runInProgress}
        setThreadRuntimeMode={setThreadRuntimeMode}
        onReady={(h) => {
          hook = h;
        }}
      />
    );
    await using screen = await render(harness(false));
    using toastSpy = vi.spyOn(toastManager, "add");

    await act(() => {
      hook.handleRuntimeModeChangeStable("approval-required");
    });
    await act(() => {
      hook.handleRuntimeModeChangeStable("auto-accept-edits");
    });

    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.runtimeMode).toBe(
      "auto-accept-edits",
    );

    // A send is in flight, so this same-mode selection is kept only as a draft.
    await screen.rerender(harness(true));
    await act(() => {
      hook.handleRuntimeModeChangeStable("approval-required");
    });
    expect(setThreadRuntimeMode).toHaveBeenCalledTimes(2);

    await act(async () => {
      rejectFirst(AsyncResult.failure(Cause.fail(new Error("First call failed"))));
    });

    await vi.waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Failed to update permission mode",
        }),
      );
    });

    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.runtimeMode).toBe(
      "approval-required",
    );
  });

  it("keeps the selection as a draft for the next send while a run is in progress", async () => {
    using _cleanup = clearRuntimeModeDraft();
    const setThreadRuntimeMode = vi.fn();
    let hook!: ReturnType<typeof useComposerSelection>;

    await using _screen = await render(
      <TestHarness
        runInProgress
        setThreadRuntimeMode={setThreadRuntimeMode}
        onReady={(h) => {
          hook = h;
        }}
      />,
    );

    await act(() => {
      hook.handleRuntimeModeChangeStable("approval-required");
    });

    expect(setThreadRuntimeMode).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.runtimeMode).toBe(
      "approval-required",
    );
  });
});
