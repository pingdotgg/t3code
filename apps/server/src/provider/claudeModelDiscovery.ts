/**
 * claudeModelDiscovery — dynamic Claude model detection.
 *
 * The Claude Agent SDK initialization result (`query().initializationResult()`)
 * carries a `models` array describing every model the installed Claude Code
 * CLI supports, including effort levels and fast-mode support. Parsing that
 * list lets the server surface newly released models (e.g. a new Opus) in the
 * UI without waiting for a hardcoded list update.
 *
 * The discovered list is merged with the curated built-in list in
 * `ClaudeProvider.checkClaudeProviderStatus`: built-ins keep their curated
 * capabilities, and discovered-only models are appended with capabilities
 * derived from the CLI-reported metadata.
 *
 * @module provider/claudeModelDiscovery
 */
import { type ModelCapabilities, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  mergeProviderModels,
} from "./providerSnapshot.ts";

/**
 * Model aliases reported by the Claude Code CLI (`sonnet`, `haiku`, …),
 * curated against the built-in model list. Discovery always normalizes
 * through this table so picker aliases resolve to the same canonical slugs
 * as the built-in list and dedupe against it.
 */
const CLAUDE_MODEL_SLUG_ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  "opus-5": "claude-opus-5",
  "claude-opus-5": "claude-opus-5",
  "opus-4.8": "claude-opus-4-8",
  "claude-opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "claude-opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4-6-20251117": "claude-opus-4-6",
  fable: "claude-fable-5",
  "fable-5": "claude-fable-5",
  sonnet: "claude-sonnet-5",
  "sonnet-5": "claude-sonnet-5",
  "claude-sonnet-5.0": "claude-sonnet-5",
  "claude-sonnet-5-0": "claude-sonnet-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  "haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
};

/**
 * Picker entries reported by the CLI that are not concrete models. `default`
 * follows whatever the CLI recommends and `auto` lets the CLI choose; neither
 * should appear as a selectable model.
 */
const NON_MODEL_PICKER_VALUES = new Set(["default", "auto", "best"]);

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];
const CLAUDE_EFFORT_LEVEL_SET: ReadonlySet<string> = new Set(CLAUDE_EFFORT_LEVELS);

const CLAUDE_EFFORT_LABELS: Record<ClaudeEffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * Runtime-validated subset of the SDK's `ModelInfo` shape. The SDK types this
 * field, but the data comes from the installed CLI over IPC, so older (or
 * newer) CLIs may omit or extend it — everything is validated defensively.
 */
interface ClaudeSdkModelEntry {
  readonly value: string;
  readonly displayName?: string | undefined;
  readonly supportsEffort?: boolean | undefined;
  readonly supportedEffortLevels?: ReadonlyArray<ClaudeEffortLevel> | undefined;
  readonly supportsFastMode?: boolean | undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseClaudeSdkModelEntry(raw: unknown): ClaudeSdkModelEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const value = nonEmptyString(record.value);
  if (!value) return undefined;

  const supportedEffortLevels = globalThis.Array.isArray(record.supportedEffortLevels)
    ? record.supportedEffortLevels.filter(
        (level): level is ClaudeEffortLevel =>
          typeof level === "string" && CLAUDE_EFFORT_LEVEL_SET.has(level),
      )
    : undefined;

  return {
    value,
    displayName: nonEmptyString(record.displayName),
    supportsEffort: typeof record.supportsEffort === "boolean" ? record.supportsEffort : undefined,
    ...(supportedEffortLevels && supportedEffortLevels.length > 0 ? { supportedEffortLevels } : {}),
    supportsFastMode:
      typeof record.supportsFastMode === "boolean" ? record.supportsFastMode : undefined,
  };
}

