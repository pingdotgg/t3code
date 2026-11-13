import {
  ProjectId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { listLinkedPullRequestThreads, makeLinkedThreadsChangeDetector } from "./linkedThreads.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "finds active, settled, and archived threads for exactly one pull request, excluding deleted, dismissed, and side chat links",
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
        { id: "settled", host: "github.com", repository: "acme/web", number: 7, source: "manual" },
        {
          id: "auto-settled",
          host: "github.com",
          repository: "acme/web",
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
          id: "side-chat",
          host: "github.com",
          repository: "acme/web",
          number: 7,
          source: "manual",
        },
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
          settledOverride: ["settled", "archived"].includes(fixture.id) ? "settled" : null,
          settledAt: fixture.id === "auto-settled" ? archivedAt : null,
          ...(fixture.id === "side-chat" ? { lineage: { sideChat: true } } : {}),
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
          { id: "archived", projectId: "project-1", title: "archived", archivedAt, settled: true },
          {
            id: "active",
            projectId: "project-1",
            title: "active",
            archivedAt: null,
            settled: false,
          },
          {
            id: "auto-settled",
            projectId: "project-1",
            title: "auto-settled",
            archivedAt: null,
            settled: true,
          },
          {
            id: "settled",
            projectId: "project-1",
            title: "settled",
            archivedAt: null,
            settled: true,
          },
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
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it("signals linked-thread changes only when a linked answer could change", () => {
  const now = DateTime.makeUnsafe("2026-11-12T00:00:00.000Z");
  const threadId = ThreadId.make("thread-a");
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "acme/web",
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    source: "agent",
    linkedAt: "2026-11-12T00:00:00.000Z",
    snapshot: null,
    stack: null,
  };
  const base = {
    id: threadId,
    projectId: ProjectId.make("project-a"),
    title: "Thread A",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: now,
  } as unknown as OrchestrationV2AppThread;
  const event = (
    type: OrchestrationV2DomainEvent["type"],
    payload: Partial<OrchestrationV2AppThread>,
  ) => ({ type, threadId, payload: { ...base, ...payload } }) as OrchestrationV2DomainEvent;
  const changed = makeLinkedThreadsChangeDetector();

  expect(
    [
      event("thread.metadata-updated", { title: "Unlinked rename" }),
      event("thread.pull-request-synced", { pullRequests: [link] }),
      event("thread.pull-request-synced", {
        pullRequests: [{ ...link, watch: { since: "2026-11-12T00:00:00.000Z" } as never }],
      }),
      event("thread.visited", { pullRequests: [link] }),
      event("thread.pinned", { pullRequests: [link], settledAt: now }),
      { type: "thread.pull-request-link-updated", threadId, payload: link } as never,
      event("thread.metadata-updated", { pullRequests: [link], title: "Renamed" }),
      event("thread.archived", { pullRequests: [link], title: "Renamed", archivedAt: now }),
      event("thread.pull-request-synced", {
        pullRequests: [{ ...link, source: "stack-dismissed" }],
        title: "Renamed",
        archivedAt: now,
      }),
      event("thread.deleted", { pullRequests: [], deletedAt: now }),
    ].map(changed),
  ).toEqual([
    "changed",
    "changed",
    null,
    null,
    "changed",
    null,
    "changed",
    "changed",
    "changed",
    null,
  ]);

  const afterRestart = makeLinkedThreadsChangeDetector();
  expect(afterRestart(event("thread.created", { title: "New" }))).toBe(null);
  expect(
    makeLinkedThreadsChangeDetector()(
      event("thread.deleted", { pullRequests: [], deletedAt: now }),
    ),
  ).toBe("changed");
});

it("signals when activity reorders the threads linked to a pull request", () => {
  const at = (second: number) => DateTime.makeUnsafe(`2026-11-12T00:00:0${second}.000Z`);
  const link = {
    host: "github.com",
    repository: "acme/web",
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    source: "agent",
  };
  const thread = (id: string, second: number, pullRequests: ReadonlyArray<unknown> = [link]) =>
    ({
      type: "thread.pull-request-synced",
      threadId: ThreadId.make(id),
      payload: {
        id: ThreadId.make(id),
        projectId: ProjectId.make("project-a"),
        title: id,
        lineage: { rootThreadId: ThreadId.make(id) },
        pullRequests,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        updatedAt: at(second),
      },
    }) as unknown as OrchestrationV2DomainEvent;
  const activity = (id: string, second: number) =>
    ({
      type: "message.updated",
      threadId: ThreadId.make(id),
      occurredAt: at(second),
    }) as unknown as OrchestrationV2DomainEvent;
  const changed = makeLinkedThreadsChangeDetector();
  changed(thread("a", 1));
  changed(thread("b", 2));

  expect(
    [
      { ...thread("a", 3), type: "thread.pinned" } as OrchestrationV2DomainEvent,
      activity("a", 4),
      activity("b", 5),
      activity("b", 5),
      // Seen since startup without links, so its activity can't reorder an answer.
      thread("unlinked", 5, []),
      activity("unlinked", 6),
      // Not seen since startup, so it may be linked from before the restart.
      activity("persisted", 6),
    ].map(changed),
  ).toEqual(["reordered", "reordered", "reordered", null, "changed", null, "reordered"]);

  // Other threads linked to the pull request may have had no event since the restart.
  const afterRestart = makeLinkedThreadsChangeDetector();
  afterRestart(thread("a", 2));
  expect(
    afterRestart({ ...thread("a", 6), type: "thread.pinned" } as OrchestrationV2DomainEvent),
  ).toBe("reordered");
});
