import { useMemo } from "react";
import type { UsageDailyBucket, UsageModelBucket, UsageSummaryResponse } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { ClaudeAI, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

// Family color system from the approved mock: hue = harness, lightness =
// model within the family. Codex renders as off-white on dark surfaces.
const CLAUDE_COLOR = "#cf6b48";
const CODEX_COLOR = "#e8e8e3";
const harnessColor = (provider: string): string =>
  provider === "claudeAgent" ? CLAUDE_COLOR : CODEX_COLOR;
const CLAUDE_MODEL_SHADES = ["#cf6b48", "#f2c1a4", "#a3492a"];
const CODEX_MODEL_SHADES = ["#e8e8e3", "#9c9c96"];
const NEUTRAL_SHADE = "#8a8880";
const T3_ACCENT = "#9085e9";

function isClaudeProvider(provider: string): boolean {
  return provider === "claudeAgent";
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return `${value}`;
}

function formatMicroUsd(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd >= 100) return `$${Math.round(usd).toLocaleString()}`;
  return `$${usd.toFixed(2)}`;
}

function providerLogo(provider: string, className?: string) {
  return isClaudeProvider(provider) ? (
    <ClaudeAI className={cn("size-3.5 shrink-0", className)} />
  ) : (
    <OpenAI className={cn("size-3.5 shrink-0", className)} />
  );
}

interface DonutSlice {
  readonly key: string;
  readonly value: number;
  readonly color: string;
  readonly estimated?: boolean;
  readonly groupColor: string;
  readonly groupShare: number;
  readonly groupStart: boolean;
}

function assignModelShades(models: ReadonlyArray<UsageModelBucket>): Map<string, string> {
  const shades = new Map<string, string>();
  let claudeIndex = 0;
  let codexIndex = 0;
  for (const bucket of models) {
    if (isClaudeProvider(bucket.provider)) {
      shades.set(bucket.model, CLAUDE_MODEL_SHADES[claudeIndex] ?? NEUTRAL_SHADE);
      claudeIndex += 1;
    } else {
      shades.set(bucket.model, CODEX_MODEL_SHADES[codexIndex] ?? NEUTRAL_SHADE);
      codexIndex += 1;
    }
  }
  return shades;
}

function Donut({
  slices,
  center,
  centerSub,
  ariaLabel,
}: {
  slices: ReadonlyArray<DonutSlice>;
  center: string;
  centerSub: string;
  ariaLabel: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const cx = 150;
  const cy = 150;
  const outer = 140;
  const inner = 96;
  const tau = Math.PI * 2;
  const point = (angle: number, radius: number) =>
    `${(cx + Math.cos(angle) * radius).toFixed(2)} ${(cy + Math.sin(angle) * radius).toFixed(2)}`;

  let angle = -Math.PI / 2;
  const paths: Array<{ d: string; color: string; estimated: boolean; title: string }> = [];
  const labels: Array<{ x: number; y: number; text: string; dark: boolean }> = [];
  let groupStartAngle = angle;

  for (const slice of slices) {
    if (slice.groupStart) {
      groupStartAngle = angle;
    }
    const sweep = total > 0 ? (slice.value / total) * tau : 0;
    const end = angle + sweep;
    const gap = Math.min(0.014, sweep * 0.3);
    const from = angle + gap / 2;
    const to = end - gap / 2;
    if (to > from) {
      const large = to - from > Math.PI ? 1 : 0;
      paths.push({
        d: `M ${point(from, outer)} A ${outer} ${outer} 0 ${large} 1 ${point(to, outer)} L ${point(to, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(from, inner)} Z`,
        color: slice.color,
        estimated: slice.estimated ?? false,
        title: slice.key,
      });
    }
    angle = end;

    const groupShare = slice.groupShare;
    const isGroupEnd =
      slices.indexOf(slice) === slices.length - 1 || slices[slices.indexOf(slice) + 1]?.groupStart;
    if (isGroupEnd && groupShare >= 0.08) {
      const mid = (groupStartAngle + angle) / 2;
      const radius = (outer + inner) / 2;
      const hex = slice.groupColor.replace("#", "");
      const luminance =
        parseInt(hex.slice(0, 2), 16) * 0.299 +
        parseInt(hex.slice(2, 4), 16) * 0.587 +
        parseInt(hex.slice(4, 6), 16) * 0.114;
      labels.push({
        x: cx + Math.cos(mid) * radius,
        y: cy + Math.sin(mid) * radius,
        text: `${Math.round(groupShare * 100)}%`,
        dark: luminance > 150,
      });
    }
  }

  return (
    <div className="relative mx-auto w-full max-w-[270px]">
      <svg viewBox="0 0 300 300" role="img" aria-label={ariaLabel}>
        <defs>
          <pattern
            id="usage-est-stripes"
            patternUnits="userSpaceOnUse"
            width="7"
            height="7"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(0,0,0,0.35)" strokeWidth="2.5" />
          </pattern>
        </defs>
        {paths.map((path) => (
          <g key={path.title + path.d.slice(0, 24)}>
            <path d={path.d} fill={path.color}>
              <title>{path.title}</title>
            </path>
            {path.estimated ? <path d={path.d} fill="url(#usage-est-stripes)" /> : null}
          </g>
        ))}
        {labels.map((label) => (
          <text
            key={`${label.x}-${label.y}`}
            x={label.x}
            y={label.y}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fill: label.dark ? "#1a1a19" : "#fff", fontSize: 15, fontWeight: 680 }}
          >
            {label.text}
          </text>
        ))}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-3xl font-semibold tracking-tight">{center}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{centerSub}</div>
      </div>
    </div>
  );
}

