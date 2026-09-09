import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type RepositoryIdentity,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

function makeLink(overrides: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number: 42,
    url: "https://github.com/t3tools/t3code/pull/42",
    source: "manual",
    linkedAt: NOW,
    snapshot: null,
    stack: null,
    ...overrides,
  };
}

const snapshot: ThreadPullRequestSnapshot = {
  state: "merged",
  title: "Add links",
  headBranch: "feat/links",
  baseBranch: "main",
  isDraft: false,
  updatedAt: LATER,
  syncedAt: LATER,
};

const createThread = (model: OrchestrationReadModel) =>
  projectEvent(
    model,
    makeEvent({
      sequence: model.snapshotSequence + 1,
      type: "thread.created",
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );

const createProject = (model: OrchestrationReadModel, repositoryIdentity: RepositoryIdentity) =>
  projectEvent(model, {
    ...makeEvent({
      sequence: model.snapshotSequence + 1,
      type: "project.created",
      payload: {
        projectId: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
  }).pipe(
    Effect.map((next) => ({
      ...next,
      projects: next.projects.map((project) =>
        project.id === PROJECT_ID ? { ...project, repositoryIdentity } : project,
      ),
    })),
  );

it.effect("seeds threads with no pull requests", () =>
  Effect.gen(function* () {
    const created = yield* createThread(createEmptyReadModel(NOW));
    expect(created.threads[0]?.pullRequests).toEqual([]);
    expect(created.threads[0]?.linkedPullRequest ?? null).toBeNull();
  }),
);

it.effect("projects link, sync, and unlink onto the thread", () =>
  Effect.gen(function* () {
    const created = yield* createThread(
      yield* createProject(createEmptyReadModel(NOW), {
        canonicalKey: "github.com/t3tools/t3code",
        provider: "github",
        displayName: "t3tools/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/t3tools/t3code.git",
        },
      }),
    );
    const link = makeLink();

    const linked = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.pull-request-linked",
        payload: { threadId: THREAD_ID, link, updatedAt: LATER },
      }),
    );
    expect(linked.threads[0]?.pullRequests).toEqual([link]);
    expect(linked.threads[0]?.updatedAt).toBe(LATER);
    // The legacy field is derived from the array so old clients keep working.
    expect(linked.threads[0]?.linkedPullRequest).toEqual({
      projectId: PROJECT_ID,
      repository: "t3tools/t3code",
      number: 42,
      url: "https://github.com/t3tools/t3code/pull/42",
    });

    // A second link for the same key replaces in place (used for un-dismiss
    // and stack tombstones), never duplicates.
    const relinked = yield* projectEvent(
      linked,
      makeEvent({
        sequence: 3,
        type: "thread.pull-request-linked",
        payload: {
          threadId: THREAD_ID,
          link: { ...link, host: "GITHUB.COM", source: "agent" },
          updatedAt: LATER,
        },
      }),
    );
    expect(relinked.threads[0]?.pullRequests).toHaveLength(1);
    expect(relinked.threads[0]?.pullRequests[0]?.source).toBe("agent");

    const synced = yield* projectEvent(
      relinked,
      makeEvent({
        sequence: 4,
        type: "thread.pull-request-synced",
        payload: {
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          snapshot,
          stack: null,
          updatedAt: LATER,
        },
      }),
    );
    expect(synced.threads[0]?.pullRequests[0]?.snapshot).toEqual(snapshot);

    const unlinked = yield* projectEvent(
      synced,
      makeEvent({
        sequence: 5,
        type: "thread.pull-request-unlinked",
        payload: {
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          updatedAt: LATER,
        },
      }),
    );
    expect(unlinked.threads[0]?.pullRequests).toEqual([]);
    expect(unlinked.threads[0]?.linkedPullRequest).toBeNull();
  }),
);

it.effect("ignores a sync for a pull request that is no longer linked", () =>
  Effect.gen(function* () {
    const created = yield* createThread(createEmptyReadModel(NOW));
    const other = makeLink({ number: 7, url: "https://github.com/t3tools/t3code/pull/7" });
    const linked = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.pull-request-linked",
        payload: { threadId: THREAD_ID, link: other, updatedAt: NOW },
      }),
    );
    const synced = yield* projectEvent(
      linked,
      makeEvent({
        sequence: 3,
        type: "thread.pull-request-synced",
        payload: {
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          snapshot,
          stack: null,
          updatedAt: LATER,
        },
      }),
    );
    expect(synced.threads[0]?.pullRequests).toEqual([other]);
    expect(synced.threads[0]?.updatedAt).toBe(NOW);
  }),
);

