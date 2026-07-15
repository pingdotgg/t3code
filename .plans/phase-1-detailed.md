# Phase 1: Detailed Step-by-Step Implementation

## Step 1: Create Directory Structure
```bash
mkdir -p apps/server/src/subagent/__tests__
```

## Step 2: Create SubAgentError.ts

File: `apps/server/src/subagent/SubAgentError.ts`

```typescript
import * as Schema from "effect/Schema";

export class SubAgentError extends Schema.TaggedError<SubAgentError>()(
  "SubAgentError",
  {
    reason: Schema.Literals([
      "provider-not-found",
      "provider-not-spawnable",
      "model-not-found",
      "concurrency-limit-exceeded",
      "thread-not-found",
      "invalid-status",
      "dispatch-failed",
      "capability-unavailable",
      "depth-limit-exceeded",
      "caller-thread-not-found",
      "model-not-resolved",
    ]),
    description: Schema.String,
  },
) {}
```

## Step 3: Create SubAgentProviderInfo.ts

File: `apps/server/src/subagent/SubAgentProviderInfo.ts`

```typescript
import * as Schema from "effect/Schema";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

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
  cursor: "subscription",
  grok: "subscription",
  fugu: "subscription",
  opencode: "api-credits", // EXCLUDED
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
```

## Step 4: Create ConcurrencyLimits.ts

File: `apps/server/src/subagent/ConcurrencyLimits.ts`

```typescript
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { CONCURRENCY_LIMITS, getModelCostTier } from "./SubAgentProviderInfo.ts";
import { SubAgentError } from "./SubAgentError.ts";

interface ActiveSubAgent {
  readonly threadId: string;
  readonly provider: ProviderInstanceId;
  readonly model: string;
  readonly startedAt: string;
}

export interface ConcurrencyLimitsShape {
  readonly checkCanSpawn: (
    provider: ProviderInstanceId,
    model: string,
  ) => Effect.Effect<void, SubAgentError>;
  
  readonly registerSpawn: (
    threadId: string,
    provider: ProviderInstanceId,
    model: string,
  ) => Effect.Effect<void>;
  
  readonly unregisterSpawn: (threadId: string) => Effect.Effect<void>;
  
  readonly getActiveCount: (model?: string) => Effect.Effect<number>;
}

export class ConcurrencyLimits extends Context.Service<
  ConcurrencyLimits,
  ConcurrencyLimitsShape
>()("t3/subagent/ConcurrencyLimits") {}

const makeConcurrencyLimits = Effect.gen(function* () {
  const active = yield* SynchronizedRef.make<ReadonlyMap<string, ActiveSubAgent>>(new Map());

  const checkCanSpawn: ConcurrencyLimitsShape["checkCanSpawn"] = (provider, model) =>
    Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(active);
      const totalActive = current.size;
      
      // Check global limit
      if (totalActive >= CONCURRENCY_LIMITS.global) {
        return yield* new SubAgentError({
          reason: "concurrency-limit-exceeded",
          description: `Global sub-agent limit reached (${totalActive}/${CONCURRENCY_LIMITS.global}). Wait for existing sub-agents to complete.`,
        });
      }
      
      // Check per-model limit
      const costTier = getModelCostTier(model);
      const modelLimit = CONCURRENCY_LIMITS[costTier];
      const modelActive = Array.from(current.values()).filter(
        (agent) => agent.model.toLowerCase() === model.toLowerCase(),
      ).length;
      
      if (modelActive >= modelLimit) {
        return yield* new SubAgentError({
          reason: "concurrency-limit-exceeded",
          description: `Model ${model} limit reached (${modelActive}/${modelLimit}). This is a ${costTier} model with restricted concurrency.`,
        });
      }
    });

  const registerSpawn: ConcurrencyLimitsShape["registerSpawn"] = (threadId, provider, model) =>
    SynchronizedRef.update(active, (current) => {
      const next = new Map(current);
      next.set(threadId, {
        threadId,
        provider,
        model,
        startedAt: new Date().toISOString(),
      });
      return next;
    });

  const unregisterSpawn: ConcurrencyLimitsShape["unregisterSpawn"] = (threadId) =>
    SynchronizedRef.update(active, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });

  const getActiveCount: ConcurrencyLimitsShape["getActiveCount"] = (model) =>
    Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(active);
      if (!model) {
        return current.size;
      }
      return Array.from(current.values()).filter(
        (agent) => agent.model.toLowerCase() === model.toLowerCase(),
      ).length;
    });

  return ConcurrencyLimits.of({
    checkCanSpawn,
    registerSpawn,
    unregisterSpawn,
    getActiveCount,
  });
});

export const ConcurrencyLimitsLive = Layer.effect(ConcurrencyLimits, makeConcurrencyLimits);
```

## Step 5: Create SubAgentProviderRegistry.ts

File: `apps/server/src/subagent/SubAgentProviderRegistry.ts`

