/**
 * Vendored Aether platform catalog (codex + claude-code families).
 *
 * Ported from the Aether monorepo's generated
 * `packages/domain-types/src/generated/platform-catalog.ts` — see the README
 * in this directory for the sync recipe. Aether exposes no runtime catalog
 * endpoint, so the driver compiles this knowledge in and it goes stale until
 * the next sync.
 *
 * @module provider/Layers/aether/vendored/catalog
 */

export interface AetherCatalogModel {
  readonly slug: string;
  readonly name: string;
  readonly runtimeModel: string;
}

export interface AetherCatalogAgent {
  readonly label: string;
  readonly defaultModel: string;
  readonly models: ReadonlyArray<AetherCatalogModel>;
}

export interface AetherReasoningEffortGroup {
  readonly default: string;
  readonly options: ReadonlyArray<string>;
  readonly selectableOptions: ReadonlyArray<string>;
  readonly modelOptions: ReadonlyArray<{
    readonly models: ReadonlyArray<string>;
    readonly options: ReadonlyArray<string>;
  }>;
}

export const AETHER_AGENT_TYPES = ["codex", "claude-code"] as const;
export type AetherAgentType = (typeof AETHER_AGENT_TYPES)[number];

export const AETHER_DEFAULT_AGENT_TYPE: AetherAgentType = "codex";

export const AETHER_PLATFORM_CATALOG: {
  readonly agents: Record<AetherAgentType, AetherCatalogAgent>;
  readonly reasoningEffort: Record<AetherAgentType, AetherReasoningEffortGroup>;
} = {
  agents: {
    codex: {
      label: "Codex",
      defaultModel: "gpt-5.6-sol",
      models: [
        { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", runtimeModel: "gpt-5.6-sol" },
        { slug: "gpt-5.6-terra", name: "GPT-5.6 Terra", runtimeModel: "gpt-5.6-terra" },
        { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna", runtimeModel: "gpt-5.6-luna" },
        { slug: "gpt-5.5", name: "GPT-5.5", runtimeModel: "gpt-5.5" },
        { slug: "gpt-5.4", name: "GPT-5.4", runtimeModel: "gpt-5.4" },
        { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini", runtimeModel: "gpt-5.4-mini" },
        {
          slug: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          runtimeModel: "gpt-5.3-codex-spark",
        },
      ],
    },
    "claude-code": {
      label: "Claude Code",
      defaultModel: "claude-opus-5",
      models: [
        { slug: "claude-fable-5", name: "Claude Fable 5", runtimeModel: "claude-fable-5" },
        { slug: "claude-sonnet-5", name: "Claude Sonnet 5", runtimeModel: "claude-sonnet-5" },
        { slug: "claude-opus-5", name: "Claude Opus 5", runtimeModel: "claude-opus-5" },
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", runtimeModel: "claude-sonnet-4-6" },
        { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", runtimeModel: "claude-haiku-4-5" },
      ],
    },
  },
  reasoningEffort: {
    codex: {
      default: "xhigh",
      options: ["ultra", "max", "xhigh", "high", "medium", "low"],
      selectableOptions: ["ultra", "max", "xhigh", "high", "medium", "low"],
      modelOptions: [
        {
          models: ["gpt-5.6-sol", "gpt-5.6-terra"],
          options: ["ultra", "max", "xhigh", "high", "medium", "low"],
        },
        {
          models: ["gpt-5.6-luna"],
          options: ["max", "xhigh", "high", "medium", "low"],
        },
        {
          models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
          options: ["xhigh", "high", "medium", "low"],
        },
      ],
    },
    "claude-code": {
      default: "xhigh",
      options: ["low", "medium", "high", "xhigh", "max", "ultrathink", "ultracode"],
      selectableOptions: ["low", "medium", "high", "xhigh", "max", "ultrathink", "ultracode"],
      modelOptions: [
        {
          models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
          options: ["low", "medium", "high", "xhigh", "max", "ultrathink", "ultracode"],
        },
        {
          models: ["claude-sonnet-4-6"],
          options: ["low", "medium", "high", "ultrathink"],
        },
      ],
    },
  },
};

/**
 * Reasoning-effort choices offered for one catalog model, mirroring the Aether
 * source of truth (`domain-types/src/model.ts` `resolveSelectableEfforts` and
 * Go `catalog.ReasoningEffortSelectableOptions`): when `modelOptions` groups
 * exist, a model in NO group gets NO efforts — the Aether API rejects any
 * `reasoning_effort` for such models. Otherwise the agent-wide `options`
 * apply. The result is intersected with `selectableOptions` — Aether rejects
 * non-selectable values too, so only selectable efforts may ever be surfaced
 * to the picker.
 */
export function reasoningEffortsForModel(
  agentType: AetherAgentType,
  modelSlug: string,
): ReadonlyArray<string> {
  const group = AETHER_PLATFORM_CATALOG.reasoningEffort[agentType];
  const modelGroup = group.modelOptions.find((entry) => entry.models.includes(modelSlug));
  const options = group.modelOptions.length > 0 ? (modelGroup?.options ?? []) : group.options;
  const selectable = new Set(group.selectableOptions);
  return options.filter((option) => selectable.has(option));
}

/** The default reasoning effort for one catalog model, constrained to its selectable set. */
export function defaultReasoningEffortForModel(
  agentType: AetherAgentType,
  modelSlug: string,
): string | undefined {
  const group = AETHER_PLATFORM_CATALOG.reasoningEffort[agentType];
  const efforts = reasoningEffortsForModel(agentType, modelSlug);
  return efforts.includes(group.default) ? group.default : efforts[0];
}
