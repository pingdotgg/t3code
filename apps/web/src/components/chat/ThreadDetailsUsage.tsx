import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
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

/** The selected provider's limit windows. Each row reads as room left and opens the usage page. */
export function ThreadDetailsUsage({
  environmentId,
  providerInstanceId,
  model,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow"> & { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  const quotas = resolveThreadHttpQuotas(providerInstanceId, sources);
  if (!resolved && quotas.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage limits")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {resolved?.kind === "pool" ? (
          resolved.windows.map((window) => <PoolRow key={window.id} window={window} now={now} />)
        ) : resolved?.limits.needsUsageAccess && providerInstanceId !== null ? (
          <UsageAccessRow
            environmentId={environmentId}
            instanceId={providerInstanceId}
            providers={providers}
          />
        ) : (
          resolved &&
          (quotas.length === 0 || limitsNotice(resolved.limits) === null) && (
            <InstanceRows limits={resolved.limits} now={now} />
          )
        )}
        {quotas.map(({ key, accountLabel, window }) => (
          <LimitRow key={key} window={window} now={now} accountLabel={accountLabel} />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function InstanceRows({
  limits,
  now,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const notice = limitsNotice(limits, m);
  if (notice) {
    return (
      <UsageRow
        label={gt("Limits", { $context: "usage limits row label" })}
        fill={null}
        tone={null}
        value={gt("Unavailable")}
        tooltip={<span className="text-foreground">{notice}</span>}
        opensUsage
      />
    );
  }
  return limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />);
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
      <div className="col-span-3 grid h-6 grid-cols-subgrid items-center px-2.5">
        <span className="text-muted-foreground">
          {gt("Limits", { $context: "usage limits row label" })}
        </span>
        <span className="col-span-2 text-end">
          {canAnswer ? (
            <Button size="micro" variant="outline" onClick={() => setOpen(true)}>
              {gt("Set up", { $context: "allow reading an agent's usage limits" })}
            </Button>
          ) : (
            <span className="text-muted-foreground">{gt("Unavailable")}</span>
          )}
        </span>
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

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const usedTokens = usage.usedTokens === null ? null : formatContextWindowTokens(usage.usedTokens);
  const percentageValue = used === null ? null : `${used}%`;
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title={gt("Context window")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={gt("Context", { $context: "context window row label" })}
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null && usedTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : (usedTokens ?? percentageValue ?? gt("Unavailable"))
          }
          ariaValue={
            used !== null
              ? gt("{used}% used", { used })
              : usedTokens !== null
                ? gt("{usedTokens} tokens used", { usedTokens })
                : gt("Unavailable")
          }
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null
                  ? gt("Context: {used}% used", { used })
                  : usedTokens !== null
                    ? gt("Context: {usedTokens} tokens used", { usedTokens })
                    : gt("Unavailable")}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {usage.usedTokens !== null
                    ? gt("{used} of {max} tokens", {
                        used: usage.usedTokens.toLocaleString(locale),
                        max: maxTokens.toLocaleString(locale),
                      })
                    : null}
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(threshold, m)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
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
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={limitTone(left)}
      tick={timeLeft}
      value={`${left}%`}
      ariaValue={gt("{left}% left", { left })}
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {accountLabel ? <span className="text-muted-foreground">{accountLabel}</span> : null}
          {pace && timeLeft !== null ? (
            <span className="text-muted-foreground">
              {m(PACE_LABEL[pace])} · {gt("{timeLeft}% of the window left", { timeLeft })}
            </span>
          ) : null}
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              {gt("Resets in {duration} · {time}", {
                duration: formatDuration(resetsAt - now, m),
                time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m),
              })}
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
      fill={left}
      tone={limitTone(left)}
      tick={window.paceRemainingPercent}
      value={`${left}%`}
      ariaValue={gt("{left}% left", { left })}
      opensUsage
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
          {window.pace ? (
            <span className="text-muted-foreground">{m(PACE_LABEL[window.pace])}</span>
          ) : null}
          {next && reset ? (
            <span className="text-muted-foreground">
              {accounts > 1
                ? gt("+{percent}% in {duration} · {time}", {
                    percent: next.restoresPercent,
                    ...reset,
                  })
                : gt("Resets in {duration} · {time}", reset)}
            </span>
          ) : null}
          {sourceLabels.length > 0 ? (
            <span className="text-muted-foreground">
              {gt("From {sources}", { sources: sourceLabels.join(", ") })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. With `opensUsage` it links to the usage page. */
export function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
  opensUsage = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
  readonly opensUsage?: boolean;
}) {
  const gt = useGT();
  const rowProps = {
    "aria-label": gt("{label}: {value}", { label, value: ariaValue }),
    className: cn(
      "col-span-3 grid h-6 grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
      opensUsage
        ? "group cursor-pointer active:bg-black/[0.06] dark:active:bg-white/[0.12]"
        : "cursor-default",
    ),
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          opensUsage ? <Link to="/usage" {...rowProps} /> : <div tabIndex={0} {...rowProps} />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground group-hover:text-foreground">
          {label}
        </span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/75"
                style={{ left: `clamp(0.5px, ${tick}%, calc(100% - 0.5px))` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">
          {tooltip}
          {opensUsage ? <span className="text-muted-foreground">{gt("Open usage")}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
