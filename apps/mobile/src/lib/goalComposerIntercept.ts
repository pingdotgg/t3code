import { formatGoalStatusMessage, parseGoalComposerCommand } from "@t3tools/shared/composerTrigger";

export const GOAL_COMMAND_REFUSE_TITLE = "That command was not sent";
export const GOAL_COMMAND_REFUSE_MESSAGE =
  "Type /goal followed by the outcome to set an Objective.";
export const GOAL_UNSUPPORTED_TITLE = "This environment cannot set an Objective";
export const GOAL_UNSUPPORTED_MESSAGE = "Update the server to use /goal.";

export type GoalComposerIntercept =
  | { readonly kind: "none" }
  | { readonly kind: "alert"; readonly title: string; readonly message: string }
  | { readonly kind: "set"; readonly objective: string }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "clear" };

export function interceptGoalComposerCommand(input: {
  readonly text: string;
  readonly supportsGoal: boolean;
  readonly allowLifecycleCommands: boolean;
  readonly goal:
    | { readonly status: string; readonly objective: string }
    | { readonly status: string; readonly objectivePreview: string }
    | null
    | undefined;
}): GoalComposerIntercept {
  const parsed = parseGoalComposerCommand(input.text);
  if (parsed === null) {
    return { kind: "none" };
  }
  if (parsed.action === "refuse") {
    return {
      kind: "alert",
      title: GOAL_COMMAND_REFUSE_TITLE,
      message: GOAL_COMMAND_REFUSE_MESSAGE,
    };
  }
  if (parsed.action === "status") {
    return {
      kind: "alert",
      title: "Objective",
      message: formatGoalStatusMessage(
        input.goal == null
          ? null
          : {
              status: input.goal.status,
              objective:
                "objective" in input.goal ? input.goal.objective : input.goal.objectivePreview,
            },
      ),
    };
  }
  if (!input.supportsGoal) {
    return {
      kind: "alert",
      title: GOAL_UNSUPPORTED_TITLE,
      message: GOAL_UNSUPPORTED_MESSAGE,
    };
  }
  if (parsed.action === "set") {
    return { kind: "set", objective: parsed.objective };
  }
  if (!input.allowLifecycleCommands) {
    return {
      kind: "alert",
      title: "Objective",
      message: "Set an Objective with /goal before pausing, resuming, or clearing.",
    };
  }
  return { kind: parsed.action };
}
