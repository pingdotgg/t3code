import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  switchRef: (async () => undefined) as (input: unknown) => Promise<unknown>,
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
  readEnvironmentScope: (() => true) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => (input: unknown) => state.switchRef(input)) as never,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => async () => ({ _tag: "Success", value: undefined })) as never,
}));

vi.mock(import("../../hooks/useThreadActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadActions: (() => ({})) as never,
  useAcknowledgeThreadWoke: (() => () => undefined) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useChildThreadInputs: (() => []) as never,
}));

import { render } from "../../../test/render";
import { useThreadLifecycle } from "./useThreadLifecycle";

const environmentId = EnvironmentId.make("environment:test");

function setup() {
  state.switchRef = async () => undefined;
}

function threadInput(threadId: string, branch: string) {
  const ref = scopeThreadRef(environmentId, ThreadId.make(threadId));
  const thread = { id: ref.threadId, environmentId, branch, worktreePath: null };
  return {
    routeThreadKey: scopedThreadKey(ref),
    activeThread: thread as never,
    activeThreadId: ref.threadId,
    activeThreadRef: ref,
    threadDetailRef: ref,
    activeThreadKey: scopedThreadKey(ref),
    localCheckoutBranchMismatch: { threadBranch: branch, currentBranch: "main" },
  };
}

type ThreadInput = ReturnType<typeof threadInput>;

function RestoreBranchHarness(props: {
  readonly thread: ThreadInput;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly refreshGitStatus: () => void;
  readonly focusComposer: () => void;
}) {
  const lifecycle = useThreadLifecycle({
    ...props.thread,
    environmentId,
    currentRouteThreadKeyRef: props.currentRouteThreadKeyRef,
    canOperateThread: true,
    clientSettingsHydrated: true,
    activeThreadShell: null,
    activeLatestRun: null as never,
    activeProjectCwd: "/repo",
    serverConfig: null,
    runtimeMode: "full-access" as never,
    isWorking: false,
    pendingBackgroundTasks: [],
    turnItems: [],
    activePendingApproval: null as never,
    activePendingUserInput: null as never,
    gitStatusQuery: { refresh: props.refreshGitStatus },
    nowMinute: "",
    composerRef: { current: { focusAtEnd: props.focusComposer } } as never,
    composerDraftTarget: { kind: "thread", ref: props.thread.activeThreadRef } as never,
    sendInFlightRef: { current: false },
    setOptimisticUserMessages: () => undefined,
    setThreadError: () => undefined,
    clearUsageLimitsFor: () => undefined,
    beginLocalDispatch: () => undefined,
    resetLocalDispatch: () => undefined,
    scrollToEnd: () => undefined,
    persistThreadSettingsForNextTurn: async () => ({ _tag: "Success", value: undefined }) as never,
  });
  return (
    <button
      type="button"
      disabled={lifecycle.isRestoringThreadBranch}
      onClick={lifecycle.handleSwitchCheckoutToThreadStable}
    >
      {lifecycle.isRestoringThreadBranch ? "Restoring..." : "Restore branch"}
    </button>
  );
}

it.each(["a", "b", "navigation"] as const)(
  "isolates restore completion and queued focus for %s",
  async (scenario) => {
    const first = scenario === "b" ? "b" : "a";
    setup();
    const completions: Array<(result: unknown) => void> = [];
    const switchRef = vi.fn(() => new Promise<unknown>((resolve) => completions.push(resolve)));
    state.switchRef = switchRef;
    const threadA = threadInput("thread:a", "feature-a");
    const threadB = threadInput("thread:b", "feature-b");
    const currentRouteThreadKeyRef = { current: threadA.routeThreadKey };
    const refreshGitStatus = vi.fn();
    const focusComposer = vi.fn();
    const harness = (thread: ThreadInput) => (
      <RestoreBranchHarness
        thread={thread}
        currentRouteThreadKeyRef={currentRouteThreadKeyRef}
        refreshGitStatus={refreshGitStatus}
        focusComposer={focusComposer}
      />
    );
    await using screen = await render(harness(threadA));
    const focusFrames: FrameRequestCallback[] = [];
    using _frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      focusFrames.push(callback);
      return 0;
    });

    await page.getByRole("button", { name: "Restore branch" }).click();
    await expect.element(page.getByRole("button", { name: "Restoring..." })).toBeDisabled();

    // ChatView stays mounted across server threads, so the hook sees thread B in place.
    currentRouteThreadKeyRef.current = threadB.routeThreadKey;
    await screen.rerender(harness(threadB));
    await expect.element(page.getByRole("button", { name: "Restore branch" })).toBeEnabled();
    await page.getByRole("button", { name: "Restore branch" }).click();
    expect(switchRef).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { cwd: "/repo", refName: "feature-b" } }),
    );

    // Back on thread A, its own restore is still pending, so it can't start a second one.
    currentRouteThreadKeyRef.current = threadA.routeThreadKey;
    await screen.rerender(harness(threadA));
    await expect.element(page.getByRole("button", { name: "Restoring..." })).toBeDisabled();
    currentRouteThreadKeyRef.current = threadB.routeThreadKey;
    await screen.rerender(harness(threadB));

    const completed = first === "a" ? threadA : threadB;
    const pending = first === "a" ? threadB : threadA;
    currentRouteThreadKeyRef.current = pending.routeThreadKey;
    await screen.rerender(harness(pending));
    completions[first === "a" ? 0 : 1]!({
      _tag: "Success",
      value: { refName: completed.localCheckoutBranchMismatch.threadBranch },
    });
    await vi.waitFor(() => expect(refreshGitStatus).toHaveBeenCalledOnce());
    expect(focusComposer).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Restoring..." })).toBeDisabled();
    expect(switchRef).toHaveBeenCalledTimes(2);

    completions[first === "a" ? 1 : 0]!({
      _tag: "Success",
      value: { refName: pending.localCheckoutBranchMismatch.threadBranch },
    });
    await expect.element(page.getByRole("button", { name: "Restore branch" })).toBeEnabled();
    expect(refreshGitStatus).toHaveBeenCalledTimes(2);
    expect(focusComposer).not.toHaveBeenCalled();
    expect(focusFrames).toHaveLength(1);
    if (scenario === "navigation") {
      currentRouteThreadKeyRef.current = completed.routeThreadKey;
      await screen.rerender(harness(completed));
    }
    focusFrames[0]!(0);
    expect(focusComposer).toHaveBeenCalledTimes(scenario === "navigation" ? 0 : 1);
  },
);
