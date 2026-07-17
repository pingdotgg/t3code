import type { ProviderUsageSnapshot } from "@t3tools/contracts";
import {
  formatProviderUsageCredits,
  formatProviderUsageReset,
  providerUsageCreditsHaveMeter,
  providerUsageCreditsUsedPercent,
  providerUsageDisplayName,
  providerUsagePercentLeft,
  type ProviderUsageCard,
} from "@t3tools/client-runtime/provider-usage";
import { CircleAlertIcon, CircleUserRoundIcon } from "lucide-react";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { cn } from "~/lib/utils";

export type ProviderUsagePresentation = Pick<
  ProviderUsageCard,
  | "account"
  | "credits"
  | "displayName"
  | "driver"
  | "fetchedAt"
  | "instanceId"
  | "message"
  | "planLabel"
  | "sourceNodes"
  | "status"
  | "windows"
>;

export function providerUsagePresentationFromSnapshot(
  snapshot: ProviderUsageSnapshot,
  sourceNodes: ReadonlyArray<string> = [],
): ProviderUsagePresentation {
  return {
    account: snapshot.account,
    credits: snapshot.credits,
    displayName: providerUsageDisplayName(snapshot.driver, snapshot.displayName),
    driver: snapshot.driver,
    fetchedAt: snapshot.fetchedAt,
    instanceId: snapshot.instanceId,
    message: snapshot.message,
    planLabel: snapshot.planLabel,
    sourceNodes,
    status: snapshot.status,
    windows: snapshot.windows,
  };
}

export interface ProviderUsageHeadline {
  readonly label: string;
  readonly usedPercent: number | null;
}

/** Pick the account limit with the least capacity remaining for compact UI. */
export function deriveProviderUsageHeadline(
  usage: ProviderUsagePresentation,
): ProviderUsageHeadline | null {
  if (usage.status !== "ok") return null;
  const mostConstrainedWindow = usage.windows.reduce<(typeof usage.windows)[number] | null>(
    (current, window) =>
      current === null || window.usedPercent > current.usedPercent ? window : current,
    null,
  );
  if (mostConstrainedWindow) {
    return {
      label: `${Math.round(providerUsagePercentLeft(mostConstrainedWindow.usedPercent))}% left`,
      usedPercent: mostConstrainedWindow.usedPercent,
    };
  }
  if (!usage.credits) return null;
  const label = formatProviderUsageCredits(usage.credits)?.split(" · ")[0] ?? null;
  return label
    ? {
        label,
        usedPercent: providerUsageCreditsHaveMeter(usage.credits)
          ? providerUsageCreditsUsedPercent(usage.credits)
          : null,
      }
    : null;
}

export function ProviderUsageIdentity({
  usage,
  compact = false,
}: {
  usage: ProviderUsagePresentation;
  compact?: boolean;
}) {
  const subtitle = buildProviderUsageSubtitle(usage.account, usage.sourceNodes);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <ProviderInstanceIcon
        driverKind={usage.driver}
        displayName={usage.displayName}
        className={compact ? "size-5" : "size-7"}
        iconClassName={compact ? "size-4" : "size-6"}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate font-semibold", compact ? "text-xs" : "text-sm")}>
            {usage.displayName}
          </span>
          {usage.planLabel ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {usage.planLabel}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <div className="truncate text-[11px] text-muted-foreground/70" title={subtitle}>
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ProviderUsageDetails({
  usage,
  nowMs,
  compact = false,
}: {
  usage: ProviderUsagePresentation;
  nowMs: number;
  compact?: boolean;
}) {
  if (usage.status === "unsupported") {
    return (
      <p className="text-xs text-muted-foreground">Usage isn't available for this provider.</p>
    );
  }

  if (usage.status !== "ok") {
    const isError = usage.status === "error";
    const Icon = isError ? CircleAlertIcon : CircleUserRoundIcon;
    return (
      <div
        className={cn(
          "flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-xs",
          isError ? "bg-destructive/8 text-destructive" : "bg-muted/60 text-muted-foreground",
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span>
          {usage.message ??
            (isError ? "Couldn't load provider usage." : "Sign in to see provider usage.")}
        </span>
      </div>
    );
  }

  const formattedCredits = usage.credits ? formatProviderUsageCredits(usage.credits) : null;
  if (usage.windows.length === 0 && !formattedCredits) {
    return <p className="text-xs text-muted-foreground">No active limits reported.</p>;
  }

  return (
    <div className={cn("grid", compact ? "gap-3.5" : "gap-5")}>
      {usage.windows.map((window) => (
        <ProviderUsageWindowRow
          key={window.id}
          label={window.label}
          usedPercent={window.usedPercent}
          {...(window.resetsAt ? { resetsAt: window.resetsAt } : {})}
          nowMs={nowMs}
          compact={compact}
        />
      ))}
      {usage.credits && formattedCredits ? (
        <ProviderUsageWindowRow
          label={usage.credits.label}
          usedPercent={
            providerUsageCreditsHaveMeter(usage.credits)
              ? providerUsageCreditsUsedPercent(usage.credits)
              : null
          }
          valueText={formattedCredits}
          compact={compact}
        />
      ) : null}
    </div>
  );
}

export function ProviderUsageWindowRow({
  label,
  usedPercent,
  resetsAt,
  nowMs,
  valueText,
  compact = false,
}: {
  label: string;
  usedPercent: number | null;
  resetsAt?: string;
  nowMs?: number;
  valueText?: string;
  compact?: boolean;
}) {
  const resets = nowMs === undefined ? null : formatProviderUsageReset(resetsAt, nowMs);
  const left =
    valueText ??
    (usedPercent === null ? "" : `${Math.round(providerUsagePercentLeft(usedPercent))}% left`);
  return (
    <div className={cn("grid", compact ? "gap-1.5" : "gap-2")}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate font-medium text-foreground/90">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{left}</span>
      </div>
      {usedPercent === null ? null : (
        <ProviderUsageMeter usedPercent={usedPercent} label={`${label} usage`} />
      )}
      {resets ? (
        <div className="text-right text-[10px] tabular-nums text-muted-foreground/65">{resets}</div>
      ) : null}
    </div>
  );
}

export function ProviderUsageMeter({ usedPercent, label }: { usedPercent: number; label: string }) {
  const used = Math.max(0, Math.min(100, usedPercent));
  const fillWidth = Math.max(used, used > 0 ? 2 : 0);
  const fillClass = used >= 95 ? "bg-red-500" : used >= 75 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-muted/70"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(used)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none",
          fillClass,
        )}
        style={{ width: `${fillWidth}%` }}
      />
    </div>
  );
}

export function buildProviderUsageSubtitle(
  account: string | undefined,
  sourceNodes: ReadonlyArray<string>,
): string | null {
  const parts: string[] = [];
  if (account) parts.push(account);
  if (sourceNodes.length > 1) parts.push(`via ${sourceNodes.join(", ")}`);
  else if (sourceNodes.length === 1) parts.push(sourceNodes[0]!);
  return parts.length > 0 ? parts.join(" · ") : null;
}
