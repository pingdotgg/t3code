import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  OrchestrationEvent,
  OrchestrationCommand,
  type OrchestrationReadModel,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { isThreadDetailEvent } from "../ws.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function expectSingleEvent<Type extends OrchestrationEvent["type"]>(
  decided: PlannedEvent | ReadonlyArray<PlannedEvent>,
  type: Type,
): Omit<Extract<OrchestrationEvent, { type: Type }>, "sequence"> {
  const event = Array.isArray(decided) ? decided[0] : (decided as PlannedEvent);
  if (event === undefined || event.type !== type) {
    throw new Error(`expected ${type}, got ${String(event?.type)}`);
  }
  return event as Omit<Extract<OrchestrationEvent, { type: Type }>, "sequence">;
}

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

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

function makeReadModel(pullRequests: ReadonlyArray<ThreadPullRequestLink>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        repositoryIdentity: {
          canonicalKey: "github.com/t3tools/t3code",
          provider: "github",
          displayName: "t3tools/t3code",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/t3tools/t3code.git",
          },
        },
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const snapshot: ThreadPullRequestSnapshot = {
  state: "open",
  title: "Add links",
  headBranch: "feat/links",
  baseBranch: "main",
  isDraft: false,
  updatedAt: NOW,
  syncedAt: NOW,
};

