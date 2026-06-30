import { LaneKey, StepKey, WorkflowDefinition } from "@t3tools/contracts";
import type {
  WorkflowDefinitionEncoded,
  WorkflowLaneTransition,
  WorkflowLintError,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

type WorkflowLaneEncoded = WorkflowDefinitionEncoded["lanes"][number];
type WorkflowStepEncoded = NonNullable<WorkflowLaneEncoded["pipeline"]>[number];
type WorkflowStepType = WorkflowStepEncoded["type"];
type LaneRoutingKind = "success" | "failure" | "blocked";
type WorkflowEditorPendingSaveSource = "revert";
type Mutable<T> =
  T extends ReadonlyArray<infer U>
    ? Array<Mutable<U>>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
type MutableWorkflowDefinition = Mutable<WorkflowDefinitionEncoded>;
type MutableWorkflowLane = Mutable<WorkflowLaneEncoded>;
type MutableWorkflowStep = Mutable<WorkflowStepEncoded>;

export interface WorkflowEditorModel {
  readonly definition: WorkflowDefinitionEncoded;
  readonly baselineDefinition: WorkflowDefinitionEncoded;
  readonly dirty: boolean;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly pendingSaveSource?: WorkflowEditorPendingSaveSource | undefined;
}

export type WorkflowEditorSelection =
  | { readonly kind: "lane"; readonly laneKey: string }
  | { readonly kind: "step"; readonly laneKey: string; readonly stepKey: string }
  | { readonly kind: "transition"; readonly laneKey: string; readonly index: number };

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const decodeWorkflowDefinition = Schema.decodeUnknownExit(WorkflowDefinition);
const encodeWorkflowDefinition = Schema.encodeSync(WorkflowDefinition);

const uniqueKey = (existing: ReadonlySet<string>, base: string): string => {
  if (!existing.has(base)) {
    return base;
  }

  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
};

const allStepKeys = (definition: WorkflowDefinitionEncoded): ReadonlySet<string> =>
  new Set(
    definition.lanes.flatMap((lane) => (lane.pipeline ?? []).map((step) => step.key as string)),
  );

const compactOn = (on: MutableWorkflowLane["on"] | MutableWorkflowStep["on"] | undefined) => {
  if (!on) {
    return undefined;
  }
  const next = { ...on };
  if (next.success === undefined) {
    delete next.success;
  }
  if (next.failure === undefined) {
    delete next.failure;
  }
  if (next.blocked === undefined) {
    delete next.blocked;
  }
  return Object.keys(next).length === 0 ? undefined : next;
};

const mutateDefinition = (
  model: WorkflowEditorModel,
  mutate: (definition: MutableWorkflowDefinition) => void,
): WorkflowEditorModel => {
  const definition = cloneJson(model.definition) as MutableWorkflowDefinition;
  mutate(definition);
  return {
    ...model,
    definition: definition as WorkflowDefinitionEncoded,
    dirty: true,
    lintErrors: [],
  };
};

const updateLane = (
  model: WorkflowEditorModel,
  laneKey: string,
  update: (lane: MutableWorkflowLane, definition: MutableWorkflowDefinition) => void,
): WorkflowEditorModel =>
  mutateDefinition(model, (definition) => {
    const lane = definition.lanes.find((candidate) => candidate.key === laneKey);
    if (lane) {
      update(lane, definition);
    }
  });

export const createWorkflowEditorModel = (
  definition: WorkflowDefinitionEncoded,
): WorkflowEditorModel => ({
  definition: cloneJson(definition),
  baselineDefinition: cloneJson(definition),
  dirty: false,
  lintErrors: [],
});

export const normalizeSelection = (
  model: WorkflowEditorModel,
  selection: WorkflowEditorSelection | null,
): WorkflowEditorSelection | null => {
  if (!selection) {
    return null;
  }

  const lane = model.definition.lanes.find(
    (candidate) => String(candidate.key) === selection.laneKey,
  );
  if (!lane) {
    return null;
  }

  if (selection.kind === "lane") {
    return selection;
  }

  if (selection.kind === "step") {
    return (lane.pipeline ?? []).some((step) => String(step.key) === selection.stepKey)
      ? selection
      : { kind: "lane", laneKey: selection.laneKey };
  }

  const transitions = lane.transitions ?? [];
  const transition = selection.index >= 0 ? transitions[selection.index] : undefined;
  return transition ? selection : { kind: "lane", laneKey: selection.laneKey };
};

export const adjustSelectionAfterTransitionRemoval = (
  selection: WorkflowEditorSelection | null,
  laneKey: string,
  removedIndex: number,
): WorkflowEditorSelection | null => {
  if (selection?.kind !== "transition" || selection.laneKey !== laneKey) {
    return selection;
  }
  if (removedIndex < selection.index) {
    return { ...selection, index: selection.index - 1 };
  }
  if (removedIndex === selection.index) {
    return { kind: "lane", laneKey: selection.laneKey };
  }
  return selection;
};

export const setWorkflowLintErrors = (
  model: WorkflowEditorModel,
  lintErrors: ReadonlyArray<WorkflowLintError>,
): WorkflowEditorModel => ({ ...model, lintErrors: [...lintErrors] });

export const lintErrorKey = (lintError: WorkflowLintError): string =>
  [
    lintError.code,
    lintError.message,
    lintError.laneKey,
    lintError.stepKey,
    lintError.transitionIndex,
  ]
    .filter((part) => part !== undefined)
    .join(":");

export const formatVersionTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

export const markWorkflowSaved = (
  model: WorkflowEditorModel,
  definition: WorkflowDefinitionEncoded,
): WorkflowEditorModel => ({
  ...model,
  definition: cloneJson(definition),
  baselineDefinition: cloneJson(definition),
  dirty: false,
  lintErrors: [],
  pendingSaveSource: undefined,
});

export const markWorkflowSavedIfUnchanged = (
  model: WorkflowEditorModel,
  submittedDefinition: WorkflowDefinitionEncoded,
  savedDefinition: WorkflowDefinitionEncoded,
): WorkflowEditorModel => {
  if (JSON.stringify(model.definition) === JSON.stringify(submittedDefinition)) {
    return markWorkflowSaved(model, savedDefinition);
  }

  return {
    ...model,
    baselineDefinition: cloneJson(savedDefinition),
    dirty: true,
    lintErrors: [],
    pendingSaveSource: undefined,
  };
};

export const discardWorkflowChanges = (model: WorkflowEditorModel): WorkflowEditorModel => ({
  ...model,
  definition: cloneJson(model.baselineDefinition),
  dirty: false,
  lintErrors: [],
  pendingSaveSource: undefined,
});

export const loadRevertedDefinition = (
  model: WorkflowEditorModel,
  versionDefinition: WorkflowDefinitionEncoded,
): WorkflowEditorModel => ({
  ...model,
  definition: cloneJson(versionDefinition),
  dirty: true,
  lintErrors: [],
  pendingSaveSource: "revert",
});

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }
  return value;
};

