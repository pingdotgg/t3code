import {
  CommandId,
  type ModelSelection,
  PIPELINE_MAX_STEPS,
  PIPELINE_NAME_MAX_LENGTH,
  PIPELINE_SKILL_NAME_PATTERN,
  PIPELINE_STEP_ID_MAX_LENGTH,
  PIPELINE_STEP_SKILLS_MAX,
  type PipelineDefinition,
  PipelineStepId,
  type PipelineStep,
  type PipelineUpsertInput,
  type RuntimeMode,
  pipelineDefinitionIssues,
} from "@t3tools/contracts";

/**
 * Pure pipeline-editor logic shared by the web and mobile settings forms: draft shape, step ids,
 * default templates, validation and the conversion to a `PipelineUpsertInput`. Randomness is
 * injected (`newId`) so the module stays pure.
 */

const FIRST_STEP_TEMPLATE = "{{input}}";
const FOLLOWING_STEP_TEMPLATE = "{{previous.output}}";

export interface PipelineStepDraft {
  /** Stable UI key; never sent to the server. */
  readonly key: string;
  /** The saved step id, or null for a step not saved yet (its id then follows its name). */
  readonly lockedId: string | null;
  readonly name: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly skills: ReadonlyArray<string>;
  readonly promptTemplate: string;
  readonly pauseBefore: boolean;
}

export interface PipelineDraft {
  /** Set when editing; null for a new pipeline. */
  readonly editingId: PipelineDefinition["id"] | null;
  /** Reused by every save attempt of a new pipeline so a retry cannot create it twice. */
  readonly commandId: string;
  readonly name: string;
  readonly steps: ReadonlyArray<PipelineStepDraft>;
}

export interface PipelineStepDefaults {
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
}

export function slugifyStepName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PIPELINE_STEP_ID_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "step";
}

/** Returns `base`, or `base-2`, `base-3`, ... when `base` is taken; the suffix keeps the id within its length limit. */
export function uniqueStepId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, PIPELINE_STEP_ID_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Saved ids never change, so references in other templates and old runs keep working. */
export function resolveStepIds(steps: ReadonlyArray<PipelineStepDraft>): ReadonlyArray<string> {
  const taken = new Set<string>();
  for (const step of steps) if (step.lockedId !== null) taken.add(step.lockedId);
  return steps.map((step) => {
    if (step.lockedId !== null) return step.lockedId;
    const id = uniqueStepId(slugifyStepName(step.name), taken);
    taken.add(id);
    return id;
  });
}

function defaultStepTemplate(index: number): string {
  return index === 0 ? FIRST_STEP_TEMPLATE : FOLLOWING_STEP_TEMPLATE;
}

function nextDefaultStepName(steps: ReadonlyArray<PipelineStepDraft>): string {
  const taken = new Set(steps.map((step) => step.name.trim().toLowerCase()));
  for (let n = steps.length + 1; ; n += 1) {
    if (!taken.has(`step ${n}`)) return `Step ${n}`;
  }
}

/** A new step continues from the last one: same model and permissions, reading the previous output. */
export function newStepDraft(
  steps: ReadonlyArray<PipelineStepDraft>,
  defaults: PipelineStepDefaults,
  newId: () => string,
): PipelineStepDraft {
  const last = steps.at(-1);
  return {
    key: newId(),
    lockedId: null,
    name: nextDefaultStepName(steps),
    modelSelection: last?.modelSelection ?? defaults.modelSelection,
    runtimeMode: last?.runtimeMode ?? defaults.runtimeMode,
    skills: [],
    promptTemplate: defaultStepTemplate(steps.length),
    pauseBefore: false,
  };
}

export function emptyPipelineDraft(
  defaults: PipelineStepDefaults,
  newId: () => string,
): PipelineDraft {
  return {
    editingId: null,
    commandId: newId(),
    name: "",
    steps: [newStepDraft([], defaults, newId)],
  };
}

