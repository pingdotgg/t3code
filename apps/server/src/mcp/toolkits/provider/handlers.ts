import {
  OrchestratorMcpFailure,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  type UsageSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import { readFullAccessCaller, unavailable } from "../../threadAccess.ts";
import { MAX_USAGE_ROWS, ProviderToolkit } from "./tools.ts";

function usageLimits(limits: ServerProviderUsageLimits) {
  return {
    checkedAt: limits.checkedAt,
    windows: limits.windows.map(({ id, kind, label, usedPercent, resetsAt }) => ({
      id,
      kind,
      label,
      usedPercent,
      resetsAt: resetsAt ?? null,
    })),
    resetCredits: limits.resetCredits?.availableCount ?? null,
    unavailable: limits.unavailable
      ? limits.unavailable.reason +
        (limits.unavailable.message ? `: ${limits.unavailable.message}` : "")
      : null,
  };
}

function providerStatus(provider: ServerProvider) {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName ?? null,
    enabled: provider.enabled,
    installed: provider.installed,
    available: provider.availability !== "unavailable",
    version: provider.version,
    latestVersion:
      provider.versionAdvisory?.status === "behind_latest"
        ? provider.versionAdvisory.latestVersion
        : null,
    status: provider.status,
    message: provider.message ?? provider.unavailableReason ?? null,
    checkedAt: provider.checkedAt,
    // Account emails stay out of agent context; label and type identify the account.
    auth: {
      status: provider.auth.status,
      type: provider.auth.type ?? null,
      label: provider.auth.label ?? null,
    },
    usageLimits: provider.usageLimits ? usageLimits(provider.usageLimits) : null,
  };
}

function usageLimitSource(source: UsageLimitSourceSnapshot) {
  return {
    id: source.id,
    label: source.label,
    checkedAt: source.checkedAt,
    error: source.error ?? null,
    accounts: source.accounts.map((account) => ({
      id: account.id,
      driver: account.driver,
      plan: account.plan ?? null,
      usageLimits: usageLimits(account.usageLimits),
    })),
  };
}

const snapshot = (providers: ReadonlyArray<ServerProvider>, instanceId?: ProviderInstanceId) =>
  Effect.gen(function* () {
    const selected =
      instanceId === undefined
        ? providers
        : providers.filter((provider) => provider.instanceId === instanceId);
    if (selected.length === 0 && instanceId !== undefined)
      return yield* new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: "The provider instance was not found.",
      });
    const sources =
      instanceId === undefined ? yield* (yield* UsageLimitSources.UsageLimitSources).current : [];
    return {
      providers: selected.map(providerStatus),
      usageLimitSources: sources.map(usageLimitSource),
    };
  });

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Window totals per provider and model; per-day buckets and source paths stay on the server. */
function usageTotals(summary: UsageSummary) {
  const rows = new Map<
    string,
    {
      provider: string;
      model: string;
      uncachedInputTokens: number;
      cachedInputTokens: number;
      cacheCreationTokens: number;
      outputTokens: number;
      costUsd: number;
      records: number;
    }
  >();
  for (const bucket of summary.buckets) {
    const key = `${bucket.provider}\u0000${bucket.model}`;
    const row = rows.get(key) ?? {
      provider: bucket.provider,
      model: bucket.model,
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      records: 0,
    };
    row.uncachedInputTokens += bucket.totals.uncachedInputTokens;
    row.cachedInputTokens += bucket.totals.cachedInputTokens;
    row.cacheCreationTokens += bucket.totals.cacheCreationTokens;
    row.outputTokens += bucket.totals.outputTokens;
    row.costUsd += bucket.costUsd;
    row.records += bucket.records;
    rows.set(key, row);
  }
  const models = [...rows.values()]
    .map((row) => ({ ...row, costUsd: round(row.costUsd) }))
    .sort((left, right) => right.costUsd - left.costUsd || right.outputTokens - left.outputTokens);
  return {
    sinceDay: summary.sinceDay,
    untilDay: summary.untilDay,
    timeZone: summary.timeZone,
    pricing: summary.pricing.status,
    models: models.slice(0, MAX_USAGE_ROWS),
    truncated: models.length > MAX_USAGE_ROWS,
    sources: summary.sources.map((source) => ({
      provider: source.fingerprint.provider,
      status: source.status,
      message: source.message,
    })),
  };
}

export const ProviderHandlersLive = ProviderToolkit.toLayer({
  t3_provider_status: ({ instanceId, usage }) =>
    Effect.gen(function* () {
      // Provider messages can carry configured URLs and executable paths.
      yield* readFullAccessCaller(
        "Provider status requires a live full-access/default thread or a full-access client.",
      );
      const registry = yield* ProviderRegistry.ProviderRegistry;
      const result = yield* snapshot(yield* registry.getProviders, instanceId);
      if (usage === undefined) return result;
      const summary = yield* (yield* UsageService.UsageService)
        .readSummary(usage)
        .pipe(
          Effect.mapError((error) =>
            error.reason === "invalidWindow"
              ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail })
              : unavailable(),
          ),
        );
      return { ...result, usage: usageTotals(summary) };
    }),
  t3_provider_refresh: ({ instanceId }) =>
    Effect.gen(function* () {
      yield* readFullAccessCaller(
        "Refreshing providers runs their CLIs and requires a live full-access/default calling thread or a full-access client.",
      );
      const registry = yield* ProviderRegistry.ProviderRegistry;
      // Matches server.refreshProviders without refreshModels: an untargeted refresh includes
      // the quota hubs, awaited so the snapshot below carries their answer.
      if (instanceId === undefined) yield* (yield* UsageLimitSources.UsageLimitSources).refresh;
      const providers = yield* instanceId === undefined
        ? registry.refresh()
        : registry.refreshInstance(instanceId);
      return yield* snapshot(providers, instanceId);
    }),
});
