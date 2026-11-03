import {
  CommandId,
  EnvironmentId,
  OrchestrationV2DispatchCommandError,
  ProviderInstanceId,
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
  modeSets: [] as unknown[],
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: ((command: { readonly label: string }) =>
    async (value: { readonly input: unknown }) => {
      if (command.label.endsWith(":start-turn")) {
        return AsyncResult.failure(Cause.fail(state.startTurnError));
      }
      if (command.label.endsWith(":set-interaction-mode")) state.modeSets.push(value.input);
      return AsyncResult.success(undefined);
    }) as never,
}));

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { usePlanFollowUpSend } from "./useProposedPlanSend";

const environmentId = EnvironmentId.make("environment:test");
const threadId = ThreadId.make("thread:plan");
const threadRef = scopeThreadRef(environmentId, threadId);

function setup(startTurnError: unknown) {
  state.startTurnError = startTurnError;
  state.modeSets = [];
  useComposerDraftStore.getState().setInteractionMode(threadRef, "plan");
}

function ImplementButton(props: { readonly onSettled: (sent: boolean) => void }) {
  const submitPlanFollowUp = usePlanFollowUpSend({
    environmentId,
    routeThreadKey: "environment:test:thread:plan",
    activeThread: { id: threadId, environmentId, interactionMode: "plan", title: "Plan" } as never,
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
  return (
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
  );
}

it.each([
  {
    name: "a refused send returns the thread to plan so Implement can be retried",
    error: new OrchestrationV2DispatchCommandError({
      commandId: CommandId.make("command:refused"),
      commandType: "message.dispatch",
      message: "Refused",
    }),
    draftMode: "plan",
    modeSets: [{ threadId, interactionMode: "plan" }],
  },
  {
    name: "a send lost in transport may have started, so the thread stays out of plan",
    error: new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "socket closed",
        cause: new Error("socket closed"),
      }),
    }),
    draftMode: "default",
    modeSets: [],
  },
])("$name", async ({ error, draftMode, modeSets }) => {
  setup(error);
  let onSettled!: (sent: boolean) => void;
  const settled = new Promise<boolean>((resolve) => {
    onSettled = resolve;
  });
  await using screen = await render(<ImplementButton onSettled={onSettled} />);

  await screen.getByRole("button", { name: "Implement" }).click();

  expect(await settled).toBe(false);
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.interactionMode).toBe(
    draftMode,
  );
  expect(state.modeSets).toMatchObject(modeSets);
});
