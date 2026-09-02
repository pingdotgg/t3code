import { formatUsd } from "@t3tools/shared/usageFormat";

export function formatCacheWriteCost(
  cacheWriteTokens: number,
  cacheWriteUsd: number | null,
): string {
  if (cacheWriteTokens === 0) return "-";
  return cacheWriteUsd === null ? "Unavailable" : formatUsd(cacheWriteUsd);
}

/** Cache writes are free for some providers and unavailable for older summaries. */
export function CacheWriteCell({
  cacheWriteTokens,
  cacheWriteUsd,
}: {
  readonly cacheWriteTokens: number;
  readonly cacheWriteUsd: number | null;
}) {
  return (
    <td className="py-2 text-right text-muted-foreground tabular-nums">
      {formatCacheWriteCost(cacheWriteTokens, cacheWriteUsd)}
    </td>
  );
}
