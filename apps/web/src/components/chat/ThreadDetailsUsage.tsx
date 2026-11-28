import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  type LimitPace,
  type LimitPoolWindow,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { msg, useGT, useLocale, useMessages } from "gt-react";
import { CalendarRangeIcon, GaugeIcon, Minimize2Icon, TimerIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentScope } from "../../state/session";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageAccessDialog } from "../usage/UsageAccessDialog";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  nextPoolReset,
  poolSources,
  resolveThreadDetailsLimits,
  resolveThreadHttpQuotas,
} from "./ThreadDetailsUsage.logic";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};
export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}
export type UsageTone = "error" | "warning" | null;

function limitTone(left: number): UsageTone {
  if (left <= 10) return "error";
  if (left <= 20) return "warning";
  return null;
}

/** Provider limits share the canvas's icon, label, meter, percentage and reset columns; each row opens the usage page. */
export function ThreadDetailsUsage({
  environmentId,
  providerInstanceId,
  model,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow"> & { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  const quotas = resolveThreadHttpQuotas(providerInstanceId, sources);
  const limits = resolved?.kind === "instance" ? resolved.limits : null;
  const notice =
    resolved === null
      ? gt("This provider has not reported usage limits.")
      : limits
        ? limitsNotice(limits, m)
        : null;
  const showUnavailable =
    resolved?.kind !== "pool" &&
    quotas.length === 0 &&
    (notice !== null || !limits?.windows.length);
  return (
    <ThreadDetailsSection title={gt("Usage limits")} variant="usage">
      {limits?.needsUsageAccess && providerInstanceId !== null ? (
        <>
          <UsageAccessRow
            environmentId={environmentId}
            instanceId={providerInstanceId}
            providers={providers}
          />
          {quotas.map(({ key, accountLabel, window }) => (
            <LimitRow key={key} window={window} now={now} accountLabel={accountLabel} />
          ))}
        </>
      ) : showUnavailable ? (
        <UsageRow
          label={gt("Limits", { $context: "usage limits row label" })}
          icon={<TimerIcon />}
          fill={null}
          tone={null}
          value={gt("Unavailable")}
          tooltip={notice ?? gt("No usage windows reported.")}
          opensUsage
        />
      ) : (
        <>
          {resolved?.kind === "pool"
            ? resolved.windows.map((window) => (
                <PoolRow key={window.id} window={window} now={now} />
              ))
            : limits && !notice
              ? limits.windows.map((window) => (
                  <LimitRow key={window.id} window={window} now={now} />
                ))
              : null}
          {quotas.map(({ key, accountLabel, window }) => (
            <LimitRow key={key} window={window} now={now} accountLabel={accountLabel} />
          ))}
        </>
      )}
    </ThreadDetailsSection>
  );
}

/** Limits that need T3 to read the agent's sign-in, which the user has not allowed yet. */
function UsageAccessRow({
  environmentId,
  instanceId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly providers: readonly ServerProvider[];
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const canAnswer = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  if (provider === undefined) return null;
  return (
    <>
      <div className="flex h-8 items-center gap-2 ps-3 pe-2 text-meta">
        <span className="shrink-0 text-muted-foreground [&>svg]:size-4">
          <TimerIcon />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {gt("Limits", { $context: "usage limits row label" })}
        </span>
        {canAnswer ? (
          <Button size="micro" variant="secondary" onClick={() => setOpen(true)}>
            {gt("Set up", { $context: "allow reading an agent's usage limits" })}
          </Button>
        ) : (
          <span className="text-muted-foreground">{gt("Unavailable")}</span>
        )}
      </div>
      {open ? (
        <UsageAccessDialog
          prompts={[
            {
              environmentId,
              environmentLabel: "",
              instanceId,
              driver: provider.driver,
            },
          ]}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

/** Context fills as tokens are used. Compact follows the composer's real provider command. */
export function ThreadDetailsContext({
  usage,
  onCompact,
  compactDisabled,
  compactDisabledReason,
}: {
  readonly usage: ContextWindowSnapshot | null;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled?: boolean | undefined;
  readonly compactDisabledReason?: string | null | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const maxTokens = usage?.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage?.usedPercentage != null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage?.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const usedTokens = usage ? formatContextWindowTokens(usage.usedTokens) : null;
  return (
    <ThreadDetailsSection title={gt("Context window")} variant="usage">
      <UsageRow
        label={gt("Context", { $context: "context window row label" })}
        icon={<GaugeIcon />}
        fill={used}
        tick={tick}
        tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
        value={
          used !== null
            ? `${used}%`
            : (usedTokens ?? gt("N/A", { $context: "context usage not reported" }))
        }
        ariaValue={
          used !== null
            ? gt("{used}% used", { used })
            : usedTokens
              ? gt("{usedTokens} tokens used", { usedTokens })
              : gt("Not reported", { $context: "context usage" })
        }
        trailing={
          onCompact && usage ? (
            <ThreadDetailsControl
              part="icon"
              aria-label={gt("Compact context")}
              disabled={compactDisabled}
              onClick={onCompact}
            >
              <Minimize2Icon className="size-3.5" />
            </ThreadDetailsControl>
          ) : undefined
        }
        tooltip={
          <>
            <span className="text-foreground">
              {used !== null
                ? gt("Context: {used}% used", { used })
                : usedTokens
                  ? gt("Context: {usedTokens} tokens used", { usedTokens })
                  : gt("The provider has not reported context usage.")}
            </span>
            {usage && maxTokens !== null ? (
              <span>
                {gt("{used} of {max} tokens", {
                  used: usage.usedTokens.toLocaleString(locale),
                  max: maxTokens.toLocaleString(locale),
                })}
              </span>
            ) : null}
            {threshold !== null && threshold > 0 ? (
              <span>{formatContextWindowCompactionMessage(threshold, m)}</span>
            ) : null}
            {compactDisabled && compactDisabledReason ? <span>{compactDisabledReason}</span> : null}
          </>
        }
      />
    </ThreadDetailsSection>
  );
}

function LimitRow({
  window,
  now,
  accountLabel,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly accountLabel?: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const remainingMs = resetsAt - now;
  const weekly = (window.windowDurationMins ?? 0) >= 24 * 60 || /week/i.test(window.label);
  const reset =
    remainingMs > 0
      ? weekly
        ? new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(resetsAt)
        : formatDuration(remainingMs, m)
      : null;
  return (
    <UsageRow
      label={window.label}
      icon={weekly ? <CalendarRangeIcon /> : <TimerIcon />}
      fill={left}
      tone={limitTone(left)}
      tick={timeLeft}
      value={`${left}%`}
      ariaValue={gt("{left}% left", { left })}
      opensUsage
      trailing={
        reset ? (
          <span className="truncate text-caption text-dim-foreground">{reset}</span>
        ) : undefined
      }
      tooltip={
        <>
          <span className="text-foreground">
            {gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {accountLabel ? <span className="text-muted-foreground">{accountLabel}</span> : null}
          {pace && timeLeft !== null ? (
            <span>
              <span className="block">{m(PACE_LABEL[pace])}</span>
              <span className="block">{gt("{timeLeft}% of the window left", { timeLeft })}</span>
            </span>
          ) : null}
          {window.resetsAt && remainingMs > 0 ? (
            <span>
              <span className="block">
                {gt("Resets in {duration}", { duration: formatDuration(remainingMs, m) })}
              </span>
              <span className="block">
                {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)}
              </span>
            </span>
          ) : null}
        </>
      }
    />
  );
}

function PoolRow({ window, now }: { readonly window: LimitPoolWindow; readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = window.remainingPercent;
  const accounts = window.members.length;
  const from = poolSources(window);
  const sourceLabels = [...from.hubs, ...(from.signedIn ? [gt("Signed-in accounts")] : [])];
  const next = nextPoolReset(window, now);
  const resetsAt = next?.member.window.resetsAt;
  const weekly = window.kind === "weekly" || window.kind === "monthly";
  const reset =
    next && resetsAt
      ? {
          duration: formatDuration(next.at - now, m),
          time: formatUpcomingTimestamp(resetsAt, timestampFormat, now, undefined, m),
        }
      : null;
  return (
    <UsageRow
      label={window.label}
      icon={weekly ? <CalendarRangeIcon /> : <TimerIcon />}
      fill={left}
      tone={limitTone(left)}
      tick={window.paceRemainingPercent}
      value={`${left}%`}
      ariaValue={gt("{left}% left", { left })}
      opensUsage
      trailing={
        next ? (
          <span className="truncate text-caption text-dim-foreground">
            {weekly
              ? new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(next.at)
              : formatDuration(next.at - now, m)}
          </span>
        ) : undefined
      }
      tooltip={
        <>
          <span className="text-foreground">
            {accounts > 1
              ? gt("{label}: {left}% left across {accounts} accounts", {
                  label: window.label,
                  left,
                  accounts,
                })
              : gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {window.pace ? <span className="block">{m(PACE_LABEL[window.pace])}</span> : null}
          {next && reset ? (
            <span>
              <span className="block">
                {accounts > 1
                  ? gt("+{percent}% in {duration}", {
                      percent: next.restoresPercent,
                      duration: reset.duration,
                    })
                  : gt("Resets in {duration}", { duration: reset.duration })}
              </span>
              <span className="block">{reset.time}</span>
            </span>
          ) : null}
          {sourceLabels.length > 0 ? (
            <span className="block">
              {gt("From {sources}", { sources: sourceLabels.join(", ") })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** With `opensUsage` the row links to the usage page. */
export function UsageRow({
  label,
  icon,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  trailing,
  opensUsage = false,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly fill: number | null;
  readonly tone: UsageTone;
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly trailing?: ReactNode;
  readonly opensUsage?: boolean;
}) {
  const gt = useGT();
  const rowProps = {
    "aria-label": gt("{label}: {value}", { label, value: ariaValue }),
    className: cn(
      "flex min-w-0 flex-1 items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      opensUsage ? "cursor-pointer" : "cursor-default",
    ),
  };
  return (
    <Tooltip>
      <div className="flex h-8 items-center gap-2 ps-3 pe-2 text-meta">
        <TooltipTrigger
          render={
            opensUsage ? <Link to="/usage" {...rowProps} /> : <div tabIndex={0} {...rowProps} />
          }
        >
          <span className="shrink-0 text-muted-foreground [&>svg]:size-4">{icon}</span>
          <span className="w-14.5 shrink-0 truncate">{label}</span>
          {fill !== null ? (
            <span className="relative h-1 min-w-0 flex-1 rounded-full bg-muted-foreground/20">
              {fill > 0 ? (
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    tone === "error"
                      ? "bg-error"
                      : tone === "warning"
                        ? "bg-warning"
                        : "bg-foreground/80",
                  )}
                  style={{ width: `max(${fill}%, 2px)` }}
                />
              ) : null}
              {tick !== null ? (
                <span
                  aria-hidden
                  className="absolute -top-[3px] h-2.5 w-0.5 rounded-sm bg-muted-foreground"
                  style={{ left: `${tick}%` }}
                />
              ) : null}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <span
            className={cn(
              "w-7.5 shrink-0 text-end tabular-nums text-muted-foreground",
              fill === null && "w-auto",
              tone === "error" && "text-error-foreground",
              tone === "warning" && "text-warning-foreground",
            )}
          >
            {value}
          </span>
        </TooltipTrigger>
        <span className="flex w-11 shrink-0 justify-end">{trailing}</span>
      </div>
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5 text-muted-foreground">
          {tooltip}
          {opensUsage ? <span>{gt("Open usage")}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