it.effect("mirrors legacy meta-updated links into pullRequests using the project host", () =>
  Effect.gen(function* () {
    const withProject = yield* createProject(createEmptyReadModel(NOW), {
      canonicalKey: "GitHub.com/t3tools/t3code",
      provider: "github",
      displayName: "t3tools/t3code",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:t3tools/t3code.git",
      },
    });
    const created = yield* createThread(withProject);
    const agentLink = makeLink({
      number: 7,
      url: "https://github.com/t3tools/t3code/pull/7",
      source: "agent",
    });
    const withAgentLink = yield* projectEvent(
      created,
      makeEvent({
        sequence: 3,
        type: "thread.pull-request-linked",
        payload: { threadId: THREAD_ID, link: agentLink, updatedAt: NOW },
      }),
    );

    const legacyLinked = yield* projectEvent(
      withAgentLink,
      makeEvent({
        sequence: 4,
        type: "thread.meta-updated",
        payload: {
          threadId: THREAD_ID,
          linkedPullRequest: {
            projectId: PROJECT_ID,
            repository: "T3Tools/T3Code",
            number: 42,
            url: "https://github.com/t3tools/t3code/pull/42",
          },
          updatedAt: LATER,
        },
      }),
    );
    expect(legacyLinked.threads[0]?.pullRequests).toEqual([
      agentLink,
      {
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
        url: "https://github.com/t3tools/t3code/pull/42",
        source: "manual",
        linkedAt: LATER,
        snapshot: null,
        stack: null,
      },
    ]);
    // Two open links read as a stack; the derived field points at the top.
    expect(legacyLinked.threads[0]?.linkedPullRequest).toEqual({
      projectId: PROJECT_ID,
      repository: "t3tools/t3code",
      number: 42,
      url: "https://github.com/t3tools/t3code/pull/42",
    });

    // Null clears only the manual link; the agent's stays.
    const legacyCleared = yield* projectEvent(
      legacyLinked,
      makeEvent({
        sequence: 5,
        type: "thread.meta-updated",
        payload: { threadId: THREAD_ID, linkedPullRequest: null, updatedAt: LATER },
      }),
    );
    expect(legacyCleared.threads[0]?.pullRequests).toEqual([agentLink]);
    expect(legacyCleared.threads[0]?.linkedPullRequest).toEqual({
      projectId: PROJECT_ID,
      repository: "t3tools/t3code",
      number: 7,
      url: "https://github.com/t3tools/t3code/pull/7",
    });
  }),
);

it.effect("falls back to the link URL host when the project has no repository identity", () =>
  Effect.gen(function* () {
    const created = yield* createThread(createEmptyReadModel(NOW));
    const legacyLinked = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.meta-updated",
        payload: {
          threadId: THREAD_ID,
          linkedPullRequest: {
            projectId: PROJECT_ID,
            repository: "t3tools/t3code",
            number: 42,
            url: "https://GitLab.example.com/t3tools/t3code/-/merge_requests/42",
          },
          updatedAt: LATER,
        },
      }),
    );
    expect(legacyLinked.threads[0]?.pullRequests[0]?.host).toBe("gitlab.example.com");
  }),
);

it.effect("leaves pullRequests alone when meta-updated carries no legacy link", () =>
  Effect.gen(function* () {
    const created = yield* createThread(createEmptyReadModel(NOW));
    const link = makeLink();
    const linked = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.pull-request-linked",
        payload: { threadId: THREAD_ID, link, updatedAt: NOW },
      }),
    );
    const retitled = yield* projectEvent(
      linked,
      makeEvent({
        sequence: 3,
        type: "thread.meta-updated",
        payload: { threadId: THREAD_ID, title: "Renamed", updatedAt: LATER },
      }),
    );
    expect(retitled.threads[0]?.title).toBe("Renamed");
    expect(retitled.threads[0]?.pullRequests).toEqual([link]);
  }),
);

it.effect("replays Azure legacy selectors as full repository keys", () =>
  Effect.gen(function* () {
    const withProject = yield* createProject(createEmptyReadModel(NOW), {
      canonicalKey: "ssh.dev.azure.com/v3/org-a/project/web",
      provider: "azure-devops",
      displayName: "v3/org-a/project/web",
      name: "web",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@ssh.dev.azure.com:v3/org-a/project/web",
      },
    });
    const created = yield* createThread(withProject);
    const legacy = {
      projectId: PROJECT_ID,
      repository: "web",
      number: 7,
      url: "https://dev.azure.com/org-a/project/_git/web/pullrequest/7",
    };
    const model = yield* projectEvent(
      created,
      makeEvent({
        sequence: 3,
        type: "thread.meta-updated",
        payload: { threadId: THREAD_ID, linkedPullRequest: legacy, updatedAt: LATER },
      }),
    );
    expect(model.threads[0]?.pullRequests).toEqual([
      {
        host: "dev.azure.com",
        repository: "org-a/project/_git/web",
        number: 7,
        url: legacy.url,
        source: "manual",
        linkedAt: LATER,
        snapshot: null,
        stack: null,
      },
    ]);
    expect(model.threads[0]?.linkedPullRequest).toEqual(legacy);
  }),
);
