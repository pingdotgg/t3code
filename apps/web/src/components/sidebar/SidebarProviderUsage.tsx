import { useAtomValue } from "@effect/atom-react";
import { Fragment } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { primaryServerProvidersAtom } from "../../state/server";
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

function ProviderUsageRow({ row }: { row: ProviderUsageRowView }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-label={`${row.name} usage`}
            className="flex h-6 w-full cursor-default items-center gap-2 rounded-md px-2 text-xs"
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.name}</span>
            <span className="flex shrink-0 items-center gap-1 font-medium tabular-nums">
              {row.windows.map((window, index) => (
                <Fragment key={window.key}>
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-muted-foreground/50">
                      ·
                    </span>
                  ) : null}
                  <span className={TONE_TEXT_STYLES[window.tone]}>
                    <span className="opacity-70">{window.label}</span> {window.percentLabel}
                  </span>
                </Fragment>
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
