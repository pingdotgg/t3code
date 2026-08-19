// @effect-diagnostics nodeBuiltinImport:off
/**
 * Cursor usage via the dashboard CSV export API.
 *
 * Cursor agent transcripts under `~/.cursor` carry no token counts. The only
 * complete ledger is Cursor's own export
 * (`/api/dashboard/export-usage-events-csv?strategy=tokens`), authenticated
 * with the desktop session token from `state.vscdb` — the same path tools like
 * tokscale use.
 *
 * Direct `node:fs` / `node:path` / `node:sqlite` are deliberate: the scan sits
 * on the same page-load path as the JSONL transcript walkers, and Effect's
 * FileSystem wrappers add nothing here beyond the SQLite + atomic write we need.
 *
 * @module usageCursorExport
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as Effect from "effect/Effect";

import type { UsageRecord } from "./usageTranscripts.ts";

const CURSOR_USAGE_CSV_URL =
  "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";

/** Skip a network refresh when the on-disk CSV is newer than this. */
const CURSOR_EXPORT_FRESHNESS_MS = 5 * 60 * 1000;

interface CursorExportAuth {
  readonly userId: string;
  readonly sessionToken: string;
}

export type CursorExportLoadResult =
  | {
      readonly status: "ok";
      readonly userId: string;
      readonly records: readonly UsageRecord[];
      readonly fromCache: boolean;
    }
  | {
      readonly status: "missing" | "failed";
      readonly message: string;
      readonly userId: string | null;
    };

/**
 * Candidate paths for Cursor desktop `state.vscdb` (VS Code globalStorage).
 */
