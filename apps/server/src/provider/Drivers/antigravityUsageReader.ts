// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's File.Info has no ctime, which the cache fingerprint needs.
import * as NodeFSP from "node:fs/promises";

import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;

/** Antigravity stores usage metadata as protobuf, independently of conversation text. */
function fields(bytes: Uint8Array): Fields {
  let offset = 0;
  const result: Fields = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) {
        throw new Error("Invalid Antigravity protobuf varint");
      }
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error("Invalid Antigravity protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value: FieldValue;
    if (wire === 0) {
      value = varint();
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number") throw new Error("Invalid protobuf field length");
      if (length > bytes.length - offset) throw new Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const numberAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
};
const bytesAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
};
const nested = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? new Map<number, FieldValue[]>() : fields(bytes);
};
const textAt = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
};
const timestamp = (value: Fields) => {
  const seconds = numberAt(value, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1_000_000) : null;
};

const MODEL_IDS: Record<number, string> = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview",
};

function modelName(name: string, id: number): string {
  if (name) {
    const normalized = name
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replaceAll(" ", "-");
    if (normalized.startsWith("claude-")) {
      return normalized
        .replace(/^claude-(4(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
        .replaceAll(".", "-");
    }
    return normalized;
  }
  return MODEL_IDS[id] ?? (id > 0 ? `antigravity-model-${id}` : "");
}

interface Metadata {
  model: string;
  timestampMs: number | null;
  usages: Fields[];
}

function metadata(bytes: Uint8Array, step: boolean): Metadata {
  const root = fields(bytes);
  if (!step && bytesAt(root, 1) === undefined) {
    throw new Error("Missing Antigravity generation metadata");
  }
  const data = step ? root : nested(root, 1);
  const model = step ? nested(data, 24) : data;
  const usage = bytesAt(data, step ? 9 : 4);
  const usages = usage === undefined ? [] : [fields(usage)];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error("Invalid retry metadata");
    const retryUsage = bytesAt(fields(retry), 2);
    if (retryUsage !== undefined) usages.push(fields(retryUsage));
  }
  return {
    model: modelName(
      textAt(model, step ? 12 : 19) || textAt(model, step ? 8 : 21),
      numberAt(model, step ? 1 : 3),
    ),
    timestampMs: step
      ? (timestamp(nested(data, 8)) ?? timestamp(nested(data, 1)))
      : timestamp(nested(nested(data, 9), 4)),
    usages,
  };
}

function blob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("Invalid Antigravity metadata blob");
  return value;
}

interface UsageCandidate {
  record: UsageRecord;
  keys: readonly string[];
  timestampQuality: number;
}

/** A conversation database whose usage tables are missing or undecodable. */
class AntigravityDatabaseDecodeError extends Schema.TaggedError<AntigravityDatabaseDecodeError>()(
  "AntigravityDatabaseDecodeError",
  { path: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Antigravity usage could not be decoded from ${this.path}.`;
  }
}

const readDatabase = Effect.fn("readDatabase")(function* (
  path: string,
  sessionId: string,
  fallbackTimestamp: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const decode = <A>(evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new AntigravityDatabaseDecodeError({ path, cause }),
    });
  yield* sql.unsafe("PRAGMA busy_timeout = 100");
  return yield* Effect.gen(function* () {
    const tables = new Set(
      (yield* sql.unsafe<{ readonly name: unknown }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )).map((row) => row.name),
    );
    if (!tables.has("gen_metadata") && !tables.has("steps")) {
      return yield* new AntigravityDatabaseDecodeError({ path });
    }
    const readMetadata = Effect.fnUntraced(function* (
      query: string,
      column: string,
      step: boolean,
    ) {
      const entries: Array<{ idx: number; entry: Metadata }> = [];
      for (const row of yield* sql.unsafe<Record<string, unknown>>(query)) {
        const idx = row.idx;
        if (typeof idx !== "number") {
          return yield* new AntigravityDatabaseDecodeError({ path });
        }
        entries.push({ idx, entry: yield* decode(() => metadata(blob(row[column]), step)) });
        if (entries.length % 256 === 0) yield* Effect.yieldNow;
      }
      return entries;
    });
    const generations = tables.has("gen_metadata")
      ? yield* readMetadata("SELECT idx, data FROM gen_metadata ORDER BY idx", "data", false)
      : [];
    let trajectoryTimestamp: number | null = null;
    if (tables.has("trajectory_metadata_blob")) {
      for (const row of yield* sql.unsafe<{ readonly data: unknown }>(
        "SELECT data FROM trajectory_metadata_blob",
      )) {
        trajectoryTimestamp ??= yield* decode(() => timestamp(nested(fields(blob(row.data)), 2)));
      }
    }
    const steps = tables.has("steps")
      ? yield* readMetadata(
          "SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx",
          "metadata",
          true,
        )
      : [];
    return yield* decode(() =>
      usageCandidates(sessionId, generations, steps, trajectoryTimestamp, fallbackTimestamp),
    );
  }).pipe(sql.withTransaction);
});

function usageCandidates(
  sessionId: string,
  generations: ReadonlyArray<{ idx: number; entry: Metadata }>,
  steps: ReadonlyArray<{ idx: number; entry: Metadata }>,
  trajectoryTimestamp: number | null,
  fallbackTimestamp: number,
): UsageCandidate[] {
  const records: UsageCandidate[] = [];
  const generationModels = new Map(generations.map(({ idx, entry }) => [idx, entry.model]));
  for (const [source, entries] of [
    ["step", steps],
    ["generation", generations],
  ] as const) {
    for (const [index, { idx, entry }] of entries.entries()) {
      for (const [usageIndex, usage] of entry.usages.entries()) {
        const outputTokens = Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10));
        const totals = {
          uncachedInputTokens: numberAt(usage, 2),
          cachedInputTokens: numberAt(usage, 5),
          cacheCreationTokens: numberAt(usage, 4),
          outputTokens,
          reasoningTokens: Math.min(outputTokens, numberAt(usage, 9)),
        };
        if (
          totals.uncachedInputTokens +
            totals.cachedInputTokens +
            totals.cacheCreationTokens +
            outputTokens ===
          0
        )
          continue;
        const keys = ([11, 12, 7] as const).flatMap((key) => {
          const id = textAt(usage, key);
          return id ? [`antigravity:${key}:${id}`] : [];
        });
        const record: UsageRecord = {
          provider: "antigravity",
          sessionId,
          timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
          model:
            MODEL_IDS[numberAt(usage, 1)] ||
            entry.model ||
            (source === "step" ? generationModels.get(idx) : "") ||
            modelName("", numberAt(usage, 1)) ||
            "antigravity-unknown",
          totals,
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: keys[0] ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}`,
        };
        records.push({
          record,
          keys,
          timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0,
        });
      }
    }
  }
  return records;
}

