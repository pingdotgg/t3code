import {
  type ProviderUsageLimitsMcpResult,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

export class UsageLimitsService extends Context.Service<
  UsageLimitsService,
  { readonly read: Effect.Effect<ProviderUsageLimitsMcpResult> }
>()("t3/usage/UsageLimitsService") {}

const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const read = Effect.gen(function* () {
    const readAt = DateTime.formatIso(yield* DateTime.now);
    const ageSeconds = (checkedAt: string) =>
      Math.max(0, (Date.parse(readAt) - Date.parse(checkedAt)) / 1000);
    const quota = (
      limits: ServerProviderUsageLimits | undefined,
    ): ProviderUsageLimitsMcpResult["providers"][number]["quota"] => ({
      status:
        limits === undefined
          ? "notReported"
          : limits.unavailable?.reason === "probeFailed"
            ? "error"
            : limits.unavailable
              ? "unavailable"
              : "available",
      ...(limits === undefined
        ? {}
        : { checkedAt: limits.checkedAt, ageSeconds: ageSeconds(limits.checkedAt) }),
      // Project fields explicitly: provider diagnostics and credential identities never leave this read.
      windows: (limits?.windows ?? []).map((window) => ({
        id: window.id,
        kind: window.kind,
        label: window.label,
        usedPercent: window.usedPercent,
        remainingPercent: 100 - window.usedPercent,
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        ...(window.windowDurationMins === undefined
          ? {}
          : { windowDurationMins: window.windowDurationMins }),
      })),
    });
    return {
      readAt,
      providers: (yield* providers.getProviders).map((provider) => ({
        instanceId: provider.instanceId,
        driver: provider.driver,
        enabled: provider.enabled,
        quota: quota(provider.usageLimits),
      })),
      sources: (yield* sources.current).map((source) => ({
        sourceId: source.id,
        status: source.error === undefined ? ("available" as const) : ("error" as const),
        checkedAt: source.checkedAt,
        ageSeconds: ageSeconds(source.checkedAt),
        accounts: source.accounts.map((account) => ({
          accountId: account.id,
          driver: account.driver,
          quota: quota(account.usageLimits),
        })),
      })),
    };
  });
  return UsageLimitsService.of({ read });
});

export const layer = Layer.effect(UsageLimitsService, make);