function cursorStateDbCandidates(homeDir: string = NodeOS.homedir()): readonly string[] {
  const paths: string[] = [
    NodePath.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    NodePath.join(
      homeDir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
    NodePath.join(homeDir, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];

  // Windows LOCALAPPDATA variant when the process env is set.
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.length > 0) {
    paths.push(NodePath.join(localAppData, "Cursor", "User", "globalStorage", "state.vscdb"));
  }

  return paths;
}

function findCursorStateDb(homeDir?: string): string | null {
  for (const candidate of cursorStateDbCandidates(homeDir)) {
    try {
      if (NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep probing.
    }
  }
  return null;
}

/**
 * Reads `cursorAuth/accessToken` from a Cursor `state.vscdb`.
 *
 * Opens read-only so a running Cursor IDE write lock does not block the scan.
 */
function readAccessTokenFromStateDb(dbPath: string): string | null {
  try {
    const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
        .get() as { value?: unknown } | undefined;
      const token = typeof row?.value === "string" ? row.value.trim() : "";
      return token.length > 0 ? token : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

/**
 * Extracts the Cursor `user_…` id from a JWT `sub` claim (e.g. `auth0|user_abc`).
 */
export function userIdFromAccessTokenJwt(accessToken: string): string | null {
  const payloadB64 = accessToken.split(".")[1];
  if (!payloadB64) return null;

  try {
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf8");
    const payload = JSON.parse(json) as { sub?: unknown };
    if (typeof payload.sub !== "string") return null;
    const idx = payload.sub.indexOf("user_");
    if (idx < 0) return null;
    const rest = payload.sub.slice(idx);
    const end = rest.search(/[^A-Za-z0-9_]/);
    const userId = end < 0 ? rest : rest.slice(0, end);
    return userId.length > "user_".length ? userId : null;
  } catch {
    return null;
  }
}

/**
 * Builds the `WorkosCursorSessionToken` cookie value from a desktop access token.
 * Format: `{userId}%3A%3A{accessToken}` (`%3A%3A` is URL-encoded `::`).
 */
export function sessionTokenFromAccessToken(accessToken: string): CursorExportAuth | null {
  const userId = userIdFromAccessTokenJwt(accessToken);
  if (userId === null) return null;
  return {
    userId,
    sessionToken: `${userId}%3A%3A${accessToken}`,
  };
}

function readLocalCursorExportAuth(homeDir?: string): CursorExportAuth | null {
  const dbPath = findCursorStateDb(homeDir);
  if (dbPath === null) return null;
  const accessToken = readAccessTokenFromStateDb(dbPath);
  if (accessToken === null) return null;
  return sessionTokenFromAccessToken(accessToken);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      fields.push(line.slice(start, i));
      start = i + 1;
    }
  }
  fields.push(line.slice(start));
  return fields;
}

function unquote(field: string): string {
  const trimmed = field.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseCostUsd(costStr: string): number | null {
  const cleaned = costStr.replace(/[$,]/g, "").trim();
  if (
    cleaned.length === 0 ||
    cleaned.toLowerCase() === "nan" ||
    cleaned.toLowerCase() === "included" ||
    cleaned === "-" ||
    !/[0-9]/.test(cleaned)
  ) {
    // Non-numeric costs (Included, Errored/No Charge) are not provider-reported
    // dollars — leave null so LiteLLM can price API-equivalent cost.
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseTokenCount(value: string): number {
  const parsed = Number(unquote(value).replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function parseTimestampMs(dateStr: string): number | null {
  const trimmed = dateStr.trim();
  if (trimmed.length === 0) return null;

  // Date-only: noon UTC keeps the local calendar day stable across zones.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}T12:00:00.000Z`);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Parses a Cursor usage-export CSV (v1 / v2 / v3 headers) into usage records.
 */
export function parseCursorUsageCsv(csv: string, userId: string): readonly UsageRecord[] {
  const lines = csv.split(/\r?\n/);
  const headerLine = lines[0];
  if (!headerLine || !headerLine.includes("Date") || !headerLine.includes("Model")) {
    return [];
  }

  const headerFields = parseCsvLine(headerLine).map((field) => unquote(field));
  const hasKind = headerFields.includes("Kind");
  const columnCount = headerFields.length;

  // Column indices match tokscale's cursor CSV parser.
  const [modelIdx, inputWithCacheIdx, inputNoCacheIdx, cacheReadIdx, outputIdx, costIdx] =
    hasKind && columnCount >= 11
      ? ([4, 6, 7, 8, 9, 11] as const)
      : hasKind
        ? ([2, 4, 5, 6, 7, 9] as const)
        : ([1, 2, 3, 4, 5, 7] as const);

  const records: UsageRecord[] = [];

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line || line.trim().length === 0) continue;

    const fields = parseCsvLine(line);
    if (fields.length <= costIdx) continue;

    const dateStr = unquote(fields[0] ?? "");
    const model = unquote(fields[modelIdx] ?? "");
    if (model.length === 0) continue;

    const timestampMs = parseTimestampMs(dateStr);
    if (timestampMs === null) continue;

    const inputWithCacheWrite = parseTokenCount(fields[inputWithCacheIdx] ?? "0");
    const inputWithoutCacheWrite = parseTokenCount(fields[inputNoCacheIdx] ?? "0");
    const cacheRead = parseTokenCount(fields[cacheReadIdx] ?? "0");
    const outputTokens = parseTokenCount(fields[outputIdx] ?? "0");
    const costUsd = parseCostUsd(unquote(fields[costIdx] ?? ""));

    const totals: UsageTokenTotals = {
      uncachedInputTokens: inputWithoutCacheWrite,
      cachedInputTokens: cacheRead,
      // The two input columns are disjoint buckets: tokens written to cache
      // and tokens read fresh. Cursor's Total Tokens is their sum plus cache
      // read and output, so the columns must not be diffed.
      cacheCreationTokens: inputWithCacheWrite,
      outputTokens,
      reasoningTokens: 0,
    };

    if (
      totals.uncachedInputTokens === 0 &&
      totals.cachedInputTokens === 0 &&
      totals.cacheCreationTokens === 0 &&
      totals.outputTokens === 0
    ) {
      continue;
    }

    records.push({
      provider: "cursor",
      timestampMs,
      model,
      // Modern exports timestamp every row, so a per-row session id would
      // count every event as its own session. Collapse to the calendar day.
      sessionId: `cursor-${userId}-${dateStr.slice(0, 10)}`,
      totals,
      // Numeric Cost only. Included / "-" stay null so LiteLLM prices them.
      reportedCostUsd: costUsd,
      dedupeKey: `cursor:${userId}:${dateStr}:${model}:${lineIndex}`,
    });
  }

  return records;
}

function isFreshCsvCache(cachePath: string, nowMs: number): boolean {
  try {
    const stats = NodeFS.statSync(cachePath);
    return nowMs - stats.mtimeMs < CURSOR_EXPORT_FRESHNESS_MS;
  } catch {
    return false;
  }
}

function readCsvCache(cachePath: string): string | null {
  try {
    const text = NodeFS.readFileSync(cachePath, "utf8");
    return text.startsWith("Date,") ? text : null;
  } catch {
    return null;
  }
}

function writeCsvCache(cachePath: string, csv: string): void {
  try {
    NodeFS.mkdirSync(NodePath.dirname(cachePath), { recursive: true });
    const tempPath = `${cachePath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(tempPath, csv, { encoding: "utf8", mode: 0o600 });
    NodeFS.renameSync(tempPath, cachePath);
  } catch {
    // Cache write failure only slows the next scan.
  }
}

/** Per-account cache path so a desktop login switch cannot reuse another user's CSV. */
export function cursorExportCachePath(cacheDir: string, userId: string): string {
  const safeUserId = userId.replace(/[^A-Za-z0-9_-]/g, "_");
  return NodePath.join(cacheDir, `usage-cursor-export.${safeUserId}.csv`);
}

/**
 * Loads Cursor usage records, preferring a fresh on-disk CSV and refreshing
 * from the dashboard export API when needed.
 */
export function loadCursorUsageRecords(options: {
  readonly cacheDir: string;
  readonly homeDir?: string;
  readonly nowMs: number;
}): Effect.Effect<CursorExportLoadResult, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const nowMs = options.nowMs;
    const auth = readLocalCursorExportAuth(options.homeDir);
    if (auth === null) {
      return {
        status: "missing" as const,
        userId: null,
        message:
          "Cursor desktop is not signed in on this environment (state.vscdb access token missing).",
      };
    }

    const cachePath = cursorExportCachePath(options.cacheDir, auth.userId);
    const cached = readCsvCache(cachePath);
    if (cached !== null && isFreshCsvCache(cachePath, nowMs)) {
      return {
        status: "ok" as const,
        userId: auth.userId,
        records: parseCursorUsageCsv(cached, auth.userId),
        fromCache: true,
      };
    }

    const request = HttpClientRequest.get(CURSOR_USAGE_CSV_URL).pipe(
      HttpClientRequest.setHeader("Accept", "*/*"),
      HttpClientRequest.setHeader("Accept-Language", "en-US,en;q=0.9"),
      HttpClientRequest.setHeader("Cookie", `WorkosCursorSessionToken=${auth.sessionToken}`),
      HttpClientRequest.setHeader("Referer", "https://www.cursor.com/settings"),
      // Cursor's export endpoint rejects non-browser clients without a UA.
      HttpClientRequest.setHeader(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    );

    const fetched = yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout(15_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );

    if (fetched !== null && fetched.startsWith("Date,")) {
      writeCsvCache(cachePath, fetched);
      return {
        status: "ok" as const,
        userId: auth.userId,
        records: parseCursorUsageCsv(fetched, auth.userId),
        fromCache: false,
      };
    }

    // Network failed; serve this account's stale cache when present.
    if (cached !== null) {
      return {
        status: "ok" as const,
        userId: auth.userId,
        records: parseCursorUsageCsv(cached, auth.userId),
        fromCache: true,
      };
    }

    return {
      status: "failed" as const,
      userId: auth.userId,
      message: "Cursor usage export could not be fetched.",
    };
  });
}
