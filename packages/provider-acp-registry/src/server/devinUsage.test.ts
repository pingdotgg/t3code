import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DEVIN_USD_PER_ACU,
  devinUsageReader,
  parseDevinMessageNodeRow,
  parseDevinModelPricesPayload,
  readDevinSessionsDb,
} from "./devinUsage.ts";

function encodeVarint(value: number | bigint): Uint8Array {
  let n = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0n);
  return Uint8Array.from(bytes);
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function fieldBytes(fieldNumber: number, payload: Uint8Array): Uint8Array {
  return concatBytes(
    encodeVarint((BigInt(fieldNumber) << 3n) | 2n),
    encodeVarint(payload.length),
    payload,
  );
}

function fieldStr(fieldNumber: number, text: string): Uint8Array {
  return fieldBytes(fieldNumber, new TextEncoder().encode(text));
}

function fieldF32(fieldNumber: number, value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, value, true);
  return concatBytes(encodeVarint((BigInt(fieldNumber) << 3n) | 5n), buf);
}

function buildSamplePricingBase64(): string {
  const modelPricing = concatBytes(
    fieldStr(22, "gemini-4-neon-high"),
    fieldBytes(32, concatBytes(fieldStr(1, "Input"), fieldF32(2, 3), fieldStr(3, "1M tokens"))),
    fieldBytes(
      32,
      concatBytes(fieldStr(1, "Cached input"), fieldF32(2, 0.15), fieldStr(3, "1M tokens")),
    ),
    fieldBytes(32, concatBytes(fieldStr(1, "Output"), fieldF32(2, 15), fieldStr(3, "1M tokens"))),
  );
  return Buffer.from(fieldBytes(33, fieldBytes(1, modelPricing))).toString("base64");
}

function seedDevinSessionsDb(dbPath: string): void {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      );
      CREATE TABLE message_nodes (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        chat_message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO sessions (id, model, created_at, last_activity_at) VALUES (?, ?, ?, ?)",
    ).run("sess-1", "gemini-4-neon-high", 1_795_530_000, 1_795_532_120);
    db.prepare(
      "INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "sess-1",
      1,
      JSON.stringify({
        role: "assistant",
        metadata: {
          request_id: "req-acu",
          generation_model: "gemini-4-neon-high",
          created_at: "2026-11-24T14:55:20.000Z",
          committed_acu_cost: 0.5,
          metrics: {
            input_tokens: 10_000,
            cache_read_tokens: 50_000,
            cache_creation_tokens: null,
            output_tokens: 2_000,
          },
        },
      }),
      1_795_532_120,
    );
    db.prepare(
      "INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "sess-1",
      2,
      JSON.stringify({
        role: "assistant",
        metadata: {
          request_id: "req-fallback-price",
          generation_model: "gemini-4-neon-high",
          created_at: "2026-11-24T14:56:00.000Z",
          metrics: {
            input_tokens: 1_000_000,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
      1_795_532_160,
    );
  } finally {
    db.close();
  }
}

describe("devinUsage", () => {
  it("decodes per-model pricing from user_status protobuf payload", () => {
    const prices = parseDevinModelPricesPayload(buildSamplePricingBase64());
    const price = prices.get("gemini-4-neon-high");
    expect(price?.inputPerMillion).toBeCloseTo(3, 5);
    expect(price?.cacheReadPerMillion).toBeCloseTo(0.15, 5);
    expect(price?.outputPerMillion).toBeCloseTo(15, 5);
  });

  it("parses assistant message_nodes metrics and converts committed_acu_cost to USD", () => {
    const record = parseDevinMessageNodeRow(
      {
        session_id: "past-castanet",
        session_model: "gemini-4-neon-high",
        node_id: 42,
        created_at: 1_795_532_120,
        chat_message: JSON.stringify({
          role: "assistant",
          metadata: {
            request_id: "req-1",
            generation_model: "gemini-4-neon-high",
            created_at: "2026-11-24T14:55:20.657Z",
            committed_acu_cost: 0.040093,
            metrics: {
              input_tokens: 9_182,
              cache_read_tokens: 84_833,
              cache_creation_tokens: 0,
              output_tokens: 2_661,
            },
          },
        }),
      },
      new Map(),
    );

    expect(record).toEqual({
      provider: "devin",
      timestampMs: Date.parse("2026-11-24T14:55:20.657Z"),
      model: "gemini-4-neon-high",
      sessionId: "past-castanet",
      totals: {
        uncachedInputTokens: 9_182,
        cachedInputTokens: 84_833,
        cacheCreationTokens: 0,
        outputTokens: 2_661,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.040093 * DEVIN_USD_PER_ACU,
      speed: "standard",
      dedupeKey: "devin:req-1",
    });
  });

  it.effect("scans sessions.db and applies fallback user_status pricing via devinUsageReader", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "devin-usage-test-" });
      yield* fileSystem.writeFileString(
        path.join(tempDir, "user_status.abc123.bin"),
        JSON.stringify({ version: 1, payload: buildSamplePricingBase64() }),
      );

      const dbPath = path.join(tempDir, "sessions.db");
      yield* Effect.sync(() => seedDevinSessionsDb(dbPath));

      const direct = readDevinSessionsDb(dbPath, Date.parse("2026-11-20T00:00:00Z"), new Map());
      expect(direct.error).toBe(false);
      expect(direct.records).toHaveLength(2);

      if (devinUsageReader.kind !== "scan") {
        throw new Error("Expected scan usage reader");
      }
      const env = { DEVIN_DATA_DIR: tempDir, DEVIN_CACHE_DIR: tempDir };
      const scanned = yield* devinUsageReader.scan({
        instances: [
          {
            instanceId: ProviderInstanceId.make("acpRegistry_devin"),
            config: undefined,
            environment: env,
            configured: false,
          },
        ],
        settings: {} as never,
        windowStartMs: Date.parse("2026-11-20T00:00:00Z"),
        retentionCutoffMs: Date.parse("2026-11-01T00:00:00Z"),
        awaitRefresh: true,
      });
      expect(scanned).toHaveLength(1);
      const records = scanned[0]?.files?.[0]?.records ?? [];
      expect(records).toHaveLength(2);
      expect(records[0]?.reportedCostUsd).toBe(1.0);
      expect(records[1]?.reportedCostUsd).toBeCloseTo(3.0, 5);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
