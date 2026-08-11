import {
  AgentProfileId,
  AgentProfileRef,
  AgentProfileRevision,
  AgentRunId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import type { AgentRunCommand } from "./AgentRun.ts";
import { AgentRunRepository, layer } from "./AgentRunRepository.ts";

const testLayer = it.layer(Layer.provideMerge(layer, NodeSqliteClient.layerMemory()));

const at = "2026-08-07T12:00:00.000Z";
const later = "2026-08-07T12:01:00.000Z";
const profile = AgentProfileRef.make({
  id: AgentProfileId.make("reviewer"),
  scope: "environment",
  revision: AgentProfileRevision.make("a".repeat(64)),
});
const budget = {
  maxRuns: 4,
  maxConcurrency: 2,
  maxDepth: 2,
  maxWallTimeMinutes: 10,
  maxTotalTokens: 100,
};
const launch = {
  parentThreadId: ThreadId.make("owning-thread"),
  projectId: ProjectId.make("project"),
  modelSelection: ModelSelection.make({
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  }),
  instanceId: ProviderInstanceId.make("codex"),
  workspaceMode: "isolated-worktree" as const,
};
const id = (value: string) => AgentRunId.make(value);
const thread = (value: string) => ThreadId.make(value);
type RequestCommand = Extract<AgentRunCommand, { readonly type: "agent-run.request" }>;
const request = (
  runId: string,
  parentRunId: string | null = null,
  launchSnapshot = launch,
): RequestCommand => ({
  type: "agent-run.request",
  runId: id(runId),
  profile,
  budget,
  parentRunId: parentRunId === null ? null : id(parentRunId),
  detached: false,
  ...launchSnapshot,
  occurredAt: at,
});

testLayer("AgentRunRepository", (it) => {
  it.effect("appends events and projects the immutable launch snapshot atomically", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 41 });
      const repository = yield* Effect.service(AgentRunRepository);
      const sql = yield* SqlClient.SqlClient;

      const requested = yield* repository.dispatch(request("root"));
      assert.equal(requested.length, 1);
      assert.equal(requested[0]?.type, "agent-run.requested");

      const row = yield* sql<{
        readonly revision: number;
        readonly childThreadId: string | null;
        readonly profileRevision: string;
        readonly providerInstanceId: string;
        readonly workspaceMode: string;
      }>`
        SELECT revision, child_thread_id AS "childThreadId", profile_revision AS "profileRevision",
          provider_instance_id AS "providerInstanceId", workspace_mode AS "workspaceMode"
        FROM projection_agent_runs WHERE agent_run_id = ${id("root")}
      `;
      assert.deepEqual(row, [
        {
          revision: 0,
          childThreadId: null,
          profileRevision: profile.revision,
          providerInstanceId: "codex",
          workspaceMode: "isolated-worktree",
        },
      ]);
      const eventCount = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM agent_run_events WHERE agent_run_id = ${id("root")}
      `;
      assert.equal(eventCount[0]?.count, 1);

      const run = yield* repository.get(id("root"));
      assert.isTrue(Option.isSome(run));
      if (Option.isSome(run)) {
        assert.equal(run.value.parentThreadId, launch.parentThreadId);
        assert.equal(run.value.childThreadId, null);
        assert.deepEqual(run.value.modelSelection, launch.modelSelection);
      }

      yield* repository.dispatch({
        type: "agent-run.assign-child-thread",
        runId: id("root"),
        childThreadId: thread("root-child"),
        occurredAt: later,
      });
      yield* repository.dispatch({
        type: "agent-run.start",
        runId: id("root"),
        occurredAt: later,
      });
      yield* repository.dispatch({
        type: "agent-run.bind-turn",
        runId: id("root"),
        turnId: TurnId.make("provider-turn-1"),
        occurredAt: later,
      });
      const activeTurn = yield* sql<{ readonly activeTurnId: string | null }>`
        SELECT active_turn_id AS "activeTurnId"
        FROM projection_agent_runs WHERE agent_run_id = ${id("root")}
      `;
      assert.deepEqual(activeTurn, [{ activeTurnId: "provider-turn-1" }]);
    }),
  );

  it.effect("replays durable events for parent-thread and lineage queries", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 41 });
      const repository = yield* Effect.service(AgentRunRepository);
      const lineageLaunch = { ...launch, parentThreadId: thread("lineage-owning-thread") };
      yield* repository.dispatch(request("lineage-root", null, lineageLaunch));
      yield* repository.dispatch({
        type: "agent-run.assign-child-thread",
        runId: id("lineage-root"),
        childThreadId: thread("lineage-child-thread"),
        occurredAt: at,
      });
      yield* repository.dispatch({
        type: "agent-run.start",
        runId: id("lineage-root"),
        occurredAt: later,
      });
      yield* repository.dispatch({
        ...request("lineage-child", "lineage-root", lineageLaunch),
        occurredAt: "2026-08-07T12:09:00.000Z",
      });

      const byThread = yield* repository.listByParentThread(lineageLaunch.parentThreadId);
      assert.deepEqual(
        byThread.map((run) => run.id),
        [id("lineage-root"), id("lineage-child")],
      );
      const lineage = yield* repository.listByLineage(id("lineage-root"));
      assert.deepEqual(
        lineage.map((run) => [run.id, run.rootRunId, run.depth]),
        [
          [id("lineage-root"), id("lineage-root"), 0],
          [id("lineage-child"), id("lineage-root"), 1],
        ],
      );
      assert.equal(lineage[0]?.status, "waiting-for-input");
      assert.equal(lineage[1]?.requestedAt, "2026-08-07T12:09:00.000Z");
      assert.equal(lineage[1]?.wallTimeOriginAt, at);

      const child = yield* repository.get(id("lineage-child"));
      assert.isTrue(Option.isSome(child));
      if (Option.isSome(child)) {
        assert.equal(child.value.requestedAt, "2026-08-07T12:09:00.000Z");
        assert.equal(child.value.wallTimeOriginAt, at);
      }
    }),
  );

  it.effect("does not replay unrelated run histories while dispatching", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 41 });
      const repository = yield* Effect.service(AgentRunRepository);
      const sql = yield* SqlClient.SqlClient;

      // A corrupted/unreadable history belonging to another run must not
      // prevent an otherwise independent dispatch from making progress.
      yield* sql`
        INSERT INTO agent_run_events
          (agent_run_id, revision, event_type, occurred_at, payload_json)
        VALUES
          (${id("unrelated-run")}, 0, 'agent-run.corrupted', ${at}, '{"not":"an AgentRun event"}')
      `;

      const events = yield* repository.dispatch(request("isolated-target"));
      assert.equal(events[0]?.type, "agent-run.requested");
      const target = yield* repository.get(id("isolated-target"));
      assert.isTrue(Option.isSome(target));
    }),
  );

  it.effect(
    "returns already-advanced revisions without polling and leaves rejected commands unpersisted",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 41 });
        const repository = yield* Effect.service(AgentRunRepository);
        const sql = yield* SqlClient.SqlClient;
        yield* repository.dispatch(request("wait-root"));

        const advanced = yield* repository.waitForAdvance({
          runIds: [id("wait-root")],
          afterRevision: {},
        });
        assert.equal(advanced[0]?.revision, 0);

        yield* repository.dispatch({
          type: "agent-run.assign-child-thread",
          runId: id("wait-root"),
          childThreadId: thread("wait-child-thread"),
          occurredAt: at,
        });
        const rejected = yield* Effect.flip(
          repository.dispatch({
            type: "agent-run.assign-child-thread",
            runId: id("wait-root"),
            childThreadId: thread("second-child"),
            occurredAt: later,
          }),
        );
        assert.equal(rejected._tag, "AgentRunCommandInvariantError");
        const count = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM agent_run_events WHERE agent_run_id = ${id("wait-root")}
      `;
        assert.equal(count[0]?.count, 2);
      }),
  );
});
