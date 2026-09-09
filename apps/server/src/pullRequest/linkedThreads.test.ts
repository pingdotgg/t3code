import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { listLinkedPullRequestThreads } from "./linkedThreads.ts";

it.effect(
  "finds active and archived threads for exactly one pull request, excluding deleted and dismissed links",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-09-01T00:00:00.000Z";
      const archivedAt = "2026-09-03T00:00:00.000Z";
      yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project-1', 'Project', '/tmp/project', '[]', ${createdAt}, ${createdAt})
    `;
      const fixtures = [
        {
          id: "azure",
          host: "dev.azure.com",
          repository: "org/project/_git/web",
          number: 7,
          source: "manual",
        },
        {
          id: "other-org",
          host: "dev.azure.com",
          repository: "other/project/_git/web",
          number: 7,
          source: "manual",
        },
        { id: "active", host: "github.com", repository: "acme/web", number: 7, source: "manual" },
        {
          id: "archived",
          host: "github.com",
          repository: "acme/web",
          number: 7,
          source: "created",
        },
        { id: "deleted", host: "github.com", repository: "acme/web", number: 7, source: "manual" },
        {
          id: "dismissed",
          host: "github.com",
          repository: "acme/web",
          number: 7,
          source: "stack-dismissed",
        },
        {
          id: "other-host",
          host: "github.example.com",
          repository: "acme/web",
          number: 7,
          source: "manual",
        },
        {
          id: "other-repository",
          host: "github.com",
          repository: "acme/api",
          number: 7,
          source: "manual",
        },
        {
          id: "other-number",
          host: "github.com",
          repository: "acme/web",
          number: 8,
          source: "manual",
        },
      ];
      for (const fixture of fixtures) {
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          ${fixture.id}, 'project-1', ${fixture.id}, '{"instanceId":"codex","model":"gpt-5.4"}',
          ${createdAt}, ${fixture.id === "archived" ? archivedAt : createdAt},
          ${fixture.id === "archived" ? archivedAt : null},
          ${fixture.id === "deleted" ? archivedAt : null}
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_pull_requests (thread_id, host, repository, number, url, source, linked_at)
        VALUES (${fixture.id}, ${fixture.host}, ${fixture.repository}, ${fixture.number},
          'https://github.com/acme/web/pull/7', ${fixture.source}, ${createdAt})
      `;
      }

      expect(
        (yield* listLinkedPullRequestThreads({
          host: "org.visualstudio.com",
          repository: "project/_git/web",
          number: 7,
        })).threads.map((thread) => thread.id),
      ).toEqual(["azure"]);
      const result = yield* listLinkedPullRequestThreads({
        host: "GitHub.Com",
        repository: "ACME/WEB",
        number: 7,
      });
      expect(result).toEqual({
        threads: [
          { id: "archived", projectId: "project-1", title: "archived", archivedAt },
          { id: "active", projectId: "project-1", title: "active", archivedAt: null },
        ],
      });
      assert.deepStrictEqual(
        yield* listLinkedPullRequestThreads({
          host: "github.com",
          repository: "acme/web",
          number: 99,
        }),
        { threads: [] },
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
