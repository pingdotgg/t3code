// @effect-diagnostics nodeBuiltinImport:off -- This file-backed acceptance fixture measures real DB/WAL files and removes its isolated temp directory after the scoped layer closes.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CIVILIZATION_CONFIG_VERSION,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";
import * as KnowledgeService from "./KnowledgeService.ts";
import * as MailService from "./MailService.ts";

const PROJECT_ID = ProjectId.make("project:civilization:g7");
const PROVIDER_ID = ProviderInstanceId.make("codex-main");
const CITIZEN_COUNT = 10_000;
const ALIVE_COUNT = 100;
const NOTE_COUNT = 200;
const MESSAGE_COUNT = 5_000;
const INTAKE_COUNT = 50;
const PAGE_SIZE = 50;
const WARM_SAMPLES = 200;
const BODY_2_KIB = "n".repeat(2 * 1024);
const BODY_4_KIB = "m".repeat(4 * 1024);

type FakeProviderCalls = {
  get: number;
  unexpectedProviderWork: number;
};

type Metric = {
  readonly name: string;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

type CpuMetric = {
  readonly userMs: number;
  readonly systemMs: number;
};

type DatabaseFootprint = {
  readonly pageCount: number;
  readonly freePages: number;
  readonly pageSize: number;
  readonly allocatedBytes: number;
  readonly liveBytes: number;
};

type DiskFootprint = {
  readonly databaseBytes: number;
  readonly walBytes: number;
  readonly totalBytes: number;
};

const threadId = (index: number) => ThreadId.make(`thread:g7:${String(index).padStart(5, "0")}`);
const runId = (index: number) => RunId.make(`run:g7:${String(index).padStart(5, "0")}`);

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
    return { value, elapsedMs: performance.now() - started } as const;
  });

const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
  );

const cpuSince = (start: NodeJS.CpuUsage): CpuMetric => {
  const delta = process.cpuUsage(start);
  return { userMs: delta.user / 1000, systemMs: delta.system / 1000 };
};

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

