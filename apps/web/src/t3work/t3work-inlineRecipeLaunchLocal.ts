import type { ProjectRecipeWorkflowCardActivityPayload } from "@t3tools/project-recipes";

import { persistStoredSidecarPersonalization } from "~/t3work/hooks/t3work-sidecarCompositionPersistence";
import {
  T3WORK_SIDECAR_APPLY_PERSONALIZATION_RESET_TOOL,
  type T3workSidecarPersonalizationResetToolInput,
} from "~/t3work/t3work-sidecarPersonalizationReset";
import type {
  T3workDeterministicWorkflowLaunch,
  T3workInlineRecipeLaunchOutcome,
} from "~/t3work/t3work-inlineRecipeLaunch";

export type PendingT3workInlineWorkflowPrompt = {
  readonly title: string;
  readonly description: string;
  readonly workflowCard: ProjectRecipeWorkflowCardActivityPayload;
  readonly submitApprovedAction: () => Promise<T3workInlineRecipeLaunchOutcome | null>;
};

function isResetToolInput(value: unknown): value is T3workSidecarPersonalizationResetToolInput {
  return typeof value === "object" && value !== null && "nextPersonalization" in value;
}

function canRunLocalToolStep(toolName: string, toolInput: unknown) {
  return (
    toolName === T3WORK_SIDECAR_APPLY_PERSONALIZATION_RESET_TOOL && isResetToolInput(toolInput)
  );
}

function runLocalToolStep(input: {
  readonly toolName: string;
  readonly toolInput: unknown;
}): T3workInlineRecipeLaunchOutcome | null {
  if (
    input.toolName !== T3WORK_SIDECAR_APPLY_PERSONALIZATION_RESET_TOOL ||
    !isResetToolInput(input.toolInput)
  ) {
    return null;
  }
  persistStoredSidecarPersonalization(input.toolInput.nextPersonalization);
  return {
    applied: true,
    promptText: input.toolInput.promptText,
  };
}

export function createPendingT3workInlineWorkflowPrompt(
  launch: T3workDeterministicWorkflowLaunch,
): PendingT3workInlineWorkflowPrompt | null {
  const presentStep = launch.workflow.steps[0];
  const collectStep = launch.workflow.steps[1];
  const toolSteps = launch.workflow.steps.slice(2);
  const awaitedActionId =
    collectStep?.kind === "collect-input" && collectStep.request.kind === "card-action"
      ? collectStep.request.actionId
      : null;
  if (
    !presentStep ||
    presentStep.kind !== "present-message" ||
    !presentStep.message.card ||
    !collectStep ||
    collectStep.kind !== "collect-input" ||
    collectStep.request.kind !== "card-action" ||
    !awaitedActionId ||
    !presentStep.message.card.actions?.some((action) => action.id === awaitedActionId) ||
    toolSteps.length === 0 ||
    toolSteps.some(
      (step) => step.kind !== "tool" || !canRunLocalToolStep(step.toolName, step.input),
    )
  ) {
    return null;
  }

  return {
    title: launch.title,
    description: launch.description,
    workflowCard: {
      workflowRunId: `local:${launch.launchId}`,
      stepId: presentStep.id,
      phase: "updated",
      awaitingActionId: awaitedActionId,
      card: presentStep.message.card,
    },
    submitApprovedAction: async () => {
      let outcome: T3workInlineRecipeLaunchOutcome | null = { applied: false };
      for (const step of toolSteps) {
        if (step.kind !== "tool") {
          return null;
        }
        const stepOutcome = runLocalToolStep({ toolName: step.toolName, toolInput: step.input });
        if (!stepOutcome) {
          return null;
        }
        outcome = stepOutcome;
      }
      return outcome;
    },
  };
}
