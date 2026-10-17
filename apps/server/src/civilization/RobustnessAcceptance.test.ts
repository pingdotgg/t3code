import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_MAX_IMPORT_BYTES,
  CIVILIZATION_MAX_MESSAGE_BYTES,
  CIVILIZATION_MAX_NAME_ENTRIES,
  CIVILIZATION_MAX_NOTE_BYTES,
  CIVILIZATION_MAX_PACKET_BYTES,
  CIVILIZATION_MAX_POOLS_PER_KIND,
  CIVILIZATION_MAX_PROFILE_ENTRIES,
  CIVILIZATION_MAX_RETAINED_BODY_BYTES,
  CIVILIZATION_CONFIG_VERSION,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";
import * as KnowledgeService from "./KnowledgeService.ts";
import * as MailService from "./MailService.ts";

type FakeProviderCalls = {
  get: number;
  unexpectedProviderWork: number;
};

const providerInstanceId = ProviderInstanceId.make("codex-main");

const fakeProviderLayer = (calls: FakeProviderCalls) =>
  Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (instanceId) => {
        calls.get += 1;
        if (instanceId !== providerInstanceId) {
          return Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          );
        }
        return Effect.succeed({
          instanceId,
          driver: "codex",
          openSession: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die("robustness acceptance must not open provider sessions");
          },
          getCapabilities: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die("robustness acceptance must not execute provider capability work");
          },
        } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]);
      },
      list: () => Effect.succeed([providerInstanceId]),
    }),
  );

const makeLayerWithDatabase = <E, R>(
  calls: FakeProviderCalls,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) => {
  const config = ConfigService.layer.pipe(Layer.provide(database));
  const knowledge = KnowledgeService.layer.pipe(Layer.provide(database));
  const providers = fakeProviderLayer(calls);
  const mailDependencies = Layer.mergeAll(database, config, providers);
  const mail = MailService.layer.pipe(Layer.provide(mailDependencies));
  const contextDependencies = Layer.mergeAll(database, config, providers, mail);
  const context = ContextService.layer.pipe(Layer.provide(contextDependencies));
  return Layer.mergeAll(database, config, knowledge, providers, mail, context);
};

const makeLayer = (calls: FakeProviderCalls) =>
  makeLayerWithDatabase(calls, SqlitePersistence.layerMemory);

type MessagingConfig = {
  readonly messageBytes?: number;
  readonly pendingPerRecipient?: number;
  readonly senderPerMinute?: number;
  readonly projectPerMinute?: number;
  readonly retainedMessageCount?: number;
  readonly retainedBodyBytes?: number;
};

const enableFeature = Effect.fn("RobustnessAcceptance.enableFeature")(function* (
  input: MessagingConfig = {},
) {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      messaging: {
        enabled: true,
        ...(input.messageBytes === undefined ? {} : { messageBytes: input.messageBytes }),
        ...(input.pendingPerRecipient === undefined
          ? {}
          : { pendingPerRecipient: input.pendingPerRecipient }),
        ...(input.senderPerMinute === undefined ? {} : { senderPerMinute: input.senderPerMinute }),
        ...(input.projectPerMinute === undefined
          ? {}
          : { projectPerMinute: input.projectPerMinute }),
        ...(input.retainedMessageCount === undefined
          ? {}
          : { retainedMessageCount: input.retainedMessageCount }),
        ...(input.retainedBodyBytes === undefined
          ? {}
          : { retainedBodyBytes: input.retainedBodyBytes }),
      },
    },
  });
});

