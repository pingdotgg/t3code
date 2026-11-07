import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { limitsNotice, remainingPercent } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatChatTimestampTooltip } from "../../timestampFormat";
import { providerClients } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

function UsageWindow({
  provider,
  window,
  checkedAt,
  color,
  connected,
}: {
  readonly provider: string;
  readonly window: ServerProviderUsageWindow;
  readonly checkedAt: string;
  readonly color: string;
  readonly connected: boolean;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const label =
    window.kind === "session" && window.windowDurationMins === 300 && window.label === "Session"
      ? "5h"
      : window.label;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="meter"
            aria-label={`${provider} ${label} remaining`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remaining}
            aria-valuetext={`${remaining}% left${connected ? "" : " (last known)"}`}
            tabIndex={0}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        <span className="max-w-32 truncate">{label}</span>
        <span aria-hidden className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full"
            style={{ width: `${remaining}%`, backgroundColor: color }}
          />
        </span>
        <span className="shrink-0 tabular-nums">{remaining}% left</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span>
            {provider} · {window.label}: {remaining}% left
          </span>
          {window.resetsAt ? (
            <span>Resets {formatChatTimestampTooltip(window.resetsAt, timestampFormat)}</span>
          ) : null}
          <span className="text-muted-foreground">
            {connected ? "Updated" : "Offline · Last updated"}{" "}
            {formatChatTimestampTooltip(checkedAt, timestampFormat)}
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function UsageStatusBar({
  provider,
  connected,
  loading,
}: {
  readonly provider: ServerProvider | null;
  readonly connected: boolean;
  readonly loading: boolean;
}) {
  const limits = provider?.usageLimits;
  const hasLimits = limits !== undefined && limitsNotice(limits) === null;
  const driverLabel = provider
    ? (providerClients.get(provider.driver)?.label ?? String(provider.driver))
    : null;
  const name = provider?.displayName?.includes("@") ? null : provider?.displayName?.trim();
  const instanceName = name && name.toLowerCase() !== driverLabel?.toLowerCase() ? name : null;
  const label = instanceName ? `${driverLabel} · ${instanceName}` : driverLabel;
  const color =
    Object.values(PROVIDER_PRESENTATION).find((entry) => entry.driverKind === provider?.driver)
      ?.color ?? "var(--foreground)";

  return (
    <section
      aria-label="Subscription usage"
      className="shrink-0 border-t border-border bg-background pb-safe text-2xs leading-4 text-muted-foreground"
    >
      <div className="flex items-start gap-3 px-3 py-1.5">
        <div className="flex max-h-24 min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 overflow-y-auto">
          {provider && label ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={label}
                    tabIndex={0}
                    className="inline-flex max-w-40 items-center gap-1.5 rounded-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  />
                }
              >
                <ProviderInstanceIcon
                  driverKind={provider.driver}
                  displayName={label}
                  acpRegistryIconUrl={provider.iconUrl}
                  size="compact"
                  className="z-auto"
                />
                {instanceName ? <span className="truncate font-medium">{instanceName}</span> : null}
              </TooltipTrigger>
              <TooltipPopup side="top">{label}</TooltipPopup>
            </Tooltip>
          ) : null}
          {!connected && hasLimits ? <span>Offline · last known usage</span> : null}
          {hasLimits && label ? (
            limits.windows.map((window) => (
              <UsageWindow
                key={window.id}
                provider={label}
                window={window}
                checkedAt={limits.checkedAt}
                color={color}
                connected={connected}
              />
            ))
          ) : (
            <span>
              {loading
                ? "Loading usage…"
                : provider
                  ? (limits?.unavailable?.message ?? "Subscription usage unavailable")
                  : "Select an agent to see usage"}
            </span>
          )}
        </div>
        <Link
          to="/usage"
          aria-label="View usage details"
          className="shrink-0 rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          Usage
        </Link>
      </div>
    </section>
  );
}
