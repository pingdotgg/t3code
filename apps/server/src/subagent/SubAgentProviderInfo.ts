import * as Schema from "effect/Schema";
import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";

export const MODEL_COST_TIERS: Record<string, "cheap" | "moderate" | "expensive"> = {
  // Cheap: 30 concurrent
  "claude-haiku-4.5": "cheap",
  "claude-haiku-4": "cheap",
  "gpt-4o-mini": "cheap",
  "gpt-4-turbo": "cheap",

  // Moderate: 10 concurrent
  "claude-sonnet-5": "moderate",
  "claude-sonnet-4": "moderate",
  "gpt-4o": "moderate",
  "gpt-4": "moderate",

  // Expensive: 5 concurrent
  "claude-fable-5": "expensive",
  "claude-opus-4.8": "expensive",
  "claude-opus-4": "expensive",
  "gpt-5.5": "expensive",
  "gpt-5": "expensive",
};

export const CONCURRENCY_LIMITS = {
  cheap: 30,
  moderate: 10,
  expensive: 5,
  global: 50,
} as const;

export const PROVIDER_COST_TIERS: Record<string, "free" | "subscription" | "api-credits"> = {
  codex: "subscription",
  claudeAgent: "subscription",
  claudeSynthero: "subscription",
  claudex: "subscription",
  grok: "subscription",
  fugu: "subscription",
  opencode: "api-credits", // EXCLUDED from sub-agents
  chatgpt: "subscription",
};

export const SubAgentModelInfo = Schema.Struct({
  slug: Schema.String,
  displayName: Schema.String,
  contextWindow: Schema.optional(Schema.Int),
  supportedOptions: Schema.Array(Schema.String),
  costTier: Schema.Literals(["cheap", "moderate", "expensive"]),
  concurrencyLimit: Schema.Int,
});
export type SubAgentModelInfo = typeof SubAgentModelInfo.Type;

export const SubAgentProviderInfo = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.String,
  status: Schema.Literals(["available", "unavailable", "disabled", "error"]),
  spawnable: Schema.Boolean,
  capabilities: Schema.Struct({
    supportsSubAgents: Schema.Boolean,
    maxConcurrentSubAgents: Schema.Int,
  }),
  models: Schema.Array(SubAgentModelInfo),
  costTier: Schema.Literals(["free", "subscription", "api-credits"]),
});
export type SubAgentProviderInfo = typeof SubAgentProviderInfo.Type;

export const SubAgentProviderFilter = Schema.Struct({
  excludeApiCredits: Schema.optional(Schema.Boolean),
  requireSubscription: Schema.optional(Schema.Boolean),
  requireAvailable: Schema.optional(Schema.Boolean),
  driverKinds: Schema.optional(Schema.Array(ProviderDriverKind)),
});
export type SubAgentProviderFilter = typeof SubAgentProviderFilter.Type;

export function getModelCostTier(modelSlug: string): "cheap" | "moderate" | "expensive" {
  const normalized = modelSlug.toLowerCase().trim();
  return MODEL_COST_TIERS[normalized] ?? "moderate";
}

export function getProviderCostTier(driverKind: string): "free" | "subscription" | "api-credits" {
  const normalized = driverKind.toLowerCase().trim();
  return PROVIDER_COST_TIERS[normalized] ?? "subscription";
}

export function isSpawnableProvider(
  status: SubAgentProviderInfo["status"],
  costTier: SubAgentProviderInfo["costTier"],
  excludeApiCredits: boolean = true,
): boolean {
  if (excludeApiCredits && costTier === "api-credits") {
    return false;
  }
  return status === "available";
}
