import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { CostTrackerLive } from "./CostTracker.ts";
import { CostTrackerService } from "../Services/CostTracker.ts";
import { localMonthKey } from "../types.ts";

const SONNET = "claude-sonnet-4-6";

const makeLayer = () => {
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-cost-" });
  return Layer.mergeAll(CostTrackerLive.pipe(Layer.provide(configLayer)), configLayer);
};

/**
 * Build a layer pointing at a pre-existing temp dir so the migration has
 * ledger files to wipe on boot. Caller is responsible for `rmSync` cleanup.
 */
const makeLayerAt = (baseDir: string) => {
  const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
  return Layer.mergeAll(CostTrackerLive.pipe(Layer.provide(configLayer)), configLayer);
};

it.layer(NodeServices.layer)("CostTrackerLive", (it) => {
  it.effect("records a turn and persists session/month/alltime files", () =>
    Effect.gen(function* () {
      const tracker = yield* CostTrackerService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const at = new Date(2026, 3, 21, 10, 0, 0);
      const monthKey = localMonthKey(at);
      const summary = yield* tracker.recordUsage({
        threadId: "thread-1",
        model: SONNET,
        usage: {
          inputTokens: 1_000,
          cachedInputTokens: 5_000,
          outputTokens: 500,
          lastInputTokens: 1_000,
          lastCachedInputTokens: 5_000,
          lastOutputTokens: 500,
        },
        at,
      });

      assert.equal(summary.thread?.turnCount, 1);
      assert.equal(summary.month.turnCount, 1);
      assert.equal(summary.allTime.turnCount, 1);
      assert.equal(summary.monthKey, monthKey);
      assert.ok(summary.month.totalUsd > 0);

      const sessionPath = path.join(config.usageDir, "session_thread-1.json");
      const monthPath = path.join(config.usageDir, `${monthKey}.json`);
      const alltimePath = path.join(config.usageDir, "alltime.json");
      assert.equal(yield* fs.exists(sessionPath), true);
      assert.equal(yield* fs.exists(monthPath), true);
      assert.equal(yield* fs.exists(alltimePath), true);

      const monthRaw = yield* fs.readFileString(monthPath);
      const monthParsed = JSON.parse(monthRaw) as {
        readonly kind: string;
        readonly bucket: { readonly turnCount: number };
      };
      assert.equal(monthParsed.kind, "month");
      assert.equal(monthParsed.bucket.turnCount, 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is idempotent for zero-delta turns", () =>
    Effect.gen(function* () {
      const tracker = yield* CostTrackerService;
      const summary = yield* tracker.recordUsage({
        threadId: "thread-1",
        model: SONNET,
        usage: {},
        at: new Date(2026, 3, 21, 10, 0, 0),
      });
      assert.equal(summary.month.turnCount, 0);
      assert.equal(summary.allTime.turnCount, 0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("accumulates multiple turns", () =>
    Effect.gen(function* () {
      const tracker = yield* CostTrackerService;
      const at = new Date(2026, 3, 21, 10, 0, 0);
      yield* tracker.recordUsage({
        threadId: "thread-1",
        model: SONNET,
        usage: {
          inputTokens: 1_000,
          outputTokens: 500,
          lastInputTokens: 1_000,
          lastOutputTokens: 500,
        },
        at,
      });
      const second = yield* tracker.recordUsage({
        threadId: "thread-1",
        model: SONNET,
        usage: {
          inputTokens: 2_000,
          outputTokens: 900,
          lastInputTokens: 1_000,
          lastOutputTokens: 400,
        },
        at,
      });
      assert.equal(second.thread?.turnCount, 2);
      assert.equal(second.month.turnCount, 2);
      assert.equal(second.allTime.turnCount, 2);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("emits summary on the updates stream after a write", () =>
    Effect.gen(function* () {
      const tracker = yield* CostTrackerService;
      const fiber = yield* Effect.forkChild(
        Stream.take(tracker.updates, 1).pipe(Stream.runCollect),
      );
      yield* tracker.recordUsage({
        threadId: "thread-stream",
        model: SONNET,
        usage: {
          lastInputTokens: 100,
          lastOutputTokens: 50,
        },
        at: new Date(2026, 3, 21),
      });
      const chunk = yield* Fiber.join(fiber);
      const events = Array.from(chunk);
      assert.equal(events.length, 1);
      assert.ok(events[0]!.month.turnCount >= 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("getSummary returns zero for an unused session/month", () =>
    Effect.gen(function* () {
      const tracker = yield* CostTrackerService;
      // Fresh layer per test, but be defensive: pin to a month no other test
      // has touched. The thread-level bucket is per-threadId so that's safe.
      const summary = yield* tracker.getSummary({
        threadId: "never-seen",
        at: new Date(2019, 11, 1),
      });
      assert.equal(summary.thread?.turnCount, 0);
      assert.equal(summary.month.turnCount, 0);
      assert.equal(summary.monthKey, "2019-12");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("wipes pre-v2 ledger files on first boot and writes a schema sentinel", () => {
    // Seed a usage dir that looks like a pre-migration install: a pair of
    // session files, one month bucket, one all-time file, and an
    // unrelated stray file we must leave alone.
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-cost-wipe-"));
    const usageDir = path.join(baseDir, "userdata", "usage");
    fs.mkdirSync(usageDir, { recursive: true });
    const seededLedgerFiles = [
      "session_thread-a.json",
      "session_thread-b.json",
      "2026-04.json",
      "alltime.json",
    ];
    for (const name of seededLedgerFiles) {
      fs.writeFileSync(
        path.join(usageDir, name),
        JSON.stringify({ version: 1, bucket: { totalUsd: 42, turnCount: 99 } }),
      );
    }
    // Stray non-ledger file that must survive the wipe.
    const strayPath = path.join(usageDir, "notes.txt");
    fs.writeFileSync(strayPath, "unrelated");

    return Effect.gen(function* () {
      // Tracker service is resolved here so the layer effect — and thus
      // the migration — runs before we assert.
      yield* CostTrackerService;

      for (const name of seededLedgerFiles) {
        assert.equal(
          fs.existsSync(path.join(usageDir, name)),
          false,
          `expected ${name} to be wiped`,
        );
      }
      assert.equal(fs.existsSync(strayPath), true, "expected stray file to survive");

      const sentinelPath = path.join(usageDir, ".schema-v2");
      assert.equal(fs.existsSync(sentinelPath), true);
      const sentinelContents = JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as {
        readonly version: number;
        readonly wipedFileCount: number;
      };
      assert.equal(sentinelContents.version, 2);
      assert.equal(sentinelContents.wipedFileCount, seededLedgerFiles.length);
    }).pipe(
      Effect.provide(makeLayerAt(baseDir)),
      Effect.ensuring(
        Effect.sync(() => fs.rmSync(baseDir, { recursive: true, force: true })),
      ),
    );
  });

  it.effect("skips the wipe on subsequent boots when the sentinel is present", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-cost-wipe-idempotent-"));
    const usageDir = path.join(baseDir, "userdata", "usage");
    fs.mkdirSync(usageDir, { recursive: true });
    // Pre-existing sentinel → migration is a no-op; ledger files survive.
    fs.writeFileSync(
      path.join(usageDir, ".schema-v2"),
      JSON.stringify({ version: 2, migratedAt: "2026-04-01T00:00:00.000Z" }),
    );
    const preservedPath = path.join(usageDir, "session_thread-keep.json");
    fs.writeFileSync(
      preservedPath,
      JSON.stringify({ version: 1, bucket: { totalUsd: 1, turnCount: 1 } }),
    );

    return Effect.gen(function* () {
      yield* CostTrackerService;
      assert.equal(fs.existsSync(preservedPath), true);
    }).pipe(
      Effect.provide(makeLayerAt(baseDir)),
      Effect.ensuring(
        Effect.sync(() => fs.rmSync(baseDir, { recursive: true, force: true })),
      ),
    );
  });
});
