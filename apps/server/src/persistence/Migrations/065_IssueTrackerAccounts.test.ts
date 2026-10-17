import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { IssueTrackerKind, ProjectId } from "@t3tools/contracts";

import { runMigrations } from "../Migrations.ts";
import * as IssueTrackerBindings from "../IssueTrackerBindings.ts";
import * as IssueTrackerAccounts from "../IssueTrackerAccounts.ts";
import * as Layer from "effect/Layer";

it.effect("preserves old rows and keeps one native binding per tracker on the same project", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 63 });
    yield* sql`INSERT INTO issue_tracker_bindings (project_id, tracker, scope, updated_at)
      VALUES ('project', 'linear', 'acme/ENG', '2026-10-14T00:00:00Z')`;
    yield* runMigrations();
    yield* Effect.gen(function* () {
      const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository;
      const projectId = ProjectId.make("project");
      const linear = { tracker: IssueTrackerKind.make("linear"), scope: "acme/ENG" };
      const jira = {
        tracker: IssueTrackerKind.make("jira"),
        scope: "OPS",
        host: "example.atlassian.net",
      };
      const updatedAt = "2026-10-15T00:00:00Z";
      yield* bindings.set({ projectId, binding: jira, updatedAt });
      assert.deepEqual((yield* bindings.list).get(projectId), [jira, linear]);
      yield* bindings.set({ projectId, tracker: linear.tracker, binding: null, updatedAt });
      assert.deepEqual((yield* bindings.list).get(projectId), [jira]);
      yield* runMigrations();
      assert.deepEqual((yield* bindings.list).get(projectId), [jira]);
    }).pipe(Effect.provide(IssueTrackerBindings.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps other accounts and tracker bindings when one account is disconnected", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* Effect.gen(function* () {
      const accounts = yield* IssueTrackerAccounts.IssueTrackerAccountsRepository;
      const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository;
      const tracker = IssueTrackerKind.make("linear");
      const updatedAt = "2026-10-15T00:00:00Z";
      for (const connectionId of ["account-a", "account-b"]) {
        yield* accounts.set({ tracker, connectionId, host: "linear.app", accountId: connectionId });
        yield* bindings.set({
          projectId: ProjectId.make(connectionId),
          binding: { tracker, connectionId, scope: "ENG", host: "linear.app" },
          updatedAt,
        });
      }
      const jira = {
        tracker: IssueTrackerKind.make("jira"),
        scope: "OPS",
        host: "example.atlassian.net",
      };
      yield* bindings.set({ projectId: ProjectId.make("account-a"), binding: jira, updatedAt });
      yield* bindings.removeTracker(tracker);
      assert.equal((yield* bindings.list).size, 2);
      yield* bindings.removeTracker(tracker, "account-a");
      yield* accounts.remove(tracker, "account-a");
      assert.deepEqual(
        (yield* accounts.list).map((account) => account.connectionId),
        ["account-b"],
      );
      const remaining = yield* bindings.list;
      assert.deepEqual(remaining.get(ProjectId.make("account-a")), [jira]);
      assert.deepEqual(remaining.get(ProjectId.make("account-b")), [
        { tracker, connectionId: "account-b", scope: "ENG", host: "linear.app" },
      ]);
    }).pipe(Effect.provide(Layer.merge(IssueTrackerAccounts.layer, IssueTrackerBindings.layer)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
