// @effect-diagnostics nodeBuiltinImport:off
/**
 * Cursor usage — dashboard CSV export authenticated from the IDE's local state.
 *
 * Local Cursor DBs do not store token totals usable for the Usage page.
 * OpenUsage's daily spend path fetches
 * `cursor.com/api/dashboard/export-usage-events-csv` with a
 * `WorkosCursorSessionToken` cookie built from the JWT in `state.vscdb`.
 *
 * @module usageCursor
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const REFRESH_TOKEN_KEY = "cursorAuth/refreshToken";
const EXPORT_CSV_URL = "https://cursor.com/api/dashboard/export-usage-events-csv";
const REFRESH_URL = "https://api2.cursor.sh/oauth/token";
const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

/** How long a successful CSV fetch may be reused without hitting the network. */
export const CURSOR_USAGE_CACHE_TTL_MS = 10 * 60 * 1000;

export interface CursorAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly stateDbPath: string;
  readonly stateDbMtimeMs: number;
}

export interface CursorCsvFetchResult {
  readonly records: readonly UsageRecord[];
  readonly status: "ok" | "missing" | "failed";
  readonly message: string | null;
}

/** Platform path to Cursor's `state.vscdb`. */
export function resolveCursorStateDbPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = NodeOS.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return NodePath.join(
      homeDir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  if (platform === "win32") {
    const appData = env["APPDATA"]?.trim();
    const root =
      appData && appData.length > 0 ? appData : NodePath.join(homeDir, "AppData", "Roaming");
    return NodePath.join(root, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const xdg = env["XDG_CONFIG_HOME"]?.trim();
  const configRoot = xdg && xdg.length > 0 ? xdg : NodePath.join(homeDir, ".config");
  return NodePath.join(configRoot, "Cursor", "User", "globalStorage", "state.vscdb");
}

function readStateValue(dbPath: string, key: string): string | null {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1").get(key) as
      | { value: unknown }
      | undefined;
    if (row === undefined || typeof row.value !== "string") return null;
    const trimmed = row.value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function writeStateValue(dbPath: string, key: string, value: string): void {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath);
  } catch {
    return;
  }
  try {
    db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, value);
  } catch {
    // Best-effort persistence of a refreshed access token.
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/** Decodes a JWT payload without verifying the signature. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || parts[1] === undefined) return null;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Builds the `WorkosCursorSessionToken` cookie value OpenUsage/tokscale use:
 * `{userId}%3A%3A{accessToken}`, where `userId` is the JWT `sub` after `|`.
 */
export function cursorSessionFromAccessToken(
  accessToken: string,
): { userId: string; sessionToken: string } | null {
  const payload = decodeJwtPayload(accessToken);
  const subject = typeof payload?.["sub"] === "string" ? payload["sub"].trim() : "";
  if (subject.length === 0) return null;
  const parts = subject.split("|");
  const userId = (parts.length > 1 ? parts[1] : parts[0])?.trim() ?? "";
  if (userId.length === 0) return null;
  return { userId, sessionToken: `${userId}%3A%3A${accessToken}` };
}

export function readCursorAuthTokens(
  stateDbPath: string = resolveCursorStateDbPath(),
): CursorAuthTokens | null {
  if (!NodeFS.existsSync(stateDbPath)) return null;
  let mtimeMs = 0;
  try {
    mtimeMs = NodeFS.statSync(stateDbPath).mtimeMs;
  } catch {
    return null;
  }
  const accessToken = readStateValue(stateDbPath, ACCESS_TOKEN_KEY);
  if (accessToken === null) return null;
  const refreshToken = readStateValue(stateDbPath, REFRESH_TOKEN_KEY);
  return { accessToken, refreshToken, stateDbPath, stateDbMtimeMs: mtimeMs };
}

function parseCsvInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const normalized = raw.trim();
  if (normalized.length === 0) return 0;
  const groups = normalized.split(",");
  if (groups.length > 1) {
    const first = groups[0] ?? "";
    if (first.length < 1 || first.length > 3 || !/^\d+$/.test(first)) return null;
    for (const group of groups.slice(1)) {
      if (group.length !== 3 || !/^\d+$/.test(group)) return null;
    }
  } else if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const value = Number(groups.join(""));
  return Number.isFinite(value) ? value : null;
}

function parseCsvDateMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Timezone-less Cursor export forms must be treated as UTC before `Date.parse`,
  // which otherwise interprets them in the server's local zone.
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(trimmed);
  if (match) {
    const iso = Date.parse(`${match[1]}T${match[2]}Z`);
    return Number.isNaN(iso) ? null : iso;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Minimal RFC4180-ish CSV row splitter (quoted fields, escaped quotes). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let i = 0;
  let state: "start" | "unquoted" | "quoted" | "quoteClosed" = "start";

  const emitRow = () => {
    if (row.length === 0 && field.length === 0) return;
    row.push(field);
    if (!row.every((cell) => cell.length === 0)) rows.push(row);
    row = [];
    field = "";
  };

  while (i < text.length) {
    const c = text[i]!;
    if (state === "quoted") {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        state = "quoteClosed";
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    switch (state) {
      case "start":
        if (c === '"') {
          state = "quoted";
        } else if (c === ",") {
          row.push(field);
          field = "";
        } else if (c === "\n") {
          emitRow();
          state = "start";
        } else if (c === "\r") {
          // swallow; handle on next char / as newline
          if (text[i + 1] === "\n") i += 1;
          emitRow();
          state = "start";
        } else {
          field += c;
          state = "unquoted";
        }
        break;
      case "unquoted":
        if (c === ",") {
          row.push(field);
          field = "";
          state = "start";
        } else if (c === "\n") {
          emitRow();
          state = "start";
        } else if (c === "\r") {
          if (text[i + 1] === "\n") i += 1;
          emitRow();
          state = "start";
        } else if (c === '"') {
          // Illegal quote mid-field — abort remaining parse by returning what we have.
          return rows;
        } else {
          field += c;
        }
        break;
      case "quoteClosed":
        if (c === ",") {
          row.push(field);
          field = "";
          state = "start";
        } else if (c === "\n") {
          emitRow();
          state = "start";
        } else if (c === "\r") {
          if (text[i + 1] === "\n") i += 1;
          emitRow();
          state = "start";
        } else {
          return rows;
        }
        break;
    }
    i += 1;
  }

  if (state !== "quoted" && (field.length > 0 || row.length > 0 || state === "quoteClosed")) {
    emitRow();
  }
  return rows;
}

const REQUIRED_COLUMNS = [
  "Date",
  "Model",
  "Input (w/ Cache Write)",
  "Input (w/o Cache Write)",
  "Cache Read",
  "Output Tokens",
] as const;

/**
 * Parses Cursor's usage-events CSV into `UsageRecord`s.
 *
 * Cost columns are ignored: dollars are imputed later via LiteLLM (same as
 * OpenUsage's token-strategy export path).
 *
 * Distinguishes a valid empty export from a schema/parse failure so callers do
 * not report "ok, zero usage" when the CSV shape changed.
 */
export function parseCursorUsageCsv(csvText: string): {
  readonly ok: boolean;
  readonly records: readonly UsageRecord[];
  readonly message: string | null;
} {
  const rows = parseCsvRows(csvText.replace(/^\uFEFF/, ""));
  if (rows.length === 0) {
    return {
      ok: false,
      records: [],
      message: "Cursor usage export was not CSV.",
    };
  }

  const header = (rows[0] ?? []).map((cell) => cell.trim());
  const index = new Map(header.map((name, i) => [name, i]));
  for (const required of REQUIRED_COLUMNS) {
    if (!index.has(required)) {
      return {
        ok: false,
        records: [],
        message: `Cursor usage export missing required column '${required}'.`,
      };
    }
  }

  // Header-only CSV is a valid empty export.
  if (rows.length === 1) {
    return { ok: true, records: [], message: null };
  }

  const records: UsageRecord[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) continue;

    const cell = (name: string): string => {
      const i = index.get(name);
      return i === undefined ? "" : (row[i] ?? "");
    };

    const timestampMs = parseCsvDateMs(cell("Date"));
    const model = cell("Model").trim();
    const cacheWrite = parseCsvInt(cell("Input (w/ Cache Write)"));
    const input = parseCsvInt(cell("Input (w/o Cache Write)"));
    const cacheRead = parseCsvInt(cell("Cache Read"));
    const output = parseCsvInt(cell("Output Tokens"));

    if (
      timestampMs === null ||
      model.length === 0 ||
      cacheWrite === null ||
      input === null ||
      cacheRead === null ||
      output === null
    ) {
      continue;
    }

    const totals: UsageTokenTotals = {
      uncachedInputTokens: input,
      cachedInputTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      outputTokens: output,
      reasoningTokens: 0,
    };
    if (totalTokens(totals) === 0) continue;

    records.push({
      provider: "cursor",
      timestampMs,
      model,
      sessionId: "",
      totals,
      reportedCostUsd: null,
      dedupeKey: `cursor:${rowIndex}:${timestampMs}:${model}:${input}:${cacheRead}:${cacheWrite}:${output}`,
    });
  }
  return { ok: true, records, message: null };
}

const CURSOR_CSV_TIMEOUT_MS = 30_000;
const CURSOR_REFRESH_TIMEOUT_MS = 15_000;

const cursorFetchFailed = (message: string): CursorCsvFetchResult => ({
  records: [],
  status: "failed",
  message,
});

const refreshAccessToken = Effect.fn("usageCursor.refreshAccessToken")(function* (
  refreshToken: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const body = yield* HttpClientRequest.post(REFRESH_URL).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      grant_type: "refresh_token",
      client_id: CURSOR_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout(CURSOR_REFRESH_TIMEOUT_MS),
    Effect.catchCause(() => Effect.succeed(null)),
  );
  if (typeof body !== "object" || body === null) return null;
  const accessToken = (body as Record<string, unknown>)["access_token"];
  return typeof accessToken === "string" && accessToken.length > 0 ? accessToken : null;
});

