import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as MailService from "./MailService.ts";
import { civilizationPersistenceParticipant } from "./PersistenceParticipant.ts";

const providerInstanceId = ProviderInstanceId.make("codex-main");
const modelSelection = { instanceId: providerInstanceId, model: "civilization-phase3-atomicity" };

const providerLayer = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: (instanceId) =>
      instanceId === providerInstanceId
        ? Effect.succeed({
            instanceId,
            driver: "codex",
            openSession: () => Effect.die("atomicity tests must not open provider sessions"),
            getCapabilities: () => Effect.die("atomicity tests must not call providers"),
          } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
        : Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          ),
    list: () => Effect.succeed([providerInstanceId]),
  }),
);

const makeLayer = () => {
  const database = SqlitePersistence.layerMemory;
  const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
  const participants = Layer.succeed(EventSink.EventSinkPersistenceParticipants, [
    civilizationPersistenceParticipant,
  ]);
  const sink = EventSink.layer.pipe(
    Layer.provide(Layer.mergeAll(stores, database)),
    Layer.provide(participants),
  );
  const config = ConfigService.layer.pipe(Layer.provide(database));
  const mailDependencies = Layer.mergeAll(database, config, providerLayer);
  const mail = MailService.layer.pipe(Layer.provide(mailDependencies));
  return Layer.mergeAll(database, stores, sink, config, providerLayer, mail);
};

function makeThread(
  id: ThreadId,
  projectId: ProjectId,
  at: DateTime.Utc,
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: `Thread ${id}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const enableFeature = Effect.fn("CivilizationMailAtomicity.enableFeature")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      messaging: {
        enabled: true,
        senderPerMinute: 60,
        projectPerMinute: 60,
        pendingPerRecipient: 100,
      },
    },
  });
});

const disableFeature = Effect.fn("CivilizationMailAtomicity.disableFeature")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 1,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: false },
      messaging: { enabled: true },
    },
  });
});

const seedProject = Effect.fn("CivilizationMailAtomicity.seedProject")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${projectId}, '/tmp/civilization-mail-atomicity', '[]',
      '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z', NULL
    )
  `;
});

const seedRun = Effect.fn("CivilizationMailAtomicity.seedRun")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
      status, requested_at, completed_at, payload_json
    ) VALUES (
      ${runId}, ${threadId}, 1, ${providerInstanceId}, ${providerInstanceId}, NULL,
      'running', '2026-10-16T10:00:00.000Z', NULL, '{}'
    )
  `;
});

type Fixture = {
  readonly projectId: ProjectId;
  readonly sender: OrchestrationV2AppThread;
  readonly recipient: OrchestrationV2AppThread;
  readonly senderRunId: RunId;
  readonly recipientRunId: RunId;
  readonly senderCaller: MailService.CivilizationMailCaller;
  readonly recipientCaller: MailService.CivilizationMailCaller;
};

const makeFixture = Effect.fn("CivilizationMailAtomicity.fixture")(function* (label: string) {
  const sink = yield* EventSink.EventSinkV2;
  const mail = yield* MailService.CivilizationMailService;
  const now = yield* DateTime.now;
  const projectId = ProjectId.make(`project:mail:atomicity:${label}`);
  const sender = makeThread(ThreadId.make(`thread:mail:atomicity:${label}:sender`), projectId, now);
  const recipient = makeThread(
    ThreadId.make(`thread:mail:atomicity:${label}:recipient`),
    projectId,
    now,
  );
  const senderRunId = RunId.make(`run:mail:atomicity:${label}:sender`);
  const recipientRunId = RunId.make(`run:mail:atomicity:${label}:recipient`);

  yield* seedProject(projectId);
  yield* enableFeature();
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:mail:atomicity:${label}:sender-created`),
        type: "thread.created",
        threadId: sender.id,
        occurredAt: now,
        payload: sender,
      },
      {
        id: EventId.make(`event:mail:atomicity:${label}:recipient-created`),
        type: "thread.created",
        threadId: recipient.id,
        occurredAt: now,
        payload: recipient,
      },
    ],
  });
  yield* seedRun(sender.id, senderRunId);
  yield* seedRun(recipient.id, recipientRunId);
  const senderCaller = yield* mail.authoritativeCaller({
    threadId: sender.id,
    projectId,
    runId: senderRunId,
    providerInstanceId,
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  const recipientCaller = yield* mail.authoritativeCaller({
    threadId: recipient.id,
    projectId,
    runId: recipientRunId,
    providerInstanceId,
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  return {
    projectId,
    sender,
    recipient,
    senderRunId,
    recipientRunId,
    senderCaller,
    recipientCaller,
  } satisfies Fixture;
});

type ClosingKind = "settled" | "archived" | "deleted";

const closeRecipient = Effect.fn("CivilizationMailAtomicity.closeRecipient")(function* (
  fixture: Fixture,
  kind: ClosingKind,
  suffix: string,
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const next: OrchestrationV2AppThread =
    kind === "settled"
      ? { ...fixture.recipient, settledOverride: "settled", settledAt: now, updatedAt: now }
      : kind === "archived"
        ? { ...fixture.recipient, archivedAt: now, updatedAt: now }
        : { ...fixture.recipient, deletedAt: now, updatedAt: now };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:mail:atomicity:${suffix}:${kind}`),
        type: `thread.${kind}` as "thread.settled" | "thread.archived" | "thread.deleted",
        threadId: fixture.recipient.id,
        occurredAt: now,
        payload: next,
      },
    ],
  });
});

const closeSender = Effect.fn("CivilizationMailAtomicity.closeSender")(function* (
  fixture: Fixture,
  suffix: string,
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:mail:atomicity:${suffix}:sender-settled`),
        type: "thread.settled",
        threadId: fixture.sender.id,
        occurredAt: now,
        payload: { ...fixture.sender, settledOverride: "settled", settledAt: now, updatedAt: now },
      },
    ],
  });
});

