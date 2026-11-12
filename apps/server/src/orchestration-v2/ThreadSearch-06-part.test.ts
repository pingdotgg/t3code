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












it.layer(layerTest)("ThreadSearch.searchOlderSettled", (it) => {
  it.effect("returns older settled title matches in scope, then older message hits", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:kestrel");
      const other = ProjectId.make("project:kestrel-other");
      yield* createProject(project);
      yield* createProject(other);
      const id = (name: string) => ThreadId.make(`thread:kestrel-${name}`);
      const old = at(10);
      yield* Effect.forEach(
        [
          thread(id("old"), project, { title: "Kestrel nest", settledAt: old }),
          thread(id("recent"), project, { title: "Kestrel nest", settledAt: at(50) }),
          thread(id("open"), project, { title: "Kestrel nest" }),
          thread(id("child"), project, { title: "Kestrel nest", subagentOf: id("old") }),
          thread(id("elsewhere"), other, { title: "Kestrel nest", settledAt: old }),
          thread(id("note"), project, { title: "Unrelated", settledAt: old }),
          thread(id("new-note"), project, { title: "Unrelated", settledAt: at(50) }),
        ],
        projections.apply,
        { discard: true },
      );
      const before = DateTime.formatIso(at(30));
      const messageThreadIds = [id("new-note"), id("note"), id("old")];
      assert.sameMembers(
        [...(yield* search.searchOlderSettled({ query: "kestrel", before, messageThreadIds }))],
        [id("old"), id("elsewhere"), id("note")],
      );
      // The scope applies to titles and message hits; message hits follow the titles in order.
      assert.deepEqual(
        yield* search.searchOlderSettled({
          query: "kestrel",
          before,
          projectIds: [project],
          messageThreadIds: [id("elsewhere"), ...messageThreadIds],
        }),
        [id("old"), id("note")],
      );
      // A palette also matches the environment's name.
      assert.include(
        yield* search.searchOlderSettled({
          query: "laptop unrelated",
          before,
          environmentLabel: "Laptop",
          messageThreadIds: [],
        }),
        id("note"),
      );
    }),
  );

  it.effect("matches the branch and linked pull requests, like the palette", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:heron");
      yield* createProject(project);
      const pullRequest = (number: number): ThreadLinkedPullRequest => ({
        projectId: project,
        repository: "acme/heron",
        number,
        url: `https://github.com/acme/heron/pull/${number}`,
      });
      const branch = ThreadId.make("thread:heron-branch");
      const linked = ThreadId.make("thread:heron-linked");
      yield* Effect.forEach(
        [
          thread(branch, project, {
            title: "Heron",
            settledAt: at(10),
            branchPullRequest: pullRequest(4101),
          }),
          thread(linked, project, {
            title: "Heron",
            settledAt: at(10),
            linkedPullRequest: pullRequest(4202),
          }),
        ],
        projections.apply,
        { discard: true },
      );
      const find = (query: string) =>
        search.searchOlderSettled({
          query,
          before: DateTime.formatIso(at(30)),
          messageThreadIds: [],
        });
      assert.deepEqual(yield* find("#4101"), [branch]);
      assert.deepEqual(yield* find("acme/heron#4202"), [linked]);
    }),
  );
});

