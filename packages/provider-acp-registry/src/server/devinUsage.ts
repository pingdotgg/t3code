import * as NodeSqlite from "node:sqlite";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../settings.ts";

/** Cognition bills 1 ACU at $2.00 USD (matches Devin's per-1M token pricing sheet). */
export const DEVIN_USD_PER_ACU = 2.0;

const WINDOW_QUERY_SLACK_MS = 24 * 60 * 60 * 1_000;

interface DevinModelPrice {
  readonly inputPerMillion: number;
  readonly cacheReadPerMillion: number;
  readonly outputPerMillion: number;
}

interface ProtoField {
  readonly fieldNumber: number;
  readonly f32?: number;
  readonly f64?: number;
  readonly varint?: bigint;
  readonly bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, offset: number): readonly [bigint, number] | null {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buf.length && shift <= 63n) {
    const byte = buf[cursor++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, cursor] as const;
    shift += 7n;
  }
  return null;
}

function decodeProtoFields(buf: Uint8Array): readonly ProtoField[] {
  const fields: ProtoField[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;
  while (offset < buf.length) {
    const tagResult = readVarint(buf, offset);
    if (tagResult === null) break;
    const [tag, nextOffset] = tagResult;
    offset = nextOffset;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber <= 0) break;
    if (wireType === 0) {
      const valueResult = readVarint(buf, offset);
      if (valueResult === null) break;
      const [varint, after] = valueResult;
      offset = after;
      fields.push({ fieldNumber, varint });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      fields.push({ fieldNumber, f64: view.getFloat64(offset, true) });
      offset += 8;
    } else if (wireType === 2) {
      const lenResult = readVarint(buf, offset);
      if (lenResult === null) break;
      const [lengthBig, afterLen] = lenResult;
      const length = Number(lengthBig);
      if (!Number.isSafeInteger(length) || length < 0 || afterLen + length > buf.length) break;
      fields.push({ fieldNumber, bytes: buf.subarray(afterLen, afterLen + length) });
      offset = afterLen + length;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      fields.push({ fieldNumber, f32: view.getFloat32(offset, true) });
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });

function fieldString(fields: readonly ProtoField[], fieldNumber: number): string | undefined {
  const bytes = fields.find((field) => field.fieldNumber === fieldNumber)?.bytes;
  if (!bytes || bytes.length === 0) return undefined;
  const decoded = textDecoder.decode(bytes).trim();
  return decoded.length > 0 ? decoded : undefined;
}

function fieldNumber(fields: readonly ProtoField[], fieldNumber: number): number | undefined {
  const field = fields.find((entry) => entry.fieldNumber === fieldNumber);
  if (!field) return undefined;
  const value =
    field.f64 ??
    field.f32 ??
    (field.varint !== undefined && field.varint <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(field.varint)
      : undefined);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseDevinModelPricesPayload(
  base64Payload: string,
): ReadonlyMap<string, DevinModelPrice> {
  const prices = new Map<string, DevinModelPrice>();
  if (base64Payload.trim().length === 0) return prices;
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(base64Payload, "base64");
  } catch {
    return prices;
  }
  const modelsBytes = decodeProtoFields(bytes).find((field) => field.fieldNumber === 33)?.bytes;
  if (!modelsBytes) return prices;
  for (const entry of decodeProtoFields(modelsBytes)) {
    if (!entry.bytes) continue;
    const modelFields = decodeProtoFields(entry.bytes);
    const modelId = fieldString(modelFields, 22);
    if (!modelId) continue;
    let inputPerMillion: number | undefined;
    let cacheReadPerMillion: number | undefined;
    let outputPerMillion: number | undefined;
    for (const pricingField of modelFields) {
      if (pricingField.fieldNumber !== 32 || !pricingField.bytes) continue;
      const row = decodeProtoFields(pricingField.bytes);
      const label = fieldString(row, 1)?.toLowerCase();
      const amount = fieldNumber(row, 2);
      if (label === undefined || amount === undefined || amount < 0) continue;
      if (label === "input") inputPerMillion = amount;
      else if (label === "cached input") cacheReadPerMillion = amount;
      else if (label === "output") outputPerMillion = amount;
    }
    if (inputPerMillion !== undefined && outputPerMillion !== undefined) {
      prices.set(modelId, {
        inputPerMillion,
        cacheReadPerMillion: cacheReadPerMillion ?? inputPerMillion,
        outputPerMillion,
      });
    }
  }
  return prices;
}

function isDevinAcpRegistrySettings(settings: AcpRegistrySettings | undefined): boolean {
  if (!settings) return false;
  if (settings.source !== "local") return settings.agentId === "devin";
  const base = settings.commandPath.split(/[\\/]/).pop() ?? "";
  return /^devin(\.exe|\.cmd)?$/i.test(base);
}

const resolveDevinDirs = Effect.fn("resolveDevinDirs")(function* (
  environment: NodeJS.ProcessEnv,
  kind: "roaming" | "cache",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const rawOverride =
    kind === "cache"
      ? (environment["DEVIN_CACHE_DIR"] ?? environment["DEVIN_DATA_DIR"])
      : environment["DEVIN_DATA_DIR"];
  const configured = rawOverride
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const defaults: string[] = [];
  if (platform === "win32") {
    const envVar = kind === "cache" ? "LOCALAPPDATA" : "APPDATA";
    const fallback = kind === "cache" ? "Local" : "Roaming";
    const root = environment[envVar]?.trim();
    defaults.push(
      root && path.isAbsolute(root)
        ? path.join(root, "devin", "cli")
        : path.join(home, "AppData", fallback, "devin", "cli"),
    );
  } else if (platform === "darwin") {
    defaults.push(
      path.join(
        home,
        "Library",
        kind === "cache" ? "Caches" : "Application Support",
        "devin",
        "cli",
      ),
    );
    defaults.push(path.join(home, kind === "cache" ? ".cache" : ".config", "devin", "cli"));
  } else {
    const envVar = kind === "cache" ? "XDG_CACHE_HOME" : "XDG_CONFIG_HOME";
    const fallback = kind === "cache" ? ".cache" : ".config";
    const root = environment[envVar]?.trim();
    defaults.push(
      root && path.isAbsolute(root)
        ? path.join(root, "devin", "cli")
        : path.join(home, fallback, "devin", "cli"),
    );
  }
  const canonical = new Set<string>();
  for (const root of configured?.length ? configured : defaults) {
    const resolved = path.resolve(expandHomePath(root, home));
    canonical.add(yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)));
  }
  return [...canonical];
});

const decodeUserStatusCacheFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ payload: Schema.String })),
);

export const readDevinModelPrices = Effect.fn("readDevinModelPrices")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dirs = yield* resolveDevinDirs(environment, "cache");
  let newest: { readonly filePath: string; readonly mtimeMs: number } | null = null;
  for (const dir of dirs) {
    const entries = yield* fileSystem
      .readDirectory(dir)
      .pipe(Effect.catchCause(() => Effect.succeed([] as string[])));
    for (const name of entries) {
      if (!name.startsWith("user_status.") || !name.endsWith(".bin")) continue;
      const filePath = path.join(dir, name);
      const stat = yield* fileSystem
        .stat(filePath)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (!stat || stat.type !== "File") continue;
      const mtimeMs = stat.mtime._tag === "Some" ? stat.mtime.value.getTime() : 0;
      if (newest === null || mtimeMs > newest.mtimeMs) {
        newest = { filePath, mtimeMs };
      }
    }
  }
  if (newest === null) return new Map<string, DevinModelPrice>();
  const raw = yield* fileSystem
    .readFileString(newest.filePath)
    .pipe(Effect.catchCause(() => Effect.succeed(null)));
  if (raw === null) return new Map<string, DevinModelPrice>();
  const decoded = Option.getOrUndefined(decodeUserStatusCacheFile(raw));
  return decoded
    ? parseDevinModelPricesPayload(decoded.payload)
    : new Map<string, DevinModelPrice>();
});

