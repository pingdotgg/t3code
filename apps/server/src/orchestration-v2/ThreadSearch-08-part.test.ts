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












it.layer(layerTest)("ThreadSearch.searchThreads", (it) => {
  it.effect("keeps room for a message-only thread behind many titled ones", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:petrel");
      yield* createProject(project);
      const messageOnly = ThreadId.make("thread:petrel-message");
      yield* Effect.forEach(
        [
          thread(messageOnly, project),
          // The oldest message, so a cut taken before titles drop would lose it.
          message(messageOnly, "petrel-old", "user", "a petrel note", { minute: 1 }),
          ...Array.from({ length: 50 }, (_, index) => {
            const id = ThreadId.make(`thread:petrel-${index}`);
            return [
              thread(id, project, { title: `Petrel ${index}` }),
              message(id, `petrel-${index}`, "user", "petrel again", { minute: 2 }),
            ];
          }).flat(),
        ],
        projections.apply,
        { discard: true },
      );
      const { matches } = yield* search.searchThreads({ query: "petrel", limit: 5 });
      assert.include(
        matches.map((match) => match.threadId),
        messageOnly,
      );
    }),
  );

  it.effect("leaves titled threads out before the hit limit", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:hit-limit");
      const messageOnly = ThreadId.make("thread:grebe-message");
      const titled = ThreadId.make("thread:grebe-titled");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(messageOnly, project, { title: "Unrelated" }),
          message(messageOnly, "grebe-old", "user", "a grebe note", { minute: 1 }),
          thread(titled, project, { title: "Grebe" }),
        ],
        projections.apply,
        { discard: true },
      );
      // Newer hits than one read holds, all in the titled thread.
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        SELECT 'grebe-titled-' || i, ${titled}, 'assistant', 0, ${DateTime.formatIso(at(5))},
          ${DateTime.formatIso(at(5))}, json_object('text', 'grebe again')
        FROM n
      `;
      const { matches } = yield* search.searchThreads({ query: "grebe", limit: 5 });
      assert.include(
        matches.map((match) => match.threadId),
        messageOnly,
      );
    }),
  );

  it.effect("ranks title matches like the palette, then message matches, within one project", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:titles");
      const otherProject = ProjectId.make("project:titles-other");
      yield* createProject(project);
      yield* createProject(otherProject);
      const wordStart = ThreadId.make("thread:word-start");
      const midWord = ThreadId.make("thread:mid-word");
      const messageOnly = ThreadId.make("thread:message-only");
      const elsewhere = ThreadId.make("thread:elsewhere");
      yield* Effect.forEach(
        [
          thread(midWord, project, { title: "Fix oauth redirect" }),
          thread(wordStart, project, { title: "Clean up auth tokens" }),
          thread(messageOnly, project, { title: "Unrelated" }),
          message(messageOnly, "message-only", "user", "the auth flow broke again"),
          thread(elsewhere, otherProject, { title: "Auth everywhere" }),
        ],
        projections.apply,
        { discard: true },
      );

      // Stronger message hits in another project must not use up this project's limit.
      yield* Effect.forEach(
        Array.from({ length: 55 }, (_, index) => {
          const busy = ThreadId.make(`thread:elsewhere-${index}`);
          return [
            thread(busy, otherProject),
            message(busy, `elsewhere-${index}`, "user", "auth auth auth"),
          ];
        }).flat(),
        projections.apply,
        { discard: true },
      );
      const result = yield* search.searchThreads({ query: "auth", projectId: project, limit: 3 });
      assert.deepEqual(
        result.matches.map((match) => [match.threadId, match.source]),
        [
          [wordStart, "title"],
          [midWord, "title"],
          [messageOnly, "user"],
        ],
      );
      // With one slot, an exact title keeps it.
      assert.deepEqual(
        (yield* search.searchThreads({ query: "auth", projectId: project, limit: 1 })).matches.map(
          (match) => match.threadId,
        ),
        [wordStart],
      );
      // Exact matching finds nothing, so one typo is forgiven.
      assert.deepEqual(
        (yield* search.searchThreads({ query: "tokesn", projectId: project })).matches.map(
          (match) => match.title,
        ),
        ["Clean up auth tokens"],
      );
    }),
  );
});

