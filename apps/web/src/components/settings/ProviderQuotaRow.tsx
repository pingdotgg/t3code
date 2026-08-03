/**
 * Plan tier + quota meters for a provider instance (fork f1, increment 2).
 *
 * Renders nothing at all unless the server actually sent quota, so an
 * upstream server, a non-Codex driver and a signed-out instance all look
 * exactly as they did before.
 *
 * The data rides the provider snapshot that already streams to every client:
 * this component reads props and never fetches, so mounting it in a list of
 * provider cards costs no requests.
 */
import type { ServerProvider } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import {
  hasProviderQuota,
  providerPlanLabel,
  providerQuotaMeters,
  providerQuotaNotice,
  providerUsageSummary,
  type ProviderQuotaTone,
} from "./providerQuotaPresentation.ts";

const TONE_BAR: Readonly<Record<ProviderQuotaTone, string>> = {
  normal: "bg-foreground/45",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

export const ProviderQuotaRow = memo(function ProviderQuotaRow({
  provider,
  className,
}: {
  provider: ServerProvider | null | undefined;
  className?: string;
}) {
  const auth = provider?.auth;
  // Evaluated once per render, never on a timer: the countdown refreshes when
  // the next snapshot lands, which is also when the number stops being a lie.
  const now = Date.now();
  if (!auth || !hasProviderQuota(auth, now)) {
    return null;
  }

  const planLabel = providerPlanLabel(auth);
  const meters = providerQuotaMeters(auth, now);
  const usage = providerUsageSummary(auth);
  const notice = providerQuotaNotice(auth, now);
  const creditBalance = auth.rateLimits?.creditBalance;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {planLabel || creditBalance ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground/80">
          {planLabel ? (
            <span className="rounded bg-muted/60 px-1.5 py-px text-[11px] text-foreground/75">
              {planLabel}
            </span>
          ) : null}
          {creditBalance ? <span>{creditBalance} credits</span> : null}
        </div>
      ) : null}
      {meters.length > 0 ? (
        <dl className="flex flex-col gap-1">
          {meters.map((meter) => (
            <div key={meter.id} className="flex min-w-0 items-center gap-2">
              <dt className="w-28 shrink-0 truncate text-[11px] text-muted-foreground/70">
                {meter.label}
              </dt>
              <dd className="flex min-w-0 flex-1 items-center gap-2">
                <div
                  className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                  role="meter"
                  aria-label={`${meter.label} used`}
                  aria-valuenow={Math.round(meter.usedPercent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className={cn("h-full rounded-full", TONE_BAR[meter.tone])}
                    style={{ width: `${Math.min(100, Math.max(0, meter.usedPercent))}%` }}
                  />
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80">
                  {Math.round(meter.usedPercent)}%
                </span>
                {meter.detail ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground/60">
                    {meter.detail}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {usage ? <p className="text-[11px] text-muted-foreground/70">{usage}</p> : null}
      {notice ? <p className="text-[11px] text-warning">{notice}</p> : null}
    </div>
  );
});
