import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  type LimitPace,
  type LimitPoolWindow,
  limitPoolNotice,
  paceOf,
  paceRemainingPercent,
  projectRunOut,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatDuration, formatRunsOutIn, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react";
import { GaugeIcon, Minimize2Icon, TimerIcon, TrendingUpIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { providerClients } from "../settings/providerDriverMeta";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ContextWindowSegments } from "./ContextWindowMeter";
import { contextWindowSegments } from "./compaction.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  foldLimitRows,
  groupLimitRows,
  isWideLimitLabel,
  limitTone,
  nextPoolReset,
  poolSources,
  resolveThreadDetailsLimits,
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

/** Provider limits grouped by provider as number-only chips; each opens the usage page. */
export function ThreadDetailsUsage({
  providerInstanceId,
  model,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  // The hub a model routes to pools the accounts it spends, when the instance reads none of its own.
  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  const limits = resolved?.kind === "instance" ? resolved.limits : undefined;
  const ownNotice =
    resolved === null
      ? gt("This provider has not reported usage limits.")
      : limits
        ? limitsNotice(limits, m)
        : null;
  const pool = resolved?.kind === "pool" ? resolved.windows : undefined;
  const activeProvider = providers.find((provider) => provider.instanceId === providerInstanceId);
  const driver = activeProvider?.driver;
  const [folded, setFolded] = useLocalStorage(
    "thread-details:collapsed:Other limits",
    true,
    Schema.Boolean,
  );
  const rows = pool
    ? pool.map((pooled) => {
        const from = poolSources(pooled);
        const window = pooledWindow(pooled, now);
        const pace = pooled.pace ?? paceOf(window, now);
        const runsOutBeforeReset =
          remainingPercent(window) > 0 &&
          (pooled.members.length === 1 || pace === "ahead") &&
          projectRunOut(window, now) !== null;
        return {
          driver: pooled.members[0]?.account.driver ?? driver,
          window,
          pace,
          runsOutBeforeReset,
          accounts: pooled.members.length,
          sources: [...from.hubs, ...(from.signedIn ? [gt("Signed-in accounts")] : [])],
        };
      })
    : (limits?.windows ?? []).map((window) => ({
        driver,
        window,
        pace: paceOf(window, now),
        runsOutBeforeReset: remainingPercent(window) > 0 && projectRunOut(window, now) !== null,
        accounts: 1,
        sources: [],
      }));
  const fold = foldLimitRows(rows, model);
  const shown = folded ? fold.shown : rows;
  const groups = groupLimitRows(shown);
  const poolNotice =
    providerInstanceId !== null && ownNotice !== null && !pool
      ? limitPoolNotice(providerInstanceId, providers, sources)
      : null;
  const notice = pool ? null : (poolNotice ?? ownNotice);
  return (
    <ThreadDetailsSection title={gt("Usage limits")} variant="usage">
      {notice || !rows.length ? (
        <StatusTile
          label={gt("Limits", { $context: "usage limits row label" })}
          icon={<TimerIcon className="size-3.5 shrink-0" aria-hidden />}
          value={
            poolNotice && !sources.some((source) => source.error)
              ? gt("Not linked", { $context: "usage limits row value" })
              : gt("Unavailable")
          }
          tooltip={notice ?? gt("No usage windows reported.")}
          opensUsage
        />
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group, groupIndex) => {
            const providerLabel =
              group.driver === activeProvider?.driver &&
              !pool &&
              activeProvider?.displayName?.trim()
                ? activeProvider.displayName.trim()
                : group.driver
                  ? (providerClients.get(group.driver)?.label ?? String(group.driver))
                  : gt("Limits", { $context: "usage limits row label" });
            const maxAccounts = group.rows.reduce((max, row) => Math.max(max, row.accounts), 1);
            return (
              <div key={group.driver ?? "limits"} className="flex flex-col gap-1">
                <div className="flex min-h-5 items-center gap-1.5 px-1.5">
                  {group.driver ? (
                    <ProviderInstanceIcon
                      driverKind={group.driver}
                      displayName={providerLabel}
                      size="compact"
                      className="size-4"
                      iconClassName="size-3.5 text-muted-foreground"
                    />
                  ) : null}
                  <span className="min-w-0 truncate text-caption text-muted-foreground">
                    {providerLabel}
                  </span>
                  {maxAccounts > 1 ? (
                    <span className="shrink-0 text-caption text-dim-foreground">
                      <T>
                        <Var>{maxAccounts}</Var> accounts, pooled
                      </T>
                    </span>
                  ) : null}
                  {groupIndex === 0 ? (
                    <span className="ms-auto shrink-0 text-caption text-muted-foreground">
                      {gt("Left", { $context: "remaining usage" })}
                    </span>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {group.rows.map(({ window, pace, runsOutBeforeReset, accounts, sources }) => (
                    <LimitTile
                      key={window.id}
                      window={window}
                      pace={pace}
                      runsOutBeforeReset={runsOutBeforeReset}
                      now={now}
                      pooledAccounts={accounts}
                      sources={sources}
                      fullWidth={group.rows.length === 1}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {fold.hidden.length > 0 ? (
            <Button
              size="xs"
              variant="ghost-muted"
              aria-expanded={!folded}
              onClick={() => setFolded(!folded)}
              className="self-start"
            >
              {folded ? gt("Show {count} more", { count: fold.hidden.length }) : gt("Show fewer")}
            </Button>
          ) : null}
        </div>
      )}
    </ThreadDetailsSection>
  );
}

/** Context fills as tokens are used. Compact follows the composer's real provider command. */
export function ThreadDetailsContext({
  usage,
  onCompact,
  compactUnavailableReason,
}: {
  readonly usage: ContextWindowSnapshot | null;
  readonly onCompact?: (() => void) | undefined;
  /** Why compacting cannot start now; the button stays hoverable to say so. */
  readonly compactUnavailableReason?: string | null | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const [collapsed, setCollapsed] = useLocalStorage(
    "thread-details:collapsed:Context breakdown",
    true,
    Schema.Boolean,
  );
  if (!usage) {
    return (
      <ThreadDetailsSection title={gt("Context window")} variant="usage">
        <StatusTile
          label={gt("Context", { $context: "context window row label" })}
          icon={<GaugeIcon className="size-3.5 shrink-0" aria-hidden />}
          value={gt("N/A", { $context: "context usage not reported" })}
          tooltip={gt("The provider has not reported context usage.")}
        />
      </ThreadDetailsSection>
    );
  }
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used = maxTokens !== null ? Math.max(0, Math.min(100, usage.usedPercentage ?? 0)) : null;
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  const maxTokensFormatted = maxTokens !== null ? formatContextWindowTokens(maxTokens) : null;
  const contextLabel =
    maxTokensFormatted !== null
      ? used !== null
        ? gt("Context: {used} / {max} tokens, {percent}% used", {
            used: usedTokens,
            max: maxTokensFormatted,
            percent: Math.round(used),
          })
        : gt("Context: {used} / {max} tokens used", {
            used: usedTokens,
            max: maxTokensFormatted,
          })
      : gt("Context: {usedTokens} tokens used", { usedTokens });
  return (
    <ThreadDetailsSection title={gt("Context window")} variant="usage">
      <Collapsible
        className="flex min-w-0 flex-col"
        open={!collapsed}
        onOpenChange={(open) => setCollapsed(!open)}
      >
        <div className="flex min-w-0 items-center gap-1">
          <CollapsibleTrigger
            aria-label={contextLabel}
            render={
              <Badge
                size="lg"
                variant="secondary"
                className="min-w-0 flex-1"
                render={<button type="button" />}
              />
            }
          >
            <span className="flex min-w-0 flex-1 items-center justify-between gap-1.5">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
                <GaugeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">
                  {gt("Context", { $context: "context window row label" })}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums">
                {maxTokensFormatted !== null ? (
                  <span className="text-caption text-muted-foreground">
                    {gt("{used} / {max}", { used: usedTokens, max: maxTokensFormatted })}
                  </span>
                ) : (
                  <span className="text-caption text-muted-foreground">{usedTokens}</span>
                )}
                {used !== null ? (
                  <Text variant="meta" tone="strong" numeric emphasis>
                    {Math.round(used)}%
                  </Text>
                ) : null}
              </span>
            </span>
          </CollapsibleTrigger>
          {onCompact ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="secondary"
                    aria-label={gt("Compact context")}
                    aria-disabled={compactUnavailableReason ? true : undefined}
                    onClick={compactUnavailableReason ? undefined : onCompact}
                  />
                }
              >
                <Minimize2Icon className="size-[13px]" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {compactUnavailableReason ?? gt("Compact context")}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <CollapsiblePanel>
          <div className="ps-1.5 pe-1">
            {used !== null ? (
              <div className="pt-2 pb-0.5">
                <ContextWindowSegments usage={usage} minSegmentWidth={2} />
              </div>
            ) : null}
            <dl className="text-meta">
              {contextWindowSegments(usage, m).map((segment) => (
                <div key={segment.label} className="flex h-8 items-center justify-between gap-2">
                  <dt className="flex min-w-0 items-center gap-1.5">
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <span aria-hidden className={cn("size-2 rounded-xs", segment.color)} />
                    </span>
                    <span className="truncate">{segment.label}</span>
                  </dt>
                  <dd className="shrink-0 text-caption tabular-nums text-muted-foreground">
                    {segment.tokens.toLocaleString(locale)}
                  </dd>
                </div>
              ))}
              <div className="flex min-h-8 items-center justify-between gap-2">
                <dt className="flex min-w-0 items-center gap-1.5">
                  <span aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">
                    {maxTokens !== null
                      ? gt("Used / max", { $context: "context window tokens" })
                      : gt("Used", { $context: "context window tokens" })}
                  </span>
                </dt>
                <dd className="shrink-0 text-caption tabular-nums text-muted-foreground">
                  {maxTokens !== null
                    ? gt("{used} / {max}", {
                        used: usage.usedTokens.toLocaleString(locale),
                        max: maxTokens.toLocaleString(locale),
                      })
                    : usage.usedTokens.toLocaleString(locale)}
                </dd>
              </div>
            </dl>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </ThreadDetailsSection>
  );
}

/** A pool's row: the share left across its accounts, and the next of their resets. */
function pooledWindow(pooled: LimitPoolWindow, now: number): ServerProviderUsageWindow {
  const durations = new Set(pooled.members.map((member) => member.window.windowDurationMins));
  const [duration] = durations;
  return {
    id: pooled.id,
    kind: pooled.kind,
    label: pooled.label,
    usedPercent: 100 - pooled.remainingPercent,
    ...(durations.size === 1 && duration !== undefined ? { windowDurationMins: duration } : {}),
    resetsAt: nextPoolReset(pooled, now)?.member.window.resetsAt,
  };
}

function isWeeklyWindow(window: ServerProviderUsageWindow): boolean {
  return (window.windowDurationMins ?? 0) >= 24 * 60 || /week/i.test(window.label);
}

function LimitTile({
  window,
  pace,
  runsOutBeforeReset,
  now,
  pooledAccounts,
  sources,
  fullWidth,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly pace: LimitPace | null;
  readonly runsOutBeforeReset: boolean;
  readonly now: number;
  readonly pooledAccounts: number;
  readonly sources: ReadonlyArray<string>;
  readonly fullWidth: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const runsOutText = runsOutBeforeReset ? formatRunsOutIn(window, now, m) : null;
  const tone = limitTone(left, runsOutBeforeReset);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const remainingMs = resetsAt - now;
  const resetText =
    window.resetsAt && remainingMs > 0
      ? pooledAccounts > 1
        ? gt("Next reset in {duration}", { duration: formatDuration(remainingMs, m) })
        : gt("Resets in {duration}", { duration: formatDuration(remainingMs, m) })
      : null;
  const weekly = isWeeklyWindow(window);
  const modelLabel =
    weekly && window.id.startsWith("seven_day_")
      ? /^Weekly\s*·\s*(.+)$/i.exec(window.label)?.[1]
      : undefined;
  const displayLabel = modelLabel ?? window.label;
  const wide = fullWidth || isWideLimitLabel(displayLabel);
  const ariaLabel = [
    gt("{label}: {left}% left", { label: window.label, left }),
    runsOutText,
    !runsOutText && pace ? m(PACE_LABEL[pace]) : null,
    resetText,
    pooledAccounts > 1
      ? gt("{count, plural, one {{count} account} other {{count} accounts}}", {
          count: pooledAccounts,
        })
      : null,
    sources.length > 0 ? gt("From {sources}", { sources: sources.join(", ") }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  const badgeVariant = tone === "error" ? "error" : tone === "warning" ? "warning" : "secondary";
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              size="lg"
              variant={badgeVariant}
              className="w-full min-w-0"
              render={<Link to="/usage" aria-label={ariaLabel} />}
            />
          }
        >
          <span className="flex min-w-0 flex-1 items-center justify-between gap-1.5">
            <span className={cn("truncate", tone === null && "text-foreground")}>
              {displayLabel}
            </span>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 tabular-nums",
                tone === null && "text-strong-foreground",
              )}
            >
              {runsOutBeforeReset ? (
                <TrendingUpIcon className="size-3 shrink-0" aria-hidden />
              ) : null}
              <Text variant="meta" tone="inherit" numeric emphasis>
                {left}%
              </Text>
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left" sideOffset={12}>
          <div className="flex flex-col gap-0.5 text-muted-foreground">
            <span className="text-foreground">
              {gt("{label}: {left}% left", { label: window.label, left })}
            </span>
            {runsOutText ? (
              <span
                className={cn(
                  tone === "error" ? "text-error-foreground" : "text-warning-foreground",
                )}
              >
                {runsOutText}
              </span>
            ) : null}
            {pace && timeLeft !== null ? (
              <span>
                <span className="block">{m(PACE_LABEL[pace])}</span>
                <span className="block">{gt("{timeLeft}% of the window left", { timeLeft })}</span>
              </span>
            ) : pace ? (
              <span>{m(PACE_LABEL[pace])}</span>
            ) : null}
            {resetText && window.resetsAt ? (
              <span>
                <span className="block">{resetText}</span>
                <span className="block">
                  {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)}
                </span>
              </span>
            ) : null}
            {pooledAccounts > 1 ? (
              <span>
                <T>
                  Across <Var>{pooledAccounts}</Var> accounts
                </T>
              </span>
            ) : null}
            {sources.length > 0 ? (
              <span>{gt("From {sources}", { sources: sources.join(", ") })}</span>
            ) : null}
            <span>{gt("Open usage")}</span>
          </div>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function StatusTile({
  label,
  icon,
  value,
  tooltip,
  opensUsage = false,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly value: string;
  readonly tooltip: ReactNode;
  readonly opensUsage?: boolean;
}) {
  const gt = useGT();
  const ariaLabel = gt("{label}: {value}", { label, value });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            size="lg"
            variant="unavailable"
            className="w-full min-w-0"
            render={
              opensUsage ? (
                <Link to="/usage" aria-label={ariaLabel} />
              ) : (
                <span tabIndex={0} aria-label={ariaLabel} />
              )
            }
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center justify-between gap-1.5">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
            <span className="shrink-0 text-muted-foreground">{icon}</span>
            <span className="truncate">{label}</span>
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{value}</span>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left" sideOffset={12}>
        <div className="flex flex-col gap-0.5 text-muted-foreground">
          {tooltip}
          {opensUsage ? <span>{gt("Open usage")}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
