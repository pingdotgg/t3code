import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GitRunStackedActionResult,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { GitHubCli, type GitHubPullRequestSummary } from "../git/Services/GitHubCli.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  PullRequestCreationIntentRepository,
  type PullRequestCreationIntentRepositoryShape,
} from "../persistence/Services/PullRequestCreationIntents.ts";
import { PullRequestCreationIntentRepositoryLive } from "../persistence/Layers/PullRequestCreationIntents.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  makePullRequestCreationAutomation,
  type PullRequestCreationAutomationShape,
} from "./PullRequestCreationAutomation.ts";

const now = "1970-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const cwd = "/isolated/worktree";
const headSha = "0123456789abcdef";
const pullRequestUrl = "https://github.com/acme/app/pull/42";

const creationIntent = {
  actionId: "create-pr-action",
  threadId,
  projectId,
  cwd,
  localBranch: "feature/fix",
  headBranch: "feature/fix",
  headSelector: "feature/fix",
  baseBranch: "main",
  headSha,
};

const createdPullRequest: GitRunStackedActionResult["pr"] = {
  status: "created",
  number: 42,
  title: "Fix the feature",
  url: pullRequestUrl,
  baseBranch: "main",
  headBranch: "feature/fix",
  headSha,
  isCrossRepository: false,
  headRepositoryNameWithOwner: "acme/app",
};

const githubSummary = (
  overrides: Partial<GitHubPullRequestSummary> = {},
): GitHubPullRequestSummary => ({
  number: 42,
  title: "Fix the feature",
  url: pullRequestUrl,
  baseRefName: "main",
  headRefName: "feature/fix",
  headRefOid: headSha,
  state: "open",
  isCrossRepository: false,
  headRepositoryNameWithOwner: "acme/app",
  ...overrides,
});

const makeReadModel = () =>
  Effect.gen(function* () {
    const commandId = CommandId.make("thread-create-command");
    const model = yield* projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.make("thread-created-event"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId,
      causationEventId: null,
      correlationId: commandId,
      metadata: {},
      payload: {
        threadId,
        projectId,
        title: "Feature",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/fix",
        worktreePath: cwd,
        createdAt: now,
        updatedAt: now,
      },
    });
    return {
      ...model,
      projects: [
        {
          id: projectId,
          title: "Feature",
          workspaceRoot: "/repo",
          repositoryIdentity: {
            canonicalKey: "github.com/acme/app",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "https://github.com/acme/app.git",
            },
          },
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      ],
    };
  });

const makeHarness = (
  pullRequests: ReadonlyArray<GitHubPullRequestSummary>,
  run: (input: {
    readonly automation: PullRequestCreationAutomationShape;
    readonly repository: PullRequestCreationIntentRepositoryShape;
    readonly commands: ReadonlyArray<OrchestrationCommand>;
    readonly lookups: ReadonlyArray<{ cwd: string; headSelector: string }>;
    readonly advanceTime: () => Effect.Effect<void>;
  }) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const model = yield* makeReadModel();
    const commands: OrchestrationCommand[] = [];
    const lookups: Array<{ cwd: string; headSelector: string }> = [];
    const layer = Layer.mergeAll(
      PullRequestCreationIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      SqlitePersistenceMemory,
      Layer.mock(OrchestrationEngineService)({
        getReadModel: () => Effect.succeed(model),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: model.snapshotSequence + commands.length };
          }),
      }),
      Layer.mock(GitHubCli)({
        listOpenPullRequests: ({ cwd: lookupCwd, headSelector }) =>
          Effect.sync(() => {
            lookups.push({ cwd: lookupCwd, headSelector });
            return pullRequests;
          }),
      }),
    );

    yield* Effect.gen(function* () {
      const automation = yield* makePullRequestCreationAutomation();
      const repository = yield* PullRequestCreationIntentRepository;
      yield* run({
        automation,
        repository,
        commands,
        lookups,
        advanceTime: () => TestClock.adjust("31 seconds"),
      });
    }).pipe(Effect.provide(layer));
  });

it.effect("links a confirmed create once with created provenance", () =>
  makeHarness([], ({ automation, repository, commands }) =>
    Effect.gen(function* () {
      yield* automation.recordIntent(creationIntent);
      yield* automation.handleCreatedResult({
        actionId: creationIntent.actionId,
        threadId,
        projectId,
        cwd,
        pullRequest: createdPullRequest,
      });

      assert.equal(commands.length, 1);
      assert.deepStrictEqual(commands[0], {
        type: "thread.pull-request.link",
        commandId: CommandId.make(`server:created-pr:${creationIntent.actionId}`),
        threadId,
        pullRequest: {
          number: 42,
          title: "Fix the feature",
          url: pullRequestUrl,
          baseBranch: "main",
          headBranch: "feature/fix",
          headSha,
          isCrossRepository: false,
          headRepositoryNameWithOwner: "acme/app",
          state: "open",
        },
        source: "created",
      });
      assert.deepStrictEqual(
        Option.getOrNull(yield* repository.getByActionId({ actionId: creationIntent.actionId })),
        null,
      );
    }),
  ),
);

it.effect("discards a created PR whose head repository differs from the project", () =>
  makeHarness([], ({ automation, repository, commands }) =>
    Effect.gen(function* () {
      yield* automation.recordIntent(creationIntent);
      yield* automation.handleCreatedResult({
        actionId: creationIntent.actionId,
        threadId,
        projectId,
        cwd,
        pullRequest: {
          ...createdPullRequest,
          isCrossRepository: true,
          headRepositoryNameWithOwner: "another-owner/another-repo",
        },
      });

      assert.deepStrictEqual(commands, []);
      assert.deepStrictEqual(
        Option.getOrNull(yield* repository.getByActionId({ actionId: creationIntent.actionId })),
        null,
      );
    }),
  ),
);

it.effect("recovers an ambiguous create only when repository, branch, and head match", () =>
  makeHarness([githubSummary()], ({ automation, repository, commands, lookups, advanceTime }) =>
    Effect.gen(function* () {
      yield* automation.recordIntent(creationIntent);
      yield* advanceTime();
      yield* automation.recoverPending();

      assert.deepStrictEqual(lookups, [{ cwd, headSelector: creationIntent.headSelector }]);
      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.type, "thread.pull-request.link");
      if (commands[0]?.type !== "thread.pull-request.link") {
        throw new Error("Expected a created PR link command.");
      }
      assert.equal(commands[0].source, "created");
      assert.equal(commands[0].pullRequest.headSha, headSha);
      assert.deepStrictEqual(
        Option.getOrNull(yield* repository.getByActionId({ actionId: creationIntent.actionId })),
        null,
      );
    }),
  ),
);

it.effect("keeps a same-branch PR unassociated when its head differs from the intent", () =>
  makeHarness(
    [githubSummary({ headRefOid: "fedcba9876543210" })],
    ({ automation, repository, commands, advanceTime }) =>
      Effect.gen(function* () {
        yield* automation.recordIntent(creationIntent);
        yield* advanceTime();
        yield* automation.recoverPending();

        assert.deepStrictEqual(commands, []);
        const stored = yield* repository.getByActionId({ actionId: creationIntent.actionId });
        assert(Option.isSome(stored));
        if (Option.isSome(stored)) {
          assert.equal(stored.value.attemptCount, 1);
          assert.equal(stored.value.nextAttemptAt, "1970-01-01T00:01:01.000Z");
        }
      }),
  ),
);
