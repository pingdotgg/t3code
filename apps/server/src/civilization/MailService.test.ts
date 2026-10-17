import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as MailService from "./MailService.ts";

type FakeProviderCalls = {
  get: number;
  unexpectedProviderWork: number;
};

const fakeProviderLayer = (calls: FakeProviderCalls) => {
  const drivers: Readonly<Record<string, string>> = {
    "codex-main": "codex",
    "claude-main": "claudeAgent",
    "cursor-main": "cursor",
  };
  return Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (instanceId) => {
        calls.get += 1;
        const driver = drivers[instanceId];
        if (driver === undefined) {
          return Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          );
        }
        return Effect.succeed({
          instanceId,
          driver,
          openSession: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die("MailService must not open provider sessions");
          },
          getCapabilities: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die("MailService must not inspect live provider capabilities");
          },
        } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]);
      },
      list: () => Effect.succeed(Object.keys(drivers).map((id) => ProviderInstanceId.make(id))),
    }),
  );
};

const makeLayer = (calls: FakeProviderCalls) => {
  const database = SqlitePersistence.layerMemory;
  const config = ConfigService.layer.pipe(Layer.provide(database));
  const providers = fakeProviderLayer(calls);
  const dependencies = Layer.mergeAll(database, config, providers);
  return Layer.mergeAll(dependencies, MailService.layer.pipe(Layer.provide(dependencies)));
};

type TestConfig = {
  readonly pendingPerRecipient?: number;
  readonly senderPerMinute?: number;
  readonly projectPerMinute?: number;
  readonly retainedMessageCount?: number;
  readonly retainedBodyBytes?: number;
  readonly unreadTtlDays?: number;
  readonly terminalRetentionDays?: number;
  readonly operationReceiptRetentionDays?: number;
  readonly responseBodyBytes?: number;
};

const enableFeature = Effect.fn("MailService.test.enableFeature")(function* (
  input: TestConfig = {},
) {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      messaging: {
        enabled: true,
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
        ...(input.unreadTtlDays === undefined ? {} : { unreadTtlDays: input.unreadTtlDays }),
      },
      operations: {
        ...(input.terminalRetentionDays === undefined
          ? {}
          : { terminalRetentionDays: input.terminalRetentionDays }),
        ...(input.operationReceiptRetentionDays === undefined
          ? {}
          : { operationReceiptRetentionDays: input.operationReceiptRetentionDays }),
        ...(input.responseBodyBytes === undefined
          ? {}
          : { responseBodyBytes: input.responseBodyBytes }),
      },
    },
  });
});

const seedProject = Effect.fn("MailService.test.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${projectId}, '/tmp/civilization-mail', '[]',
      '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z', NULL
    )
  `;
});

type ActorSeed = {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly observedOnly?: boolean;
  readonly closed?: boolean;
  readonly deleted?: boolean;
  readonly deliveryEpoch?: number;
  readonly deliverySettled?: boolean;
  readonly deliveryArchived?: boolean;
  readonly deliveryDeleted?: boolean;
  readonly withRun?: boolean;
};

const seedActor = Effect.fn("MailService.test.seedActor")(function* (
  projectId: ProjectId,
  input: ActorSeed,
) {
  const sql = yield* SqlClient.SqlClient;
  const provider = input.providerInstanceId ?? ProviderInstanceId.make("codex-main");
  const runtimeMode = input.runtimeMode ?? "full-access";
  const interactionMode = input.interactionMode ?? "default";
  const name = `Citizen ${input.threadId}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, provider_instance_id,
      runtime_mode, interaction_mode, active_provider_thread_id,
      created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${input.threadId}, ${projectId}, ${input.threadId}, ${provider}, ${provider},
      ${runtimeMode}, ${interactionMode}, NULL,
      '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z',
      ${input.deliveryArchived === true ? "2026-10-16T10:00:00.000Z" : null},
      ${input.deleted === true || input.deliveryDeleted === true ? "2026-10-16T10:00:00.000Z" : null},
      '{}'
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
      ${input.threadId}, ${projectId}, NULL, NULL, ${input.threadId},
      0, 'resolved', ${input.observedOnly === true ? 1 : 0}, 1, 1,
      ${`name:${input.threadId}`}, 1, ${name}, ${name}, ${input.threadId}, 'default-names',
      1, 0,
      'calm', 'Calm', '[]', '', 'default-profiles',
      1, 0,
      0, ${name}, NULL, ${name},
      NULL, NULL, NULL,
      0, ${input.closed === true ? 1 : 0}, ${input.deleted === true ? 1 : 0},
      ${input.deliveryEpoch ?? 0}, ${input.deliverySettled === true ? 1 : 0},
      ${input.deliveryArchived === true ? 1 : 0}, ${input.deliveryDeleted === true ? 1 : 0},
      1, '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z'
    )
  `;
  if (input.withRun !== false) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
        status, requested_at, completed_at, payload_json
      ) VALUES (
        ${input.runId}, ${input.threadId}, 1, ${provider}, ${provider}, NULL,
        'running', '2026-10-16T10:00:00.000Z', NULL, '{}'
      )
    `;
  }
});