function DailyBars({ daily }: { daily: ReadonlyArray<UsageDailyBucket> }) {
  const byDay = useMemo(() => {
    const map = new Map<string, Array<UsageDailyBucket>>();
    for (const bucket of daily) {
      const list = map.get(bucket.day) ?? [];
      list.push(bucket);
      map.set(bucket.day, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [daily]);

  const maxDay = Math.max(
    1,
    ...byDay.map(([, buckets]) => buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0)),
  );

  if (byDay.length === 0) {
    return null;
  }

  return (
    <div className="flex h-40 items-end gap-[3px] overflow-x-auto rounded-md bg-black/20 p-3">
      {byDay.map(([day, buckets]) => {
        const dayTotal = buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
        return (
          <div
            key={day}
            className="flex min-w-[14px] flex-1 flex-col-reverse gap-px"
            title={`${day}: ${formatTokens(dayTotal)} tokens`}
          >
            {buckets.map((bucket) => (
              <div
                key={`${day}-${bucket.provider}-${bucket.model}`}
                style={{
                  height: `${Math.max((bucket.totalTokens / maxDay) * 100, 1.5)}%`,
                  background: harnessColor(bucket.provider),
                }}
                className="w-full rounded-[2px]"
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function HourHeatmap({ summary }: { summary: UsageSummaryResponse }) {
  const grid = useMemo(() => {
    const cells = new Map<string, number>();
    let max = 0;
    for (const bucket of summary.hourOfWeek) {
      cells.set(`${bucket.dayOfWeek}-${bucket.hour}`, bucket.turns);
      max = Math.max(max, bucket.turns);
    }
    return { cells, max: Math.max(max, 1) };
  }, [summary.hourOfWeek]);

  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[560px] grid-cols-[34px_repeat(24,1fr)] gap-[2px]">
        <div />
        {Array.from({ length: 24 }, (_, hour) => (
          <div key={hour} className="text-center text-[9px] text-muted-foreground">
            {hour % 6 === 0
              ? hour === 0
                ? "12a"
                : hour < 12
                  ? `${hour}a`
                  : hour === 12
                    ? "12p"
                    : `${hour - 12}p`
              : ""}
          </div>
        ))}
        {dayLabels.map((label, dayOfWeek) => (
          <>
            <div key={label} className="self-center text-[10px] text-muted-foreground">
              {label}
            </div>
            {Array.from({ length: 24 }, (_, hour) => {
              const turns = grid.cells.get(`${dayOfWeek}-${hour}`) ?? 0;
              const alpha = turns === 0 ? 0 : 0.18 + 0.82 * Math.sqrt(turns / grid.max);
              return (
                <div
                  key={`${label}-${hour}`}
                  title={`${label} ${hour}:00 — ${turns} turn${turns === 1 ? "" : "s"}`}
                  className="aspect-[1.5] min-w-[14px] rounded-[3px]"
                  style={{
                    background:
                      turns === 0
                        ? "rgba(255,255,255,0.03)"
                        : `rgba(144,133,233,${alpha.toFixed(2)})`,
                  }}
                />
              );
            })}
          </>
        ))}
      </div>
    </div>
  );
}

export function UsageSettingsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.usageSummary({ environmentId, input: { timeZone } }),
  );

  const summary = data ?? null;
  const modelShades = useMemo(
    () => (summary ? assignModelShades(summary.byModel) : new Map<string, string>()),
    [summary],
  );

  const tokenSlices = useMemo(() => {
    if (!summary) return [];
    const claude = summary.byModel.filter((bucket) => isClaudeProvider(bucket.provider));
    const codex = summary.byModel.filter((bucket) => !isClaudeProvider(bucket.provider));
    const total = Math.max(summary.totals.totalTokens, 1);
    const groupTotal = (buckets: ReadonlyArray<UsageModelBucket>) =>
      buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
    const slices: Array<DonutSlice> = [];
    for (const [group, groupColor] of [
      [claude, CLAUDE_COLOR],
      [codex, CODEX_COLOR],
    ] as const) {
      group.forEach((bucket, index) => {
        slices.push({
          key: `${bucket.model}: ${formatTokens(bucket.totalTokens)} tokens`,
          value: bucket.totalTokens,
          color: modelShades.get(bucket.model) ?? NEUTRAL_SHADE,
          groupColor,
          groupShare: groupTotal(group) / total,
          groupStart: index === 0,
        });
      });
    }
    return slices;
  }, [summary, modelShades]);

  const costSlices = useMemo(() => {
    if (!summary) return [];
    const priced = summary.byModel.filter(
      (bucket) => bucket.exactCostMicroUsd > 0 || bucket.estimatedCostMicroUsd > 0,
    );
    const claude = priced.filter((bucket) => isClaudeProvider(bucket.provider));
    const codex = priced.filter((bucket) => !isClaudeProvider(bucket.provider));
    const total = Math.max(
      priced.reduce(
        (sum, bucket) => sum + bucket.exactCostMicroUsd + bucket.estimatedCostMicroUsd,
        0,
      ),
      1,
    );
    const groupTotal = (buckets: ReadonlyArray<UsageModelBucket>) =>
      buckets.reduce(
        (sum, bucket) => sum + bucket.exactCostMicroUsd + bucket.estimatedCostMicroUsd,
        0,
      );
    const slices: Array<DonutSlice> = [];
    for (const [group, groupColor] of [
      [claude, CLAUDE_COLOR],
      [codex, CODEX_COLOR],
    ] as const) {
      group.forEach((bucket, index) => {
        const value = bucket.exactCostMicroUsd + bucket.estimatedCostMicroUsd;
        const estimated = bucket.exactCostMicroUsd === 0;
        slices.push({
          key: `${bucket.model}: ${formatMicroUsd(value)}${estimated ? " (est.)" : ""}`,
          value,
          color: modelShades.get(bucket.model) ?? NEUTRAL_SHADE,
          estimated,
          groupColor,
          groupShare: groupTotal(group) / total,
          groupStart: index === 0,
        });
      });
    }
    return slices;
  }, [summary, modelShades]);

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <UsagePageHeader />
        <p className="text-sm text-muted-foreground">Connect an environment to see usage.</p>
      </SettingsPageContainer>
    );
  }

  if (isPending && !summary) {
    return (
      <SettingsPageContainer>
        <UsagePageHeader />
        <p className="text-sm text-muted-foreground">Loading usage…</p>
      </SettingsPageContainer>
    );
  }

  if (error || !summary) {
    return (
      <SettingsPageContainer>
        <UsagePageHeader />
        <div>
          <p className="text-sm text-muted-foreground">Could not load usage data.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => refresh()}>
            Retry
          </Button>
        </div>
      </SettingsPageContainer>
    );
  }

  const exactCost = summary.totals.exactCostMicroUsd;
  const estimatedCost = summary.totals.estimatedCostMicroUsd;
  const cacheHitRate =
    summary.totals.inputTokens + summary.totals.cachedInputTokens > 0
      ? (summary.totals.cachedInputTokens /
          (summary.totals.inputTokens +
            summary.totals.cachedInputTokens +
            summary.totals.cacheCreationTokens)) *
        100
      : 0;

  return (
    <SettingsPageContainer>
      <UsagePageHeader />
      <SettingsSection title="Overview">
        <div className="grid gap-8 md:grid-cols-2">
          <div>
            <div className="mb-3 text-center text-[13px] font-semibold">
              Tokens
              <span className="block text-[11px] font-normal text-muted-foreground">
                all processed, by harness
              </span>
            </div>
            <Donut
              slices={tokenSlices}
              center={formatTokens(summary.totals.totalTokens)}
              centerSub={
                summary.earliestFactAt ? `since ${summary.earliestFactAt.slice(0, 10)}` : "all time"
              }
              ariaLabel="Tokens by harness and model"
            />
          </div>
          <div>
            <div className="mb-3 text-center text-[13px] font-semibold">
              Cost
              <span className="block text-[11px] font-normal text-muted-foreground">
                exact where metered · striped slices are list-price estimates
              </span>
            </div>
            <Donut
              slices={costSlices}
              center={formatMicroUsd(exactCost + estimatedCost)}
              centerSub={`${formatMicroUsd(exactCost)} exact + ${formatMicroUsd(estimatedCost)} est.`}
              ariaLabel="Cost by harness and model"
            />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-2 lg:grid-cols-5">
          <StatTile
            label="Output tokens"
            value={formatTokens(summary.totals.outputTokens)}
            sub="generated text"
          />
          <StatTile label="Exact spend" value={formatMicroUsd(exactCost)} sub="provider-metered" />
          <StatTile
            label="Estimated value"
            value={`~${formatMicroUsd(estimatedCost)}`}
            sub="list price · plan-covered"
          />
          <StatTile label="Turns" value={`${summary.totals.turns}`} sub="recorded in ledger" />
          <StatTile
            label="Cache hit rate"
            value={`${cacheHitRate.toFixed(1)}%`}
            sub="of input tokens"
            accent
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Tokens per day">
        <DailyBars daily={summary.daily} />
      </SettingsSection>

      <SettingsSection title="When you use T3 Code">
        <p className="mb-3 text-xs text-muted-foreground">
          Turn starts by local hour and weekday ({timeZone}). Darker means more turns.
        </p>
        <HourHeatmap summary={summary} />
      </SettingsSection>

      <SettingsSection title="Models">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
              <th className="py-1.5 text-left font-medium">Model</th>
              <th className="py-1.5 text-right font-medium">Turns</th>
              <th className="py-1.5 text-right font-medium">Tokens</th>
              <th className="py-1.5 text-right font-medium">Output</th>
              <th className="py-1.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {summary.byModel.map((bucket) => (
              <tr key={`${bucket.provider}-${bucket.model}`} className="border-b border-border/40">
                <td className="flex items-center gap-2 py-2">
                  {providerLogo(bucket.provider)}
                  <span
                    className="inline-block size-2.5 rounded-[3px]"
                    style={{ background: modelShades.get(bucket.model) ?? NEUTRAL_SHADE }}
                  />
                  {bucket.model}
                </td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">
                  {bucket.turns}
                </td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">
                  {formatTokens(bucket.totalTokens)}
                </td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">
                  {formatTokens(bucket.outputTokens)}
                </td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">
                  {bucket.costSource === "exact"
                    ? formatMicroUsd(bucket.exactCostMicroUsd)
                    : bucket.costSource === "estimated"
                      ? `~${formatMicroUsd(bucket.estimatedCostMicroUsd)} est.`
                      : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {summary.unpricedModels.length > 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            No pricing data for: {summary.unpricedModels.join(", ")} — shown as tokens only, never
            $0.
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Projects">
        <div className="flex flex-col gap-2">
          {summary.byProject.slice(0, 8).map((bucket) => {
            const max = Math.max(summary.byProject[0]?.totalTokens ?? 1, 1);
            return (
              <div
                key={bucket.projectId ?? "none"}
                className="grid grid-cols-[140px_1fr_72px] items-center gap-3 text-[12.5px]"
              >
                <span className="truncate text-muted-foreground">
                  {bucket.projectTitle ?? (bucket.projectId ? "(unknown)" : "(no project)")}
                </span>
                <div className="h-4 rounded bg-black/20">
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${Math.max((bucket.totalTokens / max) * 100, 1.5)}%`,
                      background: T3_ACCENT,
                    }}
                  />
                </div>
                <span className="text-right tabular-nums text-muted-foreground">
                  {formatTokens(bucket.totalTokens)}
                </span>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        Usage facts are recorded from live provider events into this environment's local ledger
        (history begins when this feature shipped). Claude costs are exact, reported by the SDK per
        turn. Codex reports no cost over its protocol; its dollars are list-price estimates and
        always marked as such. Pricing catalog {summary.pricingVersion}.
      </p>
    </SettingsPageContainer>
  );
}

function UsagePageHeader() {
  return (
    <div>
      <h1 className="text-lg font-semibold">Usage</h1>
      <p className="text-[13px] text-muted-foreground">
        Local analytics from this environment's usage ledger. Nothing leaves your machines.
      </p>
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-black/20 px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-semibold tracking-tight", accent && "text-emerald-500")}>
        {value}
      </div>
      <div className="text-[10.5px] text-muted-foreground/80">{sub}</div>
    </div>
  );
}