/**
 * One export attempt: deadline covers headers and body together (same as the
 * old `AbortSignal.timeout` on `fetch`), so a stalled CSV transfer cannot hang
 * `readSummary`.
 */
const fetchCsvOnce = Effect.fn("usageCursor.fetchCsvOnce")(function* (
  sessionToken: string,
  sinceMs: number,
  untilMs: number,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const url = new URL(EXPORT_CSV_URL);
  url.searchParams.set("startDate", String(Math.trunc(sinceMs)));
  url.searchParams.set("endDate", String(Math.trunc(untilMs)));
  url.searchParams.set("strategy", "tokens");

  return yield* Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(url.toString()).pipe(
      HttpClientRequest.setHeaders({
        Cookie: `WorkosCursorSessionToken=${sessionToken}`,
        Accept: "text/csv",
      }),
      httpClient.execute,
    );
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status < 200 ||
      response.status >= 300
    ) {
      return { kind: "http" as const, status: response.status };
    }
    const text = yield* response.text;
    return { kind: "csv" as const, text };
  }).pipe(Effect.timeout(CURSOR_CSV_TIMEOUT_MS));
});

/**
 * Fetches and parses Cursor usage for `[sinceMs, untilMs]`.
 *
 * On 401/403, refreshes the access token once when a refresh token is present.
 * Uses Effect's `HttpClient` so the network dependency stays in the environment.
 */