const writeCounts = Effect.fn("CivilizationMailAtomicity.writeCounts")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  const messages =
    (yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM civilization_messages WHERE project_id = ${projectId}
  `)[0]?.count ?? 0;
  const receipts =
    (yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM civilization_mail_operation_receipts WHERE project_id = ${projectId}
  `)[0]?.count ?? 0;
  const quota = (yield* sql<{ readonly count: number; readonly accepted: number }>`
    SELECT COUNT(*) AS count, COALESCE(SUM(accepted_count), 0) AS accepted
    FROM civilization_mail_quota_windows WHERE project_id = ${projectId}
  `)[0] ?? { count: 0, accepted: 0 };
  return { messages, receipts, quotaRows: quota.count, quotaAccepted: quota.accepted } as const;
});

const readMessageLifecycle = Effect.fn("CivilizationMailAtomicity.readMessageLifecycle")(function* (
  messageId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    readonly offer_count: number;
    readonly terminal_at: string | null;
    readonly terminal_reason: string | null;
  }>`
    SELECT offer_count, terminal_at, terminal_reason
    FROM civilization_messages WHERE message_id = ${messageId} LIMIT 1
  `)[0];
});

const failureTag = (error: unknown) => (error as { readonly _tag?: string })._tag;

const closingCases = ["settled", "archived", "deleted"] as const;

it.effect.each(closingCases)(
  "%s first rejects send with no split mail/quota/receipt state",
  (kind) =>
    Effect.gen(function* () {
      const mail = yield* MailService.CivilizationMailService;
      const fixture = yield* makeFixture(`${kind}-first`);
      yield* closeRecipient(fixture, kind, `${kind}-first`);

      const failure = yield* mail
        .send({
          caller: fixture.senderCaller,
          targetThreadId: fixture.recipient.id,
          clientRequestId: `${kind}-first:send`,
          body: "must not commit",
        })
        .pipe(Effect.flip);
      assert.equal(failureTag(failure), "CivilizationAgentAccessError");
      assert.deepEqual(yield* writeCounts(fixture.projectId), {
        messages: 0,
        receipts: 0,
        quotaRows: 0,
        quotaAccepted: 0,
      });
    }).pipe(Effect.provide(Layer.fresh(makeLayer()))),
);

it.effect.each(closingCases)(
  "send first commits, then %s terminalizes the pending message",
  (kind) =>
    Effect.gen(function* () {
      const mail = yield* MailService.CivilizationMailService;
      const fixture = yield* makeFixture(`send-first-${kind}`);
      const sent = yield* mail.send({
        caller: fixture.senderCaller,
        targetThreadId: fixture.recipient.id,
        clientRequestId: `send-first-${kind}:send`,
        body: "accepted before recipient closes",
      });
      assert.deepEqual(yield* writeCounts(fixture.projectId), {
        messages: 1,
        receipts: 1,
        quotaRows: 2,
        quotaAccepted: 2,
      });

      yield* closeRecipient(fixture, kind, `send-first-${kind}`);
      const closed = yield* readMessageLifecycle(sent.message.messageId);
      assert.equal(closed?.terminal_reason, `recipient_${kind}`);
      assert.isNotNull(closed?.terminal_at);

      yield* closeSender(fixture, `send-first-${kind}`);
      const afterSenderClosure = yield* readMessageLifecycle(sent.message.messageId);
      assert.equal(afterSenderClosure?.terminal_reason, `recipient_${kind}`);
      assert.equal(afterSenderClosure?.terminal_at, closed?.terminal_at);
    }).pipe(Effect.provide(Layer.fresh(makeLayer()))),
);

it.effect("config disable first rejects send without message, quota, or receipt", () =>
  Effect.gen(function* () {
    const mail = yield* MailService.CivilizationMailService;
    const fixture = yield* makeFixture("disable-first");
    yield* disableFeature();
    const failure = yield* mail
      .send({
        caller: fixture.senderCaller,
        targetThreadId: fixture.recipient.id,
        clientRequestId: "disable-first:send",
        body: "must not commit",
      })
      .pipe(Effect.flip);
    assert.equal(failureTag(failure), "CivilizationAgentAccessError");
    assert.deepEqual(yield* writeCounts(fixture.projectId), {
      messages: 0,
      receipts: 0,
      quotaRows: 0,
      quotaAccepted: 0,
    });
  }).pipe(Effect.provide(Layer.fresh(makeLayer()))),
);

