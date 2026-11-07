import { EnvironmentId, ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { toastManager } from "../ui/toast";
import { useComposerSelection } from "./useComposerSelection";

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
  readonly activeThread?: EnvironmentThreadShell;
  readonly setThreadRuntimeMode?: (input: {
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
    interactionMode: "default" as ProviderInteractionMode,
    interactionModeEnabled: false,
    isLocalDraftThread: props.isLocalDraftThread ?? false,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: vi.fn(),
    setPendingServerThreadStartFromOriginByThreadId: vi.fn(),
    scheduleComposerFocus: vi.fn(),
    setThreadRuntimeMode: props.setThreadRuntimeMode as never,
  });

  props.onReady(hook);
  return null;
}

function setup() {
  useComposerDraftStore.getState().setRuntimeMode(threadRef, null);
  return {
    [Symbol.dispose]() {
      useComposerDraftStore.getState().setRuntimeMode(threadRef, null);
    },
  };
}

describe("useComposerSelection runtime mode persistence", () => {
  it("persists runtime mode change immediately to the server on an existing thread", async () => {
    using _cleanup = setup();
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
    using _cleanup = setup();
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

  it("preserves newer runtime mode selection when an earlier change fails after a delay", async () => {
    using _cleanup = setup();
    let rejectFirst!: (res: unknown) => void;
    const firstPromise = new Promise((resolve) => {
      rejectFirst = resolve;
    });
    const setThreadRuntimeMode = vi
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
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

    await act(() => {
      hook.handleRuntimeModeChangeStable("approval-required");
    });
    await act(() => {
      hook.handleRuntimeModeChangeStable("auto-accept-edits");
    });

    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.runtimeMode).toBe(
      "auto-accept-edits",
    );

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
      "auto-accept-edits",
    );
  });

  it("does not call setThreadRuntimeMode on a local draft thread", async () => {
    using _cleanup = setup();
    const setThreadRuntimeMode = vi.fn();
    let hook!: ReturnType<typeof useComposerSelection>;

    await using _screen = await render(
      <TestHarness
        isLocalDraftThread={true}
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
