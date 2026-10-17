// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as MailService from "./MailService.ts";

const providerInstanceId = ProviderInstanceId.make("codex-main");

const fakeProviderLayer = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: (instanceId) => {
      if (instanceId !== providerInstanceId) {
        return Effect.fail(
          new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
        );
      }
      return Effect.succeed({
        instanceId,
        driver: "codex",
        openSession: () => Effect.die("mail restart acceptance must not open provider sessions"),
        getCapabilities: () =>
          Effect.die("mail restart acceptance must not execute provider capability work"),
      } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]);
    },
    list: () => Effect.succeed([providerInstanceId]),
  }),
);

const makeFileLayer = (dbPath: string) => {
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const config = ConfigService.layer.pipe(Layer.provide(database));
  const dependencies = Layer.mergeAll(database, config, fakeProviderLayer);
  return Layer.mergeAll(dependencies, MailService.layer.pipe(Layer.provide(dependencies)));
};

const withFreshServices = <A, E, R>(dbPath: string, effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, makeFileLayer(dbPath));

type Actor = {
  readonly threadId: ThreadId;
  readonly runId: RunId;
};

const seedProject = Effect.fn("MailRestartAcceptance.seedProject")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${projectId}, '/tmp/civilization-mail-restart', '[]',
      '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z', NULL
    )
  `;
});

const enableFeature = Effect.fn("MailRestartAcceptance.enableFeature")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      messaging: {
        enabled: true,
        pendingPerRecipient: 10,
        senderPerMinute: 10,
        projectPerMinute: 10,
      },
      operations: { operationReceiptRetentionDays: 30 },
    },
  });
});

const seedActor = Effect.fn("MailRestartAcceptance.seedActor")(function* (
  projectId: ProjectId,
  actor: Actor,
) {
  const sql = yield* SqlClient.SqlClient;
  const name = `Citizen ${actor.threadId}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, provider_instance_id,
      runtime_mode, interaction_mode, active_provider_thread_id,
      created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${actor.threadId}, ${projectId}, ${actor.threadId}, ${providerInstanceId}, ${providerInstanceId},
      'full-access', 'default', NULL,
      '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z', NULL, NULL, '{}'
    )
  `;
  yield* sql`
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
    ) VALUES (
      ${actor.threadId}, ${projectId}, NULL, NULL, ${actor.threadId},
      0, 'resolved', 0, 1, 1,
      ${`name:${actor.threadId}`}, 1, ${name}, ${name}, ${actor.threadId}, 'default-names',
      1, 0, 'calm', 'Calm', '[]', '', 'default-profiles', 1, 0,
      0, ${name}, NULL, ${name}, NULL, NULL, NULL,
      0, 0, 0, 0, 0, 0, 0,
      1, '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
      status, requested_at, completed_at, payload_json
    ) VALUES (
      ${actor.runId}, ${actor.threadId}, 1, ${providerInstanceId}, ${providerInstanceId}, NULL,
      'running', '2026-10-16T10:00:00.000Z', NULL, '{}'
    )
  `;
});

const callerInput = (projectId: ProjectId, actor: Actor) => ({
  projectId,
  threadId: actor.threadId,
  runId: actor.runId,
  providerInstanceId,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
});

const readAccounting = Effect.fn("MailRestartAcceptance.readAccounting")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  return {
    messages:
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_messages WHERE project_id = ${projectId}
      `)[0]?.count ?? 0,
    receipts:
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_mail_operation_receipts WHERE project_id = ${projectId}
      `)[0]?.count ?? 0,
    quotas: yield* sql<{ readonly scope_kind: string; readonly accepted_count: number }>`
      SELECT scope_kind, SUM(accepted_count) AS accepted_count
      FROM civilization_mail_quota_windows
      WHERE project_id = ${projectId}
      GROUP BY scope_kind
      ORDER BY scope_kind ASC
    `,
  };
});

it.effect(
  "replays a committed send after service/database recreation while its receipt is retained",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-civ-mail-restart-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    const projectId = ProjectId.make("project:mail:restart:within-horizon");
    const sender = {
      threadId: ThreadId.make("thread:mail:restart:within-horizon:sender"),
      runId: RunId.make("run:mail:restart:within-horizon:sender"),
    } satisfies Actor;
    const recipient = {
      threadId: ThreadId.make("thread:mail:restart:within-horizon:recipient"),
      runId: RunId.make("run:mail:restart:within-horizon:recipient"),
    } satisfies Actor;
    const request = {
      targetThreadId: recipient.threadId,
      clientRequestId: "restart:within-horizon",
      body: "commit happened before the response was observed",
    } as const;

    return Effect.gen(function* () {
      const first = yield* withFreshServices(
        dbPath,
        Effect.gen(function* () {
          const mail = yield* MailService.CivilizationMailService;
          yield* seedProject(projectId);
          yield* enableFeature();
          yield* seedActor(projectId, sender);
          yield* seedActor(projectId, recipient);
          const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));
          return yield* mail.send({ caller, ...request });
        }),
      );

      const replay = yield* withFreshServices(
        dbPath,
        Effect.gen(function* () {
          const mail = yield* MailService.CivilizationMailService;
          const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));
          const result = yield* mail.send({ caller, ...request });
          assert.deepEqual(yield* readAccounting(projectId), {
            messages: 1,
            receipts: 1,
            quotas: [
              { scope_kind: "project", accepted_count: 1 },
              { scope_kind: "sender", accepted_count: 1 },
            ],
          });
          return result;
        }),
      );

      assert.equal(replay.message.messageId, first.message.messageId);
      assert.equal(replay.message.acceptedAt, first.message.acceptedAt);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect(
  "documents that retry after receipt retention requires reconciliation and is not exactly-once",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-civ-mail-horizon-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    const projectId = ProjectId.make("project:mail:restart:beyond-horizon");
    const sender = {
      threadId: ThreadId.make("thread:mail:restart:beyond-horizon:sender"),
      runId: RunId.make("run:mail:restart:beyond-horizon:sender"),
    } satisfies Actor;
    const recipient = {
      threadId: ThreadId.make("thread:mail:restart:beyond-horizon:recipient"),
      runId: RunId.make("run:mail:restart:beyond-horizon:recipient"),
    } satisfies Actor;
    const request = {
      targetThreadId: recipient.threadId,
      clientRequestId: "restart:beyond-horizon",
      body: "client must reconcile after the operation receipt horizon",
    } as const;

    return Effect.gen(function* () {
      const first = yield* withFreshServices(
        dbPath,
        Effect.gen(function* () {
          const mail = yield* MailService.CivilizationMailService;
          yield* seedProject(projectId);
          yield* enableFeature();
          yield* seedActor(projectId, sender);
          yield* seedActor(projectId, recipient);
          const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));
          return yield* mail.send({ caller, ...request });
        }),
      );

      yield* withFreshServices(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const mail = yield* MailService.CivilizationMailService;
          yield* sql`
          UPDATE civilization_mail_operation_receipts
          SET expires_at = '2000-01-01T00:00:00.000Z'
          WHERE project_id = ${projectId} AND client_request_id = ${request.clientRequestId}
        `;
          const cleanup = yield* mail.cleanupProject(projectId);
          assert.equal(cleanup.deletedReceipts, 1);
        }),
      );

      const afterHorizon = yield* withFreshServices(
        dbPath,
        Effect.gen(function* () {
          const mail = yield* MailService.CivilizationMailService;
          const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));
          const result = yield* mail.send({ caller, ...request });
          const accounting = yield* readAccounting(projectId);
          assert.equal(accounting.messages, 2);
          assert.equal(accounting.receipts, 1);
          return result;
        }),
      );

      assert.notEqual(
        afterHorizon.message.messageId,
        first.message.messageId,
        "after the retained receipt is gone, retry is a new send; clients must reconcile before retrying",
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("rejects a new send when an already-authorized sender settles before acceptance", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-civ-mail-settled-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const projectId = ProjectId.make("project:mail:settled-sender");
  const sender = {
    threadId: ThreadId.make("thread:mail:settled-sender:sender"),
    runId: RunId.make("run:mail:settled-sender:sender"),
  } satisfies Actor;
  const recipient = {
    threadId: ThreadId.make("thread:mail:settled-sender:recipient"),
    runId: RunId.make("run:mail:settled-sender:recipient"),
  } satisfies Actor;

  return withFreshServices(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mail = yield* MailService.CivilizationMailService;
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));

      yield* sql`
        UPDATE civilization_citizens
        SET epoch = epoch + 1, closed = 1,
            delivery_epoch = delivery_epoch + 1, delivery_settled = 1
        WHERE project_id = ${projectId} AND thread_id = ${sender.threadId}
      `;
      const denied = yield* mail
        .send({
          caller,
          targetThreadId: recipient.threadId,
          clientRequestId: "settled-sender:new-send",
          body: "must not be accepted after settlement",
        })
        .pipe(Effect.flip);
      assert.equal((denied as { readonly _tag?: string })._tag, "CivilizationAgentAccessError");
      assert.equal((denied as { readonly reason?: string }).reason, "closed_citizen");
      assert.deepEqual(yield* readAccounting(projectId), {
        messages: 0,
        receipts: 0,
        quotas: [],
      });
    }),
  ).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
