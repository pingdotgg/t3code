import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MarginStatsPayload } from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { RefreshCwIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { useGT, useLocale } from "gt-react";

import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type MarginWindowKey = "today" | "7d" | "30d" | "all";

function resolveSinceParam(windowKey: MarginWindowKey, anchorMs: number): string {
  if (windowKey === "today" || windowKey === "all") return windowKey;
  const days = windowKey === "7d" ? 7 : 30;
  return new Date(anchorMs - days * 86_400_000).toISOString();
}

function formatChars(chars: number): string {
  if (chars >= 1_000_000_000) return `${(chars / 1_000_000_000).toFixed(2)}B`;
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M`;
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)}K`;
  return String(chars);
}

function formatCacheBreakReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

function MarginReadyBody({
  endpoint,
  stats,
  locale,
}: {
  readonly endpoint: string;
  readonly stats: MarginStatsPayload;
  readonly locale: string;
}) {
  const gt = useGT();
  const { savings, totals, by_model: byModel, cache_breaks: cacheBreaks } = stats;
  const tier2Pct =
    totals.tier2_chars_before > 0
      ? (totals.tier2_chars_reduced / totals.tier2_chars_before) * 100
      : 0;

  const activeCacheBreaks = Object.entries(cacheBreaks).filter(
    ([, entry]) => entry.count > 0 || entry.tokens_lost > 0,
  );
  const totalBreakCount = activeCacheBreaks.reduce((sum, [, entry]) => sum + entry.count, 0);
  const totalBreakTokensLost = activeCacheBreaks.reduce(
    (sum, [, entry]) => sum + entry.tokens_lost,
    0,
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border/70 bg-card/40 p-3.5">
          <p className="text-xs text-muted-foreground">{gt("Estimated savings")}</p>
          <p className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
            {formatUsd(savings.cost_usd_est, locale)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {gt("{tokens} tokens · {pct}", {
              tokens: formatTokens(savings.tokens_est),
              pct: formatPercent(savings.pct_est),
            })}
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card/40 p-3.5">
          <p className="text-xs text-muted-foreground">{gt("Proxied requests")}</p>
          <p className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
            {formatCount(totals.requests, locale)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {gt("{cost} billed · {endpoint}", {
              cost: formatUsd(totals.cost_usd, locale),
              endpoint,
            })}
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card/40 p-3.5">
          <p className="text-xs text-muted-foreground">{gt("Compression & compaction")}</p>
          <p className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
            {formatChars(totals.tier2_chars_reduced + totals.checkpoint_chars_reduced)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {gt("Tier 2: {tier2} ({pct}) · Tier 3: {tier3}", {
              tier2: formatChars(totals.tier2_chars_reduced),
              pct: formatPercent(tier2Pct),
              tier3: formatChars(totals.checkpoint_chars_reduced),
            })}
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card/40 p-3.5">
          <p className="text-xs text-muted-foreground">{gt("Secrets & cache breaks")}</p>
          <p className="mt-1 flex items-center gap-1.5 text-2xl font-semibold text-foreground tabular-nums">
            <ShieldCheckIcon className="size-4 text-success" aria-hidden />
            {formatCount(totals.secrets_redacted, locale)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {gt("{breaks} cache breaks ({tokens} lost)", {
              breaks: formatCount(totalBreakCount, locale),
              tokens: formatTokens(totalBreakTokensLost),
            })}
          </p>
        </div>
      </div>

      {activeCacheBreaks.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {activeCacheBreaks.map(([reason, entry]) => (
            <span
              key={reason}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground tabular-nums"
            >
              <span className="font-medium text-foreground capitalize">
                {formatCacheBreakReason(reason)}
              </span>
              <span>
                {formatCount(entry.count, locale)} · {formatTokens(entry.tokens_lost)}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {byModel.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pl-2 font-normal">{gt("Model")}</th>
                <th className="py-2 pl-4 text-right font-normal">{gt("Requests")}</th>
                <th className="py-2 pl-4 text-right font-normal">{gt("Cache read")}</th>
                <th className="py-2 pl-4 text-right font-normal">{gt("Cost")}</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((row) => (
                <tr
                  key={row.model}
                  className="border-b border-border/50 text-right text-muted-foreground tabular-nums"
                >
                  <td className="py-2 pl-2 text-left text-foreground">{row.model}</td>
                  <td className="py-2 pl-4">{formatCount(row.requests, locale)}</td>
                  <td className="py-2 pl-4">{formatTokens(row.cache_read_tokens)}</td>
                  <td className="py-2 pl-4 text-foreground">{formatUsd(row.cost_usd, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function MarginStatsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const locale = useLocale();
  const [windowKey, setWindowKey] = useState<MarginWindowKey>("today");
  const [anchorMs, setAnchorMs] = useState(() => Date.now());
  const since = resolveSinceParam(windowKey, anchorMs);

  const atom = serverEnvironment.marginStats({
    environmentId,
    input: { since },
  });
  const result = useAtomValue(atom);
  const value = AsyncResult.isSuccess(result) ? result.value : null;

  if (value === null || value.status === "unconfigured") {
    return null;
  }

  return (
    <section className="flex flex-col gap-4 border-t border-border/70 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">{gt("Margin proxy")}</h2>
          <p className="text-xs text-muted-foreground">
            {gt("Claude Code traffic routed through {endpoint}", { endpoint: value.endpoint })}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <ToggleGroup
            value={[windowKey]}
            onValueChange={(next) => {
              const selected = next[0];
              if (
                selected === "today" ||
                selected === "7d" ||
                selected === "30d" ||
                selected === "all"
              ) {
                setAnchorMs(Date.now());
                setWindowKey(selected);
              }
            }}
            size="xs"
            variant="outline"
          >
            <Toggle value="today">{gt("Today")}</Toggle>
            <Toggle value="7d">{gt("7d")}</Toggle>
            <Toggle value="30d">{gt("30d")}</Toggle>
            <Toggle value="all">{gt("All")}</Toggle>
          </ToggleGroup>

          <Button
            size="xs"
            variant="outline"
            onClick={() => appAtomRegistry.refresh(atom)}
            aria-label={gt("Refresh Margin proxy stats")}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {value.status === "unavailable" ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3.5 py-2.5 text-xs text-muted-foreground">
          <TriangleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
          <span>
            {gt("Margin proxy unreachable at {endpoint}: {message}", {
              endpoint: value.endpoint,
              message: value.message,
            })}
          </span>
        </div>
      ) : (
        <MarginReadyBody endpoint={value.endpoint} stats={value.stats} locale={locale} />
      )}
    </section>
  );
}
