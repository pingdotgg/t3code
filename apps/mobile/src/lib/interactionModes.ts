import type { MenuAction } from "@react-native-menu/menu";
import {
  DEFAULT_EXECUTOR_MAX_SUB_AGENTS,
  EXECUTOR_MAX_SUB_AGENTS_MAX,
  EXECUTOR_MAX_SUB_AGENTS_MIN,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

import type { ModelOption } from "./modelOptions";

/**
 * Presentation for the composer's interaction-mode and runtime-mode menus,
 * shared by the thread composer and the new-task draft screen so both offer
 * the same modes with the same copy. Mirrors the macOS composer's
 * `ThreadInteractionMode` / `RuntimeMode` labels.
 */

export const INTERACTION_MODES: ReadonlyArray<ProviderInteractionMode> = [
  "default",
  "plan",
  "advisor",
];

const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Default",
  plan: "Plan",
  advisor: "Advisor/Planner",
};

const INTERACTION_MODE_DETAILS: Record<ProviderInteractionMode, string> = {
  default: "The agent does the work.",
  plan: "The agent proposes a plan instead of editing.",
  advisor:
    "The agent plans and advises rather than editing itself. With an executor model configured it delegates implementation to sub-agents on that model; otherwise it advises only.",
};

export function interactionModeLabel(mode: ProviderInteractionMode): string {
  return INTERACTION_MODE_LABELS[mode];
}

export function interactionModeDetail(mode: ProviderInteractionMode): string {
  return INTERACTION_MODE_DETAILS[mode];
}

export const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Approve actions",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export function runtimeModeLabel(mode: RuntimeMode): string {
  return RUNTIME_MODE_LABELS[mode];
}

/** Menu id prefix for interaction-mode rows, e.g. `options:interaction:plan`. */
export const INTERACTION_MENU_PREFIX = "options:interaction:";
/** Menu id prefix for runtime-mode rows, e.g. `options:runtime:auto`. */
export const RUNTIME_MENU_PREFIX = "options:runtime:";
/** Menu id prefix for advisor executor-model rows, e.g. `options:executor:acme:gpt`. */
export const EXECUTOR_MENU_PREFIX = "options:executor:";
/** Menu id clearing the advisor executor binding (advise-only). */
export const EXECUTOR_MENU_CLEAR_ID = "options:executor-clear";
/** Menu id prefix for the advisor sub-agent cap, e.g. `options:sub-agents:3`. */
export const SUB_AGENTS_MENU_PREFIX = "options:sub-agents:";

export function buildRuntimeModeMenuAction(current: RuntimeMode): MenuAction {
  return {
    id: "options-runtime",
    title: "Runtime",
    subtitle: runtimeModeLabel(current),
    subactions: RUNTIME_MODES.map((mode) => ({
      id: `${RUNTIME_MENU_PREFIX}${mode}`,
      title: runtimeModeLabel(mode),
      state: current === mode ? ("on" as const) : undefined,
    })),
  };
}

export function buildInteractionModeMenuAction(current: ProviderInteractionMode): MenuAction {
  return {
    id: "options-interaction",
    title: "Interaction",
    subtitle: interactionModeLabel(current),
    subactions: INTERACTION_MODES.map((mode) => ({
      id: `${INTERACTION_MENU_PREFIX}${mode}`,
      title: interactionModeLabel(mode),
      state: current === mode ? ("on" as const) : undefined,
    })),
  };
}

/**
 * Advisor-only submenus: which model delegated sub-agents run on, and how many
 * may run at once. The sub-agent cap is only meaningful once an executor is
 * bound, matching the macOS composer where the slider appears with the model.
 */
