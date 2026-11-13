import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  type PullRequestSummary,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  type OrchestrationProjectShell,
  type ThreadPullRequestLink,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as PullRequestWatchService from "./PullRequestWatchService.ts";
import type { PullRequestTarget } from "./pullRequestTarget.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(7));

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "T3Tools/T3Code",
    owner: "T3Tools",
    name: "T3Code",
  },
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(pullRequests: ReadonlyArray<ThreadPullRequestLink>): PullRequestTestThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  };
}

function makeLink(
  number: number,
  overrides: Partial<ThreadPullRequestLink> & {
    readonly headBranch?: string;
    readonly baseBranch?: string;
  } = {},
): ThreadPullRequestLink {
  const { headBranch, baseBranch, ...rest } = overrides;
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      headBranch === undefined
        ? null
        : {
            state: "open",
            title: `PR ${number}`,
            headBranch,
            baseBranch: baseBranch ?? "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-08-27T00:00:00.000Z",
          },
    stack: null,
    ...rest,
  };
}

interface HarnessOptions {
  readonly thread?: PullRequestTestThread | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly readFailure?: PullRequestService.PullRequestError;
  readonly readState?: PullRequestSummary["state"];
}

const makeHarness = Effect.fn("makePullRequestWatchHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const thread = options.thread === undefined ? makeThread([]) : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeed(Option.fromNullishOr(project)),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Effect.succeed(id === thread?.id ? v2PullRequestThread(thread) : null),
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      summary: (input) =>
        options.readFailure !== undefined
          ? Effect.fail(options.readFailure)
          : Effect.succeed({
              ...input,
              provider: SourceControlProviderKind.make("github"),
              title: "Pull request",
              url: `https://github.com/${input.repository}/pull/${input.number}`,
              state: options.readState ?? "open",
              headBranch: "feature",
              baseBranch: "main",
              updatedAt: "2026-08-20T00:00:00.000Z",
            }),
    }),
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
  );
  const service = yield* PullRequestWatchService.PullRequestWatchService.pipe(
    Effect.provide(PullRequestWatchService.layer.pipe(Layer.provide(dependencies))),
  );
  return {
    commands,
    setWatching: (watching: boolean, target: PullRequestTarget) =>
      service.setWatching({ threadId: THREAD_ID, target, watching }),
  };
});

describe("PullRequestWatchService", () => {
  it.effect("links an unlinked watch even while the host has a transient read failure", () =>
    Effect.gen(function* () {
      for (const options of [
        {},
        {
          readFailure: new PullRequestOperationError({
            operation: "summary",
            detail: "The host is temporarily unavailable.",
          }),
        },
      ]) {
        const harness = yield* makeHarness(options);
        const result = yield* harness.setWatching(true, {
          url: "https://github.com/t3tools/t3code/pull/9",
        });
        expect(result).toMatchObject({ number: 9, wasWatching: false });
        expect(yield* Ref.get(harness.commands)).toMatchObject([
          {
            type: "thread.pull-request.watch",
            number: 9,
            watching: true,
            link: { url: "https://github.com/t3tools/t3code/pull/9", source: "agent" },
          },
        ]);
      }
    }),
  );

  it.effect("reports a missing hosting CLI before saving a watch and still allows unwatch", () =>
    Effect.gen(function* () {
      const missing = new PullRequestUnavailableError({
        reason: "cli-missing",
        provider: SourceControlProviderKind.make("gitlab"),
        requirement: "Install glab on the T3 server's PATH.",
      });
      const harness = yield* makeHarness({ readFailure: missing });
      const target = { url: "https://gitlab.example.com/team/project/-/merge_requests/42" };
      const error = yield* harness.setWatching(true, target).pipe(Effect.flip);
      expect(error).toEqual(missing);
      expect(yield* Ref.get(harness.commands)).toEqual([]);

      yield* harness.setWatching(false, target);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", watching: false },
      ]);
    }),
  );

  it.effect("rejects merged PRs and keeps an active watch usable without hosting access", () =>
    Effect.gen(function* () {
      const freshMerged = yield* makeHarness({ readState: "merged" });
      const freshError = yield* freshMerged
        .setWatching(true, { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(freshError).toMatchObject({ _tag: "PullRequestNotOpenError", state: "merged" });
      expect(yield* Ref.get(freshMerged.commands)).toEqual([]);

      const watch = {
        startedAt: "2026-08-20T00:00:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-08-20T00:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      };
      const merged = makeLink(1, { headBranch: "done" });
      const harness = yield* makeHarness({
        readFailure: new PullRequestUnavailableError({ reason: "cli-missing" }),
        thread: makeThread([
          { ...merged, snapshot: merged.snapshot && { ...merged.snapshot, state: "merged" } },
          makeLink(2, { headBranch: "idle" }),
          makeLink(3, { headBranch: "watched", watch }),
        ]),
      });
      const error = yield* harness
        .setWatching(true, { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestNotOpenError", state: "merged" });
      expect(
        yield* harness.setWatching(true, { repository: "t3tools/t3code", number: 3 }),
      ).toMatchObject({ watching: true, wasWatching: true });
      expect(
        yield* harness.setWatching(false, { repository: "t3tools/t3code", number: 3 }),
      ).toMatchObject({ wasWatching: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 3, watching: true },
        { type: "thread.pull-request.watch", number: 3, watching: false },
      ]);
    }),
  );

  it.effect("watches a pull request saved as closed, since it may have reopened", () =>
    Effect.gen(function* () {
      const closed = makeLink(1, { headBranch: "closed" });
      const harness = yield* makeHarness({
        readState: "closed",
        thread: makeThread([
          { ...closed, snapshot: closed.snapshot && { ...closed.snapshot, state: "closed" } },
        ]),
      });
      yield* harness.setWatching(true, { repository: "t3tools/t3code", number: 1 });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 1, watching: true },
      ]);
    }),
  );

  it.effect("refuses a watch from a subagent thread, whose parent owns the pull request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: {
          ...makeThread([makeLink(1, { headBranch: "feature" })]),
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        },
      });
      const error = yield* harness
        .setWatching(true, { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestWatchFromSubagentError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );
});