function stepsToDrafts(
  steps: ReadonlyArray<
    Omit<PipelineStep, "modelSelection"> & Pick<PipelineStepDraft, "modelSelection">
  >,
  newId: () => string,
): ReadonlyArray<PipelineStepDraft> {
  return steps.map((step) => ({
    key: newId(),
    lockedId: step.id,
    name: step.name,
    modelSelection: step.modelSelection,
    runtimeMode: step.runtimeMode,
    skills: step.skills,
    promptTemplate: step.promptTemplate,
    pauseBefore: step.pauseBefore,
  }));
}

export function pipelineToDraft(pipeline: PipelineDefinition, newId: () => string): PipelineDraft {
  return {
    editingId: pipeline.id,
    commandId: newId(),
    name: pipeline.name,
    steps: stepsToDrafts(pipeline.steps, newId),
  };
}

/**
 * A new, unsaved pipeline prefilled from a starter. Step ids stay locked to the starter's own,
 * because its prompts reference them (`{{steps.requirements.output}}`) and slugs of the names
 * would not match. With `availableInstanceIds`, a step on any other provider instance takes the
 * default model instead.
 */
export function starterToDraft(
  starter: {
    readonly name: string;
    readonly steps: ReadonlyArray<Omit<PipelineStep, "runtimeMode">>;
  },
  newId: () => string,
  defaults: PipelineStepDefaults,
  availableInstanceIds?: ReadonlySet<string>,
): PipelineDraft {
  return {
    editingId: null,
    commandId: newId(),
    name: starter.name,
    steps: stepsToDrafts(
      starter.steps.map((starterStep) => ({
        ...starterStep,
        runtimeMode: defaults.runtimeMode,
        modelSelection:
          availableInstanceIds === undefined ||
          availableInstanceIds.has(starterStep.modelSelection.instanceId)
            ? starterStep.modelSelection
            : defaults.modelSelection,
      })),
      newId,
    ),
  };
}

