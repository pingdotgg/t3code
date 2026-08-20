/**
 * CopilotSdkModels — map `@github/copilot-sdk` `ModelInfo` into T3 Code's
 * provider model / capability shape.
 *
 * Unlike the retired ACP probe — which advertised one session-global config
 * option set for *every* model — the SDK's `client.listModels()` reports real
 * per-model capabilities. Each model therefore gets its own tunables:
 *
 * - **Reasoning effort** from `ModelInfo.supportedReasoningEfforts` (gated by
 *   `capabilities.supports.reasoningEffort`). Applied at session/turn time via
 *   `SessionConfig.reasoningEffort` / `session.setModel(id, { reasoningEffort })`.
 * - **Context window tier** offered only when the model's billing advertises a
 *   `longContext` price tier — i.e. the model actually supports `long_context`.
 *   Applied via `SessionConfig.contextTier` / `session.setModel`. This is the
 *   lever the ACP path could never drive (the CLI only accepted `--context` as
 *   an unhonored launch flag); over the SDK it is a first-class option.
 *
 * @module provider/sdk/CopilotSdkModels
 */
import type { ModelInfo } from "@github/copilot-sdk";
import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";

/**
 * The SDK's `ReasoningEffort` / `ContextTier` string unions. Mirrored locally
 * because `@github/copilot-sdk` does not re-export the type names from its
 * package root (only the shapes that reference them). `none` is included for
 * reasoning effort because the CLI advertises it for some models even though
 * the SDK's own `ReasoningEffort` type omits it.
 */
export type CopilotReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type CopilotContextTier = "default" | "long_context";

/** ACP-independent option ids the model picker keys tunables by. */
export const COPILOT_REASONING_EFFORT_OPTION_ID = "reasoning_effort";
export const COPILOT_CONTEXT_TIER_OPTION_ID = "context_tier";

/** Reasoning efforts accepted by `SessionConfig.reasoningEffort` / `session.setModel`. */
const REASONING_EFFORT_VALUES: ReadonlyArray<CopilotReasoningEffort> = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Context tiers accepted by `SessionConfig.contextTier` / `session.setModel`. */
const CONTEXT_TIER_VALUES: ReadonlyArray<CopilotContextTier> = ["default", "long_context"];

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

function reasoningEffortLabel(effort: string): string {
  switch (effort) {
    case "none":
      return "None";
    case "xhigh":
      return "Extra high";
    default:
      return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}

/**
 * Whether the model supports the `long_context` tier. The SDK reports a
 * dedicated `longContext` billing price block for exactly those models, so its
 * presence is the authoritative gate (verified against Copilot CLI 1.0.80:
 * present on claude-sonnet-5 / gpt-5.6-terra, absent on claude-sonnet-4.5 /
 * claude-haiku-4.5).
 */
export function modelSupportsLongContext(model: ModelInfo): boolean {
  return model.billing?.tokenPrices?.longContext !== undefined;
}

function reasoningEffortChoices(
  model: ModelInfo,
): ReadonlyArray<{ value: string; label: string; isDefault?: boolean }> {
  if (!model.capabilities?.supports?.reasoningEffort) return [];
  const efforts = model.supportedReasoningEfforts ?? [];
  const seen = new Set<string>();
  const defaultEffort = model.defaultReasoningEffort;
  const choices: Array<{ value: string; label: string; isDefault?: boolean }> = [];
  for (const effort of efforts) {
    const value = String(effort).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    choices.push({
      value,
      label: reasoningEffortLabel(value),
      ...(defaultEffort !== undefined && value === defaultEffort ? { isDefault: true } : {}),
    });
  }
  return choices;
}

/**
 * Builds the per-model tunable descriptors (reasoning effort, context window)
 * surfaced in the model picker. Returns empty capabilities when the model has
 * neither lever.
 */
export function buildCopilotSdkModelCapabilities(model: ModelInfo): ModelCapabilities {
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  const effortChoices = reasoningEffortChoices(model);
  if (effortChoices.length > 0) {
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: COPILOT_REASONING_EFFORT_OPTION_ID,
        label: "Reasoning Effort",
        options: effortChoices,
        description:
          "How much reasoning effort the model spends before responding. Applied when the session starts and on the next turn after a change.",
      }),
    );
  }

  if (modelSupportsLongContext(model)) {
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: COPILOT_CONTEXT_TIER_OPTION_ID,
        label: "Context Window",
        options: [
          { value: "default", label: "Default", isDefault: true },
          { value: "long_context", label: "Long context" },
        ],
        description:
          "Context window tier. `Long context` unlocks the model's extended context window (higher token limits, different billing). Takes effect on the next new chat.",
      }),
    );
  }

  if (optionDescriptors.length === 0) return EMPTY_CAPABILITIES;
  return createModelCapabilities({ optionDescriptors });
}

/**
 * Maps `client.listModels()` output into `ServerProviderModel`s with per-model
 * capabilities. Models whose policy is explicitly `disabled` are skipped.
 */
export function buildCopilotSdkModels(
  models: ReadonlyArray<ModelInfo> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!models || models.length === 0) return [];
  const seen = new Set<string>();
  const result: ServerProviderModel[] = [];
  for (const model of models) {
    const slug = model.id?.trim();
    if (!slug || seen.has(slug)) continue;
    if (model.policy?.state === "disabled") continue;
    seen.add(slug);
    result.push({
      slug,
      name: model.name?.trim() || slug,
      isCustom: false,
      capabilities: buildCopilotSdkModelCapabilities(model),
    });
  }
  return result;
}

export interface CopilotSdkSessionTunables {
  readonly reasoningEffort?: CopilotReasoningEffort;
  readonly contextTier?: CopilotContextTier;
}

/**
 * Extracts the reasoning-effort / context-tier selections a user made in the
 * model picker, to feed into `createSession` / `session.setModel`. Selection
 * ids are the option ids above verbatim, so this is a lookup + validation;
 * unknown or malformed values are dropped so the SDK never receives an invalid
 * tunable.
 */
export function resolveCopilotSdkTunables(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): CopilotSdkSessionTunables {
  if (!selections || selections.length === 0) return {};
  const tunables: { reasoningEffort?: CopilotReasoningEffort; contextTier?: CopilotContextTier } =
    {};
  for (const selection of selections) {
    const id = selection.id.trim();
    const value =
      typeof selection.value === "boolean" ? String(selection.value) : selection.value.trim();
    if (!value) continue;
    if (
      id === COPILOT_REASONING_EFFORT_OPTION_ID &&
      (REASONING_EFFORT_VALUES as ReadonlyArray<string>).includes(value)
    ) {
      tunables.reasoningEffort = value as CopilotReasoningEffort;
    } else if (
      id === COPILOT_CONTEXT_TIER_OPTION_ID &&
      (CONTEXT_TIER_VALUES as ReadonlyArray<string>).includes(value)
    ) {
      tunables.contextTier = value as CopilotContextTier;
    }
  }
  return tunables;
}