function buildDiscoveredModelCapabilities(input: {
  readonly entry: ClaudeSdkModelEntry;
  readonly supportsLongContext: boolean;
}): ModelCapabilities {
  const { entry, supportsLongContext } = input;
  const optionDescriptors = [];

  if (entry.supportsEffort === true) {
    const levels = entry.supportedEffortLevels ?? CLAUDE_EFFORT_LEVELS;
    const defaultEffort = levels.includes("high") ? "high" : (levels.at(-1) ?? "high");
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: "effort",
        label: "Reasoning",
        options: levels.map((level) => ({
          value: level,
          label: CLAUDE_EFFORT_LABELS[level],
          ...(level === defaultEffort ? { isDefault: true } : {}),
        })),
      }),
    );
  }

  if (entry.supportsFastMode === true) {
    optionDescriptors.push(
      buildBooleanOptionDescriptor({
        id: "fastMode",
        label: "Fast Mode",
      }),
    );
  }

  if (supportsLongContext) {
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: "contextWindow",
        label: "Context Window",
        options: [
          { value: "200k", label: "200k", isDefault: true },
          { value: "1m", label: "1M" },
        ],
      }),
    );
  }

  return createModelCapabilities({ optionDescriptors });
}

/**
 * Parse the raw `models` array from a Claude SDK initialization result into
 * provider models.
 *
 * The CLI reports a mix of picker aliases (`default`, `sonnet`), full model
 * ids (`claude-fable-5`), and long-context variants (`claude-fable-5[1m]`).
 * Non-model picker entries are dropped, `[...]` suffixes are stripped (and
 * recorded as long-context support), and aliases are normalized through the
 * curated Claude alias map so they dedupe against the built-in list.
 *
 * Note: brand-new models surface here via their full model id (one way the
 * CLI lists newly released flagships) or through picker aliases such as
 * `opus`, which the curated alias map keeps pointed at the latest slug.
 * Alias entries that still resolve to an older built-in slug are deduped
 * away.
 */
export function parseClaudeSdkDiscoveredModels(raw: unknown): ReadonlyArray<ServerProviderModel> {
  if (!globalThis.Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const candidate of raw) {
    const entry = parseClaudeSdkModelEntry(candidate);
    if (!entry) continue;

    const supportsLongContext = entry.value.includes("[");
    const baseValue = (
      supportsLongContext ? (entry.value.split("[", 1)[0] ?? entry.value) : entry.value
    ).trim();
    if (NON_MODEL_PICKER_VALUES.has(baseValue.toLowerCase())) continue;

    const slug = CLAUDE_MODEL_SLUG_ALIASES[baseValue] ?? baseValue;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    models.push({
      slug,
      name: entry.displayName ?? slug,
      isCustom: false,
      capabilities: buildDiscoveredModelCapabilities({ entry, supportsLongContext }),
    });
  }
  return models;
}

/**
 * Merge discovered models into the built-in list. Built-ins keep their order
 * and curated capabilities; discovered models whose slug is not already
 * covered are appended in CLI-reported order.
 */
export function mergeClaudeDiscoveredModels(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  discoveredModels: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return mergeProviderModels(builtInModels, discoveredModels);
}

/**
 * Process-wide lookup of capabilities for discovered models.
 *
 * Runtime capability lookups (`getClaudeModelCapabilities` in ClaudeProvider)
 * are synchronous slug-only calls shared by the adapter and text generation,
 * so they cannot reach the provider snapshot that carries discovery results.
 * The snapshot probe registers each discovered model's capabilities here on
 * every refresh, keeping session-start behavior (effort, fast mode) in sync
 * with what the UI offered.
 */
const discoveredCapabilitiesBySlug = new Map<string, ModelCapabilities>();

export function registerClaudeDiscoveredModels(
  discoveredModels: ReadonlyArray<ServerProviderModel>,
): void {
  discoveredCapabilitiesBySlug.clear();
  for (const model of discoveredModels) {
    if (model.capabilities) {
      discoveredCapabilitiesBySlug.set(model.slug, model.capabilities);
    }
  }
}

export function getClaudeDiscoveredModelCapabilities(
  model: string | null | undefined,
): ModelCapabilities | undefined {
  const slug = model?.trim();
  if (!slug) return undefined;
  return discoveredCapabilitiesBySlug.get(slug);
}
