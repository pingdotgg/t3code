import {
  CommandId,
  EnvironmentId,
  OrchestrationV2DispatchCommandError,
  type ProviderInteractionMode,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  startTurnError: null as unknown,
  otherCommands: [] as string[],
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: ((command: { readonly label: string }) => async () => {
    if (command.label.endsWith(":start-turn")) {
      return AsyncResult.failure(Cause.fail(state.startTurnError));
    }
    state.otherCommands.push(command.label);
    return AsyncResult.success(undefined);
  }) as never,
}));

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveComposerInteractionMode } from "../ChatView.logic";
import { usePlanFollowUpSend, useThreadInteractionMode } from "./useProposedPlanSend";

const environmentId = EnvironmentId.make("environment:test");
const threadId = ThreadId.make("thread:plan");
const threadRef = scopeThreadRef(environmentId, threadId);

function setup(startTurnError: unknown) {
  state.startTurnError = startTurnError;
  state.otherCommands = [];
  useComposerDraftStore.getState().setInteractionMode(threadRef, null);
}

function serverThread(interactionMode: ProviderInteractionMode, runId: RunId) {
  return {
    id: threadId,
    environmentId,
    interactionMode,
    title: "Plan",
    latestRun: { runId },
  } as never;
}

function PlanThread(props: {
  readonly thread: ReturnType<typeof serverThread>;
  readonly onSettled: (sent: boolean) => void;
}) {
  const submitPlanFollowUp = usePlanFollowUpSend({
    environmentId,
    routeThreadKey: `${threadRef.environmentId}:${threadRef.threadId}`,
    activeThread: props.thread,
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
    persistThreadSettingsForNextTurn: async (): Promise<AtomCommandResult<void, unknown>> =>
      AsyncResult.success(undefined),
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
          void submitPlanFollowUp({ text: "Implement the plan", interactionMode: "default" }).then(
            props.onSettled,
          )
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

it.each([
  {
    name: "refused by the server",
    planRunId: RunId.make("run:plan-refused"),
    error: new OrchestrationV2DispatchCommandError({
      commandId: CommandId.make("command:refused"),
      commandType: "message.dispatch",
      message: "Refused",
    }),
  },
  {
    name: "lost in transport",
    planRunId: RunId.make("run:plan-lost"),
    error: new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "socket closed",
        cause: new Error("socket closed"),
      }),
    }),
  },
])(
  "an Implement send $name keeps the plan controls until another run starts, without writing the thread mode",
  async ({ error, planRunId }) => {
    setup(error);
    let onSettled!: (sent: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      onSettled = resolve;
    });
    await using screen = await render(
      <PlanThread thread={serverThread("plan", planRunId)} onSettled={onSettled} />,
    );
    const composerMode = screen.getByRole("status", { name: "composer mode" });

    await screen.getByRole("button", { name: "Implement" }).click();
    expect(await settled).toBe(false);

    // The settings save already moved the server thread out of plan.
    await screen.rerender(
      <PlanThread thread={serverThread("default", planRunId)} onSettled={onSettled} />,
    );
    await expect.element(composerMode).toHaveTextContent("plan");
    expect(state.otherCommands).toEqual([]);

    // A run from this send or another client means the thread really left plan.
    await screen.rerender(
      <PlanThread thread={serverThread("default", RunId.make("run:next"))} onSettled={onSettled} />,
    );
    await expect.element(composerMode).toHaveTextContent("controls hidden");
  },
);
