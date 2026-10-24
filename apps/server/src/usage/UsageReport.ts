import {
  isProviderAvailable,
  type EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type OrchestratorMcpUsageLimitsResult,
  type OrchestratorMcpUsageSpendResult,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageSummary,
  type UsageTokenTotals,
  type UsageLimitSourceSnapshot,
  type UsageReadError,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { limitsNotice, remainingPercent } from "@t3tools/shared/usageLimits";
import { isModelCostUnknown, mergeUsage } from "@t3tools/shared/usageMerge";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageService from "./UsageService.ts";

type Reading = Pick<
  OrchestratorMcpUsageLimitsResult["providers"][number],
  "ageMins" | "windows" | "unavailable"
>;
type SpendDays = OrchestratorMcpUsageSpendResult["window"]["days"];

const minutes = (milliseconds: number) => Math.max(0, Math.round(milliseconds / 60_000));

const reading = (limits: ServerProviderUsageLimits, now: number): Reading => ({
  ageMins: minutes(now - Date.parse(limits.checkedAt)),
  windows: limits.windows.map((window) => ({
    kind: window.kind,
    label: window.label,
    remainingPercent: remainingPercent(window),
    resetsInMins: window.resetsAt === undefined ? null : minutes(Date.parse(window.resetsAt) - now),
  })),
  unavailable: limitsNotice(limits),
});

const providerReading = (provider: ServerProvider, now: number): Reading => {
  const unusable = !provider.installed
    ? "This provider is not installed."
    : !isProviderAvailable(provider)
      ? (provider.unavailableReason ?? provider.message ?? "This provider is unavailable.")
      : provider.status === "error" || provider.status === "disabled"
        ? (provider.message ?? `This provider's status is ${provider.status}.`)
        : provider.auth.status === "unauthenticated"
          ? "This provider is not signed in."
          : null;
  if (unusable !== null) {
    return { ageMins: null, windows: [], unavailable: unusable };
  }
  if (provider.usageLimits === undefined) {
    return {
      ageMins: null,
      windows: [],
      unavailable: "This provider has not reported usage limits.",
    };
  }
  return reading(provider.usageLimits, now);
};

const summarizeLimits = (
  providers: ReadonlyArray<ServerProvider>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  now: number,
): OrchestratorMcpUsageLimitsResult => ({
  providers: providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      providerInstanceId: provider.instanceId,
      driverKind: provider.driver,
      ...providerReading(provider, now),
    })),
  pooledAccounts: sources.flatMap((source) =>
    source.accounts.map((account) => ({
      source: source.label,
      accountId: account.id,
      driverKind: account.driver,
      ...reading(account.usageLimits, now),
    })),
  ),
  notices: sources.flatMap((source) =>
    source.error === undefined ? [] : [`${source.label}: ${source.error}`],
  ),
});

const CENTS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, useGrouping: false });
const usd = (value: number) => Number(CENTS.format(value));

const totalTokens = (totals: UsageTokenTotals) =>
  totals.uncachedInputTokens +
  totals.cachedInputTokens +
  totals.cacheCreationTokens +
  totals.outputTokens;

const summarizeSpend = (
  summary: UsageSummary,
  environment: { readonly environmentId: EnvironmentId; readonly label: string },
  days: SpendDays,
): OrchestratorMcpUsageSpendResult => {
  const merged = mergeUsage([{ ...environment, summary }], USAGE_CONTRACT_VERSION);
  return {
    window: {
      days,
      sinceDay: summary.sinceDay,
      untilDay: summary.untilDay,
      timeZone: summary.timeZone,
    },
    costUsd: usd(merged.costUsd),
    totalTokens: totalTokens(merged),
    sessions: merged.sessions,
    unpricedShare: Math.round(merged.costQuality.unpricedShare * 1000) / 1000,
    providers: merged.providers.map((provider) => ({
      provider: provider.provider,
      costUsd: usd(provider.costUsd),
      totalTokens: provider.totalTokens,
      sessions: provider.sessions,
    })),
    models: merged.models.map((model) => ({
      provider: model.provider,
      model: model.model,
      costUsd: isModelCostUnknown(model) ? null : usd(model.costUsd),
      totalTokens: totalTokens(model.tokens),
    })),
    periods:
      days === 1
        ? merged.hourly.map((period) => ({ start: period.hourStart, costUsd: usd(period.costUsd) }))
        : merged.daily.map((period) => ({ start: period.day, costUsd: usd(period.costUsd) })),
    notices: summary.sources.flatMap((source) => [
      ...(source.message !== null &&
      (source.status === "partial" ||
        source.status === "failed" ||
        source.fingerprint.provider === "cursor")
        ? [source.message]
        : []),
      ...(source.refreshing
        ? [
            `${source.fingerprint.provider} usage is still being read, so spend leaves it out. Pass refresh: true to wait for it.`,
          ]
        : []),
    ]),
  };
};

export class UsageReport extends Context.Service<
  UsageReport,
  {
    readonly readLimits: (input: {
      readonly refresh: boolean;
    }) => Effect.Effect<OrchestratorMcpUsageLimitsResult>;
    readonly readSpend: (input: {
      readonly days: SpendDays;
      readonly refresh: boolean;
    }) => Effect.Effect<OrchestratorMcpUsageSpendResult, UsageReadError>;
  }
>()("t3/usage/UsageReport") {}

const make = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
  const usage = yield* UsageService.UsageService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

  const readLimits = Effect.fn("UsageReport.readLimits")(function* (input: {
    readonly refresh: boolean;
  }) {
    if (input.refresh) {
      yield* Effect.all(
        [providerRegistry.refresh(undefined, { fresh: true }), usageLimitSources.refresh],
        { concurrency: "unbounded", discard: true },
      );
    }
    const [providers, sources] = yield* Effect.all([
      providerRegistry.getProviders,
      usageLimitSources.current,
    ]);
    return summarizeLimits(providers, sources, DateTime.toEpochMillis(yield* DateTime.now));
  });

  const readSpend = Effect.fn("UsageReport.readSpend")(function* (input: {
    readonly days: SpendDays;
    readonly refresh: boolean;
  }) {
    const now = yield* DateTime.now;
    const window = makeWindow(
      input.days,
      DateTime.toDateUtc(now),
      input.days === 1 ? "hour" : "day",
    );
    const summary = yield* usage.readSummary({
      ...window,
      ...(input.refresh ? { awaitRefresh: true } : {}),
    });
    const environment = yield* serverEnvironment.getDescriptor;
    return summarizeSpend(summary, environment, input.days);
  });

  return UsageReport.of({ readLimits, readSpend });
});

export const layer = Layer.effect(UsageReport, make);
