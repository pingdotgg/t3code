import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  startedTurn: null as ReturnType<typeof deferred<unknown>> | null,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => async (value: { readonly input: unknown }) => {
    state.startedTurn?.resolve(value.input);
    return AsyncResult.success(undefined);
  }) as never,
}));

import { render } from "../../../test/render";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { useComposerResume } from "./useComposerResume";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup() {
  const startedTurn = deferred<unknown>();
  state.startedTurn = startedTurn;
  return { startedTurn };
}

const threadA = ThreadId.make("thread:a");
const threadAModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
const threadBModel = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" };

function composerShowing(selectedModelSelection: typeof threadAModel) {
  return { getSendContext: () => ({ selectedModelSelection }) } as never;
}

function ResumeButton(props: {
  readonly composerRef: ComposerHandleRef;
  readonly persistSettings: () => Promise<AtomCommandResult<void, unknown>>;
}) {
  const { onResume } = useComposerResume({
    environmentId: EnvironmentId.make("environment:test"),
    routeThreadKey: "environment:test:thread:a",
    currentRouteThreadKeyRef: { current: "environment:test:thread:a" },
    activeThread: { id: threadA } as never,
    resumableRunId: RunId.make("run:interrupted"),
    hasHeldQueuedRuns: false,
    isSendBusy: false,
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    activeEnvironmentUnavailable: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    localCheckoutBranchMismatch: null,
    composerRef: props.composerRef,
    persistThreadSettingsForNextTurn: props.persistSettings,
    clearUsageLimitsFor: () => undefined,
    scrollToEnd: () => undefined,
    setThreadError: () => undefined,
  });
  return (
    <button type="button" onClick={() => void onResume()}>
      Resume
    </button>
  );
}

it("continues on the resumed thread's model after the composer moves to another thread", async () => {
  const { startedTurn } = setup();
  const settingsPersisted = deferred<AtomCommandResult<void, unknown>>();
  // ChatView keeps one composer across thread routes, so its ref follows navigation.
  const composerRef: ComposerHandleRef = { current: composerShowing(threadAModel) };
  await using screen = await render(
    <ResumeButton composerRef={composerRef} persistSettings={() => settingsPersisted.promise} />,
  );

  await screen.getByRole("button", { name: "Resume" }).click();
  composerRef.current = composerShowing(threadBModel);
  settingsPersisted.resolve(AsyncResult.success(undefined));

  expect(await startedTurn.promise).toMatchObject({
    threadId: threadA,
    manualContinuationOfRunId: "run:interrupted",
    modelSelection: threadAModel,
  });
});
