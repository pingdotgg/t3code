import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { UsageProviderKind } from "@t3tools/contracts";
import { formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { Link } from "@tanstack/react-router";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/** Threads ranked by their estimated share of each account's current weekly limit. */
export function UsageWeeklyThreads({
  environments,
  hiddenProviders,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
}) {
  const rows = environments
    .flatMap(({ environmentId, summary }) =>
      (summary?.weeklyThreads ?? [])
        .filter((thread) => !hiddenProviders.has(thread.provider))
        .map((thread) => ({ environmentId, ...thread })),
    )
    .toSorted((a, b) => b.limitPercent - a.limitPercent);
  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">Top threads this week</h2>
        <p className="text-xs text-muted-foreground">
          Estimated from each thread's share of the account's usage since its weekly limit last
          reset.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="w-full py-2 pl-2 text-left font-normal">Thread</th>
            <th className="py-2 pl-6 font-normal">Weekly limit</th>
            <th className="hidden py-2 pl-6 font-normal sm:table-cell">Cost</th>
            <th className="py-2 pr-2 pl-6 font-normal">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const presentation = PROVIDER_PRESENTATION[row.provider];
            return (
              <tr
                key={`${row.environmentId}:${row.sourcePath}:${row.threadId}`}
                className="relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50"
              >
                <td className="max-w-0 py-2.5 pl-2 text-left">
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(scopeThreadRef(row.environmentId, row.threadId))}
                    title={`${row.title} · ${presentation.label}`}
                    className="flex min-w-0 items-center gap-2 text-foreground outline-none after:absolute after:inset-0"
                  >
                    <ProviderInstanceIcon
                      driverKind={presentation.driverKind}
                      displayName={presentation.label}
                      iconClassName="size-3.5"
                    />
                    <span className="truncate">{row.title || "Untitled thread"}</span>
                  </Link>
                </td>
                <td className="py-2.5 pl-6 text-foreground">
                  ~{formatPercent(row.limitPercent / 100)}
                </td>
                <td className="hidden py-2.5 pl-6 sm:table-cell">
                  {row.basis === "cost" ? formatUsd(row.costUsd) : "Unpriced"}
                </td>
                <td className="py-2.5 pr-2 pl-6">{formatTokens(row.tokens)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