const seedProject = Effect.fn("RobustnessAcceptance.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${projectId}, '/tmp/civilization-robustness', '[]',
      '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z', NULL
    )
  `;
  // Keep this acceptance fixture on the production Knowledge/Config/SQLite path,
  // even where an individual assertion is mail-specific.
  const knowledge = yield* KnowledgeService.CivilizationKnowledgeService;
  yield* knowledge.getProjectRevisions(projectId);
});

type ActorSeed = {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly citizenEpoch?: number;
  readonly deliveryEpoch?: number;
  readonly withCitizen?: boolean;
  readonly withRun?: boolean;
};

const seedActor = Effect.fn("RobustnessAcceptance.seedActor")(function* (
  projectId: ProjectId,
  input: ActorSeed,
) {
  const sql = yield* SqlClient.SqlClient;
  const runtimeMode = input.runtimeMode ?? "full-access";
  const interactionMode = input.interactionMode ?? "default";
  const name = `Citizen ${input.threadId}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, provider_instance_id,
      runtime_mode, interaction_mode, active_provider_thread_id,
      created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${input.threadId}, ${projectId}, ${input.threadId}, ${providerInstanceId}, ${providerInstanceId},
      ${runtimeMode}, ${interactionMode}, NULL,
      '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z', NULL, NULL, '{}'
    )
  `;
  if (input.withCitizen !== false) {
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
        ${input.threadId}, ${projectId}, NULL, NULL, ${input.threadId},
        0, 'resolved', 0, 1, 1,
        ${`name:${input.threadId}`}, 1, ${name}, ${name}, ${input.threadId}, 'default-names',
        1, 0,
        'calm', 'Calm', '[]', '', 'default-profiles',
        1, 0,
        0, ${name}, NULL, ${name},
        NULL, NULL, NULL,
        ${input.citizenEpoch ?? 0}, 0, 0, ${input.deliveryEpoch ?? 0}, 0, 0, 0,
        1, '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z'
      )
    `;
  }
  if (input.withRun !== false) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
        status, requested_at, completed_at, payload_json
      ) VALUES (
        ${input.runId}, ${input.threadId}, 1, ${providerInstanceId}, ${providerInstanceId}, NULL,
        'running', '2026-10-16T10:00:00.000Z', NULL, '{}'
      )
    `;
  }
});

const callerInput = (projectId: ProjectId, actor: ActorSeed) => ({
  projectId,
  threadId: actor.threadId,
  runId: actor.runId,
  providerInstanceId,
  runtimeMode: actor.runtimeMode ?? ("full-access" as const),
  interactionMode: actor.interactionMode ?? ("default" as const),
});

const errorTag = (value: unknown) => (value as { readonly _tag?: string })._tag;
const errorReason = (value: unknown) => (value as { readonly reason?: string }).reason;
const errorScope = (value: unknown) => (value as { readonly scope?: string }).scope;

const readMutationCounts = Effect.fn("RobustnessAcceptance.readMutationCounts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    messages:
      (yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM civilization_messages`)[0]?.count ?? 0,
    receipts:
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_mail_operation_receipts
      `)[0]?.count ?? 0,
    quotaRows:
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_mail_quota_windows
      `)[0]?.count ?? 0,
  };
});

