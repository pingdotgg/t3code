import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  formatResetsIn,
  remainingPercent as windowRemainingPercent,
  usageLimitsMeterWindow,
  windowExpired,
} from "@t3tools/shared/usageLimits";

import { useNowMinute } from "~/hooks/useNowMinute";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * How much of the selected provider's subscription is left, in the width of a
 * word. Opt-in, and a shortcut into the existing `/usage-limits` panel rather
 * than a surface of its own: the meter answers "can I keep going", the panel
 * answers everything else.
 *
 * A reading whose window has already rolled over shows as unknown. The quota
 * it reports belongs to a window that no longer exists, so drawing it as a
 * full bar would promise headroom nobody has measured.
 */
export function UsageLimitsMeter(props: {
  limits: ServerProviderUsageLimits | undefined;
  providerLabel: string;
  size: ComposerControlSize;
  onOpen: (() => void) | undefined;
}) {
  const { limits, providerLabel, size, onOpen } = props;
  // The app's shared minute clock, not a timer of our own: the countdown and
  // the rollover into "expired" stay honest, and the meter repaints at most
  // once a minute instead of continuously.
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const window = usageLimitsMeterWindow(limits);
  if (!window) return null;

  const remainingPercent = windowRemainingPercent(window);
  const stale = windowExpired(window, now);
  const fillColor =
    remainingPercent <= 5
      ? "var(--color-error)"
      : remainingPercent <= 20
        ? "var(--color-warning)"
        : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const resets = stale ? null : formatResetsIn(window, now);
  const label = stale
    ? `Usage limits: ${window.label} reading expired`
    : `Usage limits: ${remainingPercent}% of ${window.label} left`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={size}
            type="button"
            aria-label={label}
            className="shrink-0 gap-1.5 whitespace-nowrap"
            aria-disabled={onOpen === undefined || undefined}
            // Footer controls never take the caret from the editor.
            onPointerDown={(event) => event.preventDefault()}
            onClick={onOpen}
          />
        }
      >
        <span
          className="h-1 w-14 shrink-0 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(stale ? {} : { "aria-valuenow": remainingPercent })}
          style={{
            backgroundColor: "color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)",
          }}
        >
          {stale ? null : (
            <span
              className="block h-full rounded-full"
              style={{ width: `${remainingPercent}%`, backgroundColor: fillColor }}
            />
          )}
        </span>
        <span aria-hidden="true" className="tabular-nums">
          {stale ? "—" : `${remainingPercent}%`}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {stale
          ? `${providerLabel} · ${window.label}: reading expired, send a message to refresh`
          : `${providerLabel} · ${window.label}: ${remainingPercent}% left${resets ? ` · ${resets}` : ""}`}
      </TooltipPopup>
    </Tooltip>
  );
}