export const fetchCursorUsageRecords = Effect.fn("fetchCursorUsageRecords")(function* (input: {
  readonly auth: CursorAuthTokens;
  readonly sinceMs: number;
  readonly untilMs: number;
}): Effect.fn.Return<CursorCsvFetchResult, never, HttpClient.HttpClient> {
  const session = cursorSessionFromAccessToken(input.auth.accessToken);
  if (session === null) {
    return cursorFetchFailed("Cursor access token has no usable subject.");
  }

  let accessToken = input.auth.accessToken;
  let sessionToken = session.sessionToken;
  let result = yield* fetchCsvOnce(sessionToken, input.sinceMs, input.untilMs).pipe(
    Effect.catchCause(() => Effect.succeed(null)),
  );
  if (result === null) {
    return cursorFetchFailed("Cursor usage export request failed.");
  }

  if (
    result.kind === "http" &&
    (result.status === 401 || result.status === 403) &&
    input.auth.refreshToken !== null
  ) {
    const refreshed = yield* refreshAccessToken(input.auth.refreshToken);
    if (refreshed !== null) {
      accessToken = refreshed;
      writeStateValue(input.auth.stateDbPath, ACCESS_TOKEN_KEY, refreshed);
      const nextSession = cursorSessionFromAccessToken(accessToken);
      if (nextSession !== null) {
        sessionToken = nextSession.sessionToken;
        result = yield* fetchCsvOnce(sessionToken, input.sinceMs, input.untilMs).pipe(
          Effect.catchCause(() => Effect.succeed(null)),
        );
        if (result === null) {
          return cursorFetchFailed("Cursor usage export request failed after refresh.");
        }
      }
    }
  }

  if (result.kind === "http") {
    if (result.status === 401 || result.status === 403) {
      return cursorFetchFailed("Cursor session expired. Sign in via the Cursor app.");
    }
    return cursorFetchFailed(`Cursor usage export returned HTTP ${result.status}.`);
  }

  // Validity comes from the parsed header row so quoted CSV headers
  // (`"Date","Model",...`) are accepted the same as bare `Date,Model,...`.
  const parsed = parseCursorUsageCsv(result.text);
  if (!parsed.ok) {
    return cursorFetchFailed(parsed.message ?? "Cursor usage export could not be parsed.");
  }

  return {
    records: parsed.records,
    status: "ok",
    message: null,
  };
});
