import type {
  ProviderInstanceConfig,
  ServerSettings,
  UsageGatewayTagCost,
  UsageProviderKind,
  UsageSource,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { readLiteLLMGatewayKey } from "@t3tools/provider-core/server/litellm";
import { readLiteLLMSpend, type LiteLLMSpend } from "@t3tools/provider-core/server/litellmUsage";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const PROVIDER_BY_DRIVER: Readonly<Record<string, UsageProviderKind>> = {
  claudeAgent: "claude",
  codex: "codex",
  opencode: "opencode",
};

export interface LiteLLMUsageInstance {
  readonly provider: UsageProviderKind;
  readonly instance: ProviderInstanceConfig;
}

function liteLLMUsageInstances(settings: ServerSettings): LiteLLMUsageInstance[] {
  return Object.values(settings.providerInstances).flatMap((instance) => {
    const provider = PROVIDER_BY_DRIVER[instance.driver];
    return instance.launcher === "litellm" && instance.enabled !== false && provider
      ? [{ provider, instance }]
      : [];
  });
}

/**
 * The gateway does not record which harness sent a request, so spend follows the model. The
 * split must not depend on local settings: environments sharing a gateway must agree on it.
 */
export function gatewayModelProvider(model: string): UsageProviderKind {
  const name = model.toLowerCase();
  if (name.includes("claude")) return "claude";
  if (/(^|\/)(gpt|o\d|codex)/.test(name)) return "codex";
  return "opencode";
}

/** Gateway days are UTC; noon keeps each one on the same calendar day in nearly every zone. */
export const gatewayDayTimestamp = (day: string) => Date.parse(`${day}T12:00:00Z`);

export function gatewayRecord(row: LiteLLMSpend, provider: UsageProviderKind): UsageRecord {
  const cached = row.cacheReadTokens;
  const created = row.cacheCreationTokens;
  return {
    provider,
    timestampMs: gatewayDayTimestamp(row.day),
    model: row.name,
    sessionId: "",
    totals: {
      // LiteLLM counts cache reads and writes inside prompt tokens.
      uncachedInputTokens: Math.max(0, row.promptTokens - cached - created),
      cachedInputTokens: cached,
      cacheCreationTokens: created,
      outputTokens: row.completionTokens,
      reasoningTokens: 0,
    },
    reportedCostUsd: row.costUsd,
    speed: "standard",
    dedupeKey: null,
  };
}

export function sumGatewayTags(
  gateway: string,
  rows: ReadonlyArray<LiteLLMSpend>,
  includesDay: (day: string) => boolean,
): UsageGatewayTagCost[] {
  const totals = new Map<string, UsageGatewayTagCost>();
  for (const row of rows) {
    const tag = row.name.trim();
    if (!tag || !includesDay(row.day)) continue;
    const previous = totals.get(tag);
    totals.set(tag, {
      gateway,
      tag,
      costUsd: (previous?.costUsd ?? 0) + row.costUsd,
      requests: (previous?.requests ?? 0) + row.requests,
    });
  }
  return [...totals.values()];
}

export interface GatewayUsageSource {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly volumeId: string;
  readonly hostId: string;
  readonly status: UsageSource["status"];
  readonly message: string;
  readonly files: readonly {
    readonly path: string;
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: readonly number[];
  }[];
}

/**
 * Reads spend from every gateway a LiteLLM instance uses. Sources share a fingerprint across
 * environments signed in as the same user, so merged views count the gateway once.
 */
export const readGatewayUsage = Effect.fn("UsageService.readGatewayUsage")(function* (
  settings: ServerSettings,
  hostEnvironment: NodeJS.ProcessEnv,
  startDay: string,
  endDay: string,
  includesDay: (day: string) => boolean,
) {
  const sources: GatewayUsageSource[] = [];
  const tagCosts: UsageGatewayTagCost[] = [];
  let tagsAvailable = false;
  const byUrl = new Map<
    string,
    { environment: NodeJS.ProcessEnv; providers: Set<UsageProviderKind> }
  >();
  for (const { provider, instance } of liteLLMUsageInstances(settings)) {
    const environment = yield* mergeProviderInstanceEnvironment(
      instance.environment,
      hostEnvironment,
    );
    const url = environment.LITELLM_PROXY_URL?.trim() ?? "";
    const entry = byUrl.get(url) ?? { environment, providers: new Set() };
    entry.providers.add(provider);
    byUrl.set(url, entry);
  }

  for (const [url, { environment, providers }] of byUrl) {
    const failed = (message: string) => {
      for (const provider of providers)
        sources.push({
          provider,
          dir: url || "litellm",
          volumeId: "",
          hostId: "litellm",
          status: "failed",
          message,
          files: [],
        });
    };
    if (!url) {
      failed("Set LITELLM_PROXY_URL to read LiteLLM gateway spend.");
      continue;
    }
    const key = yield* readLiteLLMGatewayKey(environment);
    if (Option.isNone(key)) {
      failed("Sign in to LiteLLM in Settings > Providers to read gateway spend.");
      continue;
    }
    const spend = yield* readLiteLLMSpend(
      key.value.baseUrl,
      key.value.token,
      startDay,
      endDay,
    ).pipe(Effect.option);
    if (Option.isNone(spend)) {
      failed("Could not read spend from the LiteLLM gateway.");
      continue;
    }
    const { userId, models, tags } = spend.value;
    const records = new Map<UsageProviderKind, UsageRecord[]>(
      [...providers].map((provider) => [provider, []]),
    );
    for (const row of models) {
      const provider = gatewayModelProvider(row.name);
      const providerRecords = records.get(provider) ?? [];
      providerRecords.push(gatewayRecord(row, provider));
      records.set(provider, providerRecords);
    }
    for (const [provider, providerRecords] of records)
      sources.push({
        provider,
        dir: url,
        volumeId: userId,
        hostId: "litellm",
        status: "ok",
        message: "Spend reported by the LiteLLM gateway in daily totals.",
        files: [{ path: `${url}#${userId}`, records: providerRecords, malformedRecords: [] }],
      });
    if (tags !== undefined) {
      tagsAvailable = true;
      tagCosts.push(...sumGatewayTags(`${url}#${userId}`, tags, includesDay));
    }
  }
  return { sources, tagCosts: tagsAvailable ? tagCosts : undefined };
});