const databaseFootprint = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const pageCount = Number(
      (yield* sql<{ readonly page_count: number }>`PRAGMA page_count`)[0]?.page_count ?? 0,
    );
    const freePages = Number(
      (yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`)[0]?.freelist_count ??
        0,
    );
    const pageSize = Number(
      (yield* sql<{ readonly page_size: number }>`PRAGMA page_size`)[0]?.page_size ?? 0,
    );
    return {
      pageCount,
      freePages,
      pageSize,
      allocatedBytes: pageCount * pageSize,
      liveBytes: (pageCount - freePages) * pageSize,
    } satisfies DatabaseFootprint;
  });

const diskFootprint = (dbPath: string): DiskFootprint => {
  const fileBytes = (path: string) => (NodeFS.existsSync(path) ? NodeFS.statSync(path).size : 0);
  const databaseBytes = fileBytes(dbPath);
  const walBytes = fileBytes(`${dbPath}-wal`);
  return { databaseBytes, walBytes, totalBytes: databaseBytes + walBytes };
};

const benchmarkGate = (name: string, measured: Metric, budgetMs: number) => ({
  name,
  budgetMs,
  p95Ms: measured.p95Ms,
  passed: measured.p95Ms <= budgetMs,
});

const fakeProviderLayer = (calls: FakeProviderCalls) =>
  Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (instanceId) => {
        calls.get += 1;
        if (instanceId !== PROVIDER_ID) {
          return Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          );
        }
        return Effect.succeed({
          instanceId,
          driver: "codex",
          openSession: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die("G7 acceptance must not open a provider session.");
          },
          getCapabilities: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die("G7 acceptance must not execute provider capability work.");
          },
        } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]);
      },
      list: () => Effect.succeed([PROVIDER_ID]),
    }),
  );

const makeLayer = <E>(
  calls: FakeProviderCalls,
  database: Layer.Layer<SqlClient.SqlClient, E, never>,
) => {
  const config = ConfigService.layer.pipe(Layer.provide(database));
  const providers = fakeProviderLayer(calls);
  const mailDependencies = Layer.mergeAll(database, providers);
  const mail = MailService.layer.pipe(Layer.provide(mailDependencies));
  const knowledge = KnowledgeService.layer.pipe(Layer.provide(database));
  const contextDependencies = Layer.mergeAll(database, config, providers, mail);
  const context = ContextService.layer.pipe(Layer.provide(contextDependencies));
  return Layer.mergeAll(database, config, providers, mail, knowledge, context);
};

const seedFixture = (
  sql: SqlClient.SqlClient,
  config: ConfigService.CivilizationConfigService["Service"],
) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${PROJECT_ID}, 'Civilization G7', '/tmp/civilization-g7', '[]',
        '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL
      )
    `;
    yield* config.set({
      projectId: PROJECT_ID,
      expectedRevision: 0,
      override: {
        version: CIVILIZATION_CONFIG_VERSION,
        participation: { enabled: true },
        messaging: {
          enabled: true,
          pendingPerRecipient: 1_000,
          senderPerMinute: 60,
          projectPerMinute: 1_000,
          retainedMessageCount: 10_000,
          retainedBodyBytes: 32 * 1024 * 1024,
        },
        operations: { censusPageSize: PAGE_SIZE, inboxPageSize: PAGE_SIZE },
      },
    });

    yield* sql`
      WITH RECURSIVE n(i) AS (
        VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${CITIZEN_COUNT}
      )
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, provider_instance_id,
        runtime_mode, interaction_mode, active_provider_thread_id,
        created_at, updated_at, archived_at, deleted_at, payload_json
      )
      SELECT printf('thread:g7:%05d', i), ${PROJECT_ID}, printf('Citizen %05d', i),
        ${PROVIDER_ID}, ${PROVIDER_ID}, 'full-access', 'default', NULL,
        '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL, NULL, '{}'
      FROM n
    `;

    yield* sql`
      WITH RECURSIVE n(i) AS (
        VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${ALIVE_COUNT}
      )
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
        status, requested_at, completed_at, payload_json
      )
      SELECT printf('run:g7:%05d', i), printf('thread:g7:%05d', i), 1,
        'codex', ${PROVIDER_ID}, NULL, 'running', '2026-10-16T00:00:00.000Z', NULL, '{}'
      FROM n
    `;

    yield* sql`
      WITH RECURSIVE n(i) AS (
        VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${CITIZEN_COUNT}
      )
      INSERT INTO civilization_citizens (
        thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
        generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
        name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
        name_environment_revision, name_project_revision,
        profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
        profile_environment_revision, profile_project_revision,
        title_managed, preserved_title, last_managed_title, title_topic,
        pending_title_command_id, pending_managed_title, pending_title_topic,
        epoch, closed, deleted, delivery_epoch, delivery_settled, delivery_archived, delivery_deleted,
        revision, created_at, updated_at
      )
      SELECT printf('thread:g7:%05d', i), ${PROJECT_ID}, NULL, NULL, printf('thread:g7:%05d', i),
        0, 'resolved', 0, i, i,
        printf('name:g7:%05d', i), 1, printf('Citizen %05d', i), printf('Citizen %05d', i),
        printf('citizen %05d', i), 'default-names', 1, 1,
        'calm', 'Calm', '[]', '', 'default-profiles', 1, 1,
        0, printf('Citizen %05d', i), NULL, printf('Citizen %05d', i), NULL, NULL, NULL,
        0, CASE WHEN i <= ${ALIVE_COUNT} THEN 0 ELSE 1 END, 0,
        0, CASE WHEN i <= ${ALIVE_COUNT} THEN 0 ELSE 1 END, 0, 0,
        1, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'
      FROM n
    `;

    yield* sql`
      WITH RECURSIVE n(i) AS (
        VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${NOTE_COUNT}
      )
      INSERT INTO civilization_notes (
        note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
        accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
        created_at, updated_at, resolved_at
      )
      SELECT printf('note:g7:%05d', i), ${PROJECT_ID}, 'fact', ${BODY_2_KIB}, ${2 * 1024},
        ${threadId(1)}, 0, 'full-access', 'default', '[]', 1,
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-16T00:00:00Z', printf('+%d seconds', i)),
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-16T00:00:00Z', printf('+%d seconds', i)), NULL
      FROM n
    `;

    yield* sql`
      WITH RECURSIVE n(i) AS (
        VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${MESSAGE_COUNT}
      )
      INSERT INTO civilization_messages (
        message_id, project_id, sender_thread_id, sender_name_at_send,
        sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
        reply_to_message_id, body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
        accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
        terminal_retention_days, first_offered_at, last_offered_at, offer_count,
        acknowledged_at, terminal_at, terminal_reason
      )
      SELECT printf('mail:g7:%05d', i), ${PROJECT_ID},
        printf('thread:g7:%05d', ((i - 1) % (${ALIVE_COUNT} - 1)) + 2),
        printf('Citizen %05d', ((i - 1) % (${ALIVE_COUNT} - 1)) + 2), 0,
        printf('run:g7:%05d', ((i - 1) % (${ALIVE_COUNT} - 1)) + 2),
        ${threadId(1)}, 0, NULL, ${BODY_4_KIB}, ${4 * 1024}, 'full-access', 'default',
        0, 1,
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-16T00:00:00Z', printf('+%d seconds', i)),
        '2099-01-01T00:00:00.000Z', 30, NULL, NULL, 0, NULL, NULL, NULL
      FROM n
    `;
    yield* sql`ANALYZE`;

    const counts = (yield* sql<{
      readonly citizens: number;
      readonly alive: number;
      readonly notes: number;
      readonly messages: number;
    }>`
        SELECT
          (SELECT COUNT(*) FROM civilization_citizens WHERE project_id = ${PROJECT_ID}) AS citizens,
          (SELECT COUNT(*) FROM civilization_citizens WHERE project_id = ${PROJECT_ID} AND closed = 0) AS alive,
          (SELECT COUNT(*) FROM civilization_notes WHERE project_id = ${PROJECT_ID}) AS notes,
          (SELECT COUNT(*) FROM civilization_messages WHERE project_id = ${PROJECT_ID}) AS messages
      `)[0]!;
    assert.deepEqual(counts, {
      citizens: CITIZEN_COUNT,
      alive: ALIVE_COUNT,
      notes: NOTE_COUNT,
      messages: MESSAGE_COUNT,
    });
  });

