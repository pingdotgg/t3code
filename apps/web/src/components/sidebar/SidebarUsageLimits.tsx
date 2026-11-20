import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";
import { type SidebarUsageSummary, sidebarUsageSummaries } from "./sidebarUsageLimits.logic";

const LOW_REMAINING_PERCENT = 20;

export function SidebarUsageLimits() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // Only the hidden pace and blocked-session clocks read this; reset times read their own.
  const [now] = useState(() => Date.now());
  const summaries = sidebarUsageSummaries(
    collectLimitPools(collectLimitAccounts(presentations), now),
  );
  if (summaries.length === 0) return null;

  const openLimits = () => {
    if (isMobile) setOpenMobile(false);
    saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
    void navigate({ to: "/usage" });
  };

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <div className="flex items-center gap-0.5">
        {summaries.map((summary) => (
          <SidebarUsageChip key={summary.driver} summary={summary} onClick={openLimits} />
        ))}
      </div>
    </SidebarMenuItem>
  );
}

function SidebarUsageChip({
  summary,
  onClick,
}: {
  readonly summary: SidebarUsageSummary;
  readonly onClick: () => void;
}) {
  const gt = useGT();
  const label = providerClients.get(summary.driver)?.label ?? String(summary.driver);
  const low = summary.remainingPercent <= LOW_REMAINING_PERCENT;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={gt("{provider} usage: {percent}% left", {
              provider: label,
              percent: summary.remainingPercent,
            })}
            className={cn(
              "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs tabular-nums outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset",
              low ? "text-warning" : "text-(--sidebar-icon-color)",
            )}
            onClick={onClick}
          />
        }
      >
        <ProviderInstanceIcon
          driverKind={summary.driver}
          displayName={label}
          className="size-4"
          iconClassName="size-3.5"
        />
        {summary.remainingPercent}%
      </TooltipTrigger>
      <TooltipPopup side="top">
        <SidebarUsageTooltip label={label} summary={summary} />
      </TooltipPopup>
    </Tooltip>
  );
}

// Mounts when the tooltip opens, so reset countdowns are read fresh each time.
function SidebarUsageTooltip({
  label,
  summary,
}: {
  readonly label: string;
  readonly summary: SidebarUsageSummary;
}) {
  const gt = useGT();
  const m = useMessages();
  const [now] = useState(() => Date.now());
  return (
    <div className="flex flex-col gap-0.5 text-left">
      <div className="font-medium">{gt("{provider} usage left", { provider: label })}</div>
      {summary.windows.map((window) => {
        const nextReset = window.resets.find((reset) => reset.at > now);
        return (
          <div key={`${window.kind}:${window.id}`} className="flex justify-between gap-4">
            <span className="text-muted-foreground">{window.label}</span>
            <span className="tabular-nums">
              {window.remainingPercent}%
              {nextReset ? (
                <span className="text-muted-foreground">
                  {" · "}
                  {gt("resets in {duration}", { duration: formatDuration(nextReset.at - now, m) })}
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
