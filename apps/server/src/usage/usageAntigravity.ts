// @effect-diagnostics nodeBuiltinImport:off - conversations are SQLite files, and
// `node:sqlite` is the only in-process reader; Effect has no SQLite file system.
// It is imported lazily: the persistence layer swaps in `bun:sqlite` under Bun,
// where `node:sqlite` may not resolve, and the usage scan must not take the
// server down with it.
/**
 * Antigravity conversation databases as a usage source.
 *
 * Antigravity keeps one SQLite file per conversation. Its `gen_metadata` table
 * holds one protobuf `exa.cortex_pb.CortexStepGeneratorMetadata` per model
 * generation, and that record carries the exact token counts the backend
 * reported. Only a handful of fields matter here, so the decoder below reads
 * the protobuf wire format directly instead of pulling in a proto runtime and
 * schema for a 60 KB record.
 *
 * Field numbers come from the descriptors bundled with the agent:
 *
 * ```
 * CortexStepGeneratorMetadata
 *   1 chat_model: ChatModelMetadata
 *     4 usage: ModelUsageStats
 *       2 input_tokens          (uncached only; cache reads are reported separately)
 *       3 output_tokens         (thinking + response)
 *       4 cache_write_tokens
 *       5 cache_read_tokens
 *       9 thinking_output_tokens
 *      10 response_output_tokens
 *     9 chat_start_metadata.4 created_at: google.protobuf.Timestamp
 *    19 response_model          ("gemini-3.8-flash")
 *    22 response_model_full
 *   4 execution_id              (the conversation id)
 * ```
 *
 * @module usageAntigravity
 */
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

/** Decoded protobuf message: last-wins scalars, every length-delimited value. */
interface WireMessage {
  readonly varints: ReadonlyMap<number, bigint>;
  readonly bytes: ReadonlyMap<number, readonly Uint8Array[]>;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

function readVarint(buffer: Uint8Array, position: number): [value: bigint, next: number] | null {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < 10; index += 1) {
    const byte = buffer[position + index];
    if (byte === undefined) return null;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, position + index + 1];
    shift += 7n;
  }
  return null;
}

/** Splits one message into its fields, or `null` when the bytes are not valid protobuf. */
function decodeMessage(buffer: Uint8Array): WireMessage | null {
  const varints = new Map<number, bigint>();
  const bytes = new Map<number, Uint8Array[]>();
  let position = 0;
  while (position < buffer.length) {
    const tag = readVarint(buffer, position);
    if (tag === null) return null;
    const fieldNumber = Number(tag[0] >> 3n);
    const wireType = Number(tag[0] & 7n);
    position = tag[1];
    if (fieldNumber === 0) return null;

    switch (wireType) {
      case WIRE_VARINT: {
        const read = readVarint(buffer, position);
        if (read === null) return null;
        varints.set(fieldNumber, read[0]);
        position = read[1];
        break;
      }
      case WIRE_FIXED64:
        position += 8;
        break;
      case WIRE_FIXED32:
        position += 4;
        break;
      case WIRE_LENGTH_DELIMITED: {
        const length = readVarint(buffer, position);
        if (length === null) return null;
        const start = length[1];
        const end = start + Number(length[0]);
        if (end > buffer.length) return null;
        const existing = bytes.get(fieldNumber);
        if (existing === undefined) bytes.set(fieldNumber, [buffer.subarray(start, end)]);
        else existing.push(buffer.subarray(start, end));
        position = end;
        break;
      }
      default:
        // Groups are deprecated and never appear in these records.
        return null;
    }
    if (position > buffer.length) return null;
  }
  return { varints, bytes };
}

const utf8 = new TextDecoder();

/**
 * `Timestamp.seconds` at the edge of what a JavaScript `Date` holds; anything
 * from here up is rejected. A negative int64 arrives as `2^64 - n` and lands
 * well past this, so the bound rejects both pre-1970 and out-of-range instants
 * before they can produce an invalid `Date` in the aggregator.
 */
const MAX_TIMESTAMP_SECONDS = 8_640_000_000_000n;
const NANOS_PER_SECOND = 1_000_000_000n;

function firstBytes(message: WireMessage, field: number): Uint8Array | undefined {
  return message.bytes.get(field)?.[0];
}