const callerInput = (index: number) => ({
  projectId: PROJECT_ID,
  threadId: threadId(index),
  runId: runId(index),
  providerInstanceId: PROVIDER_ID,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
});

const turnInput = (ordinal: number): ContextService.CivilizationContextForTurnInput => ({
  projectId: PROJECT_ID,
  threadId: threadId(1),
  runId: runId(1),
  attemptId: RunAttemptId.make("attempt:g7:00001"),
  providerTurnOrdinal: ordinal,
  providerInstanceId: PROVIDER_ID,
  runtimeMode: "full-access",
  interactionMode: "default",
  message: { text: "G7 performance fixture", createdBy: "user", creationSource: "web" },
});

const resetSuccessfulBurst = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`
      DELETE FROM civilization_messages
      WHERE message_id IN (
        SELECT result_message_id FROM civilization_mail_operation_receipts
        WHERE project_id = ${PROJECT_ID} AND client_request_id LIKE 'g7:success:%'
      )
    `;
    yield* sql`
      DELETE FROM civilization_mail_operation_receipts
      WHERE project_id = ${PROJECT_ID} AND client_request_id LIKE 'g7:success:%'
    `;
    yield* sql`DELETE FROM civilization_mail_quota_windows WHERE project_id = ${PROJECT_ID}`;
    const state = (yield* sql<{
      readonly retained_message_count: number;
      readonly retained_body_bytes: number;
    }>`
        SELECT retained_message_count, retained_body_bytes
        FROM civilization_project_state WHERE project_id = ${PROJECT_ID}
      `)[0]!;
    assert.deepEqual(state, {
      retained_message_count: MESSAGE_COUNT,
      retained_body_bytes: MESSAGE_COUNT * 4 * 1024,
    });
  });

