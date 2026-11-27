import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
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
  queuedRunEditDraftId,
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
  draftTarget?: Parameters<typeof useComposerSelection>[0]["composerDraftTarget"];
  runtimeMode?: RuntimeMode;
}) {
  const { onProviderModelSelectStable, handleRuntimeModeChangeStable } = useComposerSelection({
    environmentId,
    composerDraftTarget: props.draftTarget ?? scopeThreadRef(environmentId, props.thread.id),
    draftThread: null,
    activeThread: props.thread,
    activeRuntime: props.runtime,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: providers,
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: true,
    multipleModelSelections: null,
    runtimeMode: props.runtimeMode ?? "full-access",
    isLocalDraftThread: false,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: () => {},
    setPendingServerThreadStartFromOriginByThreadId: () => {},
    scheduleComposerFocus: () => {},
  });
  return (
    <>
      <button
        type="button"
        onClick={() => onProviderModelSelectStable(cursor, props.model ?? stored.model)}
      >
        Pick the model
      </button>
      <button type="button" onClick={() => handleRuntimeModeChangeStable("auto")}>
        Pick auto
      </button>
      <button type="button" onClick={() => handleRuntimeModeChangeStable("approval-required")}>
        Pick supervised
      </button>
    </>
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

it("keeps a queued edit's model pick in its own draft", async () => {
  const { setModelSelection } = setup();
  const thread = cursorThread("thread-queued-edit");
  const threadRef = scopeThreadRef(environmentId, thread.id);
  const draftTarget = queuedRunEditDraftId(threadRef, RunId.make("queued-run"));
  await using _screen = await render(
    <Picker thread={thread} runtime={null} model="auto-smart" draftTarget={draftTarget} />,
  );
  await page.getByRole("button", { name: "Pick the model" }).click();
  const store = useComposerDraftStore.getState();
  expect(store.getComposerDraft(draftTarget)?.modelSelectionByProvider[cursor]?.model).toBe(
    "auto-smart",
  );
  expect(store.getComposerDraft(threadRef)).toBeNull();
  expect(setModelSelection).not.toHaveBeenCalled();
});

// Other threads, PR watches, and schedules start turns in the thread's stored mode, not the draft.
it("saves a runtime mode pick on an idle thread right away", async () => {
  const { setModelSelection: command } = setup();
  const thread = {
    ...cursorThread("thread-mode-idle"),
    runtimeMode: "full-access",
    runtime: null,
  } as EnvironmentThreadShell;
  appAtomRegistry.set(shellAtom(thread.id), thread);
  // The shell event for the save lands before its reply.
  command.mockImplementation(async () => {
    appAtomRegistry.set(shellAtom(thread.id), { ...thread, runtimeMode: "auto" });
    return AsyncResult.success(undefined);
  });
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} />
    </AppAtomRegistryProvider>,
  );
  await page.getByRole("button", { name: "Pick auto" }).click();

  await vi.waitFor(() =>
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ threadId: thread.id, runtimeMode: "auto" }),
      }),
    ),
  );
  await vi.waitFor(() =>
    expect(
      useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, thread.id))
        ?.runtimeMode ?? null,
    ).toBeNull(),
  );
});

it("keeps a running thread's runtime mode pick for its next message", async () => {
  const { setModelSelection: command } = setup();
  const thread = {
    ...cursorThread("thread-mode-running"),
    runtimeMode: "full-access",
    runtime: { status: "running", activeRunId: RunId.make("run-active") },
  } as EnvironmentThreadShell;
  appAtomRegistry.set(shellAtom(thread.id), thread);
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} />
    </AppAtomRegistryProvider>,
  );
  await page.getByRole("button", { name: "Pick auto" }).click();

  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, thread.id))
      ?.runtimeMode,
  ).toBe("auto");
  expect(command).not.toHaveBeenCalled();
});

it.each([
  { order: "first save lands first", firstToFinish: 0 },
  { order: "second save lands first", firstToFinish: 1 },
])(
  "saves a pick back to the stored mode while an earlier save is in flight ($order)",
  async ({ firstToFinish }) => {
    const { setModelSelection: command } = setup();
    const finish: Array<(result: AtomCommandResult<void, unknown>) => void> = [];
    command.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    const thread = {
      ...cursorThread(`thread-mode-overlap-${firstToFinish}`),
      runtimeMode: "approval-required",
      runtime: null,
    } as EnvironmentThreadShell;
    appAtomRegistry.set(shellAtom(thread.id), thread);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <Picker thread={thread} runtime={null} runtimeMode="approval-required" />
      </AppAtomRegistryProvider>,
    );
    await page.getByRole("button", { name: "Pick auto" }).click();
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    await screen.rerender(
      <AppAtomRegistryProvider>
        <Picker thread={thread} runtime={null} runtimeMode="auto" />
      </AppAtomRegistryProvider>,
    );
    await page.getByRole("button", { name: "Pick supervised" }).click();
    await vi.waitFor(() =>
      expect(command).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ runtimeMode: "approval-required" }),
        }),
      ),
    );

    const draftMode = () =>
      useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, thread.id))
        ?.runtimeMode ?? null;
    finish[firstToFinish]?.(AsyncResult.success(undefined));
    finish[1 - firstToFinish]?.(AsyncResult.success(undefined));
    await vi.waitFor(() => expect(draftMode()).toBeNull());
  },
);
