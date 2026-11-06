import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
} from "@t3tools/shared/usageLimits";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { observeResize } from "../../lib/observeResize";
import { environmentPresentations } from "../../state/presentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";

export function SidebarProviderUsage({ onClick }: { readonly onClick: () => void }) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const entries = Object.values(PROVIDER_PRESENTATION).flatMap((provider) => {
    const pool = pools.find((entry) => entry.driver === provider.driverKind);
    const configured = [...presentations.values()].some((presentation) =>
      presentation.serverConfig?.providers.some(
        (entry) => entry.driver === provider.driverKind && entry.enabled && entry.installed,
      ),
    );
    if (!pool && !configured) return [];
    const window = pool ? displayLimitWindows(pool)[0] : undefined;
    const expired = window?.members.some(
      (member) => member.window.resetsAt && Date.parse(member.window.resetsAt) <= now,
    );
    return [{ ...provider, window, left: expired ? null : (window?.remainingPercent ?? null) }];
  });
  const [capacity, setCapacity] = useState(0);
  const observeWidth = (element: HTMLLIElement) =>
    observeResize(element, ([entry]) => {
      if (entry) setCapacity(Math.max(0, Math.floor((entry.contentRect.width + 4) / 36)));
    });

  return (
    <SidebarMenuItem
      className="min-w-8 flex-initial"
      ref={observeWidth}
      style={{ width: Math.max(32, entries.length * 36 - 4) }}
    >
      <div className="flex min-w-0 items-center gap-1" data-provider-usage>
        {entries.length === 0 || capacity === 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={<SidebarMenuButton aria-label="Usage" onClick={onClick} size="icon" />}
            >
              <ChartNoAxesColumnIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Usage</TooltipPopup>
          </Tooltip>
        ) : (
          entries.slice(0, capacity).map((entry) => {
            const label = `${entry.label}: ${entry.left === null ? "usage unavailable" : `${entry.left}% left`}`;
            return (
              <Tooltip key={entry.driverKind}>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      aria-label={`${label}. Open Usage`}
                      onClick={onClick}
                      size="icon"
                    />
                  }
                >
                  <span
                    className="relative grid size-4 shrink-0 place-items-center"
                    data-usage-glyph
                  >
                    <svg
                      aria-hidden
                      className="pointer-events-none absolute inset-0 size-4"
                      viewBox="0 0 16 16"
                    >
                      <circle
                        cx="8"
                        cy="8"
                        r="7"
                        fill="none"
                        className={
                          entry.left === 0 ? "stroke-error/40" : "stroke-sidebar-foreground/20"
                        }
                        strokeWidth="1"
                        strokeDasharray={entry.left === null ? "1 2" : undefined}
                      />
                      {entry.left !== null && entry.left > 0 ? (
                        <circle
                          cx="8"
                          cy="8"
                          r="7"
                          fill="none"
                          pathLength="100"
                          strokeWidth="1"
                          strokeDasharray={`${entry.left} 100`}
                          strokeLinecap="round"
                          transform="rotate(-90 8 8)"
                          className={
                            entry.left <= 10
                              ? "stroke-error"
                              : entry.left <= 20
                                ? "stroke-warning"
                                : "stroke-success"
                          }
                        />
                      ) : null}
                    </svg>
                    <ProviderInstanceIcon
                      driverKind={entry.driverKind}
                      displayName={entry.label}
                      className="absolute inset-0 grid place-items-center"
                      iconClassName="block size-[9px]"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {label}
                  {entry.window ? ` · ${entry.window.label}` : ""}
                </TooltipPopup>
              </Tooltip>
            );
          })
        )}
      </div>
    </SidebarMenuItem>
  );
}
