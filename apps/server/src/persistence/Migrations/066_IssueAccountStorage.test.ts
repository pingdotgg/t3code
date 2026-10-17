import { assert, it } from "@effect/vitest";
import {
  CommandId,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  ThreadIssueLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import * as Bindings from "../IssueTrackerBindings.ts";
import * as Accounts from "../IssueTrackerAccounts.ts";
import * as Projection from "../../orchestration-v2/ProjectionStore.ts";
import * as Events from "../OrchestrationEventStore.ts";

const encodeLink = Schema.encodeUnknownEffect(ThreadIssueLink);
const decodeLink = Schema.decodeUnknownEffect(ThreadIssueLink);
const isKind = Schema.is(IssueTrackerKind);

const tracker = IssueTrackerKind.make("linear");
const projectId = ProjectId.make("project");
const now = "2026-10-15T00:00:00Z";
const threadFields = {
  projectId,
  title: "Thread",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "selected", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
};
const link = {
  projectId,
  tracker,
  host: "linear.app",
  scope: "acme/ENG",
  key: "ENG-7",
  url: "https://linear.app/acme/issue/ENG-7",
  source: "manual" as const,
  linkedAt: now,
  linkId: CommandId.make("generation-B"),
  snapshot: null,
};

it.effect(
  "upgrades selected binding and stored link identities without changing default bytes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* sql`INSERT INTO issue_tracker_accounts VALUES ('linear', 'Account', 'linear.app', 'native-B')`;
      yield* sql`INSERT INTO issue_tracker_bindings VALUES ('project', 'linear', 'acme/ENG', 'linear.app', 'Account', ${now})`;
      yield* sql`INSERT INTO issue_tracker_bindings VALUES ('default', 'linear', 'acme/ENG', 'linear.app', NULL, ${now})`;
      const selected = { ...link, connectionId: "Account" };
      const wrapped = yield* encodeLink({
        ...link,
        connectionId: "account",
      });
      const flat = JSON.stringify({
        ...threadFields,
        id: "selected",
        issues: [link, selected, wrapped],
        preserved: "original",
      });
      const defaultJson = JSON.stringify(
        { ...threadFields, id: "default", issues: [link], preserved: "default" },
        null,
        2,
      );
      for (const [id, payload] of [
        ["selected", flat],
        ["default", defaultJson],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${id}, 'project', 'Thread', 'codex', 'full-access', 'default', ${now}, ${now}, ${payload})`;
        yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES (${id}, 'thread', ${id}, 1, 'thread.issue-synced', ${now}, 'system', ${payload}, '{}', 2)`;
        yield* sql`INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json)
        VALUES (${id}, ${id}, 'thread.issue-synced', ${now}, ${payload})`;
      }
      yield* runMigrations();
      const rows = yield* sql<{
        tracker: string;
        native_tracker: string;
        connection_id: string | null;
      }>`
      SELECT tracker, native_tracker, connection_id FROM issue_tracker_bindings ORDER BY project_id`;
      assert.equal(rows[0]!.tracker, "linear");
      assert.equal(rows[1]!.native_tracker, "linear");
      assert.deepEqual(JSON.parse(rows[1]!.tracker), {
        tracker: "linear",
        connectionId: "Account",
      });
      assert.isFalse(isKind(rows[1]!.tracker));
      for (const table of [
        "orchestration_v2_projection_threads",
        "orchestration_events",
        "orchestration_v2_events",
      ] as const) {
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM ${sql(table)} ORDER BY ${sql(table === "orchestration_v2_projection_threads" ? "thread_id" : "event_id")}`;
        assert.equal(rows[0]!.payload_json, defaultJson);
        const document = JSON.parse(rows[1]!.payload_json);
        const links = document.issues;
        assert.deepEqual(links[0], link);
        assert.deepEqual(links[1].projectId, { value: projectId, connectionId: "Account" });
        assert.notProperty(links[1], "connectionId");
        assert.deepEqual(yield* decodeLink(links[1]), selected);
        assert.equal(links[1].linkId, "generation-B");
        assert.deepEqual(links[2], wrapped);
      }
      assert.deepEqual(yield* runMigrations(), []);
      const bindings = yield* Bindings.IssueTrackerBindingsRepository.pipe(
        Effect.provide(Bindings.layer),
      );
      assert.deepEqual((yield* bindings.list).get(projectId), [
        { tracker, host: "linear.app", scope: "acme/ENG", connectionId: "Account" },
      ]);
      const projection = yield* Projection.ProjectionStoreV2.pipe(Effect.provide(Projection.layer));
      const expected = [link, selected, { ...link, connectionId: "account" }];
      assert.deepEqual((yield* projection.getThread(ThreadId.make("selected"))).issues, expected);
      const events = yield* Events.OrchestrationEventStore.pipe(Effect.provide(Events.layer));
      const replay = yield* events
        .readAgentEvents({ afterSequence: 0, threadId: ThreadId.make("selected") })
        .pipe(Stream.runCollect);
      assert.deepEqual((replay[0]!.event.payload as { issues: unknown }).issues, expected);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps one logical tracker slot across default and exact-case account replacement", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      const accounts = yield* Accounts.IssueTrackerAccountsRepository;
      const bindings = yield* Bindings.IssueTrackerBindingsRepository;
      for (const connectionId of ["Account", "account"]) {
        yield* accounts.set({ tracker, connectionId, host: "linear.app", accountId: connectionId });
      }
      const jira = {
        tracker: IssueTrackerKind.make("jira"),
        scope: "OPS",
        host: "example.atlassian.net",
      };
      yield* bindings.set({ projectId, binding: jira, updatedAt: now });
      for (const connectionId of [undefined, "Account", "account", undefined, "Account"]) {
        const binding = {
          tracker,
          scope: "acme/ENG",
          host: "linear.app",
          ...(connectionId === undefined ? {} : { connectionId }),
        };
        yield* bindings.set({ projectId, binding, updatedAt: now });
        assert.deepEqual((yield* bindings.list).get(projectId), [jira, binding]);
        assert.equal(
          (yield* sql`SELECT * FROM issue_tracker_bindings WHERE project_id = 'project'`).length,
          2,
        );
      }
      yield* bindings.removeTracker(tracker);
      yield* accounts.remove(tracker, "account");
      assert.equal((yield* bindings.list).get(projectId)!.length, 2);
      yield* accounts.remove(tracker, "Account");
      assert.deepEqual((yield* bindings.list).get(projectId), [jira]);
      yield* bindings.set({ projectId, binding: { tracker, scope: "acme/ENG" }, updatedAt: now });
      yield* bindings.set({ projectId, tracker, binding: null, updatedAt: now });
      assert.deepEqual((yield* bindings.list).get(projectId), [jira]);
    }).pipe(Effect.provide(Layer.merge(Accounts.layer, Bindings.layer)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("refuses inconsistent selected tracker and account identities", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO issue_tracker_accounts VALUES ('linear', 'Account', 'linear.app', 'native-B')`;
    const bindings = yield* Bindings.IssueTrackerBindingsRepository.pipe(
      Effect.provide(Bindings.layer),
    );
    yield* bindings.set({
      projectId,
      binding: { tracker, scope: "acme/ENG", connectionId: "Account" },
      updatedAt: now,
    });
    for (const stored of [
      "linear",
      JSON.stringify({ tracker: "jira", connectionId: "Account" }),
      JSON.stringify({ tracker: "linear", connectionId: "account" }),
    ]) {
      yield* sql`UPDATE issue_tracker_bindings SET tracker=${stored} WHERE project_id=${projectId}`;
      assert.equal((yield* bindings.list.pipe(Effect.result))._tag, "Failure");
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
