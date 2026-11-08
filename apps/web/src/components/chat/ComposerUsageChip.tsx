import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { collectProviderUsageLimits, remainingPercent } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ThreadDetailsUsage } from "./ThreadDetailsUsage";

const SHORT_KIND: Partial<Record<ServerProviderUsageWindow["kind"], string>> = {
  session: "5h",
  weekly: "wk",
  monthly: "mo",
};

function providerLabel(provider: ServerProvider): string {
  return provider.displayName ?? String(provider.driver);
}

function hasLimits(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.usageLimits !== undefined &&
    provider.usageLimits.unavailable?.reason !== "unsupported"
  );
}

/**
 * The current agent's room left beside the composer, like Orca's status bar segment.
 * It opens every agent's limits, so all subscriptions stay one glance away.
 */
export function ComposerUsageChip({
  providerInstanceId,
  providers,
  sources,
}: {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
}) {
  const nowMinute = useNowMinute();
  const withLimits = providers.filter(hasLimits);
  if (withLimits.length === 0) return null;
  const current =
    withLimits.find((provider) => provider.instanceId === providerInstanceId) ?? withLimits[0]!;
  const now = Date.parse(`${nowMinute}:00Z`);
  const limits =
    collectProviderUsageLimits(current.instanceId, providers, sources, now)?.accounts.find(
      (account) => account.instanceId === current.instanceId,
    )?.limits ?? current.usageLimits;
  // The first session and weekly windows; model-scoped weeklies stay in the popover.
  const all = limits?.windows ?? [];
  const picked = (["session", "weekly"] as const).flatMap((kind) => {
    const window = all.find((entry) => entry.kind === kind);
    return window ? [window] : [];
  });
  const shown = picked.length > 0 ? picked : all.slice(0, 2);

  return (
    <Popover>
      <div className="rounded-md bg-background/70 backdrop-blur-sm">
        <PopoverTrigger
          render={
            <Button
              size="compact"
              variant="ghost-muted"
              aria-label={`Usage limits for ${providerLabel(current)}`}
            />
          }
        >
          <ProviderInstanceIcon
            driverKind={current.driver}
            displayName={providerLabel(current)}
            accentColor={current.accentColor}
            size="compact"
          />
          {shown.length === 0 ? (
            <span>Limits</span>
          ) : (
            shown.map((window) => {
              const left = remainingPercent(window);
              return (
                <span key={window.id} className="tabular-nums">
                  <span className="text-muted-foreground">
                    {SHORT_KIND[window.kind] ?? window.label}
                  </span>{" "}
                  <span
                    className={cn(
                      left <= 10 ? "text-destructive" : left <= 20 ? "text-warning" : undefined,
                    )}
                  >
                    {left}%
                  </span>
                </span>
              );
            })
          )}
        </PopoverTrigger>
      </div>
      <PopoverPopup side="top" align="end" width="md">
        <div className="flex flex-col gap-4">
          {withLimits.map((provider) => (
            <section key={provider.instanceId} className="flex flex-col gap-2">
              <h3 className="flex items-center gap-1.5 font-medium text-sm">
                <ProviderInstanceIcon
                  driverKind={provider.driver}
                  displayName={providerLabel(provider)}
                  accentColor={provider.accentColor}
                  size="compact"
                />
                {providerLabel(provider)}
              </h3>
              <ThreadDetailsUsage
                providerInstanceId={provider.instanceId}
                providers={providers}
                sources={sources}
              />
            </section>
          ))}
          <Link to="/usage" className="text-muted-foreground text-xs hover:text-foreground">
            Open Usage →
          </Link>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
