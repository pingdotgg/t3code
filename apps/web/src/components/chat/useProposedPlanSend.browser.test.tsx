import {
  CommandId,
  EnvironmentId,
  OrchestrationV2DispatchCommandError,
  type ProviderInteractionMode,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  startTurnErrors: [] as unknown[],
  startTurnModes: [] as string[],
  otherCommands: [] as string[],
  settingsModes: [] as string[],
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: ((command: { readonly label: string }) =>
    async ({ input }: { input: { interactionMode: string } }) => {
      if (command.label.endsWith(":start-turn")) {
        state.startTurnModes.push(input.interactionMode);
        const error = state.startTurnErrors.shift();
        return error === undefined
          ? AsyncResult.success(undefined)
          : AsyncResult.failure(Cause.fail(error));
      }
      state.otherCommands.push(command.label);
      return AsyncResult.success(undefined);
    }) as never,
}));

import { render } from "../../../test/render";
import { partializeComposerDraftStoreState, useComposerDraftStore } from "../../composerDraftStore";
import { resolveComposerInteractionMode } from "../ChatView.logic";
import { usePlanFollowUpSend, useThreadInteractionMode } from "./useProposedPlanSend";

const environmentId = EnvironmentId.make("environment:test");
const threadId = ThreadId.make("thread:plan");
const threadRef = scopeThreadRef(environmentId, threadId);

const refused = new OrchestrationV2DispatchCommandError({
  commandId: CommandId.make("command:refused"),
  commandType: "message.dispatch",
  message: "Refused",
});
const lost = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({
    message: "socket closed",
    cause: new Error("socket closed"),
  }),
});

function setup(startTurnErrors: unknown[]) {
  state.startTurnErrors = startTurnErrors;
  state.startTurnModes = [];
  state.otherCommands = [];
  state.settingsModes = [];
  const store = useComposerDraftStore.getState();
  store.setInteractionMode(threadRef, null);
  store.setFailedPlanFollowUpRunId(threadRef, undefined);
}

function serverThread(
  interactionMode: ProviderInteractionMode,
  runId: RunId | null,
): EnvironmentThreadShell {
  return {
    id: threadId,
    environmentId,
    interactionMode,
    title: "Plan",
    latestRun: runId === null ? null : { runId },
  } as never;
}

function persistedFailure() {
  const persisted = JSON.parse(
    JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
  );
  return persisted.draftsByThreadKey[scopedThreadKey(threadRef)]?.failedPlanFollowUpRunId;
}

function PlanThread(props: {
  readonly thread: ReturnType<typeof serverThread>;
  readonly onSettled: (sent: boolean) => void;
  readonly detailRunId?: RunId | null;
  readonly interactionMode?: "default" | "plan";
}) {
  const submitPlanFollowUp = usePlanFollowUpSend({
    environmentId,
    routeThreadKey: scopedThreadKey(threadRef),
    activeThread: props.thread,
    activeLatestRun:
      props.detailRunId === null
        ? null
        : ({ runId: props.detailRunId ?? props.thread.latestRun?.runId } as never),
    activeThreadBranch: null,
    activeProposedPlan: { id: "plan:1", planMarkdown: "# Plan" } as never,
    isServerThread: true,
    isSendBusy: false,
    composerRef: {
      current: {
        getSendContext: () => ({
          providerAvailable: true,
          interactionModeEnabled: true,
          selectedProvider: "codex",
          selectedModel: "gpt-5.5",
          selectedProviderModels: [],
          selectedPromptEffort: null,
          selectedModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
          },
        }),
      },
    } as never,
    beginLocalDispatch: () => undefined,
    resetLocalDispatch: () => undefined,
    runtimeMode: "full-access",
    localCheckoutBranchMismatch: null,
    setOptimisticUserMessages: () => undefined,
    setThreadError: () => undefined,
    anchorNewTurn: () => undefined,
    persistThreadSettingsForNextTurn: async ({
      interactionMode,
    }): Promise<AtomCommandResult<void, unknown>> => {
      state.settingsModes.push(interactionMode);
      return AsyncResult.success(undefined);
    },
  });
  const threadMode = useThreadInteractionMode(props.thread);
  const draftMode = useComposerDraftStore(
    (store) => store.getComposerDraft(threadRef)?.interactionMode ?? null,
  );
  // Mirrors ChatView with the plan mode setting off.
  const composer = resolveComposerInteractionMode({
    planModeEnabled: false,
    provider: { showInteractionModeToggle: true },
    interactionMode: draftMode ?? threadMode ?? "default",
    persistedInteractionMode: threadMode,
  });
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void submitPlanFollowUp({
            text: "Implement the plan",
            interactionMode: props.interactionMode ?? "default",
          }).then(props.onSettled)
        }
      >
        Implement
      </button>
      <output aria-label="composer mode">
        {composer.enabled ? composer.interactionMode : "controls hidden"}
      </output>
    </>
  );
}