it.layer(NodeServices.layer)("pull request link decider", (it) => {
  it.effect("legacy unlink cannot remove a newer cross-host link", () =>
    Effect.gen(function* () {
      const own = makeLink();
      const foreign = makeLink({
        host: "github.enterprise.test",
        url: "https://github.enterprise.test/t3tools/t3code/pull/42",
        linkedAt: "2026-01-02T00:00:00Z",
      });
      const command = yield* decodeCommand({
        type: "thread.meta.update",
        commandId: "unlink",
        threadId: THREAD_ID,
        linkedPullRequest: null,
      });
      const decided = yield* decideOrchestrationCommand({
        readModel: makeReadModel([own, foreign]),
        command,
      });
      const event = expectSingleEvent(decided, "thread.pull-request-unlinked");
      expect(event.payload.host).toBe("github.com");
    }),
  );

  it.effect("legacy replacement preserves unrelated manual links", () =>
    Effect.gen(function* () {
      const other = makeLink({ number: 7, snapshot: { ...snapshot, state: "merged" } });
      const current = makeLink({ linkedAt: "2026-01-02T00:00:00Z" });
      let model = makeReadModel([other, current]);
      const command = yield* decodeCommand({
        type: "thread.meta.update",
        commandId: "replace",
        threadId: THREAD_ID,
        linkedPullRequest: {
          projectId: "project-1",
          repository: "t3tools/t3code",
          number: 99,
          url: "https://github.com/t3tools/t3code/pull/99",
        },
      });
      const decided = yield* decideOrchestrationCommand({ readModel: model, command });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.pull-request-unlinked",
        "thread.pull-request-linked",
      ]);
      for (const event of events)
        model = yield* projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 });
      expect(model.threads[0]!.pullRequests.map((link) => link.number)).toEqual([7, 99]);
    }),
  );
  it.effect("round-trips an Azure legacy link and unlinks only its organization", () =>
    Effect.gen(function* () {
      const foreign = makeLink({
        host: "dev.azure.com",
        repository: "org-b/project/_git/web",
        number: 7,
        url: "https://dev.azure.com/org-b/project/_git/web/pullrequest/7",
      });
      let model = makeReadModel([foreign]);
      model = {
        ...model,
        projects: model.projects.map((project) => ({
          ...project,
          repositoryIdentity: {
            ...project.repositoryIdentity!,
            provider: "azure-devops",
            canonicalKey: "ssh.dev.azure.com/v3/org-a/project/web",
            displayName: "v3/org-a/project/web",
            name: "web",
          },
        })),
      };
      const legacy = {
        projectId: "project-1",
        repository: "web",
        number: 7,
        url: "https://dev.azure.com/org-a/project/_git/web/pullrequest/7",
      };
      for (const linkedPullRequest of [legacy, null]) {
        const command = yield* decodeCommand({
          type: "thread.meta.update",
          commandId: linkedPullRequest === null ? "unlink-azure" : "link-azure",
          threadId: THREAD_ID,
          linkedPullRequest,
        });
        const decided = yield* decideOrchestrationCommand({ readModel: model, command });
        for (const event of Array.isArray(decided) ? decided : [decided]) {
          model = yield* projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 });
        }
        if (linkedPullRequest !== null) {
          expect(model.threads[0]!.linkedPullRequest).toEqual(legacy);
          expect(model.threads[0]!.pullRequests.map((link) => link.repository)).toEqual([
            "org-b/project/_git/web",
            "org-a/project/_git/web",
          ]);
        }
      }
      expect(model.threads[0]!.pullRequests).toEqual([foreign]);
      expect(model.threads[0]!.linkedPullRequest).toBeNull();
    }),
  );
  it.effect("legacy unlink alone does not emit an empty metadata event", () =>
    Effect.gen(function* () {
      const command = yield* decodeCommand({
        type: "thread.meta.update",
        commandId: "unlink",
        threadId: THREAD_ID,
        linkedPullRequest: null,
      });
      const decided = yield* decideOrchestrationCommand({
        readModel: makeReadModel([makeLink()]),
        command,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.pull-request-unlinked"]);
    }),
  );

  for (const source of ["manual", "agent", "created", "stack"] as const) {
    it.effect(`legacy unlink removes the visible ${source} link and preserves other requests`, () =>
      Effect.gen(function* () {
        const other = makeLink({ number: 7, snapshot: { ...snapshot, state: "merged" } });
        const current = makeLink({ source, linkedAt: "2026-01-02T00:00:00.000Z" });
        let model = makeReadModel([other, current]);
        // This is the pre-array command shape sent by older clients.
        const command = yield* decodeCommand({
          type: "thread.meta.update",
          commandId: "legacy-unlink",
          threadId: THREAD_ID,
          linkedPullRequest: null,
          title: "Renamed by old client",
        });
        const decided = yield* decideOrchestrationCommand({ readModel: model, command });
        const events = Array.isArray(decided) ? decided : [decided];
        for (const planned of events) {
          const event = { ...planned, sequence: model.snapshotSequence + 1 };
          const encoded = yield* Schema.encodeEffect(OrchestrationEvent)(event);
          const decoded = yield* Schema.decodeUnknownEffect(OrchestrationEvent)(encoded);
          // Older detail-event unions must never receive the new PR discriminants.
          expect(isThreadDetailEvent(decoded)).toBe(false);
          model = yield* projectEvent(model, decoded);
        }
        const thread = model.threads[0]!;
        expect(thread.title).toBe("Renamed by old client");
        expect(thread.pullRequests).toEqual(
          source === "stack" ? [other, { ...current, source: "stack-dismissed" }] : [other],
        );
        // The old single-link field continues to track the remaining visible request.
        expect(thread.linkedPullRequest?.number).toBe(7);
      }),
    );
  }

  it.effect("links a pull request with a normalized key and empty host state", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-link"),
          threadId: THREAD_ID,
          host: " GitHub.com ",
          repository: "T3Tools/T3Code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "manual",
        },
        readModel: makeReadModel([]),
      });
      expect(Array.isArray(decided)).toBe(false);
      const event = expectSingleEvent(decided, "thread.pull-request-linked");
      expect(event.payload.link).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
        url: "https://github.com/t3tools/t3code/pull/42",
        source: "manual",
        linkedAt: event.payload.updatedAt,
        snapshot: null,
        stack: null,
      });
      expect(event.payload.updatedAt).not.toBe(NOW);
    }),
  );

  it.effect("rejects linking a pull request that is already linked", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-link-dup"),
          threadId: THREAD_ID,
          host: "GITHUB.COM",
          repository: "t3tools/t3code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "agent",
        },
        readModel: makeReadModel([makeLink()]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("re-linking a dismissed stack member un-dismisses it", () =>
    Effect.gen(function* () {
      const dismissed = makeLink({
        source: "stack-dismissed",
        snapshot,
        stack: {
          kind: "native",
          id: "stack-1",
          number: 1,
          url: "https://github.com/t3tools/t3code/stack/1",
          base: "main",
          layers: [{ number: 42, headBranch: "feat/links", state: "open" }],
        },
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-relink"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "manual",
        },
        readModel: makeReadModel([dismissed]),
      });
      const event = expectSingleEvent(decided, "thread.pull-request-linked");
      // Host state survives the flip; only the source changes.
      expect(event.payload.link).toEqual({ ...dismissed, source: "manual" });
    }),
  );

  it.effect("rejects a stack sync re-adding a dismissed stack member", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-stack-readd"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "stack",
        },
        readModel: makeReadModel([makeLink({ source: "stack-dismissed" })]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("unlinks a manual pull request", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("cmd-unlink"),
          threadId: THREAD_ID,
          host: "GitHub.com",
          repository: "t3tools/t3code",
          number: 42,
        },
        readModel: makeReadModel([makeLink()]),
      });
      const event = expectSingleEvent(decided, "thread.pull-request-unlinked");
      expect(event.payload).toMatchObject({
        threadId: THREAD_ID,
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
      });
    }),
  );

  it.effect("unlinking a stack member leaves a stack-dismissed tombstone", () =>
    Effect.gen(function* () {
      const member = makeLink({ source: "stack", snapshot });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("cmd-unlink-stack"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
        },
        readModel: makeReadModel([member]),
      });
      const event = expectSingleEvent(decided, "thread.pull-request-linked");
      expect(event.payload.link).toEqual({ ...member, source: "stack-dismissed" });
    }),
  );

  for (const source of ["manual", "agent", "created"] as const) {
    it.effect(`unlinking a ${source} member prevents its sibling rediscovering it`, () =>
      Effect.gen(function* () {
        const member = makeLink({ source });
        const sibling = makeLink({
          number: 43,
          source: "stack",
          stack: {
            kind: "native",
            id: "stack-1",
            number: 1,
            url: "https://github.com/t3tools/t3code/stack/1",
            base: "main",
            layers: [
              { number: 42, headBranch: "first", state: "open" },
              { number: 43, headBranch: "second", state: "open" },
            ],
          },
        });
        let model = makeReadModel([member, sibling]);
        const decided = yield* decideOrchestrationCommand({
          readModel: model,
          command: {
            type: "thread.pull-request.unlink",
            commandId: CommandId.make("remove"),
            threadId: THREAD_ID,
            host: member.host,
            repository: member.repository,
            number: member.number,
          },
        });
        const event = expectSingleEvent(decided, "thread.pull-request-linked");
        model = yield* projectEvent(model, { ...event, sequence: 1 });
        expect(model.threads[0]!.pullRequests).toEqual([
          { ...member, source: "stack-dismissed" },
          sibling,
        ]);
        const rediscovered = yield* decideOrchestrationCommand({
          readModel: model,
          command: {
            type: "thread.pull-request.link",
            commandId: CommandId.make("rediscovered"),
            threadId: THREAD_ID,
            host: member.host,
            repository: member.repository,
            number: member.number,
            url: member.url,
            source: "stack",
          },
        }).pipe(Effect.result);
        expect(rediscovered._tag).toBe("Failure");
      }),
    );
  }

  it.effect("rejects unlinking a pull request that is not linked", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("cmd-unlink-missing"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 7,
        },
        readModel: makeReadModel([makeLink()]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects syncing a pull request that is not linked", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make("cmd-sync-missing"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          snapshot,
          stack: null,
        },
        readModel: makeReadModel([]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("sync emits the host snapshot for a linked pull request", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make("cmd-sync"),
          threadId: THREAD_ID,
          host: "GitHub.com",
          repository: "t3tools/t3code",
          number: 42,
          snapshot,
          stack: null,
        },
        readModel: makeReadModel([makeLink()]),
      });
      const event = expectSingleEvent(decided, "thread.pull-request-synced");
      expect(event.payload).toMatchObject({
        threadId: THREAD_ID,
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
        snapshot,
        stack: null,
      });
    }),
  );
});
