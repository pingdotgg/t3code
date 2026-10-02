import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { listLinkedPullRequestThreads } from "./linkedThreads.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "finds active and archived threads for exactly one pull request, excluding deleted and dismissed links",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-09-01T00:00:00.000Z";
      const archivedAt = "2026-09-03T00:00:00.000Z";
      const fixtures = [
        {
          id: "forgejo-old",
          host: "forge.example",
          repository: "acme/web",
          number: 7,
          source: "manual",
          url: "http://forge.example:3000/acme/web/pulls/7",
        },
        {
          id: "forgejo-other-port",
          host: "forge.example:4000",
          repository: "acme/web",
          number: 7,
          source: "manual",
          url: "http://forge.example:4000/acme/web/pulls/7",
        },
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
        const payload = yield* encodePayload({
          linkedPullRequest: null,
          pullRequests: [{ ...fixture, linkedAt: createdAt, snapshot: null, stack: null }],
        });
        yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${fixture.id}, 'project-1', ${fixture.id}, 'codex', 'full-access', 'default',
          ${createdAt}, ${fixture.id === "archived" ? archivedAt : createdAt},
          ${fixture.id === "archived" ? archivedAt : null},
          ${fixture.id === "deleted" ? archivedAt : null}, ${payload}
        )
      `;
      }
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (
          'legacy-single', 'project-1', 'legacy-single', 'codex', 'full-access', 'default',
          ${createdAt}, ${createdAt},
          '{"linkedPullRequest":{"projectId":"project-1","repository":"acme/web","number":7,"url":"https://github.com/acme/web/pull/7"}}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (
          'explicitly-unlinked', 'project-1', 'explicitly-unlinked', 'codex', 'full-access', 'default',
          ${createdAt}, ${createdAt},
          '{"linkedPullRequest":{"projectId":"project-1","repository":"acme/web","number":7,"url":"https://github.com/acme/web/pull/7"},"pullRequests":[]}'
        )
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-1', 'Project', '/tmp/project', '[]', ${createdAt}, ${createdAt})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES ('v1-only', 'project-1', 'v1-only',
          '{"instanceId":"codex","model":"gpt-5.4"}', ${createdAt}, ${createdAt})
      `;
      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at
        ) VALUES ('v1-only', 'github.com', 'acme/web', 7,
          'https://github.com/acme/web/pull/7', 'manual', ${createdAt})
      `;

      expect(
        (yield* listLinkedPullRequestThreads({
          host: "forge.example:3000",
          repository: "acme/web",
          number: 7,
        })).threads.map((thread) => thread.id),
      ).toEqual(["forgejo-old"]);
      expect(
        (yield* listLinkedPullRequestThreads({
          host: "forge.example:4000",
          repository: "acme/web",
          number: 7,
        })).threads.map((thread) => thread.id),
      ).toEqual(["forgejo-other-port"]);
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
          { id: "legacy-single", projectId: "project-1", title: "legacy-single", archivedAt: null },
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