export const canonicalizeDefinitionJson = (definition: WorkflowDefinitionEncoded): string => {
  const decoded = decodeWorkflowDefinition(definition);
  const canonicalValue = Exit.isSuccess(decoded)
    ? encodeWorkflowDefinition(decoded.value)
    : definition;
  return `${JSON.stringify(sortJsonValue(canonicalValue), null, 2)}\n`;
};

export const addLane = (model: WorkflowEditorModel): WorkflowEditorModel =>
  mutateDefinition(model, (definition) => {
    const key = uniqueKey(new Set(definition.lanes.map((lane) => lane.key as string)), "new-lane");
    definition.lanes.push({ key: LaneKey.make(key), name: "New lane", entry: "manual" });
  });

export const removeLane = (model: WorkflowEditorModel, laneKey: string): WorkflowEditorModel =>
  mutateDefinition(model, (definition) => {
    definition.lanes = definition.lanes.filter((lane) => lane.key !== laneKey);
    for (const lane of definition.lanes) {
      lane.on = compactOn({
        success: lane.on?.success === laneKey ? undefined : lane.on?.success,
        failure: lane.on?.failure === laneKey ? undefined : lane.on?.failure,
        blocked: lane.on?.blocked === laneKey ? undefined : lane.on?.blocked,
      });
      lane.transitions = lane.transitions?.filter((transition) => transition.to !== laneKey);
      if (lane.transitions?.length === 0) {
        delete lane.transitions;
      }
      lane.actions = lane.actions?.filter((action) => action.to !== laneKey);
      if (lane.actions?.length === 0) {
        delete lane.actions;
      }
      lane.onEvent = lane.onEvent?.filter((event) => event.to !== laneKey);
      if (lane.onEvent?.length === 0) {
        delete lane.onEvent;
      }
      for (const step of lane.pipeline ?? []) {
        step.on = compactOn({
          success: step.on?.success === laneKey ? undefined : step.on?.success,
          failure: step.on?.failure === laneKey ? undefined : step.on?.failure,
          blocked: step.on?.blocked === laneKey ? undefined : step.on?.blocked,
        });
      }
    }
  });