function firstString(message: WireMessage, field: number): string {
  const value = firstBytes(message, field);
  return value === undefined ? "" : utf8.decode(value);
}

function firstMessage(message: WireMessage, field: number): WireMessage | null {
  const value = firstBytes(message, field);
  return value === undefined ? null : decodeMessage(value);
}

function count(message: WireMessage, field: number): number {
  const value = message.varints.get(field);
  if (value === undefined || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
  return Number(value);
}

/**
 * Parses one `gen_metadata.data` blob into a usage record.
 *
 * `fallbackSessionId` is the conversation the row was read from, used when the
 * record does not name its own execution id.
 */
export function parseAntigravityGeneration(
  data: Uint8Array,
  fallbackSessionId: string,
): UsageRecord | null {
  const root = decodeMessage(data);
  if (root === null) return null;
  const chatModel = firstMessage(root, 1);
  if (chatModel === null) return null;
  const usage = firstMessage(chatModel, 4);
  if (usage === null) return null;

  const createdAt = firstMessage(chatModel, 9);
  const timestamp = createdAt === null ? null : firstMessage(createdAt, 4);
  if (timestamp === null) return null;
  const seconds = timestamp.varints.get(1);
  const nanos = timestamp.varints.get(2) ?? 0n;
  if (seconds === undefined || seconds >= MAX_TIMESTAMP_SECONDS || nanos >= NANOS_PER_SECOND) {
    return null;
  }
  const timestampMs = Number(seconds) * 1000 + Number(nanos / 1_000_000n);

  const model = firstString(chatModel, 19) || firstString(chatModel, 22);
  if (model.length === 0) return null;

  const thinkingTokens = count(usage, 9);
  // `output_tokens` already folds thinking in; older records without it only
  // carry the two halves.
  const outputTokens = usage.varints.has(3) ? count(usage, 3) : thinkingTokens + count(usage, 10);
  const totals: UsageTokenTotals = {
    // Observed on a cache hit: `input_tokens` dropped by exactly the
    // `cache_read_tokens` reported beside it, so the three counts are disjoint
    // and must not be subtracted from one another.
    uncachedInputTokens: count(usage, 2),
    cachedInputTokens: count(usage, 5),
    cacheCreationTokens: count(usage, 4),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, thinkingTokens),
  };
  if (totalTokens(totals) === 0) return null;

  return {
    provider: "antigravity",
    timestampMs,
    model,
    sessionId: firstString(root, 4) || fallbackSessionId,
    totals,
    reportedCostUsd: null,
    // One row per generation. UsageService deduplicates canonical database
    // paths before reading, so records need no further generation-level key.
    dedupeKey: null,
  };
}

/**
 * Reads every generation in one conversation database.
 *
 * Opened read-only so the scan can never interfere with an agent that is
 * still writing. The query itself is synchronous, but bounded: finished
 * generations are compacted to a few hundred bytes and only the one in flight
 * is large, so even a 2,000-generation conversation reads in about 70 ms, a
 * typical one in single-digit milliseconds. Each call first yields to the
 * event loop so a cold scan over many conversations interleaves with other
 * work, and the result is memoised by the caller until the database or its
 * write-ahead log changes.
 *
 * Returns `null` when the file could not be opened or queried, which the
 * caller must not cache: a database the agent has locked for a moment is not
 * an empty conversation. A file that is valid SQLite but carries no
 * `gen_metadata` table is genuinely empty and returns `[]`.
 */
export async function readAntigravityConversation(
  filePath: string,
): Promise<readonly UsageRecord[] | null> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  let database: NodeSqlite.DatabaseSync;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(filePath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'")
      .get();
    if (table === undefined) return [];
    const fallbackSessionId = NodePath.basename(filePath, ".db");
    const records: UsageRecord[] = [];
    for (const row of database.prepare("SELECT data FROM gen_metadata ORDER BY idx").iterate()) {
      const data = row["data"];
      if (!(data instanceof Uint8Array)) continue;
      const record = parseAntigravityGeneration(data, fallbackSessionId);
      if (record !== null) records.push(record);
    }
    return records;
  } catch {
    return null;
  } finally {
    database.close();
  }
}
