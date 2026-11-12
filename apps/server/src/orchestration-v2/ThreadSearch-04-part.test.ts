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












it.layer(layerTest)("ThreadSearch filters before it ranks", (it) => {
  it.effect("orders message matches by when they were written, not by row order", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:written");
      yield* createProject(project);
      const recent = ThreadId.make("thread:written-recent");
      const imported = ThreadId.make("thread:written-imported");
      // An imported history lands after newer messages in row order.
      yield* Effect.forEach(
        [
          thread(recent, project),
          message(recent, "written-recent", "user", "kestrel deploy notes", { minute: 30 }),
          thread(imported, project),
          message(imported, "written-imported", "user", "kestrel deploy notes", { minute: 1 }),
        ],
        projections.apply,
        { discard: true },
      );
      const { matches } = yield* search.search({ query: "kestrel" });
      assert.deepEqual(
        matches.map((match) => match.threadId),
        [recent, imported],
      );
    }),
  );

  it.effect("ranks a thread about the word above a passing mention", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:about");
      yield* createProject(project);
      const about = ThreadId.make("thread:about-osprey");
      const mention = ThreadId.make("thread:mention-osprey");
      yield* Effect.forEach(
        [
          thread(about, project),
          ...Array.from({ length: 12 }, (_, index) =>
            message(about, `about-osprey-${index}`, "assistant", `osprey step ${index}`, {
              minute: 2,
            }),
          ),
          thread(mention, project),
          message(mention, "mention-osprey", "user", "also check osprey", { minute: 5 }),
        ],
        projections.apply,
        { discard: true },
      );
      const { matches } = yield* search.search({ query: "osprey" });
      assert.deepEqual(
        matches.map((match) => [match.threadId, match.hits]),
        [
          [about, 12],
          [mention, 1],
        ],
      );
    }),
  );

  it.effect("counts a thread's hits at its best match only", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:best-hits");
      yield* createProject(project);
      const clarks = ThreadId.make("thread:clarks");
      const larks = ThreadId.make("thread:lark-many");
      yield* Effect.forEach(
        [
          thread(clarks, project),
          message(clarks, "clarks-lark", "user", "Lark once", { minute: 3 }),
          ...Array.from({ length: 31 }, (_, index) =>
            message(clarks, `clarks-${index}`, "assistant", "Clark the plan", { minute: 3 }),
          ),
          thread(larks, project),
          ...Array.from({ length: 8 }, (_, index) =>
            message(larks, `lark-many-${index}`, "assistant", "Lark again", { minute: 3 }),
          ),
        ],
        projections.apply,
        { discard: true },
      );
      const { matches } = yield* search.search({ query: "lark" });
      assert.deepEqual(
        matches.map((match) => [match.threadId, match.hits]),
        [
          [larks, 8],
          [clarks, 1],
        ],
      );
    }),
  );

  it.effect("finds a visible match behind hundreds of hidden or narrower hits", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:crowded");
      const parent = ThreadId.make("thread:crowded-parent");
      const subagent = ThreadId.make("thread:crowded-subagent");
      const older = ThreadId.make("thread:crowded-older");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(parent, project),
          thread(subagent, project, { subagentOf: parent }),
          thread(older, project),
          ...Array.from({ length: 450 }, (_, index) =>
            message(subagent, `subagent-${index}`, "assistant", "needle needle"),
          ),
          ...Array.from({ length: 450 }, (_, index) =>
            message(older, `older-${index}`, "assistant", "pnpm 11 pnpm"),
          ),
          message(parent, "parent-needle", "user", "a needle in a long haystack of other words"),
          // Agent-written notices in user messages are not indexed, so they never read as "You".
          message(older, "older-notice", "user", "needle update from a watched pull request", {
            createdBy: "agent",
          }),
          message(parent, "parent-pnpm", "user", "moved the repo to pnpm 12 today"),
        ],
        projections.apply,
        { discard: true },
      );

      const threadIds = (query: string) =>
        search.search({ query }).pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));
      assert.deepEqual(yield* threadIds("needle"), [parent]);
      assert.deepEqual(yield* threadIds("pnpm 12"), [parent]);
    }),
  );

  it.effect("keeps a thread picked for the query when the limit cuts", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:plover");
      const busy = ThreadId.make("thread:plover-busy");
      const picked = ThreadId.make("thread:plover-picked");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(busy, project),
          message(busy, "plover-1", "user", "plover notes", { minute: 3 }),
          message(busy, "plover-2", "user", "more plover notes", { minute: 4 }),
          thread(picked, project),
          message(picked, "plover-old", "user", "one plover mention", { minute: 1 }),
        ],
        projections.apply,
        { discard: true },
      );
      const threadIds = () =>
        search
          .search({ query: "plover", limit: 1 })
          .pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));
      assert.deepEqual(yield* threadIds(), [busy]);
      // A pick at time 0 would read as no pick.
      yield* TestClock.adjust("1 day");
      const at = DateTime.toEpochMillis(yield* DateTime.now);
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.opens', json(${JSON.stringify({
          openedAt: at,
          score: 1,
          picks: [{ query: "plover", at }],
        })}))
        WHERE thread_id = ${picked}
      `;
      assert.deepEqual(yield* threadIds(), [picked]);
    }),
  );

  it.effect("finds a curly apostrophe for a straight one and back", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:apostrophes");
      const curly = ThreadId.make("thread:apostrophe-curly");
      const straight = ThreadId.make("thread:apostrophe-straight");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(curly, project),
          message(curly, "apostrophe-curly", "user", "the gannet\u2019s nest"),
          thread(straight, project),
          message(straight, "apostrophe-straight", "user", "a kittiwake's nest"),
        ],
        projections.apply,
        { discard: true },
      );
      const threadIds = (query: string) =>
        search.search({ query }).pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));
      assert.deepEqual(yield* threadIds("gannet's"), [curly]);
      assert.deepEqual(yield* threadIds("kittiwake\u2019s"), [straight]);
    }),
  );

  it.effect("leaves out answers to an agent's question, which show in its card", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:answers");
      const asked = ThreadId.make("thread:answers");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(asked, project),
          message(asked, "async-answer:request-1", "user", "use the albatross drive"),
        ],
        projections.apply,
        { discard: true },
      );
      assert.deepEqual((yield* search.search({ query: "albatross" })).matches, []);
    }),
  );

  it.effect("matches messages as they read, with links as their text", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:heron");
      const labeled = ThreadId.make("thread:heron-label");
      const addressOnly = ThreadId.make("thread:heron-address");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(labeled, project),
          message(labeled, "heron-label", "assistant", "See [the heron plan](https://x.dev/a) now"),
          thread(addressOnly, project),
          message(addressOnly, "heron-address", "user", "Read [this](https://heron.dev/b)"),
        ],
        projections.apply,
        { discard: true },
      );
      const { matches } = yield* search.search({ query: "heron" });
      assert.deepEqual(
        matches.map((match) => [match.threadId, match.snippet]),
        [[labeled, "See the heron plan now"]],
      );
    }),
  );

  it.effect("reads at most the newest 10,000 index hits, however many the filters drop", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:kestrel");
      const old = ThreadId.make("thread:kestrel-old");
      const busy = ThreadId.make("thread:kestrel-busy");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(old, project),
          message(old, "kestrel-old", "user", "kestrel ci is red"),
          thread(busy, project),
        ],
        projections.apply,
        { discard: true },
      );
      const insertBusy = (count: number) => sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        SELECT 'kestrel-busy-' || i, ${busy}, 'assistant', 0, ${DateTime.formatIso(at(5))},
          ${DateTime.formatIso(at(5))}, json_object('text', 'kestrel packages')
        FROM n
      `;
      const threadIds = (query: string) =>
        search.search({ query }).pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));
      yield* insertBusy(9_999);
      assert.deepEqual(yield* threadIds("kestrel ci"), [old]);
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = ${busy}`;
      yield* insertBusy(10_000);
      assert.deepEqual(yield* threadIds("kestrel ci"), []);
    }),
  );
});

