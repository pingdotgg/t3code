import { useAtomValue } from "@effect/atom-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getProviderUsageRows,
  type ProviderUsageRowView,
  type ProviderUsageTone,
} from "./SidebarProviderUsage.logic";

const TONE_TEXT_STYLES: Record<ProviderUsageTone, string> = {
  default: "text-muted-foreground",
  warning: "text-warning",
  critical: "text-destructive",
};

const RING_SIZE = 14;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function UsageRing({ usedPercent }: { usedPercent: number }) {
  const filled = (usedPercent / 100) * RING_CIRCUMFERENCE;
  return (
    <svg
      aria-hidden="true"
      className="-rotate-90 shrink-0"
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      width={RING_SIZE}
    >
      <circle
        className="opacity-25"
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        fill="none"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeWidth={RING_STROKE}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        fill="none"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
        strokeLinecap="round"
        strokeWidth={RING_STROKE}
      />
    </svg>
  );
}

function ProviderUsageRow({ row }: { row: ProviderUsageRowView }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-label={`${row.name} usage`}
            className="flex h-6 w-full cursor-default items-center gap-2 rounded-md px-2 text-xs"
          >
            <ProviderInstanceIcon
              className="size-4"
              displayName={row.name}
              driverKind={row.driver}
              iconClassName="size-3.5"
              {...(row.accentColor !== undefined ? { accentColor: row.accentColor } : {})}
            />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.name}</span>
            <span className="flex shrink-0 items-center gap-1.5 font-medium tabular-nums">
              {row.windows.map((window) => (
                <span
                  key={window.key}
                  className={`flex items-center gap-1 ${TONE_TEXT_STYLES[window.tone]}`}
                >
                  <span className="font-normal opacity-70">{window.label}</span>
                  <UsageRing usedPercent={window.usedPercent} />
                  {window.percentLabel}
                </span>
              ))}
            </span>
          </div>
        }
      />
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          {row.windows.map((window) => (
            <span key={window.key}>
              {window.label} — {window.percentLabel} used
              {window.resetsAtLabel !== undefined ? `, ${window.resetsAtLabel}` : ""}
            </span>
          ))}
          <span className="text-muted-foreground">{row.updatedAgoLabel}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Always-visible per-provider account usage (rate-limit windows) rendered
 * in the sidebar footer above the settings button. Providers appear as
 * soon as they report usage data and keep their registry order.
 */
export function SidebarProviderUsage() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  // Minute tick re-renders relative labels; the precise clock is read fresh.
  useNowMinute();
  const rows = getProviderUsageRows(providers, Date.now());

  if (rows.length === 0) {
    return null;
  }

  return (
    <div aria-label="AI provider usage" className="flex flex-col" role="group">
      {rows.map((row) => (
        <ProviderUsageRow key={row.key} row={row} />
      ))}
    </div>
  );
}