function settlements() {
  const queue: ((sent: boolean) => void)[] = [];
  return {
    onSettled: (sent: boolean) => queue.shift()?.(sent),
    next: () => new Promise<boolean>((resolve) => queue.push(resolve)),
  };
}

it.each([
  { name: "refused by the server", planRunId: RunId.make("run:plan-refused"), error: refused },
  { name: "lost in transport", planRunId: RunId.make("run:plan-lost"), error: lost },
])(
  "an Implement send $name keeps the plan controls until another run starts, without writing the thread mode",
  async ({ error, planRunId }) => {
    setup([error]);
    const send = settlements();
    await using screen = await render(
      <PlanThread thread={serverThread("plan", planRunId)} onSettled={send.onSettled} />,
    );
    const composerMode = screen.getByRole("status", { name: "composer mode" });

    const settled = send.next();
    await screen.getByRole("button", { name: "Implement" }).click();
    expect(await settled).toBe(false);

    // The settings save already moved the server thread out of plan.
    await screen.rerender(
      <PlanThread thread={serverThread("default", planRunId)} onSettled={send.onSettled} />,
    );
    await expect.element(composerMode).toHaveTextContent("plan");
    expect(state.otherCommands).toEqual([]);

    expect(persistedFailure()).toBe(planRunId);
    const persisted = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    const merge = useComposerDraftStore.persist.getOptions().merge!;
    useComposerDraftStore.setState(merge(persisted, useComposerDraftStore.getInitialState()));
    await expect.element(composerMode).toHaveTextContent("plan");

    // A run from this send or another client means the thread really left plan.
    await screen.rerender(
      <PlanThread
        thread={serverThread("default", RunId.make("run:next"))}
        onSettled={send.onSettled}
      />,
    );
    await expect.element(composerMode).toHaveTextContent("controls hidden");
  },
);

it("a refused Implement can be retried, and an accepted retry is not offered again", async () => {
  const planRunId = RunId.make("run:plan-retry");
  setup([refused]);
  const send = settlements();
  await using screen = await render(
    <PlanThread thread={serverThread("plan", planRunId)} onSettled={send.onSettled} />,
  );
  const implement = screen.getByRole("button", { name: "Implement" });

  let settled = send.next();
  await implement.click();
  expect(await settled).toBe(false);

  // The first save moved the thread to default; recovery keeps Implement reachable.
  await screen.rerender(
    <PlanThread thread={serverThread("default", planRunId)} onSettled={send.onSettled} />,
  );
  settled = send.next();
  await implement.click();
  expect(await settled).toBe(true);
  expect(state.startTurnModes).toEqual(["default", "default"]);
  expect(persistedFailure()).toBeUndefined();
  // Before the accepted run reaches the shell, Implement must not be offered a second time.
  await expect
    .element(screen.getByRole("status", { name: "composer mode" }))
    .toHaveTextContent("controls hidden");
});

const detailPlanRunId = RunId.make("run:detail-plan");
it.each([
  { name: "missing shell run", shellRunId: null, detailRunId: detailPlanRunId },
  {
    name: "different shell run",
    shellRunId: RunId.make("run:stale-shell"),
    detailRunId: detailPlanRunId,
  },
  { name: "missing detail run", shellRunId: detailPlanRunId, detailRunId: null },
])("does not save Implement mode with a $name", async ({ shellRunId, detailRunId }) => {
  setup([refused]);
  const send = settlements();
  await using screen = await render(
    <PlanThread
      thread={serverThread("plan", shellRunId)}
      detailRunId={detailRunId}
      onSettled={send.onSettled}
    />,
  );
  const settled = send.next();
  await screen.getByRole("button", { name: "Implement" }).click();
  expect(await settled).toBe(false);
  expect(state.settingsModes).toEqual([]);
});

it("allows refinement while the shell run catches up", async () => {
  setup([refused]);
  const send = settlements();
  await using screen = await render(
    <PlanThread
      thread={serverThread("plan", null)}
      detailRunId={detailPlanRunId}
      interactionMode="plan"
      onSettled={send.onSettled}
    />,
  );
  const settled = send.next();
  await screen.getByRole("button", { name: "Implement" }).click();
  expect(await settled).toBe(false);
  expect(state.settingsModes).toEqual(["plan"]);
});