/** Moves an item by `delta` positions; returns the same array when it cannot move. */
export function moveStep<T>(
  items: ReadonlyArray<T>,
  index: number,
  delta: -1 | 1,
): ReadonlyArray<T> {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

/** Accepts what a user types or pastes: `$review`, ` review `. Null when it is not a valid skill name. */
export function normalizeSkillName(raw: string): string | null {
  const name = raw.trim().replace(/^[$/]/, "");
  return PIPELINE_SKILL_NAME_PATTERN.test(name) ? name : null;
}

export interface PipelineDraftIssues {
  readonly name: string | null;
  readonly stepCount: string | null;
  /** Messages per step key. */
  readonly steps: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Every message in one list, step messages prefixed with the step they belong to. */
  readonly messages: ReadonlyArray<string>;
  readonly valid: boolean;
}

/** `availableInstanceIds`: the provider instances this draft's environment can run; omit to skip the check. */
export function pipelineDraftIssues(
  draft: PipelineDraft,
  availableInstanceIds?: ReadonlySet<string>,
): PipelineDraftIssues {
  const name = draft.name.trim()
    ? draft.name.trim().length > PIPELINE_NAME_MAX_LENGTH
      ? `Use at most ${PIPELINE_NAME_MAX_LENGTH} characters.`
      : null
    : "Give the pipeline a name.";
  const stepCount =
    draft.steps.length === 0
      ? "Add at least one step."
      : draft.steps.length > PIPELINE_MAX_STEPS
        ? `A pipeline has at most ${PIPELINE_MAX_STEPS} steps.`
        : null;

  const ids = resolveStepIds(draft.steps);
  const steps = new Map<string, string[]>();
  const stepMessages: string[] = [];
  const add = (key: string, message: string, flatMessage = message) => {
    const messages = steps.get(key);
    if (messages) messages.push(message);
    else steps.set(key, [message]);
    stepMessages.push(flatMessage);
  };

  draft.steps.forEach((step, index) => {
    const stepName = step.name.trim();
    const own = (message: string) =>
      add(step.key, message, `${stepName || `Step ${index + 1}`}: ${message}`);
    if (!stepName) own("Give the step a name.");
    else if (stepName.length > PIPELINE_NAME_MAX_LENGTH) {
      own(`Use at most ${PIPELINE_NAME_MAX_LENGTH} characters for the name.`);
    }
    if (step.modelSelection === null) own("Choose a model.");
    else if (
      availableInstanceIds !== undefined &&
      !availableInstanceIds.has(step.modelSelection.instanceId)
    ) {
      own(`Provider ${step.modelSelection.instanceId} isn't available here.`);
    }
    if (!step.promptTemplate.trim()) own("Write a prompt template.");
    if (step.skills.length > PIPELINE_STEP_SKILLS_MAX) {
      own(`A step has at most ${PIPELINE_STEP_SKILLS_MAX} skills.`);
    }
    if (step.skills.some((skill) => normalizeSkillName(skill) !== skill)) {
      own("A skill name has an invalid character.");
    }
  });

  // Blank names are reported above, so give them distinct stand-ins instead of "used twice".
  const keyById = new Map(ids.map((id, index) => [id, draft.steps[index]!.key]));
  for (const issue of pipelineDefinitionIssues(
    draft.steps.map((step, index) => ({
      id: ids[index]!,
      name: step.name.trim() || `Step ${index + 1}`,
      promptTemplate: step.promptTemplate,
    })),
  )) {
    const key = keyById.get(issue.stepId);
    if (key !== undefined) add(key, issue.message);
  }

  return {
    name,
    stepCount,
    steps,
    messages: [
      ...(name === null ? [] : [name]),
      ...(stepCount === null ? [] : [stepCount]),
      ...stepMessages,
    ],
    valid: name === null && stepCount === null && steps.size === 0,
  };
}

/** Null when the draft has any issue. Create calls carry a commandId; edits carry `requireExisting`. */
export function draftToUpsertInput(draft: PipelineDraft): PipelineUpsertInput | null {
  if (!pipelineDraftIssues(draft).valid) return null;
  const ids = resolveStepIds(draft.steps);
  const steps = draft.steps.map((step, index) => ({
    id: PipelineStepId.make(ids[index]!),
    name: step.name.trim(),
    modelSelection: step.modelSelection!,
    runtimeMode: step.runtimeMode,
    skills: step.skills,
    promptTemplate: step.promptTemplate.trim(),
    pauseBefore: step.pauseBefore,
  }));
  return {
    ...(draft.editingId !== null
      ? { id: draft.editingId, requireExisting: true }
      : { commandId: CommandId.make(draft.commandId) }),
    name: draft.name.trim(),
    steps,
  };
}

function draftSignature(draft: PipelineDraft): string {
  return JSON.stringify([
    draft.editingId,
    draft.name,
    draft.steps.map((step) => [
      step.lockedId,
      step.name,
      step.modelSelection?.instanceId,
      step.modelSelection?.model,
      [...(step.modelSelection?.options ?? [])]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((option) => [option.id, option.value]),
      step.runtimeMode,
      step.skills,
      step.promptTemplate,
      step.pauseBefore,
    ]),
  ]);
}

/** Compares what would be saved; UI keys and the command id are ignored. */
export function hasPipelineDraftChanges(initial: PipelineDraft, current: PipelineDraft): boolean {
  return draftSignature(initial) !== draftSignature(current);
}

/** "Plan (Claude Opus) → Implement (Codex) → Review"; the model is shown only where `modelLabel` knows it. */
export function pipelineStepSummary(
  steps: ReadonlyArray<{ readonly name: string; readonly modelSelection: ModelSelection }>,
  modelLabel: (selection: ModelSelection) => string | null,
): string {
  return steps
    .map((step) => {
      const label = modelLabel(step.modelSelection);
      return label ? `${step.name} (${label})` : step.name;
    })
    .join(" → ");
}

/** "3 steps: Plan, Build, Review" for a list row. */
export function describePipelineSteps(steps: ReadonlyArray<{ readonly name: string }>): string {
  const count = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  return steps.length === 0 ? count : `${count}: ${steps.map((step) => step.name).join(", ")}`;
}