export const renameLane = (
  model: WorkflowEditorModel,
  laneKey: string,
  name: string,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.name = name;
  });

export const setLaneEntry = (
  model: WorkflowEditorModel,
  laneKey: string,
  entry: WorkflowLaneEncoded["entry"],
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.entry = entry;
  });

export const setLaneWipLimit = (
  model: WorkflowEditorModel,
  laneKey: string,
  wipLimit: number | undefined,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (wipLimit === undefined) {
      delete lane.wipLimit;
    } else {
      lane.wipLimit = wipLimit;
    }
  });

export const setLaneTerminal = (
  model: WorkflowEditorModel,
  laneKey: string,
  terminal: boolean | undefined,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (terminal === undefined) {
      delete lane.terminal;
    } else {
      lane.terminal = terminal;
    }
  });

export type LaneActionEncoded = NonNullable<WorkflowLaneEncoded["actions"]>[number];

export const addLaneAction = (model: WorkflowEditorModel, laneKey: string): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane, definition) => {
    const to = definition.lanes.find((candidate) => candidate.key !== laneKey)?.key ?? lane.key;
    lane.actions = [...(lane.actions ?? []), { label: "New action", to } as LaneActionEncoded];
  });

export const updateLaneAction = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
  patch: Partial<LaneActionEncoded>,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (index < 0 || index >= (lane.actions?.length ?? 0)) {
      return;
    }
    lane.actions = (lane.actions ?? []).map((action, candidateIndex) => {
      if (candidateIndex !== index) {
        return action;
      }
      const next = { ...action, ...patch };
      if (next.hint !== undefined && next.hint.length === 0) {
        delete next.hint;
      }
      return next;
    });
  });

export const removeLaneAction = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    const next = (lane.actions ?? []).filter((_, candidateIndex) => candidateIndex !== index);
    if (next.length === 0) {
      delete lane.actions;
    } else {
      lane.actions = next;
    }
  });

export const setLaneColor = (
  model: WorkflowEditorModel,
  laneKey: string,
  color: string | undefined,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (color === undefined) {
      delete lane.color;
    } else {
      lane.color = color;
    }
  });

type MutableAgentSelection = Extract<MutableWorkflowStep, { type: "agent" }>["agent"];

const defaultAgent = (definition: WorkflowDefinitionEncoded): MutableAgentSelection => {
  for (const lane of definition.lanes) {
    for (const step of lane.pipeline ?? []) {
      if (step.type === "agent") {
        return cloneJson(step.agent) as MutableAgentSelection;
      }
    }
  }
  return { instance: "missing-provider", model: "missing-model" };
};

const newStep = (
  definition: WorkflowDefinitionEncoded,
  type: WorkflowStepType,
): MutableWorkflowStep => {
  const key = uniqueKey(allStepKeys(definition), type);
  if (type === "agent") {
    return {
      key: StepKey.make(key),
      type,
      agent: defaultAgent(definition),
      instruction: "",
    };
  }
  if (type === "script") {
    return { key: StepKey.make(key), type, run: "true" };
  }
  if (type === "pullRequest") {
    return { key: StepKey.make(key), type, action: "open" };
  }
  return { key: StepKey.make(key), type };
};

