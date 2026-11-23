import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderInstanceQuota,
  collectVendorQuotas,
  MODEL_VENDOR_IDS,
  modelVendorAccentColor,
  modelVendorDisplayName,
  modelVendorIconDriver,
  type ModelVendorId,
  type ModelVendorTabId,
  parseModelVendorTabId,
  type VendorQuotaSummary,
  type VendorQuotaWindowItem,
} from "@t3tools/shared/modelVendorQuota";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { memo, type ReactNode, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { AntigravityIcon, ClaudeAI, DeepSeekIcon, OpenAI, ZhipuIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon, providerTextColor } from "./ProviderInstanceIcon";

export function VendorBrandIcon({
  vendor,
  className = "size-4",
}: {
  readonly vendor: ModelVendorId;
  readonly className?: string;
}) {
  const tone = providerTextColor(modelVendorIconDriver(vendor));
  switch (vendor) {
    case "claude":
      return (
        <ClaudeAI
          className={cn(className, "shrink-0", tone.className)}
          style={tone.style}
          aria-hidden
        />
      );
    case "gpt":
      return (
        <OpenAI
          className={cn(className, "shrink-0", tone.className)}
          style={tone.style}
          aria-hidden
        />
      );
    case "gemini":
      return (
        <AntigravityIcon
          className={cn(className, "shrink-0", tone.className)}
          style={tone.style}
          aria-hidden
        />
      );
    case "glm":
      return (
        <ZhipuIcon
          className={cn(className, "shrink-0")}
          style={{ color: modelVendorAccentColor("glm") }}
          aria-hidden
        />
      );
    case "deepseek":
      return (
        <DeepSeekIcon
          className={cn(className, "shrink-0")}
          style={{ color: modelVendorAccentColor("deepseek") }}
          aria-hidden
        />
      );
  }
}

interface ParsedBalanceWindow {
  readonly currency: string;
  readonly total: string;
  readonly toppedUp: string | null;
  readonly granted: string | null;
  readonly isAvailable: boolean;
}

function parseBalanceWindow(item: VendorQuotaWindowItem): ParsedBalanceWindow | null {
  if (!item.window.id.startsWith("deepseek-balance-")) return null;
  const [currencyPart, totalPart, detailPart] = item.window.label.split("|");
  if (!currencyPart || !totalPart) return null;
  let toppedUp: string | null = null;
  let granted: string | null = null;
  if (detailPart) {
    for (const token of detailPart.split(",")) {
      if (token.startsWith("topped:")) toppedUp = token.slice("topped:".length);
      else if (token.startsWith("granted:")) granted = token.slice("granted:".length);
    }
  }
  return {
    currency: currencyPart,
    total: totalPart,
    toppedUp,
    granted,
    isAvailable: item.usedPercent < 100,
  };
}

function QuotaBalanceCard({
  balance,
  brandColor,
}: {
  readonly balance: ParsedBalanceWindow;
  readonly brandColor: string;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background/60 p-2.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {gt("Balance ({currency})", { currency: balance.currency })}
        </span>
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-2xs font-medium",
            balance.isAvailable
              ? "bg-success/15 text-success-foreground"
              : "bg-destructive/15 text-destructive",
          )}
        >
          {balance.isAvailable ? gt("Available") : gt("Exhausted")}
        </span>
      </div>
      <div
        className="text-lg font-semibold leading-tight tracking-tight tabular-nums"
        style={{ color: balance.isAvailable ? brandColor : "var(--destructive)" }}
      >
        {balance.total}
      </div>
      {balance.toppedUp || balance.granted ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-2xs text-muted-foreground tabular-nums">
          {balance.toppedUp ? (
            <span>{gt("Top-up {amount}", { amount: balance.toppedUp })}</span>
          ) : null}
          {balance.granted ? (
            <span>{gt("Granted {amount}", { amount: balance.granted })}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function barFillColor(usedPercent: number, brandColor: string): string {
  if (usedPercent >= 90) return "var(--destructive)";
  if (usedPercent >= 80) return "var(--warning)";
  return brandColor;
}

function QuotaProgressBar({
  item,
  brandColor,
  now,
}: {
  readonly item: VendorQuotaWindowItem;
  readonly brandColor: string;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const balance = parseBalanceWindow(item);
  if (balance) {
    return <QuotaBalanceCard balance={balance} brandColor={brandColor} />;
  }
  const resetsIn = formatResetsIn(item.window, now, m);
  const resetsAt = item.resetsAt
    ? formatUpcomingTimestamp(item.resetsAt, timestampFormat, now, undefined, m)
    : null;
  const fillColor = barFillColor(item.usedPercent, brandColor);
  const isCritical = item.remainingPercent <= 10;
  const isLow = !isCritical && item.remainingPercent <= 20;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{item.window.label}</span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            isCritical ? "text-destructive" : isLow ? "text-warning-foreground" : "text-foreground",
          )}
        >
          {gt("{remaining}% left", { remaining: item.remainingPercent })}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="progressbar"
              aria-label={item.window.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={item.usedPercent}
              className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full transition-[width] duration-300 ease-out"
                style={{
                  width: `${item.usedPercent}%`,
                  backgroundColor: fillColor,
                }}
              />
            </div>
          }
        />
        <TooltipPopup side="top">
          <div className="flex flex-col gap-0.5 text-xs">
            <span className="text-foreground">
              {gt("{used}% used · {remaining}% left", {
                used: item.usedPercent,
                remaining: item.remainingPercent,
              })}
            </span>
            {resetsAt ? (
              <span className="text-muted-foreground">
                {resetsIn
                  ? gt("Resets {resetsAt} · {resetsIn}", { resetsAt, resetsIn })
                  : gt("Resets {resetsAt}", { resetsAt })}
              </span>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
        <span>{gt("{used}% used", { used: item.usedPercent })}</span>
        <span className="truncate">{resetsIn ?? item.sourceName}</span>
      </div>
    </div>
  );
}

function VendorOverviewRow({
  summary,
  now,
}: {
  readonly summary: VendorQuotaSummary;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const primary = summary.windows[0] ?? null;
  const primaryBalance = primary ? parseBalanceWindow(primary) : null;
  const brandColor = modelVendorAccentColor(summary.vendor);
  const resetsIn = primary ? formatResetsIn(primary.window, now, m) : null;

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/50 bg-background/50 p-2">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <VendorBrandIcon vendor={summary.vendor} className="size-3.5" />
          <span className="truncate text-xs font-medium text-foreground">
            {modelVendorDisplayName(summary.vendor)}
          </span>
          {summary.viaAntigravityOnly && summary.vendor !== "gemini" ? (
            <Badge variant="outline" size="sm">
              Antigravity
            </Badge>
          ) : null}
        </div>
        {primaryBalance ? (
          <span
            className={cn(
              "shrink-0 text-xs font-semibold tabular-nums",
              primaryBalance.isAvailable ? "text-foreground" : "text-destructive",
            )}
          >
            {primaryBalance.total}
          </span>
        ) : primary ? (
          <span
            className={cn(
              "shrink-0 text-xs font-medium tabular-nums",
              primary.remainingPercent <= 10
                ? "text-destructive"
                : primary.remainingPercent <= 20
                  ? "text-warning-foreground"
                  : "text-foreground",
            )}
          >
            {gt("{remaining}% left", { remaining: primary.remainingPercent })}
          </span>
        ) : (
          <span className="shrink-0 text-2xs text-muted-foreground">--</span>
        )}
      </div>
      {primaryBalance ? (
        <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
          <span>
            {primaryBalance.isAvailable
              ? gt("Balance ({currency})", { currency: primaryBalance.currency })
              : gt("Exhausted")}
          </span>
          <span className="truncate">
            {[
              primaryBalance.toppedUp
                ? gt("Top-up {amount}", { amount: primaryBalance.toppedUp })
                : null,
              primaryBalance.granted
                ? gt("Granted {amount}", { amount: primaryBalance.granted })
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || primary?.sourceName}
          </span>
        </div>
      ) : primary ? (
        <>
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-[width] duration-300 ease-out"
              style={{
                width: `${primary.usedPercent}%`,
                backgroundColor: barFillColor(primary.usedPercent, brandColor),
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
            <span>{gt("{used}% used", { used: primary.usedPercent })}</span>
            <span className="truncate">{resetsIn ?? primary.window.label}</span>
          </div>
        </>
      ) : (
        <span className="text-2xs text-muted-foreground">
          {summary.unavailableMessage ?? gt("No active quota")}
        </span>
      )}
    </div>
  );
}

export const ModelPickerQuotaPanel = memo(function ModelPickerQuotaPanel(props: {
  readonly selectedTab: ProviderInstanceId | "favorites" | ModelVendorTabId;
  readonly isSearching: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: UsageLimitSourceSnapshots;
  readonly environmentId: EnvironmentId | null;
  readonly onRequestClose?: (() => void) | undefined;
  readonly effortSection?: ReactNode;
  readonly onFocusSearch?: (() => void) | undefined;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const [refreshing, setRefreshing] = useState(false);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const handleRefresh = () => {
    if (!props.environmentId || refreshing) return;
    setRefreshing(true);
    void refreshProviders({
      environmentId: props.environmentId,
      input: { usageLimitsOnly: true },
    }).finally(() => {
      setRefreshing(false);
    });
  };

  const vendorQuotas = collectVendorQuotas({
    providers: props.providers,
    sources: props.sources,
    now,
  });

  const selectedVendor = props.isSearching ? null : parseModelVendorTabId(props.selectedTab);
  const selectedProvider =
    !props.isSearching && selectedVendor === null && props.selectedTab !== "favorites"
      ? props.providers.find((provider) => provider.instanceId === props.selectedTab)
      : undefined;
  const instanceQuota = selectedProvider
    ? collectProviderInstanceQuota({ provider: selectedProvider, now })
    : null;

  const showVendorOverview =
    props.isSearching || (selectedVendor === null && instanceQuota === null);

  const selectedVendorSummary = selectedVendor ? vendorQuotas[selectedVendor] : null;

  return (
    <aside
      data-model-picker-quota="true"
      className="flex w-60 shrink-0 flex-col border-l border-border/70 bg-muted/25 max-sm:hidden"
      aria-label={gt("Quota usage")}
    >
      <div className="flex items-center justify-between gap-1.5 border-b border-border/70 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {selectedVendor ? (
            <>
              <VendorBrandIcon vendor={selectedVendor} className="size-3.5" />
              <span className="truncate text-xs font-medium text-foreground">
                {modelVendorDisplayName(selectedVendor)}
              </span>
              {selectedVendorSummary?.viaAntigravityOnly && selectedVendor !== "gemini" ? (
                <Badge variant="outline" size="sm" className="shrink-0">
                  Antigravity
                </Badge>
              ) : null}
            </>
          ) : instanceQuota && selectedProvider ? (
            <>
              <ProviderInstanceIcon
                driverKind={selectedProvider.driver}
                displayName={instanceQuota.title}
                accentColor={selectedProvider.accentColor}
                className="size-3.5"
                iconClassName="size-3.5"
              />
              <span className="truncate text-xs font-medium text-foreground">
                {instanceQuota.title}
              </span>
            </>
          ) : (
            <span className="truncate text-xs font-medium text-foreground">
              <T>Vendor quotas</T>
            </span>
          )}
        </div>
        {props.environmentId ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  aria-label={gt("Refresh quota")}
                >
                  <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} />
                </Button>
              }
            />
            <TooltipPopup side="top">
              <T>Refresh quota</T>
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {showVendorOverview ? (
          MODEL_VENDOR_IDS.map((vendor) => (
            <VendorOverviewRow key={vendor} summary={vendorQuotas[vendor]} now={now} />
          ))
        ) : selectedVendorSummary ? (
          selectedVendorSummary.windows.length > 0 ? (
            <>
              {selectedVendor === "claude" && selectedVendorSummary.viaAntigravityOnly ? (
                <p className="text-2xs leading-snug text-muted-foreground">
                  <T>Opus & Claude quota from your Antigravity account.</T>
                </p>
              ) : null}
              {selectedVendorSummary.windows.map((item) => (
                <QuotaProgressBar
                  key={item.key}
                  item={item}
                  brandColor={modelVendorAccentColor(selectedVendorSummary.vendor)}
                  now={now}
                />
              ))}
            </>
          ) : (
            <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <p>
                {selectedVendorSummary.unavailableMessage ??
                  gt("No active quota for {vendor}.", {
                    vendor: modelVendorDisplayName(selectedVendorSummary.vendor),
                  })}
              </p>
            </div>
          )
        ) : instanceQuota ? (
          instanceQuota.windows.length > 0 ? (
            instanceQuota.windows.map((item) => (
              <QuotaProgressBar
                key={item.key}
                item={item}
                brandColor={
                  item.sourceDriver === "claudeAgent"
                    ? "#d97757"
                    : item.sourceDriver === "antigravity"
                      ? "#5b87bf"
                      : "var(--primary)"
                }
                now={now}
              />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">
              {instanceQuota.unavailableMessage ?? gt("No quota data available.")}
            </p>
          )
        ) : null}
      </div>

      {props.effortSection ? (
        <div
          data-model-picker-effort
          className="shrink-0 border-t border-border/70 bg-muted/40"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" || event.altKey || event.ctrlKey || event.metaKey) return;
            if (
              event.target instanceof HTMLElement &&
              event.target.getAttribute("role") === "slider"
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            props.onFocusSearch?.();
          }}
        >
          {props.effortSection}
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-border/70 px-3 py-1.5 text-2xs text-muted-foreground">
        <InlineButton
          onClick={() => {
            props.onRequestClose?.();
            void navigate({ to: "/usage" });
          }}
        >
          <T>Usage details</T>
        </InlineButton>
      </div>
    </aside>
  );
});