interface CachedDatabase {
  readonly fingerprint: string;
  readonly candidates: readonly UsageCandidate[];
}

/**
 * Parsed databases keyed by canonical path. An entry is reused only while both
 * the database and its `-wal` sidecar keep the same size, mtime and ctime: new
 * rows land in the WAL without touching the main file until a checkpoint, and
 * ctime moves on any content write even when mtime is restored.
 */
export const makeAntigravityUsageCache = () => new Map<string, CachedDatabase>();

/**
 * Reads and merges aliases across every configured Antigravity store before date
 * filtering. With a cache, databases unchanged since the previous read are not
 * decoded again.
 */
export const readAntigravityUsage = Effect.fn("readAntigravityUsage")(function* (
  conversationsDirectories: string | readonly string[],
  sinceMs: number,
  cache?: Map<string, CachedDatabase>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const roots =
    typeof conversationsDirectories === "string"
      ? [conversationsDirectories]
      : conversationsDirectories;
  const files: Array<{ root: string; path: string; records: UsageRecord[] }> = [];
  const errors: string[] = [];
  const identities = new Map<string, number>();
  const groups: Array<
    UsageCandidate & { parent: number; size: number; owner: number; fileIndex: number }
  > = [];
  const find = (index: number): number => {
    let root = index;
    while (groups[root]!.parent !== root) root = groups[root]!.parent;
    while (index !== root) {
      const parent = groups[index]!.parent;
      groups[index]!.parent = root;
      index = parent;
    }
    return root;
  };
  const merge = (left: number, right: number): number => {
    let a = find(left);
    let b = find(right);
    if (a === b) return a;
    if (groups[a]!.size < groups[b]!.size) [a, b] = [b, a];
    const target = groups[a]!;
    const source = groups[b]!;
    const first = target.owner < source.owner ? target : source;
    const bestTime =
      source.timestampQuality > target.timestampQuality ||
      (source.timestampQuality === target.timestampQuality &&
        source.record.timestampMs < target.record.timestampMs)
        ? source
        : target;
    const x = target.record.totals;
    const y = source.record.totals;
    target.record = {
      ...first.record,
      model:
        first.record.model === "antigravity-unknown"
          ? first === target
            ? source.record.model
            : target.record.model
          : first.record.model,
      timestampMs: bestTime.record.timestampMs,
      totals: {
        uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens),
        cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens),
        cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens),
        outputTokens: Math.max(x.outputTokens, y.outputTokens),
        reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens),
      },
    };
    target.timestampQuality = bestTime.timestampQuality;
    target.owner = first.owner;
    target.fileIndex = first.fileIndex;
    target.size += source.size;
    source.parent = a;
    return a;
  };
  const append = (candidate: UsageCandidate, fileIndex: number) => {
    const index = groups.length;
    groups.push({ ...candidate, parent: index, size: 1, owner: index, fileIndex });
    for (const key of candidate.keys) {
      const existing = identities.get(key);
      if (existing !== undefined) merge(index, existing);
      identities.set(key, index);
    }
  };
  const visited = new Set<string>();
  const readFile = Effect.fn("readAntigravityUsage.readFile")(function* (path: string) {
    const canonical = yield* fileSystem.realPath(path);
    if (visited.has(canonical)) return null;
    visited.add(canonical);
    const fingerprintOf = (file: string) =>
      Effect.tryPromise(() => NodeFSP.stat(file)).pipe(
        Effect.map((stat) => ({ stat, part: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` })),
      );
    const { stat, part } = yield* fingerprintOf(path);
    const wal = yield* fingerprintOf(`${path}-wal`).pipe(Effect.option);
    const fingerprint = `${part}/${wal._tag === "Some" ? wal.value.part : "-"}`;
    const cached = cache?.get(canonical);
    if (cached?.fingerprint === fingerprint) return cached.candidates;
    const candidates = yield* readDatabase(
      path,
      pathService.basename(path, ".db"),
      stat.mtimeMs,
    ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: path, readonly: true })));
    cache?.set(canonical, { fingerprint, candidates });
    return candidates;
  });
  const walk = (directory: string, root: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const names = yield* fileSystem.readDirectory(directory).pipe(
        Effect.catchTags({
          PlatformError: (cause) => {
            if (cause.reason._tag !== "NotFound") errors.push(directory);
            return Effect.succeed(null);
          },
        }),
      );
      if (names === null) return;
      names.sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        const path = pathService.join(directory, name);
        // Like a directory listing's entry types: symlinks are neither files nor directories.
        const isLink = Exit.isSuccess(yield* Effect.exit(fileSystem.readLink(path)));
        const type = isLink
          ? "SymbolicLink"
          : yield* fileSystem.stat(path).pipe(
              Effect.map((info) => info.type),
              Effect.orElseSucceed(() => null),
            );
        if (type === "Directory") {
          yield* walk(path, root);
        } else if ((type === "File" || type === null) && name.endsWith(".db")) {
          const candidates = yield* readFile(path).pipe(
            Effect.catch(() => {
              errors.push(path);
              return Effect.succeed(null);
            }),
          );
          if (candidates === null) continue;
          const fileIndex = files.length;
          files.push({ root, path, records: [] });
          for (const [index, candidate] of candidates.entries()) {
            append(candidate, fileIndex);
            if (index % 256 === 255) yield* Effect.yieldNow;
          }
        }
      }
    });
  for (const root of roots) yield* walk(root, root);
  if (cache !== undefined) {
    for (const key of cache.keys()) if (!visited.has(key)) cache.delete(key);
  }
  for (const [index, group] of groups.entries()) {
    if (group.parent === index && group.record.timestampMs >= sinceMs) {
      files[group.fileIndex]!.records.push(group.record);
    }
  }
  return { files, errors };
});