const callerInput = (projectId: ProjectId, actor: ActorSeed) => ({
  projectId,
  threadId: actor.threadId,
  runId: actor.runId,
  providerInstanceId: actor.providerInstanceId ?? ProviderInstanceId.make("codex-main"),
  runtimeMode: actor.runtimeMode ?? ("full-access" as const),
  interactionMode: actor.interactionMode ?? ("default" as const),
});

const errorTag = (value: unknown) => (value as { readonly _tag?: string })._tag;
const errorReason = (value: unknown) => (value as { readonly reason?: string }).reason;

it.effect("derives an authoritative caller from the live host run and supported provider", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:caller");
    const actor: ActorSeed = {
      threadId: ThreadId.make("thread:mail:caller"),
      runId: RunId.make("run:mail:caller"),
    };
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, actor);

    const caller = yield* service.authoritativeCaller(callerInput(projectId, actor));
    assert.deepEqual(caller, {
      ...callerInput(projectId, actor),
      citizenEpoch: 0,
      deliveryEpoch: 0,
    });
    assert.equal(calls.get, 1);
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "sends atomically and replays an identical request without double quota or receipt",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:send");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:send:from"),
        runId: RunId.make("run:mail:send:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:send:to"),
        runId: RunId.make("run:mail:send:to"),
      };
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));

      const input = {
        caller,
        targetThreadId: recipient.threadId,
        clientRequestId: "send:one",
        body: "hello",
      } as const;
      const first = yield* service.send(input);
      const replay = yield* service.send(input);
      assert.equal(replay.message.messageId, first.message.messageId);

      const changed = yield* service.send({ ...input, body: "different" }).pipe(Effect.flip);
      assert.equal(errorTag(changed), "CivilizationMailConflictError");
      assert.equal(errorReason(changed), "idempotency_conflict");
      assert.deepEqual(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM civilization_messages`)[0],
        { count: 1 },
      );
      assert.deepEqual(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM civilization_mail_operation_receipts`)[0],
        { count: 1 },
      );
      assert.deepEqual(
        yield* sql<{ readonly scope_kind: string; readonly accepted_count: number }>`
        SELECT scope_kind, accepted_count FROM civilization_mail_quota_windows ORDER BY scope_kind ASC
      `,
        [
          { scope_kind: "project", accepted_count: 1 },
          { scope_kind: "sender", accepted_count: 1 },
        ],
      );
      assert.deepEqual(
        (yield* sql<{
          readonly retained_message_count: number;
          readonly retained_body_bytes: number;
        }>`
        SELECT retained_message_count, retained_body_bytes FROM civilization_project_state WHERE project_id = ${projectId}
      `)[0],
        { retained_message_count: 1, retained_body_bytes: 5 },
      );
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`)[0]?.count,
        0,
      );
      assert.equal(calls.unexpectedProviderWork, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("rejects unsupported, observed, self, closed and above-ceiling recipients", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:reject");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:from"),
      runId: RunId.make("run:mail:reject:from"),
    };
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, sender);
    const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));
    const sendTo = (targetThreadId: ThreadId, clientRequestId: string) =>
      service.send({ caller, targetThreadId, clientRequestId, body: "hello" });

    const self = yield* sendTo(sender.threadId, "reject:self").pipe(Effect.flip);
    assert.equal(errorReason(self), "self_send");

    const unsupported: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:unsupported"),
      runId: RunId.make("run:mail:reject:unsupported"),
      providerInstanceId: ProviderInstanceId.make("cursor-main"),
    };
    yield* seedActor(projectId, unsupported);
    const unsupportedError = yield* sendTo(unsupported.threadId, "reject:unsupported").pipe(
      Effect.flip,
    );
    assert.equal(errorReason(unsupportedError), "unsupported_provider");

    const observed: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:observed"),
      runId: RunId.make("run:mail:reject:observed"),
      observedOnly: true,
    };
    yield* seedActor(projectId, observed);
    const observedError = yield* sendTo(observed.threadId, "reject:observed").pipe(Effect.flip);
    assert.equal(errorReason(observedError), "observed_agent_read_only");

    const closed: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:closed"),
      runId: RunId.make("run:mail:reject:closed"),
      closed: true,
      deliverySettled: true,
    };
    yield* seedActor(projectId, closed);
    const closedError = yield* sendTo(closed.threadId, "reject:closed").pipe(Effect.flip);
    assert.equal(errorReason(closedError), "closed_citizen");

    const lowSender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:low-sender"),
      runId: RunId.make("run:mail:reject:low-sender"),
      runtimeMode: "approval-required",
      interactionMode: "plan",
    };
    const highTarget: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:high-target"),
      runId: RunId.make("run:mail:reject:high-target"),
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    yield* seedActor(projectId, lowSender);
    yield* seedActor(projectId, highTarget);
    const lowCaller = yield* service.authoritativeCaller(callerInput(projectId, lowSender));
    const ceilingError = yield* service
      .send({
        caller: lowCaller,
        targetThreadId: highTarget.threadId,
        clientRequestId: "reject:ceiling",
        body: "hello",
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(ceilingError), "forbidden");
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "enforces recipient pending capacity and sender per-minute quota before extra acceptance",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:limits");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:limits:from"),
        runId: RunId.make("run:mail:limits:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:limits:to"),
        runId: RunId.make("run:mail:limits:to"),
      };
      const other: ActorSeed = {
        threadId: ThreadId.make("thread:mail:limits:other"),
        runId: RunId.make("run:mail:limits:other"),
      };
      yield* seedProject(projectId);
      yield* enableFeature({ pendingPerRecipient: 1, senderPerMinute: 1, projectPerMinute: 10 });
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      yield* seedActor(projectId, other);
      const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      yield* service.send({
        caller,
        targetThreadId: recipient.threadId,
        clientRequestId: "limits:first",
        body: "one",
      });
      const pending = yield* service
        .send({
          caller,
          targetThreadId: recipient.threadId,
          clientRequestId: "limits:pending",
          body: "two",
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(pending), "CivilizationMailCapacityError");
      assert.equal(errorReason(pending), undefined);
      const quota = yield* service
        .send({
          caller,
          targetThreadId: other.threadId,
          clientRequestId: "limits:quota",
          body: "two",
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(quota), "CivilizationMailQuotaError");
      assert.equal((quota as { readonly scope?: string }).scope, "sender");
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("enforces retained project message capacity independently of pending delivery", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:retained-capacity");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:retained-capacity:from"),
      runId: RunId.make("run:mail:retained-capacity:from"),
    };
    const firstRecipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:retained-capacity:first"),
      runId: RunId.make("run:mail:retained-capacity:first"),
    };
    const secondRecipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:retained-capacity:second"),
      runId: RunId.make("run:mail:retained-capacity:second"),
    };
    yield* seedProject(projectId);
    yield* enableFeature({
      retainedMessageCount: 1,
      pendingPerRecipient: 10,
      senderPerMinute: 10,
      projectPerMinute: 10,
    });
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, firstRecipient);
    yield* seedActor(projectId, secondRecipient);
    const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));
    yield* service.send({
      caller,
      targetThreadId: firstRecipient.threadId,
      clientRequestId: "retained:first",
      body: "one",
    });
    const capacity = yield* service
      .send({
        caller,
        targetThreadId: secondRecipient.threadId,
        clientRequestId: "retained:second",
        body: "two",
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(capacity), "CivilizationMailCapacityError");
    assert.equal((capacity as { readonly scope?: string }).scope, "project_message_count");
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "keeps inbox metadata body-free; receive offers once, ack requires offer, and acked mail is explicit-read only",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:receive");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:receive:from"),
        runId: RunId.make("run:mail:receive:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:receive:to"),
        runId: RunId.make("run:mail:receive:to"),
      };
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
      const sent = yield* service.send({
        caller: senderCaller,
        targetThreadId: recipient.threadId,
        clientRequestId: "receive:send",
        body: "secret body",
      });
      const messageId = sent.message.messageId;

      const inbox = yield* service.listInbox({ caller: recipientCaller });
      assert.lengthOf(inbox.messages, 1);
      assert.isFalse("body" in inbox.messages[0]!);

      const earlyAck = yield* service
        .acknowledge({ caller: recipientCaller, messageId, clientRequestId: "receive:early-ack" })
        .pipe(Effect.flip);
      assert.equal(errorTag(earlyAck), "CivilizationMailInvalidError");

      const received = yield* service.receive({
        caller: recipientCaller,
        messageId,
        clientRequestId: "receive:one",
      });
      assert.equal(received.message.body, "secret body");
      assert.isNull(received.message.acknowledgedAt);
      const replay = yield* service.receive({
        caller: recipientCaller,
        messageId,
        clientRequestId: "receive:one",
      });
      assert.equal(replay.message.offerCount, 1);

      const ack = yield* service.acknowledge({
        caller: recipientCaller,
        messageId,
        clientRequestId: "receive:ack",
      });
      assert.isString(ack.acknowledgedAt);
      const explicitAfterAck = yield* service.receive({
        caller: recipientCaller,
        messageId,
        clientRequestId: "receive:after-ack",
      });
      assert.equal(explicitAfterAck.message.body, "secret body");
      assert.isNotNull(explicitAfterAck.message.acknowledgedAt);
      assert.deepEqual(
        yield* service.selectInboxForContext({
          caller: recipientCaller,
          limit: 10,
          selection: "recent",
        }),
        [],
      );
      assert.equal(
        (yield* sql<{
          readonly offer_count: number;
        }>`SELECT offer_count FROM civilization_messages WHERE message_id = ${messageId}`)[0]
          ?.offer_count,
        2,
      );
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect(
  "offers exactly the requested context messages and leaves other candidates untouched",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:context-offer");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:context-offer:from"),
        runId: RunId.make("run:mail:context-offer:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:context-offer:to"),
        runId: RunId.make("run:mail:context-offer:to"),
      };
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
      const first = yield* service.send({
        caller: senderCaller,
        targetThreadId: recipient.threadId,
        clientRequestId: "context:first",
        body: "first",
      });
      const second = yield* service.send({
        caller: senderCaller,
        targetThreadId: recipient.threadId,
        clientRequestId: "context:second",
        body: "second",
      });

      const offered = yield* service.offerInboxForContext({
        caller: recipientCaller,
        messageIds: [second.message.messageId, second.message.messageId],
      });
      assert.deepEqual(
        offered.messages.map((message) => message.messageId),
        [second.message.messageId],
      );
      assert.deepEqual(
        yield* sql<{ readonly message_id: string; readonly offer_count: number }>`
        SELECT message_id, offer_count FROM civilization_messages ORDER BY message_id ASC
      `,
        [
          { message_id: first.message.messageId, offer_count: 0 },
          { message_id: second.message.messageId, offer_count: 1 },
        ].sort((a, b) => a.message_id.localeCompare(b.message_id)),
      );
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("keeps reply references inside the current lifecycle epochs of both participants", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:reply-epoch");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reply-epoch:sender"),
      runId: RunId.make("run:mail:reply-epoch:sender"),
    };
    const recipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reply-epoch:recipient"),
      runId: RunId.make("run:mail:reply-epoch:recipient"),
    };
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, recipient);
    const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
    const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
    const first = yield* service.send({
      caller: senderCaller,
      targetThreadId: recipient.threadId,
      clientRequestId: "reply:first",
      body: "original correspondence",
    });

    const acceptedReply = yield* service.send({
      caller: recipientCaller,
      targetThreadId: sender.threadId,
      clientRequestId: "reply:accepted",
      body: "current-epoch reply",
      replyToMessageId: first.message.messageId,
    });
    assert.equal(acceptedReply.message.replyToMessageId, first.message.messageId);

    // Model a close/reopen generation without changing the recipient's own
    // epoch. Historical correspondence must not become a reply bridge into the
    // sender's new lifecycle generation.
    yield* sql`
      UPDATE civilization_citizens
      SET epoch = epoch + 1, delivery_epoch = delivery_epoch + 1
      WHERE project_id = ${projectId} AND thread_id = ${sender.threadId}
    `;
    const staleReply = yield* service
      .send({
        caller: recipientCaller,
        targetThreadId: sender.threadId,
        clientRequestId: "reply:stale",
        body: "must not cross the sender lifecycle boundary",
        replyToMessageId: first.message.messageId,
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(staleReply), "CivilizationMailInvalidError");
    assert.equal(errorReason(staleReply), "invalid_reply");
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "bounds inbox and administrative metadata pages by the configured response byte limit",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:response-budget");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:response-budget:sender"),
        runId: RunId.make("run:mail:response-budget:sender"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:response-budget:recipient"),
        runId: RunId.make("run:mail:response-budget:recipient"),
      };
      yield* seedProject(projectId);
      yield* enableFeature({ responseBodyBytes: 1 });
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
      yield* service.send({
        caller: senderCaller,
        targetThreadId: recipient.threadId,
        clientRequestId: "response-budget:send",
        body: "body remains separate from metadata",
      });

      const inboxError = yield* service.listInbox({ caller: recipientCaller }).pipe(Effect.flip);
      assert.equal(errorTag(inboxError), "CivilizationMailInvalidError");
      assert.equal(errorReason(inboxError), "response_too_large");
      const adminError = yield* service.listAdminMail({ projectId }).pipe(Effect.flip);
      assert.equal(errorTag(adminError), "CivilizationMailInvalidError");
      assert.equal(errorReason(adminError), "response_too_large");
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("expires zero-TTL mail and later cleans retained message plus expired receipt", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:cleanup");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:cleanup:from"),
      runId: RunId.make("run:mail:cleanup:from"),
    };
    const recipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:cleanup:to"),
      runId: RunId.make("run:mail:cleanup:to"),
    };
    yield* seedProject(projectId);
    yield* enableFeature({
      unreadTtlDays: 0,
      terminalRetentionDays: 30,
      operationReceiptRetentionDays: 30,
    });
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, recipient);
    const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));
    yield* service.send({
      caller,
      targetThreadId: recipient.threadId,
      clientRequestId: "cleanup:send",
      body: "ephemeral",
    });

    const expiry = yield* service.cleanupProject(projectId);
    assert.equal(expiry.expired, 1);
    assert.equal(expiry.deletedMessages, 0);
    assert.equal(expiry.deletedReceipts, 0);
    yield* sql`
      UPDATE civilization_messages
      SET terminal_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days')
      WHERE project_id = ${projectId}
    `;
    yield* sql`
      UPDATE civilization_mail_operation_receipts
      SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
      WHERE project_id = ${projectId}
    `;
    const cleanup = yield* service.cleanupProject(projectId);
    assert.equal(cleanup.deletedMessages, 1);
    assert.equal(cleanup.deletedReceipts, 1);
    assert.equal(
      (yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM civilization_messages`)[0]?.count,
      0,
    );
    assert.deepEqual(
      (yield* sql<{
        readonly retained_message_count: number;
        readonly retained_body_bytes: number;
      }>`
        SELECT retained_message_count, retained_body_bytes FROM civilization_project_state WHERE project_id = ${projectId}
      `)[0],
      { retained_message_count: 0, retained_body_bytes: 0 },
    );
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});
