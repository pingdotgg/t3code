import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type { AcpRegistrySettings } from "../settings.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Devin appends reasoning effort and a fast-mode flag to the model id, e.g. claude-opus-5-5-high-fast.
const DEVIN_MODEL_SUFFIX = /(?:-(?:none|minimal|low|medium|high|xhigh|max))?(-fast)?$/;

function parseDevinMessage(row: {
  readonly sessionId: string;
  readonly createdAtSeconds: unknown;
  readonly metadata: string;
}): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadata);
  } catch {
    return null;
  }
  const metadata = object(parsed);
  const metrics = object(metadata.metrics);
  const model = text(metadata.generation_model);
  if (!model) return null;
  const totals = {
    uncachedInputTokens: tokenCount(metrics.input_tokens),
    cachedInputTokens: tokenCount(metrics.cache_read_tokens),
    cacheCreationTokens: tokenCount(metrics.cache_creation_tokens),
    outputTokens: tokenCount(metrics.output_tokens),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;
  const createdAt = Date.parse(text(metadata.created_at));
  const timestampMs = Number.isFinite(createdAt)
    ? createdAt
    : typeof row.createdAtSeconds === "number"
      ? row.createdAtSeconds * 1000
      : null;
  if (timestampMs === null || !Number.isFinite(timestampMs)) return null;
  const suffix = DEVIN_MODEL_SUFFIX.exec(model);
  // One inference can be stored on several message nodes; the request id identifies it.
  const requestId = text(metadata.request_id);
  return {
    provider: "devin",
    timestampMs,
    model,
    rateModel: model.slice(0, suffix?.index ?? model.length) || model,
    sessionId: row.sessionId,
    totals,
    // Devin bills in ACUs, not USD; let shared pricing estimate list cost.
    reportedCostUsd: null,
    speed: suffix?.[1] ? "fast" : "standard",
    dedupeKey: requestId ? `devin:${requestId}` : null,
  };
}

export interface DevinUsageReadResult {
  readonly records: readonly UsageRecord[];
  readonly missing: boolean;
  readonly error: boolean;
}

const MESSAGE_PAGE_SIZE = 256;

export const readDevinUsage = Effect.fn("readDevinUsage")(function* (
  filename: string,
  sinceMs: number,
): Effect.fn.Return<DevinUsageReadResult, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(filename).pipe(Effect.orElseSucceed(() => false)))) {
    return { records: [], missing: true, error: false };
  }
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Fail promptly on live-writer locks instead of stalling the server.
    yield* sql.unsafe("PRAGMA busy_timeout = 100");
    const [range] = yield* sql.unsafe<{
      readonly first_row_id: number | null;
      readonly last_row_id: number | null;
    }>(
      "SELECT (SELECT MIN(rowid) FROM message_nodes) AS first_row_id, (SELECT MAX(rowid) FROM message_nodes) AS last_row_id",
    );
    const firstRowId = range?.first_row_id;
    const lastRowId = range?.last_row_id;
    if (typeof firstRowId !== "number" || typeof lastRowId !== "number") {
      return { records, missing: false, error: false };
    }
    // Page by rowid so message bodies are never materialized together; only metadata is projected.
    for (let after = firstRowId - 1; after < lastRowId; after += MESSAGE_PAGE_SIZE) {
      const rows = yield* sql
        .unsafe<{
          readonly session_id: unknown;
          readonly created_at: unknown;
          readonly metadata: unknown;
        }>(
          `SELECT session_id, created_at, json_extract(chat_message, '$.metadata') AS metadata
           FROM message_nodes
           WHERE rowid > ? AND rowid <= ? AND created_at >= ?
             AND json_valid(chat_message)
             AND json_extract(chat_message, '$.role') = 'assistant'
           ORDER BY rowid`,
          [after, Math.min(after + MESSAGE_PAGE_SIZE, lastRowId), Math.floor(sinceMs / 1000)],
        )
        .pipe(Effect.withTracerEnabled(false));
      for (const row of rows) {
        const record = parseDevinMessage({
          sessionId: text(row.session_id),
          createdAtSeconds: row.created_at,
          metadata: text(row.metadata),
        });
        if (record === null || record.timestampMs < sinceMs) continue;
        if (record.dedupeKey !== null) {
          if (seen.has(record.dedupeKey)) continue;
          seen.add(record.dedupeKey);
        }
        records.push(record);
      }
      yield* Effect.yieldNow;
    }
    return { records, missing: false, error: false };
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })),
    Effect.catchTags({
      SqlError: () => Effect.succeed({ records, missing: false, error: true }),
    }),
  );
});

const resolveDevinSessionsDir = Effect.fn("resolveDevinSessionsDir")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const override = environment["DEVIN_SESSIONS_DIR"]?.trim();
  if (override) return path.resolve(expandHomePath(override, homeDirectory));
  const dataHome = environment["XDG_DATA_HOME"]?.trim();
  return path.join(
    dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(homeDirectory, ".local", "share"),
    "devin",
    "cli",
  );
});

export type DevinUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const devinUsageReader: ProviderUsageReader<AcpRegistrySettings, DevinUsageReaderEnv> = {
  kind: "scan",
  provider: "devin",
  scan: Effect.fn("devinUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    const dirs = new Set<string>();
    for (const instance of instances) {
      // Local commands are not identified as Devin by filename; only registry Devin instances count.
      if (instance.config?.source !== "registry" || instance.config.agentId !== "devin") continue;
      dirs.add(yield* resolveDevinSessionsDir(instance.environment));
    }
    return yield* Effect.forEach(
      dirs,
      (dir) =>
        readDevinUsage(path.join(dir, "sessions.db"), windowStartMs).pipe(
          Effect.map((result) => ({
            dir,
            files: result.missing
              ? null
              : [{ path: path.join(dir, "sessions.db"), records: result.records }],
            status: result.error ? ("partial" as const) : ("ok" as const),
            ...(result.error ? { message: "Some Devin history could not be read." } : {}),
          })),
        ),
      { concurrency: "unbounded" },
    );
  }),
};
