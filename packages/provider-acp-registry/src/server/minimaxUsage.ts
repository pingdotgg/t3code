import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import { UsageReadError } from "@t3tools/contracts";
import type {
  ProviderUsageReader,
  ProviderUsageScanInput,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import type { AcpRegistrySettings } from "../settings.ts";

/**
 * MiniMax's first-party rate entries carry no bare alias: the rate table drops a bare
 * "minimax-m3" because resellers disagree on price, so a recorded MiniMax model prices as
 * unpriced. Point pricing at the first-party key instead.
 *
 * @public
 */
export function miniMaxRateModel(model: string): string {
  const name = model.trim();
  if (!/^minimax-/i.test(name)) return name;
  // LiteLLM has no M2.7 entry yet, and MiniMax publishes M2.7 at M3's input, output and
  // cache-read rates. Borrowing M3's entry understates M2.7 cache writes by $0.075/M.
  return `minimax/${name.toLowerCase() === "minimax-m2.7" ? "MiniMax-M3" : name}`;
}

/**
 * Reads MiniMax rows from a Hermes history database. `retentionCutoffMs` bounds the scan to
 * the retained window, so the query does not grow with the lifetime of the database.
 *
 * @public
 */
export function readMiniMaxHistory(path: string, retentionCutoffMs?: number): UsageRecord[] {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    // The cutoff is compared against the same effective timestamp each row reports, in seconds.
    const cutoffSeconds =
      retentionCutoffMs === undefined ? undefined : Math.floor(retentionCutoffMs / 1000);
    const rows = db
      .prepare(
        `SELECT u.session_id, u.model, u.billing_provider, u.billing_base_url, u.billing_mode,
      u.task, u.input_tokens, u.cache_read_tokens, u.cache_write_tokens, u.output_tokens,
      u.reasoning_tokens, u.actual_cost_usd, u.cost_status, COALESCE(u.first_seen, s.started_at) AS timestamp
      FROM session_model_usage u JOIN sessions s ON s.id = u.session_id
      WHERE lower(u.model) LIKE '%minimax%'
        AND (? IS NULL OR COALESCE(u.first_seen, s.started_at) >= ?)`,
      )
      .all(cutoffSeconds ?? null, cutoffSeconds ?? null);
    return rows.map((row) => {
      const count = (key: string) =>
        typeof row[key] === "number" && Number.isFinite(row[key]) ? Math.max(0, row[key]) : 0;
      const model = String(row.model);
      const rateModel = miniMaxRateModel(model);
      return {
        provider: "minimax",
        timestampMs: count("timestamp") * 1000,
        model,
        ...(rateModel === model ? {} : { rateModel }),
        sessionId: String(row.session_id),
        totals: {
          uncachedInputTokens: count("input_tokens"),
          cachedInputTokens: count("cache_read_tokens"),
          cacheCreationTokens: count("cache_write_tokens"),
          outputTokens: count("output_tokens"),
          reasoningTokens: count("reasoning_tokens"),
        },
        reportedCostUsd:
          row.cost_status === "included"
            ? 0
            : row.cost_status === "actual"
              ? count("actual_cost_usd")
              : null,
        speed: "standard",
        dedupeKey: JSON.stringify([
          row.session_id,
          row.model,
          row.billing_provider,
          row.billing_base_url,
          row.billing_mode,
          row.task,
        ]),
      };
    });
  } finally {
    db.close();
  }
}

export const minimaxUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "scan",
  provider: "minimax",
  scan: Effect.fn("MiniMaxUsage.scan")(function* ({
    instances,
    retentionCutoffMs,
  }: ProviderUsageScanInput<AcpRegistrySettings>) {
    const pathService = yield* Path.Path;
    // Only read history when an ACP registry instance is configured. Without that gate every
    // environment, including CI, would pick up the host's own ~/.hermes directory.
    const configured = instances.filter((instance) => instance.configured);
    if (configured.length === 0) return [];
    const directories = [
      ...new Set(
        configured.map((instance) =>
          pathService.resolve(
            instance.environment.HERMES_HOME || pathService.join(NodeOS.homedir(), ".hermes"),
          ),
        ),
      ),
    ];
    const scans = yield* Effect.forEach(directories, (dir) => {
      const path = pathService.join(dir, "state.db");
      return Effect.try({
        try: () => readMiniMaxHistory(path, retentionCutoffMs),
        catch: (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Could not read Hermes MiniMax usage history.",
            cause,
          }),
      }).pipe(
        Effect.map((records) => [
          {
            dir,
            files: [{ path, records }],
            message:
              "Hermes cumulative per-model totals are attributed to the first recorded activity; hourly timing is approximate. Costs use MiniMax's first-party rates unless Hermes reports an actual charge.",
          },
        ]),
        Effect.orElseSucceed(() => [
          {
            dir,
            files: null,
            status: "failed" as const,
            message: "Could not read Hermes MiniMax usage history.",
          },
        ]),
      );
    });
    return scans.flat();
  }),
};