function computeModelPricedCost(price: DevinModelPrice, totals: UsageRecord["totals"]): number {
  return (
    (totals.uncachedInputTokens * price.inputPerMillion +
      totals.cachedInputTokens * price.cacheReadPerMillion +
      totals.cacheCreationTokens * price.inputPerMillion * 1.25 +
      totals.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}

export function parseDevinMessageNodeRow(
  row: {
    readonly session_id: string;
    readonly session_model: string;
    readonly node_id: number;
    readonly created_at: number;
    readonly chat_message: string;
  },
  modelPrices: ReadonlyMap<string, DevinModelPrice>,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.chat_message);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message["role"] !== "assistant") return null;

  const metadata = message["metadata"];
  if (typeof metadata !== "object" || metadata === null) return null;
  const meta = metadata as Record<string, unknown>;

  const metrics = meta["metrics"];
  if (typeof metrics !== "object" || metrics === null) return null;
  const metricRecord = metrics as Record<string, unknown>;

  const uncachedInputTokens = tokenCount(metricRecord["input_tokens"]);
  const cachedInputTokens = tokenCount(metricRecord["cache_read_tokens"]);
  const cacheCreationTokens = tokenCount(metricRecord["cache_creation_tokens"]);
  const outputTokens = tokenCount(metricRecord["output_tokens"]);
  if (
    uncachedInputTokens === 0 &&
    cachedInputTokens === 0 &&
    cacheCreationTokens === 0 &&
    outputTokens === 0
  ) {
    return null;
  }

  const generationModel =
    typeof meta["generation_model"] === "string" ? meta["generation_model"].trim() : "";
  const model = generationModel.length > 0 ? generationModel : row.session_model.trim();
  if (model.length === 0) return null;

  const timestampMs =
    parseTimestampMs(meta["created_at"]) ??
    (Number.isFinite(row.created_at) && row.created_at > 0 ? row.created_at * 1_000 : null);
  if (timestampMs === null) return null;

  const totals: UsageRecord["totals"] = {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: 0,
  };

  const acuCost = meta["committed_acu_cost"];
  let reportedCostUsd: number | null =
    typeof acuCost === "number" && Number.isFinite(acuCost) && acuCost >= 0
      ? acuCost * DEVIN_USD_PER_ACU
      : null;

  if (reportedCostUsd === null) {
    const price = modelPrices.get(model);
    if (price !== undefined) {
      reportedCostUsd = computeModelPricedCost(price, totals);
    }
  }

  const requestId = typeof meta["request_id"] === "string" ? meta["request_id"].trim() : "";
  const dedupeKey =
    requestId.length > 0 ? `devin:${requestId}` : `devin:${row.session_id}:${row.node_id}`;

  const speed = model.endsWith("-priority") || model.endsWith("-fast") ? "fast" : "standard";

  return {
    provider: "devin",
    timestampMs,
    model,
    sessionId: row.session_id,
    totals,
    reportedCostUsd,
    speed,
    dedupeKey,
  };
}

export function readDevinSessionsDb(
  dbPath: string,
  windowStartMs: number,
  modelPrices: ReadonlyMap<string, DevinModelPrice>,
): { readonly records: readonly UsageRecord[]; readonly error: boolean } {
  let db: NodeSqlite.DatabaseSync | null = null;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const sinceSecs = Math.max(0, Math.floor((windowStartMs - WINDOW_QUERY_SLACK_MS) / 1_000));
    const statement = db.prepare(
      `SELECT m.session_id, s.model AS session_model, m.node_id, m.created_at, m.chat_message
       FROM message_nodes m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.created_at >= ? AND m.chat_message LIKE '%"metrics":{%'`,
    );
    const rows = statement.all(sinceSecs) as unknown as ReadonlyArray<{
      readonly session_id: string;
      readonly session_model: string;
      readonly node_id: number;
      readonly created_at: number;
      readonly chat_message: string;
    }>;
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const record = parseDevinMessageNodeRow(row, modelPrices);
      if (record !== null) records.push(record);
    }
    return { records, error: false };
  } catch {
    return { records: [], error: true };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors on read-only handles
    }
  }
}

export type DevinUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const devinUsageReader: ProviderUsageReader<AcpRegistrySettings, DevinUsageReaderEnv> = {
  kind: "scan",
  provider: "devin",
  scan: Effect.fn("devinUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const relevant = instances.filter(
      (instance) => !instance.configured || isDevinAcpRegistrySettings(instance.config),
    );
    const roots = new Set<string>();
    const modelPrices = new Map<string, DevinModelPrice>();
    for (const instance of relevant) {
      for (const dir of yield* resolveDevinDirs(instance.environment, "roaming")) {
        roots.add(dir);
      }
      const prices = yield* readDevinModelPrices(instance.environment);
      for (const [model, price] of prices) {
        if (!modelPrices.has(model)) modelPrices.set(model, price);
      }
    }

    return yield* Effect.forEach(
      roots,
      Effect.fnUntraced(function* (dir) {
        const dbPath = path.join(dir, "sessions.db");
        const exists = yield* fileSystem
          .exists(dbPath)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (!exists) {
          return { dir, files: null, status: "ok" as const };
        }
        const { records, error } = yield* Effect.sync(() =>
          readDevinSessionsDb(dbPath, windowStartMs, modelPrices),
        );
        return {
          dir,
          files: [{ path: dbPath, records }],
          status: error ? ("partial" as const) : ("ok" as const),
          ...(error ? { message: "Some Devin session history could not be read." } : {}),
        };
      }),
      { concurrency: "unbounded" },
    );
  }),
};
