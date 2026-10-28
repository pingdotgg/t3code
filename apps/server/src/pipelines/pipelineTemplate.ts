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
