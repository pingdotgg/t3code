import {
  pipelineTemplateReferences,
  resolvePipelineStepKey,
  type PipelineRevision,
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

const REVISION_HISTORY_FEEDBACK_CHARS = 600;
const REVISION_HISTORY_QUOTE_CHARS = 300;

const clip = (text: string, max: number) => {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}…`;
};

const blockquote = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

export interface PipelineRevisionNote {
  readonly stepIndex: number;
  readonly feedback: string;
  readonly quote: string | null;
  readonly author: PipelineRevision["author"];
}

const authorLabel = (author: PipelineRevision["author"]) =>
  author === "user" ? "the user" : author === "coordinator" ? "the coordinator" : "an agent";

const revisionBody = (
  revision: PipelineRevisionNote,
  limits: { feedback: number; quote: number },
) =>
  [
    revision.quote === null || revision.quote.trim().length === 0
      ? null
      : blockquote(clip(revision.quote, limits.quote)),
    clip(revision.feedback, limits.feedback),
  ]
    .filter((part) => part !== null)
    .join("\n\n");

/** Every revision of the run so far, oldest first, so a later step can check earlier feedback too. */
function pipelineRevisionHistory(
  revisions: ReadonlyArray<PipelineRevisionNote>,
  stepNames: ReadonlyArray<string>,
): string {
  return revisions
    .map(
      (revision, index) =>
        `${index + 1}. On step ${revision.stepIndex + 1} "${stepNames[revision.stepIndex] ?? ""}", from ${authorLabel(revision.author)}:\n${revisionBody(
          revision,
          { feedback: REVISION_HISTORY_FEEDBACK_CHARS, quote: REVISION_HISTORY_QUOTE_CHARS },
        )}`,
    )
    .join("\n\n");
}

/** The section a freshly launched step gets when it has to catch up on feedback given earlier. */
export function pipelineRevisionSection(
  revisions: ReadonlyArray<PipelineRevisionNote>,
  stepNames: ReadonlyArray<string>,
): string {
  if (revisions.length === 0) return "";
  return `Revision feedback:\nEarlier steps of this run were revised after the feedback below. Make sure your work reflects all of it.\n\n${pipelineRevisionHistory(revisions, stepNames)}`;
}

/** Sent into the revised step's own thread. */
export function pipelineRevisionMessage(input: {
  readonly revision: PipelineRevisionNote & { readonly sourceStepName: string | null };
  readonly history: ReadonlyArray<PipelineRevisionNote>;
  readonly stepNames: ReadonlyArray<string>;
  readonly handoff: string;
}): string {
  const { revision } = input;
  const from =
    revision.sourceStepName === null
      ? ""
      : ` while looking at the step "${revision.sourceStepName}"`;
  const earlier = input.history.slice(0, -1);
  return [
    `Feedback on your work (step ${revision.stepIndex + 1}, "${input.stepNames[revision.stepIndex] ?? ""}") from ${authorLabel(revision.author)}${from}:`,
    revisionBody(revision, { feedback: Number.MAX_SAFE_INTEGER, quote: Number.MAX_SAFE_INTEGER }),
    ...(earlier.length === 0
      ? []
      : [
          `Feedback already given on this run:\n${pipelineRevisionHistory(earlier, input.stepNames)}`,
        ]),
    "Fix this in the current files, then hand off again with your complete result. The steps after you will redo their work against it.",
    input.handoff,
  ].join("\n\n");
}

/** Sent into a later step's existing thread once an earlier step was revised and handed off. */
export function pipelineUpstreamChangedMessage(input: {
  readonly revised: { readonly stepIndex: number; readonly feedback: string };
  readonly history: ReadonlyArray<PipelineRevisionNote>;
  readonly stepNames: ReadonlyArray<string>;
  /** Only outputs this step's template references, or the revised step's when it has none. */
  readonly outputs: ReadonlyArray<{ readonly stepIndex: number; readonly output: string }>;
  readonly handoff: string;
}): string {
  const { revised } = input;
  return [
    `Something upstream changed. Step ${revised.stepIndex + 1} "${input.stepNames[revised.stepIndex] ?? ""}" was revised after this feedback:\n${blockquote(clip(revised.feedback, REVISION_HISTORY_FEEDBACK_CHARS))}`,
    ...input.outputs.map(
      ({ stepIndex, output }) =>
        `New output of step ${stepIndex + 1} "${input.stepNames[stepIndex] ?? ""}":\n${output}`,
    ),
    `All feedback given on this run so far, oldest first. Check that your result also reflects the earlier items:\n${pipelineRevisionHistory(input.history, input.stepNames)}`,
    "Redo your step against the current state of the files and the outputs above, re-verifying rather than relying on your earlier conclusions. Then hand off again with your complete result.",
    input.handoff,
  ].join("\n\n");
}

/** Indexes of the earlier steps whose output the step's template reads, ascending. */
export function pipelineReferencedStepIndexes(
  snapshot: PipelineSnapshot,
  stepIndex: number,
  isCompleted: (index: number) => boolean,
): ReadonlyArray<number> {
  const step = snapshot.steps[stepIndex];
  if (step === undefined) return [];
  const indexes = new Set<number>();
  for (const reference of pipelineTemplateReferences(step.promptTemplate)) {
    if (reference.kind === "previous") {
      for (let index = stepIndex - 1; index >= 0; index -= 1) {
        if (isCompleted(index)) {
          indexes.add(index);
          break;
        }
      }
    } else if (reference.kind === "step") {
      const target = resolvePipelineStepKey(snapshot.steps, reference.key);
      if (target !== -1 && target < stepIndex) indexes.add(target);
    }
  }
  return [...indexes].toSorted((left, right) => left - right);
}
