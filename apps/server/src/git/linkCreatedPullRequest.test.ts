import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GitRunStackedActionResult,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { createdPullRequestKey, linkCreatedPullRequest } from "./linkCreatedPullRequest.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const commandId = Effect.succeed(CommandId.make("server:pr-created-link:test"));

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "github.acme.test/platform/api",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.acme.test:Platform/API.git",
    },
    provider: "github",
    displayName: "Platform/API",
    owner: "Platform",
    name: "API",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const thread: OrchestrationThreadShell = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

function prResult(pr: GitRunStackedActionResult["pr"]): Pick<GitRunStackedActionResult, "pr"> {
  return { pr };
}

const makeDependencies = (
  dispatch: OrchestrationEngineShape["dispatch"],
  threadShell: OrchestrationThreadShell | null = thread,
) =>
  Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeed(Option.fromNullishOr(threadShell)),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
  );

const recordingDispatch = Effect.fn("recordingDispatch")(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 }));
  return { commands, dispatch };
});

describe("createdPullRequestKey", () => {
  it("reads host and repository from the URL when it is recognisable", () => {
    expect(
      createdPullRequestKey(
        prResult({
          status: "created",
          number: 12,
          url: "https://github.com/Other/Fork/pull/12",
        }),
        project,
      ),
    ).toEqual({
      host: "github.com",
      repository: "other/fork",
      number: 12,
      url: "https://github.com/Other/Fork/pull/12",
    });
  });

  it("falls back to the project's host and repository for an unreadable URL", () => {
    expect(
      createdPullRequestKey(
        prResult({ status: "opened_existing", number: 3, url: "https://ghe.internal/x/3" }),
        project,
      ),
    ).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 3,
      url: "https://ghe.internal/x/3",
    });
    expect(
      createdPullRequestKey(
        prResult({ status: "created", number: 3, url: "https://ghe.internal/x/3" }),
        undefined,
      ),
    ).toBeNull();
  });

  it("yields nothing when no pull request came out of the action", () => {
    expect(
      createdPullRequestKey(prResult({ status: "skipped_not_requested" }), project),
    ).toBeNull();
    expect(
      createdPullRequestKey(
        prResult({ status: "created", url: "https://github.com/a/b/pull/1" }),
        project,
      ),
    ).toBeNull();
    expect(createdPullRequestKey(prResult({ status: "created", number: 1 }), project)).toBeNull();
  });
});

describe("linkCreatedPullRequest", () => {
  it.effect("links a created pull request to the thread with source created", () =>
    Effect.gen(function* () {
      const { commands, dispatch } = yield* recordingDispatch();
      yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({
          status: "created",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
        }),
        commandId,
      }).pipe(Effect.provide(makeDependencies(dispatch)));

      expect(yield* Ref.get(commands)).toEqual([
        {
          type: "thread.pull-request.link",
          commandId: "server:pr-created-link:test",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "created",
        },
      ]);
    }),
  );

  it.effect("dispatches nothing when the action produced no pull request", () =>
    Effect.gen(function* () {
      const { commands, dispatch } = yield* recordingDispatch();
      const dependencies = makeDependencies(dispatch);
      yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({ status: "skipped_not_requested" }),
        commandId,
      }).pipe(Effect.provide(dependencies));
      yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({ status: "created", url: "https://github.com/t3tools/t3code/pull/42" }),
        commandId,
      }).pipe(Effect.provide(dependencies));

      expect(yield* Ref.get(commands)).toEqual([]);
    }),
  );

  it.effect("swallows an already-linked rejection and other dispatch failures", () =>
    Effect.gen(function* () {
      const rejecting: OrchestrationEngineShape["dispatch"] = (command) =>
        Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "already linked",
          }),
        );
      const result = prResult({
        status: "opened_existing",
        number: 7,
        url: "https://github.com/t3tools/t3code/pull/7",
      });
      yield* linkCreatedPullRequest({ threadId: THREAD_ID, result, commandId }).pipe(
        Effect.provide(makeDependencies(rejecting)),
      );
      yield* linkCreatedPullRequest({ threadId: THREAD_ID, result, commandId }).pipe(
        Effect.provide(makeDependencies(() => Effect.die(new Error("engine down")))),
      );
      // A thread that vanished between the action and the link is not an error either.
      yield* linkCreatedPullRequest({ threadId: THREAD_ID, result, commandId }).pipe(
        Effect.provide(makeDependencies(() => Effect.die(new Error("unreachable")), null)),
      );
    }),
  );
});