it.effect(
  "accepts configured pool/entry/import maxima and rejects the first value over each ceiling",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const config = yield* ConfigService.CivilizationConfigService;
      const nameEntries = Array.from({ length: CIVILIZATION_MAX_NAME_ENTRIES }, (_, index) => ({
        id: `name.${index}`,
        displayName: `Name ${index}`,
        weight: 1,
      }));
      const profileEntries = Array.from(
        { length: CIVILIZATION_MAX_PROFILE_ENTRIES },
        (_, index) => ({
          id: `profile.${index}`,
          label: `Profile ${index}`,
          traits: [],
          styleText: "",
          rich: {
            label: `Rich Profile ${index}`,
            traits: [],
            axiom: "Stay within the requested task.",
            voice: "Focused and precise.",
            styleText: "",
          },
          weight: 1,
        }),
      );
      const namePools = Array.from({ length: CIVILIZATION_MAX_POOLS_PER_KIND }, (_, index) => ({
        id: `names.${index}`,
        entries:
          index === 0
            ? nameEntries
            : [{ id: `name.extra.${index}`, displayName: `Extra Name ${index}`, weight: 1 }],
      }));
      const profilePools = Array.from({ length: CIVILIZATION_MAX_POOLS_PER_KIND }, (_, index) => ({
        id: `profiles.${index}`,
        entries:
          index === 0
            ? profileEntries
            : [
                {
                  id: `profile.extra.${index}`,
                  label: `Extra Profile ${index}`,
                  traits: [],
                  styleText: "",
                  rich: {
                    label: `Rich Extra Profile ${index}`,
                    traits: [],
                    axiom: "Stay within the requested task.",
                    voice: "Focused and precise.",
                    styleText: "",
                  },
                  weight: 1,
                },
              ],
      }));
      const atMax = yield* config.validate({
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          names: { pools: namePools, selectedPoolId: "names.0" },
          personalities: {
            pools: profilePools,
            selectedPoolId: "profiles.0",
            rendering: "off",
          },
        },
      });
      assert.lengthOf(atMax.config.names.pools, CIVILIZATION_MAX_POOLS_PER_KIND);
      assert.lengthOf(atMax.config.names.pools[0]!.entries, CIVILIZATION_MAX_NAME_ENTRIES);
      assert.lengthOf(atMax.config.personalities.pools, CIVILIZATION_MAX_POOLS_PER_KIND);
      assert.lengthOf(
        atMax.config.personalities.pools[0]!.entries,
        CIVILIZATION_MAX_PROFILE_ENTRIES,
      );

      const overNames = yield* config
        .validate({
          override: {
            version: CIVILIZATION_CONFIG_VERSION,
            names: {
              pools: [
                {
                  id: "names.over",
                  entries: [
                    ...nameEntries,
                    { id: "name.over", displayName: "Name over", weight: 1 },
                  ],
                },
              ],
              selectedPoolId: "names.over",
            },
          },
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(overNames), "CivilizationConfigInvalidError");
      assert.equal(errorReason(overNames), "invalid_limit");

      const overProfiles = yield* config
        .validate({
          override: {
            version: CIVILIZATION_CONFIG_VERSION,
            personalities: {
              pools: [
                {
                  id: "profiles.over",
                  entries: [
                    ...profileEntries,
                    {
                      id: "profile.over",
                      label: "Profile over",
                      traits: [],
                      styleText: "",
                      rich: {
                        label: "Rich Profile over",
                        traits: [],
                        axiom: "Stay within the requested task.",
                        voice: "Focused and precise.",
                        styleText: "",
                      },
                      weight: 1,
                    },
                  ],
                },
              ],
              selectedPoolId: "profiles.over",
              rendering: "off",
            },
          },
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(overProfiles), "CivilizationConfigInvalidError");
      assert.equal(errorReason(overProfiles), "invalid_limit");

      const overPools = yield* config
        .validate({
          override: {
            version: CIVILIZATION_CONFIG_VERSION,
            names: {
              pools: [
                ...namePools,
                {
                  id: "names.over",
                  entries: [{ id: "name.pool.over", displayName: "Pool Over", weight: 1 }],
                },
              ],
              selectedPoolId: "names.0",
            },
          },
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(overPools), "CivilizationConfigInvalidError");
      assert.equal(errorReason(overPools), "invalid_limit");

      const minimalJson = JSON.stringify({ version: CIVILIZATION_CONFIG_VERSION });
      const exactImport =
        minimalJson + " ".repeat(CIVILIZATION_MAX_IMPORT_BYTES - minimalJson.length);
      assert.equal(Buffer.byteLength(exactImport, "utf8"), CIVILIZATION_MAX_IMPORT_BYTES);
      const imported = yield* config.import({ expectedRevision: 0, json: exactImport });
      assert.equal(imported.revision, 1);
      const oversizedImport = yield* config
        .import({ expectedRevision: 1, json: `${exactImport} ` })
        .pipe(Effect.flip);
      assert.equal(errorTag(oversizedImport), "CivilizationConfigInvalidError");
      assert.equal(errorReason(oversizedImport), "import_too_large");
      assert.equal(calls.unexpectedProviderWork, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("accepts the exact UTF-8 mail byte boundary and rejects one byte over", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const mail = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:robust:utf8");
    const sender = {
      threadId: ThreadId.make("thread:robust:utf8:sender"),
      runId: RunId.make("run:robust:utf8:sender"),
    } satisfies ActorSeed;
    const recipient = {
      threadId: ThreadId.make("thread:robust:utf8:recipient"),
      runId: RunId.make("run:robust:utf8:recipient"),
    } satisfies ActorSeed;
    yield* seedProject(projectId);
    yield* enableFeature({ messageBytes: 4 });
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, recipient);
    const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));

    const accepted = yield* mail.send({
      caller,
      targetThreadId: recipient.threadId,
      clientRequestId: "utf8:exact",
      body: "🙂",
    });
    assert.equal(accepted.message.bodyBytes, 4);
    assert.deepEqual(yield* readMutationCounts(), { messages: 1, receipts: 1, quotaRows: 2 });

    const tooLarge = yield* mail
      .send({
        caller,
        targetThreadId: recipient.threadId,
        clientRequestId: "utf8:over",
        body: "🙂a",
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(tooLarge), "CivilizationMailInvalidError");
    assert.equal(errorReason(tooLarge), "message_too_large");
    assert.deepEqual(yield* readMutationCounts(), { messages: 1, receipts: 1, quotaRows: 2 });
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "rejects bidi/format-control mail and malformed or oversized clientRequestId values",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const mail = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:robust:text-validation");
      const sender = {
        threadId: ThreadId.make("thread:robust:text-validation:sender"),
        runId: RunId.make("run:robust:text-validation:sender"),
      } satisfies ActorSeed;
      const recipient = {
        threadId: ThreadId.make("thread:robust:text-validation:recipient"),
        runId: RunId.make("run:robust:text-validation:recipient"),
      } satisfies ActorSeed;
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));

      for (const [clientRequestId, body] of [
        ["unsafe:bidi", "safe\u202Ereversed"],
        ["unsafe:isolate", "safe\u2066isolated"],
      ] as const) {
        const error = yield* mail
          .send({ caller, targetThreadId: recipient.threadId, clientRequestId, body })
          .pipe(Effect.flip);
        assert.equal(errorTag(error), "CivilizationMailInvalidError");
        assert.equal(errorReason(error), "invalid_message");
      }

      for (const clientRequestId of ["   ", "x".repeat(1025)]) {
        const error = yield* mail
          .send({ caller, targetThreadId: recipient.threadId, clientRequestId, body: "safe body" })
          .pipe(Effect.flip);
        assert.equal(errorTag(error), "CivilizationMailInvalidError");
        assert.equal(errorReason(error), "invalid_message");
      }

      assert.deepEqual(yield* readMutationCounts(), { messages: 0, receipts: 0, quotaRows: 0 });
      assert.equal(calls.unexpectedProviderWork, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("rejects cross-project, outsider and stale caller authority without accounting", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mail = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:robust:authority");
    const otherProjectId = ProjectId.make("project:robust:authority:other");
    yield* seedProject(projectId);
    yield* seedProject(otherProjectId);
    yield* enableFeature();

    const regularRecipient = {
      threadId: ThreadId.make("thread:robust:authority:recipient"),
      runId: RunId.make("run:robust:authority:recipient"),
    } satisfies ActorSeed;
    const crossProjectTarget = {
      threadId: ThreadId.make("thread:robust:authority:cross-project"),
      runId: RunId.make("run:robust:authority:cross-project"),
    } satisfies ActorSeed;
    const outsider = {
      threadId: ThreadId.make("thread:robust:authority:outsider"),
      runId: RunId.make("run:robust:authority:outsider"),
      withCitizen: false,
      withRun: false,
    } satisfies ActorSeed;
    const senders = {
      cross: {
        threadId: ThreadId.make("thread:robust:authority:sender-cross"),
        runId: RunId.make("run:robust:authority:sender-cross"),
      },
      outsider: {
        threadId: ThreadId.make("thread:robust:authority:sender-outsider"),
        runId: RunId.make("run:robust:authority:sender-outsider"),
      },
      staleRun: {
        threadId: ThreadId.make("thread:robust:authority:sender-run"),
        runId: RunId.make("run:robust:authority:sender-run"),
      },
      staleCitizen: {
        threadId: ThreadId.make("thread:robust:authority:sender-citizen"),
        runId: RunId.make("run:robust:authority:sender-citizen"),
      },
      staleDelivery: {
        threadId: ThreadId.make("thread:robust:authority:sender-delivery"),
        runId: RunId.make("run:robust:authority:sender-delivery"),
      },
    } satisfies Record<string, ActorSeed>;

    yield* seedActor(projectId, regularRecipient);
    yield* seedActor(otherProjectId, crossProjectTarget);
    yield* seedActor(projectId, outsider);
    for (const sender of Object.values(senders)) yield* seedActor(projectId, sender);

    const crossCaller = yield* mail.authoritativeCaller(callerInput(projectId, senders.cross));
    const cross = yield* mail
      .send({
        caller: crossCaller,
        targetThreadId: crossProjectTarget.threadId,
        clientRequestId: "authority:cross",
        body: "no",
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(cross), "forbidden");

    const outsiderCaller = yield* mail.authoritativeCaller(
      callerInput(projectId, senders.outsider),
    );
    const outsiderError = yield* mail
      .send({
        caller: outsiderCaller,
        targetThreadId: outsider.threadId,
        clientRequestId: "authority:outsider",
        body: "no",
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(outsiderError), "forbidden");

    const staleRunCaller = yield* mail.authoritativeCaller(
      callerInput(projectId, senders.staleRun),
    );
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = datetime('now')
      WHERE run_id = ${senders.staleRun.runId}
    `;
    const staleRun = yield* mail
      .send({
        caller: staleRunCaller,
        targetThreadId: regularRecipient.threadId,
        clientRequestId: "authority:stale-run",
        body: "no",
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(staleRun), "stale_run");

    const staleCitizenCaller = yield* mail.authoritativeCaller(
      callerInput(projectId, senders.staleCitizen),
    );
    yield* sql`
      UPDATE civilization_citizens SET epoch = epoch + 1
      WHERE thread_id = ${senders.staleCitizen.threadId}
    `;
    const staleCitizen = yield* mail
      .send({
        caller: staleCitizenCaller,
        targetThreadId: regularRecipient.threadId,
        clientRequestId: "authority:stale-citizen",
        body: "no",
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(staleCitizen), "stale_epoch");

    const staleDeliveryCaller = yield* mail.authoritativeCaller(
      callerInput(projectId, senders.staleDelivery),
    );
    yield* sql`
      UPDATE civilization_citizens SET delivery_epoch = delivery_epoch + 1
      WHERE thread_id = ${senders.staleDelivery.threadId}
    `;
    const staleDelivery = yield* mail
      .send({
        caller: staleDeliveryCaller,
        targetThreadId: regularRecipient.threadId,
        clientRequestId: "authority:stale-delivery",
        body: "no",
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(staleDelivery), "stale_epoch");

    assert.deepEqual(yield* readMutationCounts(), { messages: 0, receipts: 0, quotaRows: 0 });
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect("rechecks the saved sender ceiling before releasing an accepted mail body", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mail = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:robust:offer-ceiling");
    const sender = {
      threadId: ThreadId.make("thread:robust:offer-ceiling:sender"),
      runId: RunId.make("run:robust:offer-ceiling:sender"),
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
    } satisfies ActorSeed;
    const recipient = {
      threadId: ThreadId.make("thread:robust:offer-ceiling:recipient"),
      runId: RunId.make("run:robust:offer-ceiling:recipient"),
      runtimeMode: "approval-required",
      interactionMode: "plan",
    } satisfies ActorSeed;
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, recipient);
    const senderCaller = yield* mail.authoritativeCaller(callerInput(projectId, sender));
    const sent = yield* mail.send({
      caller: senderCaller,
      targetThreadId: recipient.threadId,
      clientRequestId: "offer-ceiling:send",
      body: "bounded transfer",
    });
    assert.equal(sent.message.acceptedRuntimeMode, "auto-accept-edits");
    assert.equal(sent.message.acceptedInteractionMode, "plan");

    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET runtime_mode = 'full-access', interaction_mode = 'default'
      WHERE thread_id = ${recipient.threadId}
    `;
    const permissiveRecipient = yield* mail.authoritativeCaller({
      ...callerInput(projectId, recipient),
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const denied = yield* mail
      .receive({
        caller: permissiveRecipient,
        messageId: sent.message.messageId,
        clientRequestId: "offer-ceiling:receive",
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(denied), "CivilizationAgentAccessError");
    assert.equal(errorReason(denied), "forbidden");
    assert.deepEqual(
      (yield* sql<{ readonly offer_count: number }>`
        SELECT offer_count FROM civilization_messages WHERE message_id = ${sent.message.messageId}
      `)[0],
      { offer_count: 0 },
    );
    assert.equal(
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_mail_operation_receipts
        WHERE operation_kind = 'receive'
      `)[0]?.count,
      0,
    );
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect("uses UTC minute quota windows across a boundary and denies rollback reuse", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mail = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:robust:quota-window");
    const sender = {
      threadId: ThreadId.make("thread:robust:quota-window:sender"),
      runId: RunId.make("run:robust:quota-window:sender"),
    } satisfies ActorSeed;
    const recipients = [1, 2, 3].map((index) => ({
      threadId: ThreadId.make(`thread:robust:quota-window:recipient:${index}`),
      runId: RunId.make(`run:robust:quota-window:recipient:${index}`),
    })) satisfies ReadonlyArray<ActorSeed>;
    yield* seedProject(projectId);
    yield* enableFeature({ senderPerMinute: 1, projectPerMinute: 10, pendingPerRecipient: 10 });
    yield* seedActor(projectId, sender);
    for (const recipient of recipients) yield* seedActor(projectId, recipient);
    const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));

    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-16T12:00:59.999Z")),
    );
    const firstInput = {
      caller,
      targetThreadId: recipients[0]!.threadId,
      clientRequestId: "quota-window:first",
      body: "one",
    } as const;
    const first = yield* mail.send(firstInput);
    const duplicate = yield* mail.send(firstInput);
    assert.equal(duplicate.message.messageId, first.message.messageId);

    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-16T12:01:00.000Z")),
    );
    const secondInput = {
      caller,
      targetThreadId: recipients[1]!.threadId,
      clientRequestId: "quota-window:second",
      body: "two",
    } as const;
    const second = yield* mail.send(secondInput);

    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-16T12:00:30.000Z")),
    );
    const secondReplayAfterRollback = yield* mail.send(secondInput);
    assert.equal(secondReplayAfterRollback.message.messageId, second.message.messageId);
    const exhausted = yield* mail
      .send({
        caller,
        targetThreadId: recipients[2]!.threadId,
        clientRequestId: "quota-window:third",
        body: "three",
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(exhausted), "CivilizationMailQuotaError");
    assert.equal(errorScope(exhausted), "sender");
    assert.equal((exhausted as { readonly retryAt?: string }).retryAt, "2026-10-16T12:01:00.000Z");

    const senderWindows = yield* sql<{
      readonly window_start_minute: string;
      readonly accepted_count: number;
    }>`
      SELECT window_start_minute, accepted_count
      FROM civilization_mail_quota_windows
      WHERE project_id = ${projectId} AND scope_kind = 'sender' AND scope_id = ${sender.threadId}
      ORDER BY window_start_minute ASC
    `;
    assert.deepEqual(senderWindows, [
      { window_start_minute: "2026-10-16T12:00:00.000Z", accepted_count: 1 },
      { window_start_minute: "2026-10-16T12:01:00.000Z", accepted_count: 1 },
    ]);

    const projectWindows = yield* sql<{
      readonly window_start_minute: string;
      readonly accepted_count: number;
    }>`
      SELECT window_start_minute, accepted_count
      FROM civilization_mail_quota_windows
      WHERE project_id = ${projectId} AND scope_kind = 'project' AND scope_id = ${projectId}
      ORDER BY window_start_minute ASC
    `;
    assert.deepEqual(projectWindows, [
      { window_start_minute: "2026-10-16T12:00:00.000Z", accepted_count: 1 },
      { window_start_minute: "2026-10-16T12:01:00.000Z", accepted_count: 1 },
    ]);
    assert.deepEqual(yield* readMutationCounts(), { messages: 2, receipts: 2, quotaRows: 4 });
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect("returns typed pending and retained-body saturation errors", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const mail = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:robust:capacity");
    const sender = {
      threadId: ThreadId.make("thread:robust:capacity:sender"),
      runId: RunId.make("run:robust:capacity:sender"),
    } satisfies ActorSeed;
    const firstRecipient = {
      threadId: ThreadId.make("thread:robust:capacity:first"),
      runId: RunId.make("run:robust:capacity:first"),
    } satisfies ActorSeed;
    const secondRecipient = {
      threadId: ThreadId.make("thread:robust:capacity:second"),
      runId: RunId.make("run:robust:capacity:second"),
    } satisfies ActorSeed;
    yield* seedProject(projectId);
    yield* enableFeature({
      pendingPerRecipient: 1,
      retainedMessageCount: 10,
      retainedBodyBytes: 5,
      senderPerMinute: 10,
      projectPerMinute: 10,
    });
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, firstRecipient);
    yield* seedActor(projectId, secondRecipient);
    const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));

    yield* mail.send({
      caller,
      targetThreadId: firstRecipient.threadId,
      clientRequestId: "capacity:first",
      body: "four",
    });
    const pending = yield* mail
      .send({
        caller,
        targetThreadId: firstRecipient.threadId,
        clientRequestId: "capacity:pending",
        body: "x",
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(pending), "CivilizationMailCapacityError");
    assert.equal(errorScope(pending), "recipient_pending");

    const retained = yield* mail
      .send({
        caller,
        targetThreadId: secondRecipient.threadId,
        clientRequestId: "capacity:retained-body",
        body: "xx",
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(retained), "CivilizationMailCapacityError");
    assert.equal(errorScope(retained), "project_body_bytes");
    assert.deepEqual(yield* readMutationCounts(), { messages: 1, receipts: 1, quotaRows: 2 });
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "enforces the hard packet and retained-storage ceilings at their configured maxima",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ConfigService.CivilizationConfigService;
      const context = yield* ContextService.CivilizationContextService;
      const mail = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:robust:hard-ceilings");
      const sender = {
        threadId: ThreadId.make("thread:robust:hard-ceilings:sender"),
        runId: RunId.make("run:robust:hard-ceilings:sender"),
      } satisfies ActorSeed;
      const recipient = {
        threadId: ThreadId.make("thread:robust:hard-ceilings:recipient"),
        runId: RunId.make("run:robust:hard-ceilings:recipient"),
      } satisfies ActorSeed;
      const secondRecipient = {
        threadId: ThreadId.make("thread:robust:hard-ceilings:recipient:2"),
        runId: RunId.make("run:robust:hard-ceilings:recipient:2"),
      } satisfies ActorSeed;
      yield* seedProject(projectId);
      yield* config.set({
        expectedRevision: 0,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true },
          context: {
            packetBytes: CIVILIZATION_MAX_PACKET_BYTES,
            rosterCount: 0,
            noteCount: 10,
            inboxExcerptCount: 0,
          },
          knowledge: { noteBytes: CIVILIZATION_MAX_NOTE_BYTES },
          messaging: {
            enabled: true,
            messageBytes: CIVILIZATION_MAX_MESSAGE_BYTES,
            pendingPerRecipient: 10,
            senderPerMinute: 10,
            projectPerMinute: 10,
            retainedBodyBytes: CIVILIZATION_MAX_RETAINED_BODY_BYTES,
          },
        },
      });
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      yield* seedActor(projectId, secondRecipient);

      for (let index = 0; index < 4; index += 1) {
        yield* sql`
        INSERT INTO civilization_notes (
          note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
          accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
          created_at, updated_at, resolved_at
        ) VALUES (
          ${`note:hard:${index}`}, ${projectId}, 'fact', ${"n".repeat(CIVILIZATION_MAX_NOTE_BYTES)},
          ${CIVILIZATION_MAX_NOTE_BYTES}, ${sender.threadId}, 0,
          'full-access', 'default', '[]', 1,
          '2026-10-16T10:00:00.000Z', ${`2026-10-16T10:00:0${index}.000Z`}, NULL
        )
      `;
      }
      const packet = yield* context.forTurn({
        projectId,
        threadId: sender.threadId,
        runId: sender.runId,
        attemptId: RunAttemptId.make("attempt:robust:hard-ceilings"),
        providerTurnOrdinal: 1,
        providerInstanceId,
        runtimeMode: "full-access",
        interactionMode: "default",
        message: { text: "bounded hard-limit packet", createdBy: "user", creationSource: "web" },
      });
      assert.isNotNull(packet.packet);
      assert.isAtMost(packet.packet!.bytes, CIVILIZATION_MAX_PACKET_BYTES);
      assert.isAbove(packet.packet!.bytes, CIVILIZATION_MAX_NOTE_BYTES);
      assert.isAbove(packet.packet!.reference.selectedNoteIds.length, 0);
      assert.isBelow(packet.packet!.reference.selectedNoteIds.length, 4);

      // Exercise the 128 MiB production retained-byte ceiling without allocating
      // 128 MiB of bodies: seed the authoritative counter at max-1 and let the
      // normal message trigger/accounting path consume the final byte.
      yield* sql`
      INSERT INTO civilization_project_state (
        project_id, census_revision, notes_revision, mail_revision,
        retained_message_count, retained_body_bytes, updated_at
      ) VALUES (${projectId}, 0, 0, 0, 0, ${CIVILIZATION_MAX_RETAINED_BODY_BYTES - 1}, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        retained_message_count = 0,
        retained_body_bytes = ${CIVILIZATION_MAX_RETAINED_BODY_BYTES - 1},
        updated_at = datetime('now')
    `;
      const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));
      yield* mail.send({
        caller,
        targetThreadId: recipient.threadId,
        clientRequestId: "hard-ceiling:last-byte",
        body: "x",
      });
      const atMax = (yield* sql<{ readonly retained_body_bytes: number }>`
      SELECT retained_body_bytes FROM civilization_project_state WHERE project_id = ${projectId}
    `)[0]!;
      assert.equal(atMax.retained_body_bytes, CIVILIZATION_MAX_RETAINED_BODY_BYTES);
      const saturated = yield* mail
        .send({
          caller,
          targetThreadId: secondRecipient.threadId,
          clientRequestId: "hard-ceiling:over-byte",
          body: "x",
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(saturated), "CivilizationMailCapacityError");
      assert.equal(errorScope(saturated), "project_body_bytes");
      assert.equal(calls.unexpectedProviderWork, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect(
  "keeps repeated bounded census reads on an RSS plateau",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const knowledge = yield* KnowledgeService.CivilizationKnowledgeService;
      const projectId = ProjectId.make("project:robust:rss-plateau");
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* sql`
        WITH RECURSIVE n(i) AS (
          VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 5000
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
        SELECT printf('thread:rss:%05d', i), ${projectId}, NULL, NULL, printf('thread:rss:%05d', i),
          0, 'resolved', 0, i, i,
          printf('name:rss:%05d', i), 1, printf('RSS %05d', i), printf('RSS %05d', i),
          printf('rss %05d', i), 'default-names', 1, 0,
          'calm', 'Calm', '[]', '', 'default-profiles', 1, 0,
          0, printf('RSS %05d', i), NULL, printf('RSS %05d', i), NULL, NULL, NULL,
          0, 0, 0, 0, 0, 0, 0, 1,
          '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z'
        FROM n
      `;

      // Warm the query/JIT before measuring allocator behavior.
      for (let index = 0; index < 50; index += 1) {
        yield* knowledge.listCensus({ projectId, limit: 50 });
      }
      const samples: number[] = [];
      for (let index = 0; index < 300; index += 1) {
        const page = yield* knowledge.listCensus({ projectId, limit: 50 });
        assert.lengthOf(page.citizens, 50);
        if ((index + 1) % 30 === 0) samples.push(process.memoryUsage().rss);
      }
      const latterHalf = samples.slice(Math.floor(samples.length / 2));
      const range = Math.max(...latterHalf) - Math.min(...latterHalf);
      const plateauBudget = 64 * 1024 * 1024;
      assert.isAtMost(range, plateauBudget);
      assert.isAtMost((samples.at(-1) ?? 0) - (latterHalf[0] ?? 0), plateauBudget);
      assert.equal(calls.unexpectedProviderWork, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
  { timeout: 30_000 },
);

it.effect("fails a disk-full send closed, then succeeds after storage capacity is restored", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mail = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:robust:disk-full");
    const sender = {
      threadId: ThreadId.make("thread:robust:disk-full:sender"),
      runId: RunId.make("run:robust:disk-full:sender"),
    } satisfies ActorSeed;
    const recipient = {
      threadId: ThreadId.make("thread:robust:disk-full:recipient"),
      runId: RunId.make("run:robust:disk-full:recipient"),
    } satisfies ActorSeed;
    yield* seedProject(projectId);
    yield* enableFeature({
      messageBytes: 16 * 1024,
      retainedBodyBytes: 1024 * 1024,
      pendingPerRecipient: 10,
      senderPerMinute: 10,
      projectPerMinute: 10,
    });
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, recipient);
    const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));

    // Compact away freelist slack, then cap the database at exactly its current
    // number of pages. The 16 KiB accepted body necessarily needs overflow pages,
    // so the write deterministically reaches SQLITE_FULL without filesystem tricks.
    yield* sql`VACUUM`;
    const pageCount = (yield* sql<{ readonly page_count: number }>`PRAGMA page_count`)[0]!
      .page_count;
    const freelistCount = (yield* sql<{
      readonly freelist_count: number;
    }>`PRAGMA freelist_count`)[0]!.freelist_count;
    assert.equal(freelistCount, 0);
    yield* sql.unsafe(`PRAGMA max_page_count = ${pageCount}`);

    const request = {
      caller,
      targetThreadId: recipient.threadId,
      clientRequestId: "disk-full:send",
      body: "x".repeat(16 * 1024),
    } as const;
    const full = yield* mail.send(request).pipe(Effect.flip);
    assert.equal(errorTag(full), "CivilizationUnavailableError");
    assert.equal(errorReason(full), "storage");
    assert.deepEqual(yield* readMutationCounts(), { messages: 0, receipts: 0, quotaRows: 0 });

    yield* sql.unsafe(`PRAGMA max_page_count = ${pageCount + 128}`);
    const recovered = yield* mail.send(request);
    assert.equal(recovered.message.bodyBytes, CIVILIZATION_MAX_MESSAGE_BYTES);
    assert.deepEqual(yield* readMutationCounts(), { messages: 1, receipts: 1, quotaRows: 2 });
    const overHardLimit = yield* mail
      .send({
        ...request,
        clientRequestId: "disk-full:over-hard-limit",
        body: "x".repeat(CIVILIZATION_MAX_MESSAGE_BYTES + 1),
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(overHardLimit), "CivilizationMailInvalidError");
    assert.equal(errorReason(overHardLimit), "message_too_large");
    assert.deepEqual(yield* readMutationCounts(), { messages: 1, receipts: 1, quotaRows: 2 });
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "fails a production file-backed busy send closed and succeeds when the writer lock is released",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-civilization-busy-" });
      const dbPath = path.join(tempDirectory, "state.sqlite");
      const database = SqlitePersistence.layerFromPath(dbPath).pipe(
        Layer.provide(NodeServices.layer),
      );
      const primary = yield* Layer.build(makeLayerWithDatabase(calls, database));
      const lockerDatabase = SqlitePersistence.layerFromPath(dbPath).pipe(
        Layer.provide(NodeServices.layer),
      );
      const locker = yield* Layer.build(lockerDatabase);

      yield* Effect.gen(function* () {
        const mail = yield* MailService.CivilizationMailService;
        const projectId = ProjectId.make("project:robust:busy");
        const sender = {
          threadId: ThreadId.make("thread:robust:busy:sender"),
          runId: RunId.make("run:robust:busy:sender"),
        } satisfies ActorSeed;
        const recipient = {
          threadId: ThreadId.make("thread:robust:busy:recipient"),
          runId: RunId.make("run:robust:busy:recipient"),
        } satisfies ActorSeed;
        yield* seedProject(projectId);
        yield* enableFeature({
          senderPerMinute: 10,
          projectPerMinute: 10,
          pendingPerRecipient: 10,
        });
        yield* seedActor(projectId, sender);
        yield* seedActor(projectId, recipient);
        const caller = yield* mail.authoritativeCaller(callerInput(projectId, sender));

        const lockerSql = Context.get(locker, SqlClient.SqlClient);
        const lockAcquired = yield* Deferred.make<void>();
        const releaseLock = yield* Deferred.make<void>();
        const holder = yield* Effect.forkScoped(
          lockerSql.withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(lockAcquired, undefined);
              yield* Deferred.await(releaseLock);
            }),
          ),
        );
        yield* Deferred.await(lockAcquired);

        const request = {
          caller,
          targetThreadId: recipient.threadId,
          clientRequestId: "busy:send",
          body: "writer contention must fail atomically",
        } as const;
        const startedAt = performance.now();
        const busy = yield* mail
          .send(request)
          .pipe(
            Effect.flip,
            Effect.ensuring(Deferred.succeed(releaseLock, undefined).pipe(Effect.ignore)),
          );
        const elapsedMs = performance.now() - startedAt;
        yield* Fiber.join(holder);

        assert.equal(errorTag(busy), "CivilizationUnavailableError");
        assert.equal(errorReason(busy), "storage");
        assert.isBelow(elapsedMs, 7_500, "host busy_timeout must bound the failed writer attempt");
        assert.deepEqual(yield* readMutationCounts(), { messages: 0, receipts: 0, quotaRows: 0 });

        const recovered = yield* mail.send(request);
        assert.isString(recovered.message.messageId);
        assert.deepEqual(yield* readMutationCounts(), { messages: 1, receipts: 1, quotaRows: 2 });
        assert.equal(calls.unexpectedProviderWork, 0);
      }).pipe(Effect.provide(primary));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  },
  { timeout: 20_000 },
);
