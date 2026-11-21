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

import { render } from "../../../test/render";
import {
  deriveEffectiveComposerModelState,
  DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
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
    canPersistRuntimeModeImmediately: true,
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
        threadStarted: true,
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

it("saves a pick of a seeded model the started thread does not show", async () => {
  const { setModelSelection } = setup();
  setModelSelection.mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-cursor-seeded");
  appAtomRegistry.set(shellAtom(thread.id), thread);
  useComposerDraftStore
    .getState()
    .setModelSelection(
      scopeThreadRef(environmentId, thread.id),
      createModelSelection(cursor, "auto-smart"),
    );
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} model="auto-smart" />
    </AppAtomRegistryProvider>,
  );
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() =>
    expect(setModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          threadId: thread.id,
          modelSelection: expect.objectContaining({ instanceId: cursor, model: "auto-smart" }),
        },
      }),
    ),
  );
});

describe("runtime mode persistence", () => {
  function RuntimeModePicker(props: {
    readonly thread?: EnvironmentThreadShell;
    readonly target?: Parameters<typeof useComposerSelection>[0]["composerDraftTarget"];
    readonly runtimeMode: RuntimeMode;
    readonly isLocalDraftThread?: boolean;
    readonly canPersistRuntimeModeImmediately: boolean;
    readonly setThreadRuntimeMode: Parameters<
      typeof useComposerSelection
    >[0]["setThreadRuntimeMode"];
  }) {
    const target =
      props.target ??
      (props.thread
        ? scopeThreadRef(props.thread.environmentId, props.thread.id)
        : DraftId.make("draft-1"));
    const { handleRuntimeModeChangeStable } = useComposerSelection({
      environmentId,
      composerDraftTarget: target,
      draftThread: null,
      activeThread: props.thread,
      activeRuntime: null,
      activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
      settings: DEFAULT_UNIFIED_SETTINGS,
      providerStatuses: providers,
      lockedProvider: null,
      supportsProviderSwitchingViaHandoff: true,
      multipleModelSelections: null,
      runtimeMode: props.runtimeMode,
      isLocalDraftThread: props.isLocalDraftThread ?? false,
      canOverrideServerThreadEnvMode: false,
      setPendingServerThreadEnvModeEntry: () => {},
      setPendingServerThreadStartFromOriginByThreadId: () => {},
      scheduleComposerFocus: () => {},
      setThreadRuntimeMode: props.setThreadRuntimeMode,
      canPersistRuntimeModeImmediately: props.canPersistRuntimeModeImmediately,
    });
    return (
      <div>
        <button type="button" onClick={() => handleRuntimeModeChangeStable("full-access")}>
          Full access
        </button>
        <button type="button" onClick={() => handleRuntimeModeChangeStable("auto")}>
          Auto
        </button>
        <button type="button" onClick={() => handleRuntimeModeChangeStable("approval-required")}>
          Supervised
        </button>
      </div>
    );
  }

  function threadWithMode(id: string, runtimeMode: RuntimeMode): EnvironmentThreadShell {
    return {
      environmentId,
      id: ThreadId.make(id),
      modelSelection: stored,
      runtimeMode,
    } as EnvironmentThreadShell;
  }

  it("persists immediately on an existing thread and releases the draft override on success", async () => {
    setup();
    const setThreadRuntimeMode = vi.fn<
      Parameters<typeof useComposerSelection>[0]["setThreadRuntimeMode"]
    >(async () => AsyncResult.success(undefined));
    const thread = threadWithMode("thread-mode-persist", "auto");
    const target = scopeThreadRef(environmentId, thread.id);
    await using _screen = await render(
      <RuntimeModePicker
        thread={thread}
        runtimeMode="auto"
        canPersistRuntimeModeImmediately={true}
        setThreadRuntimeMode={setThreadRuntimeMode}
      />,
    );

    await page.getByRole("button", { name: "Full access" }).click();

    await vi.waitFor(() =>
      expect(setThreadRuntimeMode).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId,
          input: expect.objectContaining({
            threadId: thread.id,
            runtimeMode: "full-access",
            preserveActiveSession: true,
          }),
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(useComposerDraftStore.getState().getComposerDraft(target)?.runtimeMode ?? null).toBe(
        null,
      );
    });
  });

  it("persists against the thread ref instead of a queued-message edit draft and preserves draft on busy rejection", async () => {
    setup();
    const setThreadRuntimeMode = vi
      .fn<Parameters<typeof useComposerSelection>[0]["setThreadRuntimeMode"]>()
      .mockResolvedValueOnce(
        AsyncResult.failure(
          Cause.fail({ code: "provider_selection_busy", message: "Thread has an active turn." }),
        ),
      );
    const thread = threadWithMode("thread-mode-queued-edit", "auto");
    const threadTarget = scopeThreadRef(environmentId, thread.id);
    const editDraftId = DraftId.make("queued-edit-draft");
    await using _screen = await render(
      <RuntimeModePicker
        thread={thread}
        target={editDraftId}
        runtimeMode="auto"
        canPersistRuntimeModeImmediately={true}
        setThreadRuntimeMode={setThreadRuntimeMode}
      />,
    );

    await page.getByRole("button", { name: "Full access" }).click();

    await vi.waitFor(() =>
      expect(setThreadRuntimeMode).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId,
          input: expect.objectContaining({
            threadId: thread.id,
            runtimeMode: "full-access",
            preserveActiveSession: true,
          }),
        }),
      ),
    );
    // Busy rejection keeps the pick on the thread's own draft, never the queued edit draft.
    expect(useComposerDraftStore.getState().getComposerDraft(threadTarget)?.runtimeMode).toBe(
      "full-access",
    );
    expect(
      useComposerDraftStore.getState().getComposerDraft(editDraftId)?.runtimeMode ?? null,
    ).toBe(null);
  });

  it("keeps the pick in draft without saving when active work forbids immediate switch, and clears draft when reverted", async () => {
    setup();
    const setThreadRuntimeMode = vi.fn<
      Parameters<typeof useComposerSelection>[0]["setThreadRuntimeMode"]
    >(async () => AsyncResult.success(undefined));
    const thread = threadWithMode("thread-mode-defer", "auto");
    const target = scopeThreadRef(environmentId, thread.id);
    await using screen = await render(
      <RuntimeModePicker
        thread={thread}
        runtimeMode="auto"
        canPersistRuntimeModeImmediately={false}
        setThreadRuntimeMode={setThreadRuntimeMode}
      />,
    );

    await page.getByRole("button", { name: "Full access" }).click();
    expect(setThreadRuntimeMode).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.runtimeMode).toBe(
      "full-access",
    );

    await screen.rerender(
      <RuntimeModePicker
        thread={thread}
        runtimeMode="full-access"
        canPersistRuntimeModeImmediately={false}
        setThreadRuntimeMode={setThreadRuntimeMode}
      />,
    );
    await page.getByRole("button", { name: "Auto" }).click();
    expect(setThreadRuntimeMode).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.runtimeMode ?? null).toBe(
      null,
    );
  });

  it("clears the draft override on failure and ignores superseded overlapping saves", async () => {
    setup();
    let resolveFirst!: (value: AtomCommandResult<unknown, unknown>) => void;
    let resolveSecond!: (value: AtomCommandResult<unknown, unknown>) => void;
    const setThreadRuntimeMode = vi
      .fn<Parameters<typeof useComposerSelection>[0]["setThreadRuntimeMode"]>()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    const thread = threadWithMode("thread-mode-overlap", "auto");
    const target = scopeThreadRef(environmentId, thread.id);
    await using screen = await render(
      <RuntimeModePicker
        thread={thread}
        runtimeMode="auto"
        canPersistRuntimeModeImmediately={true}
        setThreadRuntimeMode={setThreadRuntimeMode}
      />,
    );

    await page.getByRole("button", { name: "Full access" }).click();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.runtimeMode).toBe(
      "full-access",
    );

    await screen.rerender(
      <RuntimeModePicker
        thread={thread}
        runtimeMode="full-access"
        canPersistRuntimeModeImmediately={true}
        setThreadRuntimeMode={setThreadRuntimeMode}
      />,
    );
    await page.getByRole("button", { name: "Supervised" }).click();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.runtimeMode).toBe(
      "approval-required",
    );

    // An older reply (even a failure) must not clobber the newer pick.
    resolveFirst(AsyncResult.failure(Cause.fail(new Error("stale failure"))));
    await Promise.resolve();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.runtimeMode).toBe(
      "approval-required",
    );

    // Failure of the latest pick clears its optimistic draft override.
    resolveSecond(AsyncResult.failure(Cause.fail(new Error("policy ceiling"))));
    await vi.waitFor(() => {
      expect(useComposerDraftStore.getState().getComposerDraft(target)?.runtimeMode ?? null).toBe(
        null,
      );
    });
  });

  it("does not dispatch to the server for a local draft thread", async () => {
    setup();
    const setThreadRuntimeMode = vi.fn<
      Parameters<typeof useComposerSelection>[0]["setThreadRuntimeMode"]
    >(async () => AsyncResult.success(undefined));
    const draftTarget = DraftId.make("draft-runtime-mode");
    await using _screen = await render(
      <RuntimeModePicker
        target={draftTarget}
        runtimeMode="auto"
        isLocalDraftThread={true}
        canPersistRuntimeModeImmediately={true}
        setThreadRuntimeMode={setThreadRuntimeMode}
      />,
    );

    await page.getByRole("button", { name: "Full access" }).click();
    expect(setThreadRuntimeMode).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.runtimeMode).toBe(
      "full-access",
    );
  });
});
