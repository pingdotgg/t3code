import {
  pipelineTemplateReferences,
  resolvePipelineStepKey,
  type PipelineRunStepStatus,
  type PipelineSnapshot,
} from "@t3tools/contracts";

// Same placeholder shape as the webhook renderer; contracts parses the expression inside.
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

export interface RenderPipelinePromptInput {
  readonly snapshot: PipelineSnapshot;
  readonly stepIndex: number;
  /** The user's starting prompt. */
  readonly input: string;
  /** Run state per step, index-aligned with `snapshot.steps`. */
  readonly steps: ReadonlyArray<{
    readonly status: PipelineRunStepStatus;
    readonly output: string | null;
  }>;
}

/**
 * Renders the prompt a step sends. Never throws: definitions are validated at upsert, so an
 * expression that cannot be resolved here is left as written. Substitution is a single pass, so
 * placeholders inside a substituted output are not expanded.
 */
export function renderPipelinePrompt(input: RenderPipelinePromptInput): { prompt: string } {
  const { snapshot, stepIndex } = input;
  const step = snapshot.steps[stepIndex];
  if (step === undefined) return { prompt: "" };

  const completedOutput = (index: number): string => {
    const state = input.steps[index];
    return state?.status === "completed" ? (state.output ?? "") : "";
  };

  const previousOutput = (): string => {
    for (let index = Math.min(stepIndex, input.steps.length) - 1; index >= 0; index -= 1) {
      if (input.steps[index]?.status === "completed") return completedOutput(index);
    }
    return "";
  };

  const body = step.promptTemplate.replace(PLACEHOLDER, (placeholder) => {
    const reference = pipelineTemplateReferences(placeholder)[0];
    switch (reference?.kind) {
      case "input":
        return input.input;
      case "previous":
        return previousOutput();
      case "step": {
        const target = resolvePipelineStepKey(snapshot.steps, reference.key);
        return target === -1 ? placeholder : completedOutput(target);
      }
      default:
        return placeholder;
    }
  });

  if (step.skills.length === 0) return { prompt: body };
  return { prompt: `${step.skills.map((skill) => `$${skill}`).join(" ")}\n\n${body}` };
}

/** The MCP tool a step calls to hand its result to the next step. */
const PIPELINE_HANDOFF_TOOL = "handoff_pipeline_step";

/**
 * Appended to every step's prompt, whatever its template says: a step's turn ending is not a
 * result, so the run only moves on once the agent hands off explicitly.
 */
export function pipelineHandoffInstructions(input: {
  readonly stepNumber: number;
  readonly stepCount: number;
  readonly stepName: string;
}): string {
  const last = input.stepNumber >= input.stepCount;
  return `Pipeline handoff:
- You are step ${input.stepNumber} of ${input.stepCount} ("${input.stepName}") of a pipeline. ${
    last
      ? "This is the last step: the run finishes only after you call the T3 tool"
      : "The next step starts only after you call the T3 tool"
  } \`${PIPELINE_HANDOFF_TOOL}\` with your final result as \`output\`.${
    last ? "" : " The next step sees only that output, so make it complete."
  }
- Hand off only when this step's work is done, as your last action. Ending your turn without handing off pauses the pipeline until I respond.
- If something this step needs is missing or unfinished (an earlier step's work, the branch or pull request it builds on, another ticket's work), or a decision only I can make blocks you, ask me with your question tool and wait for my answer. Do not hand off a report that the work could not be done, and do not end your turn with an open question.
- If I tell you to stop, end your turn without handing off.`;
}