export const addStep = (
  model: WorkflowEditorModel,
  laneKey: string,
  type: WorkflowStepType,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane, definition) => {
    lane.pipeline = [...(lane.pipeline ?? []), newStep(definition, type)];
  });

export const removeStep = (
  model: WorkflowEditorModel,
  laneKey: string,
  stepKey: string,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.pipeline = lane.pipeline?.filter((step) => step.key !== stepKey);
    if (lane.pipeline?.length === 0) {
      delete lane.pipeline;
    }
  });

export const reorderStep = (
  model: WorkflowEditorModel,
  laneKey: string,
  from: number,
  to: number,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    const pipeline = [...(lane.pipeline ?? [])];
    if (from < 0 || from >= pipeline.length || to < 0 || to >= pipeline.length) {
      return;
    }
    const [step] = pipeline.splice(from, 1);
    if (!step) {
      return;
    }
    pipeline.splice(to, 0, step);
    lane.pipeline = pipeline;
  });

const applyPatch = <T extends Record<string, unknown>>(target: T, patch: Partial<T>): T => {
  const next = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key as keyof T] = value as T[keyof T];
    }
  }
  return next;
};

export const updateStep = (
  model: WorkflowEditorModel,
  laneKey: string,
  stepKey: string,
  patch: Partial<WorkflowStepEncoded>,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.pipeline = lane.pipeline?.map((step) =>
      step.key === stepKey
        ? (applyPatch(step as Record<string, unknown>, patch) as MutableWorkflowStep)
        : step,
    );
  });

export const setLaneOn = (
  model: WorkflowEditorModel,
  laneKey: string,
  kind: LaneRoutingKind,
  targetLaneKey: string | undefined,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.on = compactOn({
      ...lane.on,
      [kind]: targetLaneKey === undefined ? undefined : LaneKey.make(targetLaneKey),
    });
  });

export const addTransition = (model: WorkflowEditorModel, laneKey: string): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane, definition) => {
    const to =
      definition.lanes.find((candidate) => candidate.key !== laneKey)?.key ?? LaneKey.make(laneKey);
    lane.transitions = [...(lane.transitions ?? []), { when: { var: "pipeline.result" }, to }];
  });

export const updateTransition = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
  patch: { readonly when?: unknown; readonly to?: string },
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (!lane.transitions?.[index]) {
      return;
    }
    const current = lane.transitions[index];
    const next: WorkflowLaneTransition = {
      when: patch.when === undefined ? current.when : patch.when,
      to: patch.to === undefined ? LaneKey.make(current.to as string) : LaneKey.make(patch.to),
    };
    lane.transitions = lane.transitions.map((transition, transitionIndex) =>
      transitionIndex === index ? next : transition,
    );
  });

export const removeTransition = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.transitions = lane.transitions?.filter((_, transitionIndex) => transitionIndex !== index);
    if (lane.transitions?.length === 0) {
      delete lane.transitions;
    }
  });

export const addLaneEvent = (model: WorkflowEditorModel, laneKey: string): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane, definition) => {
    const to =
      definition.lanes.find((candidate) => candidate.key !== laneKey)?.key ?? LaneKey.make(laneKey);
    lane.onEvent = [...(lane.onEvent ?? []), { name: "ci.passed", to }];
  });

export const updateLaneEvent = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
  patch: { readonly name?: string; readonly when?: unknown | null; readonly to?: string },
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (!lane.onEvent?.[index]) {
      return;
    }
    const current = lane.onEvent[index];
    // when: null clears the predicate; undefined keeps it.
    const when =
      patch.when === undefined ? current.when : patch.when === null ? undefined : patch.when;
    const next = {
      name: patch.name === undefined ? current.name : patch.name,
      ...(when === undefined ? {} : { when }),
      to: patch.to === undefined ? LaneKey.make(current.to as string) : LaneKey.make(patch.to),
    };
    lane.onEvent = lane.onEvent.map((event, eventIndex) => (eventIndex === index ? next : event));
  });

export const removeLaneEvent = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.onEvent = lane.onEvent?.filter((_, eventIndex) => eventIndex !== index);
    if (lane.onEvent?.length === 0) {
      delete lane.onEvent;
    }
  });
