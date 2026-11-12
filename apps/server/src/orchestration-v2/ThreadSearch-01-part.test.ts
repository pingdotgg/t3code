import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

const layerTest = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: {
    readonly archivedAt?: DateTime.Utc;
    readonly deletedAt?: DateTime.Utc;
    readonly subagentOf?: ThreadId;
    readonly sideChatOf?: ThreadId;
    readonly title?: string;
    readonly settledAt?: DateTime.Utc;
    readonly linkedPullRequest?: ThreadLinkedPullRequest;
    readonly branchPullRequest?: ThreadLinkedPullRequest;
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: overrides.title ?? threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: overrides.linkedPullRequest ?? null,
    branchPullRequest: overrides.branchPullRequest ?? null,
    activeProviderThreadId: null,
    lineage: overrides.subagentOf
      ? {
          parentThreadId: overrides.subagentOf,
          relationshipToParent: "subagent",
          rootThreadId: overrides.subagentOf,
        }
      : overrides.sideChatOf
        ? {
            parentThreadId: overrides.sideChatOf,
            relationshipToParent: "fork",
            rootThreadId: overrides.sideChatOf,
            sideChat: true,
          }
        : { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: overrides.settledAt === undefined ? null : "settled",
    settledAt: overrides.settledAt ?? null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: {
    readonly minute?: number;
    readonly streaming?: boolean;
    readonly createdBy?: "user" | "agent";
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: options.createdBy ?? (role === "user" ? "user" : "agent"),
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});












it.effect.each([true, false])(
  "ThreadSearch excludes bootstrap text before the hit and candidate limits (indexed: %s)",
  (indexed) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:attachments");
      const threadId = ThreadId.make("thread:attachments");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(threadId, project),
          message(threadId, "ordinary", "user", "Review the attached files in context", {
            minute: 1,
          }),
          message(threadId, "attachment", "user", ATTACHMENT_ONLY_BOOTSTRAP_PROMPT, { minute: 2 }),
          message(
            threadId,
            "ultrathink",
            "user",
            `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
            { minute: 3 },
          ),
        ],
        projections.apply,
        { discard: true },
      );
      if (!indexed) {
        yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
        yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
        yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
        yield* sql`DROP TABLE orchestration_v2_message_search`;
      }
      assert.deepEqual((yield* search.search({ query: "conversation context" })).matches, []);
      assert.deepEqual((yield* search.search({ query: "ultrathink" })).matches, []);
      assert.deepEqual(
        (yield* search.search({ query: "attached files" })).matches.map((match) => [
          match.messageId,
          match.snippet,
        ]),
        [[MessageId.make("ordinary"), "Review the attached files in context"]],
      );
      for (const text of [
        ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
        `uLtRaThInK:\r\n\t\u00a0${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
      ]) {
        yield* sql`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${indexed ? 10_000 : 2000})
          INSERT INTO orchestration_v2_projection_messages
            (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
          SELECT 'attachment-limit:' || i, ${threadId}, 'user', 0,
            ${DateTime.formatIso(at(5))}, ${DateTime.formatIso(at(5))}, json_object('text', ${text})
          FROM n
        `;
        assert.deepEqual(
          (yield* search.search({ query: "context" })).matches.map((match) => match.messageId),
          [MessageId.make("ordinary")],
        );
        yield* sql`
          DELETE FROM orchestration_v2_projection_messages WHERE message_id LIKE 'attachment-limit:%'
        `;
      }
    }).pipe(Effect.provide(layerTest)),
);

