import type { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

import type { OrchestrationThread } from "./connection.ts";

// Friendly labels for the composer controls, mirroring the web composer's toolbar
// (apps/web/src/components/chat/ChatComposer.tsx runtimeModeConfig + the plan/build
// toggle). Kept in one place so the controls row, the pickers, and the footer all
// read the same names.

export const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];

export interface RuntimeModeMeta {
  readonly label: string;
  readonly description: string;
  readonly glyph: string;
}

export const RUNTIME_MODE_META: Record<RuntimeMode, RuntimeModeMeta> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    glyph: "⊘",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    glyph: "✎",
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    glyph: "⊙",
  },
};

export function runtimeModeLabel(mode: RuntimeMode): string {
  return RUNTIME_MODE_META[mode]?.label ?? mode;
}

export function interactionModeLabel(mode: ProviderInteractionMode): string {
  return mode === "plan" ? "Plan" : "Build";
}

// The web stores reasoning under a couple of option ids depending on the provider
// (apps/web TraitsPicker); read any of them.
const REASONING_OPTION_IDS = new Set(["reasoningEffort", "effort", "reasoning"]);

type ModelSelectionLike = ModelSelection | null | undefined;

/** The chosen reasoning effort on a model selection, or null. */
export function getReasoningEffort(selection: ModelSelectionLike): string | null {
  const options = selection?.options;
  if (!Array.isArray(options)) return null;
  const match = options.find(
    (option) => REASONING_OPTION_IDS.has(option.id) && typeof option.value === "string",
  );
  return match ? (match.value as string) : null;
}

export interface ComposerControls {
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | null;
  readonly reasoning: string | null;
}

/** The current composer state to render as chips, derived from the thread. */
export function composerControls(
  detail: OrchestrationThread | null,
  modelSelection: ModelSelectionLike = detail?.modelSelection,
  resolvedReasoning?: string | null,
): ComposerControls {
  return {
    interactionMode: detail?.interactionMode ?? "default",
    runtimeMode: detail?.runtimeMode ?? "full-access",
    model: modelSelection?.model ?? null,
    reasoning: resolvedReasoning ?? getReasoningEffort(modelSelection),
  };
}