it.effect(
  "send first survives config disable and later recipient closure still terminalizes it",
  () =>
    Effect.gen(function* () {
      const mail = yield* MailService.CivilizationMailService;
      const fixture = yield* makeFixture("disable-after-send");
      const sent = yield* mail.send({
        caller: fixture.senderCaller,
        targetThreadId: fixture.recipient.id,
        clientRequestId: "disable-after-send:send",
        body: "accepted before disable",
      });
      yield* disableFeature();
      assert.isNull((yield* readMessageLifecycle(sent.message.messageId))?.terminal_at);
      yield* closeRecipient(fixture, "settled", "disable-after-send");
      assert.equal(
        (yield* readMessageLifecycle(sent.message.messageId))?.terminal_reason,
        "recipient_settled",
      );
    }).pipe(Effect.provide(Layer.fresh(makeLayer()))),
);

it.effect(
  "offer first may release the body, then recipient closure terminalizes that pending mail",
  () =>
    Effect.gen(function* () {
      const mail = yield* MailService.CivilizationMailService;
      const fixture = yield* makeFixture("offer-first");
      const sent = yield* mail.send({
        caller: fixture.senderCaller,
        targetThreadId: fixture.recipient.id,
        clientRequestId: "offer-first:send",
        body: "body released before closure",
      });
      const offered = yield* mail.receive({
        caller: fixture.recipientCaller,
        messageId: sent.message.messageId,
        clientRequestId: "offer-first:receive",
      });
      assert.equal(offered.message.body, "body released before closure");
      assert.equal((yield* readMessageLifecycle(sent.message.messageId))?.offer_count, 1);

      yield* closeRecipient(fixture, "settled", "offer-first");
      const closed = yield* readMessageLifecycle(sent.message.messageId);
      assert.equal(closed?.offer_count, 1);
      assert.equal(closed?.terminal_reason, "recipient_settled");
    }).pipe(Effect.provide(Layer.fresh(makeLayer()))),
);

it.effect("recipient closure first prevents any new body offer", () =>
  Effect.gen(function* () {
    const mail = yield* MailService.CivilizationMailService;
    const fixture = yield* makeFixture("offer-close-first");
    const sent = yield* mail.send({
      caller: fixture.senderCaller,
      targetThreadId: fixture.recipient.id,
      clientRequestId: "offer-close-first:send",
      body: "never newly offered",
    });
    yield* closeRecipient(fixture, "settled", "offer-close-first");
    const before = yield* writeCounts(fixture.projectId);
    const failure = yield* mail
      .receive({
        caller: fixture.recipientCaller,
        messageId: sent.message.messageId,
        clientRequestId: "offer-close-first:receive",
      })
      .pipe(Effect.flip);
    assert.equal(failureTag(failure), "CivilizationAgentAccessError");
    assert.equal((yield* readMessageLifecycle(sent.message.messageId))?.offer_count, 0);
    assert.deepEqual(yield* writeCounts(fixture.projectId), before);
  }).pipe(Effect.provide(Layer.fresh(makeLayer()))),
);

class AtomicityParticipantFailure extends Schema.TaggedError<AtomicityParticipantFailure>()(
  "AtomicityParticipantFailure",
  {},
) {}

const failingParticipant: EventSink.EventSinkPersistenceParticipant = {
  name: "civilization-mail-atomicity-failure",
  apply: () => Effect.fail(new AtomicityParticipantFailure()),
};

it.effect(
  "a later participant failure rolls back host lifecycle and real mail terminalization together",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      const mail = yield* MailService.CivilizationMailService;
      const fixture = yield* makeFixture("participant-rollback");
      const sent = yield* mail.send({
        caller: fixture.senderCaller,
        targetThreadId: fixture.recipient.id,
        clientRequestId: "participant-rollback:send",
        body: "must remain pending when lifecycle transaction rolls back",
      });
      const now = yield* DateTime.now;
      const exit = yield* Effect.exit(
        sink.write({
          events: [
            {
              id: EventId.make("event:mail:atomicity:participant-rollback:settled"),
              type: "thread.settled",
              threadId: fixture.recipient.id,
              occurredAt: now,
              payload: {
                ...fixture.recipient,
                settledOverride: "settled",
                settledAt: now,
                updatedAt: now,
              },
            },
          ],
          participants: [failingParticipant],
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.isNull((yield* readMessageLifecycle(sent.message.messageId))?.terminal_at);
      const citizen = (yield* sql<{
        readonly closed: number;
        readonly delivery_epoch: number;
        readonly delivery_settled: number;
      }>`
      SELECT closed, delivery_epoch, delivery_settled
      FROM civilization_citizens WHERE thread_id = ${fixture.recipient.id}
    `)[0];
      assert.deepEqual(citizen, { closed: 0, delivery_epoch: 0, delivery_settled: 0 });
      const projected = yield* ProjectionStore.ProjectionStoreV2;
      assert.isNull((yield* projected.getThread(fixture.recipient.id)).settledAt);
    }).pipe(Effect.provide(Layer.fresh(makeLayer()))),
);
