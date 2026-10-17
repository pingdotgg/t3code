/**
 * Phase 0 G7 baseline probe (disposable experiment, not feature implementation).
 *
 * This establishes a reproducible local SQLite/data-shape baseline before the
 * production Civilization services exist. It deliberately does not turn G7
 * green: the real enabled/disabled implementation must later be measured on
 * the same fixture and compared against these numbers.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";

const PROJECT_ID = "project:g7";
const CITIZEN_COUNT = 10_000;
const ALIVE_COUNT = 100;
const NOTE_COUNT = 200;
const MESSAGE_COUNT = 5_000;
const CONCURRENT_SENDS = 50;
const WARM_SAMPLES = 200;
const BODY_2_KIB = "n".repeat(2 * 1024);
const BODY_4_KIB = "m".repeat(4 * 1024);

type Metric = {
  readonly name: string;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

const percentile = (values: ReadonlyArray<number>, fraction: number) => {
  const ordered = [...values].toSorted((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction));
  return ordered[index] ?? 0;
};

const metric = (name: string, values: ReadonlyArray<number>): Metric => ({
  name,
  samples: values.length,
  p50Ms: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  maxMs: Math.max(...values),
});

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const value = yield* effect;
    return { value, elapsedMs: performance.now() - started };
  });

const layerDatabase = SqlitePersistence.layerMemory;

const createFixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE civilization_g7_config (
    project_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    packet_bytes INTEGER NOT NULL,
    pending_limit INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE civilization_g7_citizens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    alive INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    profile_label TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX civilization_g7_citizens_census_idx
    ON civilization_g7_citizens(project_id, alive DESC, id)`;
  yield* sql`CREATE TABLE civilization_g7_notes (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    category TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX civilization_g7_notes_project_idx
    ON civilization_g7_notes(project_id, updated_at DESC, id DESC)`;
  yield* sql`CREATE TABLE civilization_g7_messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    recipient_epoch INTEGER NOT NULL,
    status TEXT NOT NULL,
    body TEXT NOT NULL,
    accepted_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX civilization_g7_messages_inbox_idx
    ON civilization_g7_messages(project_id, recipient_id, recipient_epoch, status, accepted_at, id)`;
  yield* sql`INSERT INTO civilization_g7_config (project_id, enabled, packet_bytes, pending_limit)
    VALUES (${PROJECT_ID}, 1, ${6 * 1024}, 1000)`;

  yield* sql`WITH RECURSIVE n(i) AS (
    VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${CITIZEN_COUNT}
  ) INSERT INTO civilization_g7_citizens (id, project_id, alive, epoch, display_name, profile_label)
    SELECT printf('citizen:%05d', i), ${PROJECT_ID}, CASE WHEN i <= ${ALIVE_COUNT} THEN 1 ELSE 0 END,
      0, printf('Citizen %05d', i), printf('Profile %02d', i % 20)
    FROM n`;
  yield* sql`WITH RECURSIVE n(i) AS (
    VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${NOTE_COUNT}
  ) INSERT INTO civilization_g7_notes (id, project_id, category, body, updated_at)
    SELECT i, ${PROJECT_ID}, 'fact', ${BODY_2_KIB}, i FROM n`;
  yield* sql`WITH RECURSIVE n(i) AS (
    VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${MESSAGE_COUNT}
  ) INSERT INTO civilization_g7_messages
    (id, project_id, sender_id, recipient_id, recipient_epoch, status, body, accepted_at)
    SELECT printf('message:%05d', i), ${PROJECT_ID},
      printf('citizen:%05d', ((i - 1) % ${ALIVE_COUNT}) + 1),
      'citizen:00001', 0, 'pending', ${BODY_4_KIB}, i
    FROM n`;
  yield* sql`ANALYZE`;
});

const censusPage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly id: string;
    readonly display_name: string;
    readonly profile_label: string;
    readonly alive: number;
  }>`SELECT id, display_name, profile_label, alive
    FROM civilization_g7_citizens
    WHERE project_id = ${PROJECT_ID} AND id > ''
    ORDER BY id LIMIT 50`;
});

const inboxPage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly id: string;
    readonly sender_id: string;
    readonly body: string;
  }>`SELECT id, sender_id, body
    FROM civilization_g7_messages
    WHERE project_id = ${PROJECT_ID}
      AND recipient_id = 'citizen:00001'
      AND recipient_epoch = 0
      AND status = 'pending'
    ORDER BY accepted_at, id LIMIT 50`;
});

const packetBuild = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const roster = yield* sql<{ readonly id: string; readonly display_name: string }>`
    SELECT id, display_name FROM civilization_g7_citizens
    WHERE project_id = ${PROJECT_ID} AND alive = 1 ORDER BY id LIMIT 10`;
  const notes = yield* sql<{ readonly id: number; readonly body: string }>`
    SELECT id, body FROM civilization_g7_notes
    WHERE project_id = ${PROJECT_ID} ORDER BY updated_at DESC, id DESC LIMIT 3`;
  const messages = yield* sql<{
    readonly id: string;
    readonly sender_id: string;
    readonly body: string;
  }>`
    SELECT id, sender_id, body FROM civilization_g7_messages
    WHERE project_id = ${PROJECT_ID}
      AND recipient_id = 'citizen:00001'
      AND recipient_epoch = 0
      AND status = 'pending'
    ORDER BY accepted_at, id LIMIT 5`;
  // The later production allocator will truncate excerpts against one total
  // budget. Here we measure the bounded read/serialization shape, not a final
  // prompt packet contract.
  const json = JSON.stringify({ roster, notes, messages });
  return Buffer.byteLength(json, "utf8");
});

const intake = (senderId: string, operationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const config = yield* sql<{ readonly enabled: number; readonly pending_limit: number }>`
          SELECT enabled, pending_limit FROM civilization_g7_config WHERE project_id = ${PROJECT_ID}`;
        if (config[0]?.enabled !== 1) return "disabled" as const;
        const citizens = yield* sql<{
          readonly id: string;
          readonly alive: number;
          readonly epoch: number;
        }>`
          SELECT id, alive, epoch FROM civilization_g7_citizens
          WHERE id IN (${senderId}, 'citizen:00001')`;
        if (citizens.length !== 2 || citizens.some((citizen) => citizen.alive !== 1)) {
          return "ineligible" as const;
        }
        const pending = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM civilization_g7_messages
          WHERE project_id = ${PROJECT_ID} AND recipient_id = 'citizen:00001'
            AND recipient_epoch = 0 AND status = 'pending'`;
        if ((pending[0]?.count ?? 0) >= (config[0]?.pending_limit ?? 0)) return "capacity" as const;
        yield* sql`INSERT INTO civilization_g7_messages
          (id, project_id, sender_id, recipient_id, recipient_epoch, status, body, accepted_at)
          VALUES (${operationId}, ${PROJECT_ID}, ${senderId}, 'citizen:00001', 0, 'pending', 'x', 100000)`;
        return "accepted" as const;
      }),
    );
  });

it.effect("records the fixed Phase 0 performance fixture and bounded-operation baseline", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const fixture = yield* timed(createFixture);
    const rssAfterFixture = process.memoryUsage().rss;

    const coldCensus = yield* timed(censusPage);
    const coldInbox = yield* timed(inboxPage);
    const coldPacket = yield* timed(packetBuild);
    assert.lengthOf(coldCensus.value, 50);
    assert.lengthOf(coldInbox.value, 50);
    assert.isAbove(coldPacket.value, 0);

    const censusSamples: number[] = [];
    const inboxSamples: number[] = [];
    const packetSamples: number[] = [];
    const sqlControlSamples: number[] = [];
    for (let index = 0; index < WARM_SAMPLES; index += 1) {
      sqlControlSamples.push((yield* timed(sql`SELECT 1 AS ok`)).elapsedMs);
      censusSamples.push((yield* timed(censusPage)).elapsedMs);
      inboxSamples.push((yield* timed(inboxPage)).elapsedMs);
      packetSamples.push((yield* timed(packetBuild)).elapsedMs);
    }

    // The configured limit is raised only for this throughput baseline so all
    // 50 operations are successful; the hard-cap/rejection behavior is G9/G3.
    yield* sql`UPDATE civilization_g7_config SET pending_limit = 10000 WHERE project_id = ${PROJECT_ID}`;
    const sendResults = yield* Effect.all(
      Array.from({ length: CONCURRENT_SENDS }, (_, index) => {
        const senderId = `citizen:${String(index + 2).padStart(5, "0")}`;
        return timed(intake(senderId, `burst:${String(index).padStart(2, "0")}`));
      }),
      { concurrency: "unbounded" },
    );
    assert.isTrue(sendResults.every((result) => result.value === "accepted"));

    yield* sql`UPDATE civilization_g7_config SET enabled = 0 WHERE project_id = ${PROJECT_ID}`;
    const disabledSamples: number[] = [];
    for (let index = 0; index < WARM_SAMPLES; index += 1) {
      const result = yield* timed(intake("citizen:00002", `disabled:${index}`));
      assert.equal(result.value, "disabled");
      disabledSamples.push(result.elapsedMs);
    }

    const pageCount = Number(
      (yield* sql<{ readonly page_count: number }>`PRAGMA page_count`)[0]?.page_count ?? 0,
    );
    const pageSize = Number(
      (yield* sql<{ readonly page_size: number }>`PRAGMA page_size`)[0]?.page_size ?? 0,
    );
    const dbBytes = pageCount * pageSize;
    const rssAfter = process.memoryUsage().rss;
    const cpu = process.cpuUsage(cpuBefore);
    const report = {
      fixture: {
        citizens: CITIZEN_COUNT,
        alive: ALIVE_COUNT,
        notes: NOTE_COUNT,
        noteBytes: byteLength(BODY_2_KIB),
        messages: MESSAGE_COUNT,
        messageBytes: byteLength(BODY_4_KIB),
        concurrentSuccessfulSends: CONCURRENT_SENDS,
      },
      coldMs: {
        fixtureSetup: fixture.elapsedMs,
        censusPage: coldCensus.elapsedMs,
        inboxPage: coldInbox.elapsedMs,
        packetBuild: coldPacket.elapsedMs,
      },
      warm: [
        metric("host-sql-control-select-1", sqlControlSamples),
        metric("census-page-50", censusSamples),
        metric("inbox-page-50", inboxSamples),
        metric("bounded-packet-read-and-json", packetSamples),
        metric(
          "successful-intake-50-way",
          sendResults.map((result) => result.elapsedMs),
        ),
        metric("disabled-intake-noop", disabledSamples),
      ],
      payloadBytes: { boundedPacketJson: coldPacket.value },
      process: {
        rssBefore,
        rssAfterFixture,
        rssAfter,
        rssDelta: rssAfter - rssBefore,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
      },
      database: { pageCount, pageSize, bytes: dbBytes },
    };
    yield* Effect.log(`CIVILIZATION_G7_BASELINE ${JSON.stringify(report)}`);
  }).pipe(Effect.provide(Layer.fresh(layerDatabase))),
);

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
