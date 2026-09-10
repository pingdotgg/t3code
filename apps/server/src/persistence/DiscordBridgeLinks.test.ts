import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as DiscordBridgeLinks from "./DiscordBridgeLinks.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(
  Layer.mergeAll(DiscordBridgeLinks.layer).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const AT = Option.getOrThrow(DateTime.make(Date.parse("2026-08-02T17:00:00.000Z")));

const link = {
  threadId: "thr_1",
  guildId: "1533582443788111952",
  channelId: "1533593019834568875",
  discordThreadId: "dthr_1",
  headerMessageId: "dmsg_header_1",
  lastSeenDiscordMessageId: "dmsg_header_1",
  createdAt: AT,
};

layer("036_DiscordBridge", (it) => {
  it.effect("creates both bridge tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const names = new Set(tables.map((t) => t.name));
      assert.ok(names.has("discord_bridge_threads"));
      assert.ok(names.has("discord_bridge_messages"));
    }),
  );

  it.effect("enforces the unique constraint that makes thread creation crash-safe", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });

      const indexes = yield* sql<{ readonly sql: string | null }>`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'discord_bridge_threads'
      `;
      assert.include(indexes[0]?.sql ?? "", "UNIQUE");
    }),
  );
});

layer("DiscordBridgeLinkRepository", (it) => {
  it.effect("links a thread and reads it back by both keys", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 36 });
      const repo = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;

      yield* repo.link(link);

      const byThread = yield* repo.getByThreadId("thr_1");
      assert.isTrue(Option.isSome(byThread));
      assert.strictEqual(Option.getOrThrow(byThread).discordThreadId, "dthr_1");
      assert.strictEqual(Option.getOrThrow(byThread).state, "active");

      const byDiscord = yield* repo.getByDiscordThreadId("dthr_1");
      assert.isTrue(Option.isSome(byDiscord));
      assert.strictEqual(Option.getOrThrow(byDiscord).threadId, "thr_1");
    }),
  );

  it.effect("returns none for an unknown thread", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 36 });
      const repo = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;
      assert.isTrue(Option.isNone(yield* repo.getByThreadId("missing")));
      assert.isTrue(Option.isNone(yield* repo.getByDiscordThreadId("missing")));
    }),
  );

  it.effect("re-linking the same thread is idempotent, not an error", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 36 });
      const repo = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;

      yield* repo.link(link);
      yield* repo.link(link);

      const active = yield* repo.listActive();
      assert.strictEqual(active.length, 1);
    }),
  );

  it.effect("drops a thread out of listActive once it is orphaned", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 36 });
      const repo = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;

      yield* repo.link(link);
      assert.strictEqual((yield* repo.listActive()).length, 1);

      yield* repo.setState({ threadId: "thr_1", state: "orphaned", updatedAt: AT });
      assert.strictEqual((yield* repo.listActive()).length, 0);

      // The row survives so a deleted Discord thread is never silently recreated.
      const row = yield* repo.getByThreadId("thr_1");
      assert.strictEqual(Option.getOrThrow(row).state, "orphaned");
    }),
  );

  it.effect("advances the inbound cursor", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 36 });
      const repo = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;

      yield* repo.link(link);
      yield* repo.setLastSeen({
        threadId: "thr_1",
        lastSeenDiscordMessageId: "dmsg_42",
        updatedAt: AT,
      });

      const row = yield* repo.getByThreadId("thr_1");
      assert.strictEqual(Option.getOrThrow(row).lastSeenDiscordMessageId, "dmsg_42");
    }),
  );

  it.effect("upserts chunks and round-trips the frozen flag through SQLite 0/1", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 36 });
      const repo = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;
      yield* repo.link(link);

      yield* repo.upsertChunk({
        messageId: "msg_1",
        chunkIndex: 0,
        threadId: "thr_1",
        discordThreadId: "dthr_1",
        discordMessageId: "dmsg_1",
        publishedLength: 120,
        frozen: false,
        now: AT,
      });

      let chunks = yield* repo.listChunks("msg_1");
      assert.strictEqual(chunks.length, 1);
      assert.strictEqual(chunks[0]!.publishedLength, 120);
      assert.strictEqual(chunks[0]!.frozen, false);

      // A later flush advances the same chunk and freezes it.
      yield* repo.upsertChunk({
        messageId: "msg_1",
        chunkIndex: 0,
        threadId: "thr_1",
        discordThreadId: "dthr_1",
        discordMessageId: "dmsg_1",
        publishedLength: 1900,
        frozen: true,
        now: AT,
      });

      chunks = yield* repo.listChunks("msg_1");
      assert.strictEqual(chunks.length, 1, "upsert must not duplicate the chunk row");
      assert.strictEqual(chunks[0]!.publishedLength, 1900);
      assert.strictEqual(chunks[0]!.frozen, true);
    }),
  );

  it.effect("orders chunks by index", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 36 });
      const repo = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;
      yield* repo.link(link);

      for (const chunkIndex of [2, 0, 1]) {
        yield* repo.upsertChunk({
          messageId: "msg_1",
          chunkIndex,
          threadId: "thr_1",
          discordThreadId: "dthr_1",
          discordMessageId: `dmsg_${chunkIndex}`,
          publishedLength: 10,
          frozen: chunkIndex < 2,
          now: AT,
        });
      }

      const chunks = yield* repo.listChunks("msg_1");
      assert.deepStrictEqual(
        chunks.map((c) => c.chunkIndex),
        [0, 1, 2],
      );
    }),
  );
});
