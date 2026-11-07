import {
  isProviderAvailable,
  type OrchestratorMcpProviderUsageResult,
  type OrchestratorMcpProviderUsageUnavailableReason,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

export class ProviderUsage extends Context.Service<
  ProviderUsage,
  { readonly read: Effect.Effect<OrchestratorMcpProviderUsageResult> }
>()("t3/usage/ProviderUsage") {}

type Gate = { readonly reason: OrchestratorMcpProviderUsageUnavailableReason; message?: string };

/** Credential fingerprints, credit ids, emails and workspace ids never leave the server here. */
function limitsReading(limits: ServerProviderUsageLimits | undefined, gate: Gate | null) {
  const windows = (limits?.windows ?? []).map((window) => ({
    id: window.id,
    kind: window.kind,
    label: window.label,
    usedPercent: window.usedPercent,
    remainingPercent: remainingPercent(window),
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null,
  }));
  const unavailable = limits?.unavailable;
  const blocked: Gate | null =
    gate ??
    (limits === undefined
      ? { reason: "notReported" }
      : unavailable && (unavailable.reason === "unsupported" || windows.length === 0)
        ? {
            reason: unavailable.reason,
            ...(unavailable.message ? { message: unavailable.message } : {}),
          }
        : windows.length === 0
          ? { reason: "noWindows" }
          : null);
  const credits = limits?.resetCredits;
  return {
    available: blocked === null,
    reason: blocked?.reason ?? null,
    message: (blocked === null ? unavailable?.message : blocked.message) ?? null,
    stale: blocked === null && unavailable?.reason === "probeFailed",
    checkedAt: limits?.checkedAt ?? null,
    windows: blocked === null ? windows : [],
    resetCredits:
      blocked === null && credits
        ? { availableCount: credits.availableCount, nextExpiresAt: credits.nextExpiresAt ?? null }
        : null,
  };
}

function providerGate(provider: ServerProvider): Gate | null {
  if (!isProviderAvailable(provider)) {
    return {
      reason: "providerUnavailable",
      ...(provider.unavailableReason ? { message: provider.unavailableReason } : {}),
    };
  }
  if (!provider.enabled) return { reason: "disabled" };
  if (!provider.installed) return { reason: "notInstalled" };
  if (provider.auth.status === "unauthenticated") {
    return { reason: "unauthenticated" };
  }
  return null;
}

/** Projects the snapshots Usage → Limits and `/usage-limits` read. */
export function providerUsageReport(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly generatedAt: string;
}): OrchestratorMcpProviderUsageResult {
  return {
    generatedAt: input.generatedAt,
    providers: input.providers.map((provider) => ({
      providerInstanceId: provider.instanceId,
      driverKind: provider.driver,
      displayName: provider.displayName ?? null,
      enabled: provider.enabled,
      status: provider.status,
      plan: provider.auth.label ?? null,
      ...limitsReading(provider.usageLimits, providerGate(provider)),
      externalUsageUrl: provider.usageLimits?.externalUsage?.url ?? null,
    })),
    sources: input.sources.map((source) => ({
      sourceId: source.id,
      kind: source.kind,
      label: source.label,
      checkedAt: source.checkedAt,
      error: source.error ?? null,
      accounts: source.accounts.map((account) => ({
        driverKind: account.driver,
        plan: account.plan ?? null,
        ...limitsReading(account.usageLimits, null),
      })),
    })),
  };
}

/** Matches the five-minute automatic check that opening Usage → Limits runs. */
const REFRESH_TTL = "5 minutes";

export const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  // Background refreshes run only while a client holds an activity lease, so a headless caller
  // refreshes the same way the Limits page does. Concurrent callers share one refresh.
  const refresh = yield* Effect.cachedWithTTL(
    Effect.andThen(sources.refresh, registry.refresh()),
    REFRESH_TTL,
  );
  return {
    read: Effect.gen(function* () {
      yield* refresh;
      return providerUsageReport({
        providers: yield* registry.getProviders,
        sources: yield* sources.current,
        generatedAt: DateTime.formatIso(yield* DateTime.now),
      });
    }).pipe(Effect.withSpan("ProviderUsage.read")),
  } satisfies ProviderUsage["Service"];
});

export const layer = Layer.effect(ProviderUsage, make);
