import { formatUsd } from "@t3tools/shared/usageFormat";

/** Consistent cache-write treatment across project, model, and thread tables. */
export function UsageCacheWriteCell({
  cacheWriteTokens,
  cacheWriteUsd,
}: {
  readonly cacheWriteTokens: number;
  readonly cacheWriteUsd: number | null;
}) {
  const value =
    cacheWriteTokens === 0
      ? "-"
      : cacheWriteUsd === null
        ? "Unavailable"
        : formatUsd(cacheWriteUsd);

  return <td className="py-2 text-right text-muted-foreground tabular-nums">{value}</td>;
}
