import type {
  ProviderBankedReset,
  ProviderQuotaMetric,
  ProviderQuotaSnapshot,
} from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { memo } from "react";

import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import {
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import type { ProviderUsageStripItem } from "../sidebar/ProviderUsageStrip.logic";

function formatPercentage(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatWindow(minutes: number): string {
  if (minutes === 0) return "0 minutes";
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function detailLabel(value: string): string {
  const spaced = value.replace(/[_-]+/gu, " ").replace(/([a-z])([A-Z])/gu, "$1 $2");
  return `${spaced.slice(0, 1).toUpperCase()}${spaced.slice(1)}`;
}

function ProviderQuotaMetricDetails({ metric }: { readonly metric: ProviderQuotaMetric }) {
  const remainingPercent =
    metric.remainingPercent === null ? null : Math.min(100, Math.max(0, metric.remainingPercent));
  return (
    <section className="border-t border-border/70 py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{metric.label}</h3>
        {metric.blocking ? (
          <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Blocking
          </span>
        ) : null}
      </div>
      {remainingPercent === null ? null : (
        <div
          aria-label={`${metric.label}: ${formatPercentage(remainingPercent)} remaining`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={remainingPercent}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-foreground/75"
            style={{ width: `${remainingPercent}%` }}
          />
        </div>
      )}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {remainingPercent === null ? null : (
          <>
            <dt className="text-muted-foreground">Remaining</dt>
            <dd>{formatPercentage(remainingPercent)} remaining</dd>
          </>
        )}
        {metric.usedPercent === null ? null : (
          <>
            <dt className="text-muted-foreground">Used</dt>
            <dd>{formatPercentage(metric.usedPercent)} used</dd>
          </>
        )}
        {metric.resetsAt === null ? null : (
          <>
            <dt className="text-muted-foreground">Resets</dt>
            <dd>
              <time dateTime={metric.resetsAt}>{formatDate(metric.resetsAt)}</time>
            </dd>
          </>
        )}
        {metric.windowMinutes === null ? null : (
          <>
            <dt className="text-muted-foreground">Window</dt>
            <dd>{formatWindow(metric.windowMinutes)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function ProviderQuotaCreditsDetails({ snapshot }: { readonly snapshot: ProviderQuotaSnapshot }) {
  const credits = snapshot.credits;
  if (credits === null) return null;
  return (
    <section>
      <h3 className="font-medium text-sm">Credits</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {credits.unlimited
          ? "Unlimited"
          : (credits.balance ?? (credits.hasCredits ? "Credits available" : "No credits"))}
      </p>
    </section>
  );
}

function ProviderResetRow({
  canOperate,
  onRequestReset,
  pending,
  reset,
}: {
  readonly canOperate: boolean;
  readonly onRequestReset: (reset: ProviderBankedReset) => void;
  readonly pending: boolean;
  readonly reset: ProviderBankedReset;
}) {
  const title = reset.title ?? detailLabel(reset.resetType);
  return (
    <li className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-sm">{title}</p>
          {reset.description ? (
            <p className="mt-1 text-xs text-muted-foreground">{reset.description}</p>
          ) : null}
        </div>
        {canOperate && reset.status === "available" ? (
          <Button
            disabled={pending}
            size="xs"
            variant="outline"
            onClick={() => onRequestReset(reset)}
          >
            Use reset
          </Button>
        ) : null}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Type</dt>
        <dd>{detailLabel(reset.resetType)}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{detailLabel(reset.status)}</dd>
        <dt className="text-muted-foreground">Granted</dt>
        <dd>
          <time dateTime={reset.grantedAt}>{formatDate(reset.grantedAt)}</time>
        </dd>
        {reset.expiresAt === null ? null : (
          <>
            <dt className="text-muted-foreground">Expires</dt>
            <dd>
              <time dateTime={reset.expiresAt}>{formatDate(reset.expiresAt)}</time>
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}

export const ProviderQuotaDetails = memo(function ProviderQuotaDetails({
  canOperate,
  feedback,
  item,
  onRequestReset,
  pendingReset,
}: {
  readonly canOperate: boolean;
  readonly feedback: string | null;
  readonly item: ProviderUsageStripItem;
  readonly onRequestReset: (reset: ProviderBankedReset | null) => void;
  readonly pendingReset: boolean;
}) {
  const snapshot = item.snapshot;
  const Icon = PROVIDER_ICON_BY_PROVIDER[item.driver] ?? BotIcon;
  const canUseCodexReset = snapshot?.status === "current" && canOperate && item.driver === "codex";
  const bankedResets = snapshot?.bankedResets ?? null;
  const showCountOnlyCodexReset =
    canUseCodexReset &&
    bankedResets !== null &&
    bankedResets.availableCount > 0 &&
    bankedResets.resets.length === 0;

  return (
    <div className="w-full min-w-0 space-y-4 text-foreground">
      <header className="flex items-center gap-2.5">
        <Icon aria-hidden="true" className="size-5 shrink-0" />
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-sm">{item.displayName}</h2>
          {snapshot ? (
            <p className="text-xs text-muted-foreground">
              {detailLabel(snapshot.status)} · {snapshot.source}
            </p>
          ) : null}
        </div>
      </header>

      {snapshot === null ? (
        <p className="text-sm text-muted-foreground">
          This provider does not provide normalized quota details on the connected server.
        </p>
      ) : (
        <>
          {snapshot.lastSuccessfulReadAt === null ? null : (
            <p className="text-xs text-muted-foreground">
              Last successful read{" "}
              <time dateTime={snapshot.lastSuccessfulReadAt}>
                {formatDate(snapshot.lastSuccessfulReadAt)}
              </time>
            </p>
          )}
          {snapshot.status === "unknown" ? (
            <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
              This provider did not return a supported normalized quota snapshot.
            </p>
          ) : null}
          {snapshot.message ? (
            <p className="rounded-lg bg-muted/40 p-3 text-sm">{snapshot.message.slice(0, 512)}</p>
          ) : null}
          {snapshot.metrics.map((metric) => (
            <ProviderQuotaMetricDetails key={metric.key} metric={metric} />
          ))}
          <ProviderQuotaCreditsDetails snapshot={snapshot} />
          {snapshot.bankedResets === null ? null : (
            <section>
              <h3 className="font-medium text-sm">Banked resets</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {snapshot.bankedResets.availableCount} available
                {snapshot.bankedResets.detailsComplete ? "" : " · Details may be incomplete"}
              </p>
              <ul className="mt-2 space-y-2">
                {snapshot.bankedResets.resets.map((reset) => (
                  <ProviderResetRow
                    key={reset.id}
                    canOperate={canUseCodexReset}
                    onRequestReset={onRequestReset}
                    pending={pendingReset}
                    reset={reset}
                  />
                ))}
              </ul>
              {showCountOnlyCodexReset ? (
                <Button
                  className="mt-2"
                  disabled={pendingReset}
                  size="xs"
                  variant="outline"
                  onClick={() => onRequestReset(null)}
                >
                  Use reset
                </Button>
              ) : null}
            </section>
          )}
          {Object.keys(snapshot.detail).length === 0 ? null : (
            <section>
              <h3 className="font-medium text-sm">Details</h3>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {Object.entries(snapshot.detail).map(([key, value]) => (
                  <div className="contents" key={key}>
                    <dt className="text-muted-foreground">{detailLabel(key)}</dt>
                    <dd className="min-w-0 break-words">{value.slice(0, 512)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      )}
      <p aria-live="polite" className={feedback ? "rounded-lg bg-muted/40 p-3 text-sm" : "sr-only"}>
        {feedback ?? ""}
      </p>
    </div>
  );
});

export function ProviderQuotaResetConfirmationContent({
  onCancel,
  onConfirm,
  pending,
  reset,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly pending: boolean;
  readonly reset: ProviderBankedReset | null;
}) {
  const title = reset === null ? "banked reset" : (reset.title ?? detailLabel(reset.resetType));
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Use {title}?</AlertDialogTitle>
        <AlertDialogDescription>
          This will apply {title}.{" "}
          {reset === null ? (
            "No specific reset credit was reported; the provider will select the next available reset."
          ) : reset.expiresAt === null ? (
            "No expiry is reported for this reset."
          ) : (
            <>
              It expires <time dateTime={reset.expiresAt}>{formatDate(reset.expiresAt)}</time>.
            </>
          )}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <Button disabled={pending} variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={pending} onClick={onConfirm}>
          Confirm reset
        </Button>
      </AlertDialogFooter>
    </>
  );
}
