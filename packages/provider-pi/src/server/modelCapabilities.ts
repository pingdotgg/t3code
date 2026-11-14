import {
  type ModelCapabilities,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Predicate from "effect/Predicate";

// xhigh/max require per-model thinkingLevelMap opt-in; global advertising makes set_thinking_level fail.
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const PI_THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const EMPTY_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** Selecting Standard sends no `service_tier`, leaving the endpoint's default. */
export const PI_STANDARD_SERVICE_TIER = "default";

export function piModelCapabilities(
  model: unknown,
  defaultThinkingLevel: unknown,
): ModelCapabilities {
  const optionDescriptors = [
    thinkingDescriptor(model, defaultThinkingLevel),
    serviceTierDescriptor(model),
  ].filter(Predicate.isNotUndefined);
  return optionDescriptors.length === 0
    ? EMPTY_PI_MODEL_CAPABILITIES
    : createModelCapabilities({ optionDescriptors });
}

function thinkingDescriptor(
  model: unknown,
  defaultThinkingLevel: unknown,
): ProviderOptionDescriptor | undefined {
  const levels = supportedPiThinkingLevelsFromModel(model);
  if (levels.length === 0) return undefined;
  const defaultLevel = clampPiThinkingLevel(defaultThinkingLevel, levels);
  return {
    id: "thinking",
    label: "Thinking",
    type: "select",
    options: levels.map((level): ProviderOptionChoice => ({
      id: level,
      label: PI_THINKING_LEVEL_LABELS[level],
      ...(level === defaultLevel ? { isDefault: true } : {}),
    })),
  };
}

// Pi has no service tier concept; provider extensions advertise `serviceTiers` on a model,
// and T3's injected extension sends the chosen id as the request's `service_tier`.
function serviceTierDescriptor(model: unknown): ProviderOptionDescriptor | undefined {
  const tiers = recordField(model, "serviceTiers");
  if (!Array.isArray(tiers)) return undefined;
  const seen = new Set<string>([PI_STANDARD_SERVICE_TIER]);
  const options: Array<ProviderOptionChoice> = [];
  for (const tier of tiers) {
    const id = recordField(tier, "id");
    if (typeof id !== "string" || id.trim() === "" || seen.has(id)) continue;
    seen.add(id);
    const name = recordField(tier, "name");
    const description = recordField(tier, "description");
    options.push({
      id,
      label: typeof name === "string" && name.trim() !== "" ? name : id,
      ...(typeof description === "string" && description.trim() !== "" ? { description } : {}),
    });
  }
  if (options.length === 0) return undefined;
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [{ id: PI_STANDARD_SERVICE_TIER, label: "Standard", isDefault: true }, ...options],
    currentValue: PI_STANDARD_SERVICE_TIER,
  };
}

function clampPiThinkingLevel(
  input: unknown,
  availableLevels: ReadonlyArray<PiThinkingLevel>,
): PiThinkingLevel | undefined {
  if (typeof input !== "string") return undefined;
  const requestedIndex = PI_THINKING_LEVELS.findIndex((level) => level === input);
  if (requestedIndex === -1) return undefined;
  const exact = availableLevels.find((level) => level === input);
  if (exact !== undefined) return exact;
  for (let index = requestedIndex + 1; index < PI_THINKING_LEVELS.length; index += 1) {
    const higher = availableLevels.find((level) => level === PI_THINKING_LEVELS[index]);
    if (higher !== undefined) return higher;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const lower = availableLevels.find((level) => level === PI_THINKING_LEVELS[index]);
    if (lower !== undefined) return lower;
  }
  return availableLevels[0];
}

function supportedPiThinkingLevelsFromModel(model: unknown): ReadonlyArray<PiThinkingLevel> {
  if (recordField(model, "reasoning") !== true) return [];
  const thinkingLevelMap = thinkingLevelMapFromModel(model);
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function thinkingLevelMapFromModel(model: unknown): Record<string, unknown> | undefined {
  const value = recordField(model, "thinkingLevelMap");
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function recordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}