export function buildAdvisorMenuActions(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly executorModelSelection: ModelSelection | null;
  readonly executorMaxSubAgents: number;
  readonly modelOptions: ReadonlyArray<ModelOption>;
}): MenuAction[] {
  if (input.interactionMode !== "advisor") {
    return [];
  }

  const selected = input.executorModelSelection;
  const actions: MenuAction[] = [
    {
      id: "options-executor",
      title: "Executor model",
      subtitle: executorModelLabel(selected, input.modelOptions),
      subactions: [
        {
          id: EXECUTOR_MENU_CLEAR_ID,
          title: "None — advise only",
          state: selected === null ? ("on" as const) : undefined,
        },
        ...input.modelOptions.map((option) => ({
          id: `${EXECUTOR_MENU_PREFIX}${option.key}`,
          title: option.label,
          subtitle: option.subtitle,
          state:
            selected !== null &&
            selected.instanceId === option.selection.instanceId &&
            selected.model === option.selection.model
              ? ("on" as const)
              : undefined,
        })),
      ],
    },
  ];

  if (selected !== null) {
    const cap = clampMaxSubAgents(input.executorMaxSubAgents);
    actions.push({
      id: "options-sub-agents",
      title: "Max sub-agents",
      subtitle: String(cap),
      subactions: subAgentChoices().map((value) => ({
        id: `${SUB_AGENTS_MENU_PREFIX}${value}`,
        title: String(value),
        state: cap === value ? ("on" as const) : undefined,
      })),
    });
  }

  return actions;
}

/** Display name for the bound executor model, falling back to its raw slug. */
export function executorModelLabel(
  selection: ModelSelection | null,
  modelOptions: ReadonlyArray<ModelOption>,
): string {
  if (selection === null) {
    return "None — advise only";
  }
  const option = modelOptions.find(
    (candidate) =>
      candidate.selection.instanceId === selection.instanceId &&
      candidate.selection.model === selection.model,
  );
  return option?.label ?? selection.model;
}

export function subAgentChoices(): ReadonlyArray<number> {
  const choices: number[] = [];
  for (let value = EXECUTOR_MAX_SUB_AGENTS_MIN; value <= EXECUTOR_MAX_SUB_AGENTS_MAX; value += 1) {
    choices.push(value);
  }
  return choices;
}

/**
 * Keeps a cap inside the contract's bounds. Threads that predate the field
 * decode as the default, but a hand-edited or future payload should still land
 * on a value the `thread.executor-model.set` command will accept.
 */
export function clampMaxSubAgents(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_EXECUTOR_MAX_SUB_AGENTS;
  }
  const rounded = Math.round(value);
  if (rounded < EXECUTOR_MAX_SUB_AGENTS_MIN) return EXECUTOR_MAX_SUB_AGENTS_MIN;
  if (rounded > EXECUTOR_MAX_SUB_AGENTS_MAX) return EXECUTOR_MAX_SUB_AGENTS_MAX;
  return rounded;
}

export type AdvisorMenuEvent =
  | { readonly kind: "interaction-mode"; readonly interactionMode: ProviderInteractionMode }
  | { readonly kind: "runtime-mode"; readonly runtimeMode: RuntimeMode }
  | { readonly kind: "executor-model"; readonly modelKey: string | null }
  | { readonly kind: "max-sub-agents"; readonly maxSubAgents: number };

/**
 * Decodes a native menu event id into the composer action it stands for.
 * Returns null for ids this module does not own (provider options, etc.), so
 * callers can keep handling those themselves.
 */
export function parseComposerMenuEvent(event: string): AdvisorMenuEvent | null {
  if (event === EXECUTOR_MENU_CLEAR_ID) {
    return { kind: "executor-model", modelKey: null };
  }
  if (event.startsWith(EXECUTOR_MENU_PREFIX)) {
    return { kind: "executor-model", modelKey: event.slice(EXECUTOR_MENU_PREFIX.length) };
  }
  if (event.startsWith(SUB_AGENTS_MENU_PREFIX)) {
    const parsed = Number.parseInt(event.slice(SUB_AGENTS_MENU_PREFIX.length), 10);
    if (Number.isNaN(parsed)) {
      return null;
    }
    return { kind: "max-sub-agents", maxSubAgents: clampMaxSubAgents(parsed) };
  }
  if (event.startsWith(RUNTIME_MENU_PREFIX)) {
    const value = event.slice(RUNTIME_MENU_PREFIX.length);
    const runtimeMode = RUNTIME_MODES.find((mode) => mode === value);
    return runtimeMode ? { kind: "runtime-mode", runtimeMode } : null;
  }
  if (event.startsWith(INTERACTION_MENU_PREFIX)) {
    const value = event.slice(INTERACTION_MENU_PREFIX.length);
    const interactionMode = INTERACTION_MODES.find((mode) => mode === value);
    return interactionMode ? { kind: "interaction-mode", interactionMode } : null;
  }
  return null;
}