```typescript
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ServerProvider } from "@t3tools/contracts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import type {
  SubAgentProviderInfo,
  SubAgentProviderFilter,
  SubAgentModelInfo,
} from "./SubAgentProviderInfo.ts";
import {
  getModelCostTier,
  getProviderCostTier,
  isSpawnableProvider,
  CONCURRENCY_LIMITS,
} from "./SubAgentProviderInfo.ts";

export interface SubAgentProviderRegistryShape {
  readonly listSpawnableProviders: (
    filter?: SubAgentProviderFilter,
  ) => Effect.Effect<ReadonlyArray<SubAgentProviderInfo>>;
  
  readonly getProviderInfo: (
    instanceId: string,
  ) => Effect.Effect<SubAgentProviderInfo | null>;
}

export class SubAgentProviderRegistry extends Context.Service<
  SubAgentProviderRegistry,
  SubAgentProviderRegistryShape
>()("t3/subagent/SubAgentProviderRegistry") {}

const makeSubAgentProviderRegistry = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry;

  function mapToSubAgentProviderInfo(provider: ServerProvider): SubAgentProviderInfo {
    const costTier = getProviderCostTier(provider.driver);
    
    const models: SubAgentModelInfo[] = provider.models.map((model) => {
      const modelCostTier = getModelCostTier(model.slug);
      return {
        slug: model.slug,
        displayName: model.displayName ?? model.slug,
        contextWindow: model.capabilities?.contextWindow,
        supportedOptions: model.capabilities?.optionDescriptors?.map((d) => d.id) ?? [],
        costTier: modelCostTier,
        concurrencyLimit: CONCURRENCY_LIMITS[modelCostTier],
      };
    });

    const status: SubAgentProviderInfo["status"] =
      provider.status === "available"
        ? "available"
        : provider.status === "disabled"
          ? "disabled"
          : provider.status === "error"
            ? "error"
            : "unavailable";

    const spawnable = isSpawnableProvider(
      status,
      costTier,
      true, // excludeApiCredits
    );

    return {
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? provider.driver,
      status,
      spawnable,
      capabilities: {
        supportsSubAgents: true,
        maxConcurrentSubAgents: CONCURRENCY_LIMITS.global,
      },
      models,
      costTier,
    };
  }

  const listSpawnableProviders: SubAgentProviderRegistryShape["listSpawnableProviders"] = (
    filter,
  ) =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      let mapped = providers.map(mapToSubAgentProviderInfo);

      // Apply filters
      if (filter?.excludeApiCredits !== false) {
        mapped = mapped.filter((p) => p.costTier !== "api-credits");
      }
      if (filter?.requireSubscription) {
        mapped = mapped.filter((p) => p.costTier === "subscription");
      }
      if (filter?.requireAvailable !== false) {
        mapped = mapped.filter((p) => p.spawnable);
      }
      if (filter?.driverKinds && filter.driverKinds.length > 0) {
        const driverSet = new Set(filter.driverKinds);
        mapped = mapped.filter((p) => driverSet.has(p.driver));
      }

      return mapped;
    });

  const getProviderInfo: SubAgentProviderRegistryShape["getProviderInfo"] = (instanceId) =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      const provider = providers.find((p) => p.instanceId === instanceId);
      return provider ? mapToSubAgentProviderInfo(provider) : null;
    });

  return SubAgentProviderRegistry.of({
    listSpawnableProviders,
    getProviderInfo,
  });
});

export const SubAgentProviderRegistryLive = Layer.effect(
  SubAgentProviderRegistry,
  makeSubAgentProviderRegistry,
).pipe(Layer.provide(ProviderRegistry.Default));
```

## Step 6: Create Basic Test

File: `apps/server/src/subagent/__tests__/SubAgentProviderRegistry.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import * as Effect from "effect/Effect";
import { SubAgentProviderRegistry, SubAgentProviderRegistryLive } from "../SubAgentProviderRegistry.ts";
import { getModelCostTier, getProviderCostTier } from "../SubAgentProviderInfo.ts";

describe("SubAgentProviderInfo", () => {
  it("should classify cheap models correctly", () => {
    expect(getModelCostTier("claude-haiku-4.5")).toBe("cheap");
    expect(getModelCostTier("gpt-4o-mini")).toBe("cheap");
  });

  it("should classify expensive models correctly", () => {
    expect(getModelCostTier("claude-fable-5")).toBe("expensive");
    expect(getModelCostTier("claude-opus-4.8")).toBe("expensive");
    expect(getModelCostTier("gpt-5.5")).toBe("expensive");
  });

  it("should mark opencode as api-credits", () => {
    expect(getProviderCostTier("opencode")).toBe("api-credits");
  });

  it("should mark other providers as subscription", () => {
    expect(getProviderCostTier("codex")).toBe("subscription");
    expect(getProviderCostTier("claudeAgent")).toBe("subscription");
  });
});
```

## Step 7: Run Validation

```bash
cd /Users/serge/Library/Application\ Support/SergeCode/worktrees/SergeCode/sergecode-55150a4f
vp check
vp run typecheck
```

Execute all these steps in order and report any errors.