it.effect(
  "measures the production Civilization G7 fixture against local acceptance budgets with zero provider work",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-civilization-g7-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    const database = SqlitePersistence.layerFromPath(dbPath).pipe(
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const rssBeforeStartup = process.memoryUsage().rss;
      const startupCpuStart = process.cpuUsage();
      const startup = yield* timed(Layer.build(makeLayer(calls, database)));
      const startupCpu = cpuSince(startupCpuStart);
      const services = startup.value;
      const rssAfterStartup = process.memoryUsage().rss;

      const sql = Context.get(services, SqlClient.SqlClient);
      const config = Context.get(services, ConfigService.CivilizationConfigService);
      const knowledge = Context.get(services, KnowledgeService.CivilizationKnowledgeService);
      const mail = Context.get(services, MailService.CivilizationMailService);
      const context = Context.get(services, ContextService.CivilizationContextService);

      const migrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id BETWEEN 63 AND 66 ORDER BY migration_id ASC
      `;
      assert.deepEqual(migrations, [
        { migration_id: 63, name: "DropUnusedV1Projections" },
        { migration_id: 64, name: "Civilization" },
        { migration_id: 65, name: "CivilizationKnowledge" },
        { migration_id: 66, name: "CivilizationMail" },
      ]);
      const dbAfterMigrations = yield* databaseFootprint(sql);
      const diskAfterMigrations = diskFootprint(dbPath);

      const fixtureCpuStart = process.cpuUsage();
      const fixture = yield* timed(seedFixture(sql, config));
      const fixtureCpu = cpuSince(fixtureCpuStart);
      const rssAfterFixture = process.memoryUsage().rss;
      const dbAfterFixture = yield* databaseFootprint(sql);
      const diskAfterFixturePreCheckpoint = diskFootprint(dbPath);
      yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
      const diskAfterFixture = diskFootprint(dbPath);

      const recipientCaller = yield* mail.authoritativeCaller(callerInput(1));
      const senderCallers = yield* Effect.all(
        Array.from({ length: INTAKE_COUNT }, (_, index) =>
          mail.authoritativeCaller(callerInput(index + 2)),
        ),
        { concurrency: 1 },
      );

      const coldCensus = yield* timed(
        knowledge.listCensus({ projectId: PROJECT_ID, limit: PAGE_SIZE }),
      );
      const coldInbox = yield* timed(
        mail.listInbox({ caller: recipientCaller, limit: PAGE_SIZE, includeAcknowledged: false }),
      );
      const coldPacket = yield* timed(context.forTurn(turnInput(1)));
      assert.lengthOf(coldCensus.value.citizens, PAGE_SIZE);
      assert.lengthOf(coldInbox.value.messages, PAGE_SIZE);
      assert.isNotNull(coldPacket.value.packet);

      const censusSamples: number[] = [];
      const inboxSamples: number[] = [];
      const packetSamples: number[] = [];
      const sqlControlSamples: number[] = [];
      const warmRssSamples: number[] = [];
      const warmCpuStart = process.cpuUsage();
      for (let index = 0; index < WARM_SAMPLES; index += 1) {
        sqlControlSamples.push((yield* timed(sql`SELECT 1 AS ok`)).elapsedMs);
      }
      for (let index = 0; index < WARM_SAMPLES; index += 1) {
        censusSamples.push(
          (yield* timed(knowledge.listCensus({ projectId: PROJECT_ID, limit: PAGE_SIZE })))
            .elapsedMs,
        );
      }
      for (let index = 0; index < WARM_SAMPLES; index += 1) {
        inboxSamples.push(
          (yield* timed(
            mail.listInbox({
              caller: recipientCaller,
              limit: PAGE_SIZE,
              includeAcknowledged: false,
            }),
          )).elapsedMs,
        );
      }
      for (let index = 0; index < WARM_SAMPLES; index += 1) {
        packetSamples.push((yield* timed(context.forTurn(turnInput(1)))).elapsedMs);
        if ((index + 1) % 20 === 0) warmRssSamples.push(process.memoryUsage().rss);
      }
      const warmCpu = cpuSince(warmCpuStart);
      const rssAfterWarm = process.memoryUsage().rss;
      const dbAfterWarm = yield* databaseFootprint(sql);
      const diskAfterWarm = diskFootprint(dbPath);

      const successCpuStart = process.cpuUsage();
      const successfulSends = yield* Effect.forEach(
        senderCallers,
        (caller, index) =>
          timed(
            mail.send({
              caller,
              targetThreadId: threadId(52),
              clientRequestId: `g7:success:${String(index).padStart(2, "0")}`,
              body: BODY_4_KIB,
            }),
          ),
        { concurrency: "unbounded" },
      );
      const successCpu = cpuSince(successCpuStart);
      assert.lengthOf(successfulSends, INTAKE_COUNT);
      const dbAfterSuccess = yield* databaseFootprint(sql);
      const diskAfterSuccess = diskFootprint(dbPath);
      yield* resetSuccessfulBurst(sql);
      const dbAfterSuccessReset = yield* databaseFootprint(sql);
      const diskAfterSuccessReset = diskFootprint(dbPath);

      const rejectionCpuStart = process.cpuUsage();
      const rejectedSends = yield* Effect.forEach(
        senderCallers,
        (caller, index) =>
          timed(
            mail
              .send({
                caller,
                targetThreadId: threadId(1),
                clientRequestId: `g7:capacity:${String(index).padStart(2, "0")}`,
                body: BODY_4_KIB,
              })
              .pipe(outcome),
          ),
        { concurrency: "unbounded" },
      );
      const rejectionCpu = cpuSince(rejectionCpuStart);
      assert.isTrue(
        rejectedSends.every(
          ({ value }) => !value.ok && value.error._tag === "CivilizationMailCapacityError",
        ),
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM civilization_mail_quota_windows WHERE project_id = ${PROJECT_ID}
          `)[0]?.count,
        0,
      );

      yield* config.set({
        projectId: PROJECT_ID,
        expectedRevision: 1,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: false },
          messaging: { enabled: true },
        },
      });
      yield* sql`DELETE FROM civilization_mail_quota_windows WHERE project_id = ${PROJECT_ID}`;
      const disabledContextSamples: number[] = [];
      const disabledSendSamples: number[] = [];
      const disabledCpuStart = process.cpuUsage();
      for (let index = 0; index < WARM_SAMPLES; index += 1) {
        const packet = yield* timed(context.forTurn(turnInput(1)));
        assert.isNull(packet.value.packet);
        disabledContextSamples.push(packet.elapsedMs);
        const send = yield* timed(
          mail
            .send({
              caller: senderCallers[0]!,
              targetThreadId: threadId(52),
              clientRequestId: `g7:disabled:${index}`,
              body: "disabled",
            })
            .pipe(outcome),
        );
        assert.isTrue(
          !send.value.ok &&
            send.value.error._tag === "CivilizationAgentAccessError" &&
            send.value.error.reason === "disabled",
        );
        disabledSendSamples.push(send.elapsedMs);
      }
      const disabledCpu = cpuSince(disabledCpuStart);
      const rssFinal = process.memoryUsage().rss;
      const dbFinal = yield* databaseFootprint(sql);
      const diskFinal = diskFootprint(dbPath);

      const censusMetric = metric("census-page-50", censusSamples);
      const inboxMetric = metric("inbox-page-50", inboxSamples);
      const packetMetric = metric("production-packet-build", packetSamples);
      const successfulSendMetric = metric(
        "successful-send-50-way",
        successfulSends.map((result) => result.elapsedMs),
      );
      const rejectionMetric = metric(
        "capacity-rejection-50-way",
        rejectedSends.map((result) => result.elapsedMs),
      );
      const gates = [
        benchmarkGate("packet", packetMetric, 10),
        benchmarkGate("census", censusMetric, 50),
        benchmarkGate("inbox", inboxMetric, 50),
        benchmarkGate("successful-send", successfulSendMetric, 100),
      ];

      const outboxCount = Number(
        (yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
          `)[0]?.count ?? 0,
      );
      assert.equal(calls.unexpectedProviderWork, 0);
      assert.equal(outboxCount, 0);

      const report = {
        fixture: {
          citizens: CITIZEN_COUNT,
          alive: ALIVE_COUNT,
          notes: NOTE_COUNT,
          noteBytes: Buffer.byteLength(BODY_2_KIB, "utf8"),
          messages: MESSAGE_COUNT,
          messageBytes: Buffer.byteLength(BODY_4_KIB, "utf8"),
          distinctSenderIntakeRequests: INTAKE_COUNT,
        },
        migrations,
        coldMs: {
          startupAndMigrations: startup.elapsedMs,
          fixtureSetup: fixture.elapsedMs,
          censusPage: coldCensus.elapsedMs,
          inboxPage: coldInbox.elapsedMs,
          packetBuild: coldPacket.elapsedMs,
        },
        warm: [
          metric("host-sql-control-select-1", sqlControlSamples),
          censusMetric,
          inboxMetric,
          packetMetric,
          successfulSendMetric,
          rejectionMetric,
          metric("disabled-packet-noop", disabledContextSamples),
          metric("disabled-send-rejection", disabledSendSamples),
        ],
        budgets: gates,
        payloadBytes: {
          censusPageJson: bytes(coldCensus.value),
          inboxPageJson: bytes(coldInbox.value),
          packet: coldPacket.value.packet?.bytes ?? 0,
        },
        cpu: {
          startup: startupCpu,
          fixture: fixtureCpu,
          warmReadsAndPacket: warmCpu,
          successfulSendBurst: successCpu,
          rejectionBurst: rejectionCpu,
          disabled: disabledCpu,
        },
        rss: {
          beforeStartup: rssBeforeStartup,
          afterStartup: rssAfterStartup,
          afterFixture: rssAfterFixture,
          warmSamples: warmRssSamples,
          afterWarm: rssAfterWarm,
          final: rssFinal,
          totalDelta: rssFinal - rssBeforeStartup,
          warmPlateauDelta:
            rssAfterWarm -
            (warmRssSamples[Math.floor(warmRssSamples.length / 2) - 1] ?? rssAfterFixture),
          warmRange:
            warmRssSamples.length === 0
              ? 0
              : Math.max(...warmRssSamples) - Math.min(...warmRssSamples),
        },
        database: {
          afterMigrations: dbAfterMigrations,
          afterFixture: dbAfterFixture,
          afterWarm: dbAfterWarm,
          afterSuccessfulBurst: dbAfterSuccess,
          afterSuccessfulBurstReset: dbAfterSuccessReset,
          final: dbFinal,
          fixtureAllocatedGrowth: dbAfterFixture.allocatedBytes - dbAfterMigrations.allocatedBytes,
          fixtureLiveGrowth: dbAfterFixture.liveBytes - dbAfterMigrations.liveBytes,
        },
        disk: {
          afterMigrations: diskAfterMigrations,
          afterFixturePreCheckpoint: diskAfterFixturePreCheckpoint,
          afterFixture: diskAfterFixture,
          afterWarm: diskAfterWarm,
          afterSuccessfulBurst: diskAfterSuccess,
          afterSuccessfulBurstReset: diskAfterSuccessReset,
          final: diskFinal,
          fixtureGrowth: diskAfterFixture.totalBytes - diskAfterMigrations.totalBytes,
          warmGrowth: diskAfterWarm.totalBytes - diskAfterFixture.totalBytes,
        },
        provider: {
          registryLookups: calls.get,
          unexpectedProviderWork: calls.unexpectedProviderWork,
          orchestrationEffectOutboxRows: outboxCount,
        },
      };
      yield* Effect.logWarning(`CIVILIZATION_G7_ACCEPTANCE ${JSON.stringify(report)}`);

      for (const gate of gates) {
        assert.isTrue(
          gate.passed,
          `CIVILIZATION_G7_BUDGET ${gate.name} p95=${gate.p95Ms.toFixed(3)}ms exceeds ${gate.budgetMs}ms`,
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() =>
          NodeFS.rmSync(tempDir, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25,
          }),
        ),
      ),
    );
  },
  { timeout: 120_000 },
);
