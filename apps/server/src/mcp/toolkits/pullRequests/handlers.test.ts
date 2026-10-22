import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  PullRequestOperationError,
  type OrchestrationProjectShell,
  type PullRequestRef,
  type PullRequestReviewGuideResult,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { listThreadPullRequests } from "./handlers.ts";
import * as PullRequestsHandlers from "./handlers.ts";
import { PullRequestsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: "github",
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
  readonly reject?: (command: OrchestrationCommand) => string | null;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly generate?: (
    input: PullRequestRef,
  ) => Effect.Effect<
    PullRequestReviewGuideResult & { started: boolean },
    PullRequestOperationError
  >;
}

const NO_GUIDE: PullRequestReviewGuideResult = { guide: null, run: null, currentHeadSha: "head-1" };

const makeHarness = Effect.fn("makePullRequestsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const guideRequests = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const thread = options.thread === undefined ? makeThread([]) : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null)
        return yield* new Orchestrator.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: rejection,
        });
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1, storedEvents: [] };
    });
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeed(Option.fromNullishOr(project)),
      listShells: () => Effect.succeed(options.projects ?? (project ? [project] : [])),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      hostDetails: (input) =>
        Ref.update(guideRequests, (values) => [...values, input]).pipe(Effect.as(null)),
      runHostAction: (input) =>
        Ref.update(guideRequests, (values) => [...values, input]).pipe(
          Effect.as({ message: "Pull request updated.", url: null }),
        ),
    }),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({
      get: () => Effect.succeed(NO_GUIDE),
      generate: (input) =>
        Ref.update(guideRequests, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.generate?.(input) ??
              Effect.succeed({
                ...NO_GUIDE,
                run: {
                  _tag: "Running" as const,
                  headSha: "head-1",
                  startedAt: "2026-10-11T00:00:00.000Z",
                },
                started: true,
              }),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Effect.succeed(id === THREAD_ID && thread ? v2PullRequestThread(thread) : null),
      dispatch,
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(PullRequestsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PullRequestsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(layerDependencies),
    );
  return { commands, guideRequests, call };
});

describe("pull request toolkit handlers", () => {
  it.effect("refuses a credential without the pull-requests capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_pull_requests", {}, ["preview"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "pull-requests",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links by URL with source agent on the token's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 123,
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.link",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 123,
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("watching an unlinked pull request links it first", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("watch_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(result).toMatchObject({ number: 9, watching: false, wasWatching: false });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.watch",
          number: 9,
          watching: true,
          link: { url: "https://github.com/t3tools/t3code/pull/9", source: "agent" },
        },
      ]);
    }),
  );

  it.effect("refuses to watch a merged pull request and stops an existing watch", () =>
    Effect.gen(function* () {
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
        thread: makeThread([
          { ...merged, snapshot: merged.snapshot && { ...merged.snapshot, state: "merged" } },
          makeLink(2, { headBranch: "idle" }),
          makeLink(3, { headBranch: "watched", watch }),
        ]),
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestNotOpenError", state: "merged" });
      expect(
        yield* harness.call("unwatch_pull_request", { repository: "t3tools/t3code", number: 3 }),
      ).toMatchObject({ wasWatching: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 3, watching: false },
      ]);
    }),
  );

  it.effect("watches a pull request saved as closed, since it may have reopened", () =>
    Effect.gen(function* () {
      const closed = makeLink(1, { headBranch: "closed" });
      const harness = yield* makeHarness({
        thread: makeThread([
          { ...closed, snapshot: closed.snapshot && { ...closed.snapshot, state: "closed" } },
        ]),
      });
      yield* harness.call("watch_pull_request", { repository: "t3tools/t3code", number: 1 });
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
        .call("watch_pull_request", { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestWatchFromSubagentError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("builds the URL in the project host's own shape", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "gitlab.com/group/sub/project",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.com:group/sub/project.git",
          },
          provider: "gitlab",
          displayName: "group/sub/project",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "group/sub/project",
        number: 42,
      });
      expect(result.url).toBe("https://gitlab.com/group/sub/project/-/merge_requests/42");
      expect(result.host).toBe("gitlab.com");
    }),
  );

  it.effect("links a numeric Forgejo reference with its remote's web origin and mount path", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "forge.example/git/owner/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "http://forge.example:3000/git/owner/repo.git",
          },
          provider: "forgejo",
          displayName: "git/owner/repo",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "git/owner/repo",
        number: 42,
      });
      expect(result).toEqual({
        host: "forge.example:3000",
        repository: "git/owner/repo",
        number: 42,
        url: "http://forge.example:3000/git/owner/repo/pulls/42",
        alreadyLinked: false,
      });
      const other = yield* harness.call("link_pull_request", {
        host: "other.example",
        repository: "owner/repo",
        number: 42,
      });
      expect(other.url).toBe("https://other.example/owner/repo/pull/42");
    }),
  );

  it.effect("links Azure DevOps Server URLs and numeric references without a known provider", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "scm.example.test/tfs/collection/project/_git/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "http://dummy:secret@scm.example.test:8080/tfs/Collection/Project/_git/Repo",
          },
          provider: "unknown",
          displayName: "tfs/collection/project/_git/repo",
        }),
      });
      const generated =
        "http://scm.example.test:8080/tfs/collection/project/_git/repo/pullrequest/124";
      const fromNumber = yield* harness.call("link_pull_request", {
        repository: "tfs/Collection/Project/_git/Repo",
        number: 124,
      });
      expect.soft(fromNumber.url).toBe(generated);

      const supplied = "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/123";
      const fromUrl = yield* harness.call("link_pull_request", { url: supplied });
      expect(fromUrl).toEqual({
        host: "scm.example.test",
        repository: "tfs/collection/project/_git/repo",
        number: 123,
        url: supplied,
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.link", number: 124, url: generated },
        { type: "thread.pull-request.link", number: 123, url: supplied },
      ]);
    }),
  );

  it.effect("treats a duplicate link as alreadyLinked rather than an error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(123)]),
        reject: (command) =>
          command.type === "thread.pull-request.link" ? "already linked" : null,
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/123",
      });
      expect(result.alreadyLinked).toBe(true);
    }),
  );

  it.effect("unlinks a linked pull request and reports a missing one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        reject: (command) =>
          command.type === "thread.pull-request.unlink" && command.number !== 5
            ? "not linked"
            : null,
      });
      const linked = yield* harness.call("unlink_pull_request", {
        repository: "t3tools/t3code",
        number: 5,
      });
      expect(linked).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 5,
        wasLinked: true,
      });
      const missing = yield* harness.call("unlink_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(missing.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 5 },
      ]);
    }),
  );

  it("reports an older Forgejo link's HTTP port when listing thread links", () => {
    const result = listThreadPullRequests(
      makeThread([
        makeLink(42, {
          host: "forge.example",
          url: "http://forge.example:3000/t3tools/t3code/pulls/42",
        }),
      ]),
    );
    expect(result.pullRequests[0]?.host).toBe("forge.example:3000");
  });

  it.effect("lists visible links with host state and derived chain order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([
          makeLink(3, { headBranch: "feat-c", baseBranch: "feat-b", source: "agent" }),
          makeLink(1, { headBranch: "feat-a", baseBranch: "main", source: "created" }),
          makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a", source: "agent" }),
          makeLink(9, { source: "stack-dismissed" }),
          makeLink(10),
        ]),
      });
      const result = yield* harness.call("list_thread_pull_requests", {});
      expect(result.pullRequests.map((entry) => entry.number)).toEqual([3, 1, 2, 10]);
      expect(result.pullRequests[0]).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 3,
        url: "https://github.com/t3tools/t3code/pull/3",
        source: "agent",
        watching: false,
        state: "open",
        title: "PR 3",
        headBranch: "feat-c",
        baseBranch: "feat-b",
        isDraft: false,
        stack: { kind: "derived", position: 3, size: 3 },
      });
      expect(result.pullRequests[3]).toMatchObject({
        number: 10,
        state: null,
        title: null,
        headBranch: null,
        stack: null,
      });
      expect(result.chains).toEqual([
        { kind: "derived", numbers: [1, 2, 3] },
        { kind: "derived", numbers: [10] },
      ]);
    }),
  );
});

describe("listThreadPullRequests", () => {
  it("reports a native stack position for each member", () => {
    const stack = {
      kind: "native" as const,
      id: "stack-1",
      number: 1,
      url: "https://github.com/t3tools/t3code/stack/1",
      base: "main",
      layers: [
        { number: 1, headBranch: "a", state: "open" as const },
        { number: 2, headBranch: "b", state: "open" as const },
      ],
    };
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(2, { stack, source: "stack" }),
        makeLink(1, { stack, source: "created" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [2, { kind: "native", position: 2, size: 2 }],
      [1, { kind: "native", position: 1, size: 2 }],
    ]);
    expect(result.chains).toEqual([{ kind: "native", numbers: [1, 2] }]);
  });

  it("gives pull requests built on the same one the same position", () => {
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(1, { headBranch: "feat-a", baseBranch: "main" }),
        makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a" }),
        makeLink(3, { headBranch: "feat-c", baseBranch: "feat-a" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [1, { kind: "derived", position: 1, size: 3 }],
      [2, { kind: "derived", position: 2, size: 3 }],
      [3, { kind: "derived", position: 2, size: 3 }],
    ]);
    expect(result.chains).toEqual([{ kind: "derived", numbers: [1, 2, 3] }]);
  });
});

describe("pull request guide tools", () => {
  it.effect(
    "writes guides through the project whose checkout is each pull request's repository",
    () =>
      Effect.gen(function* () {
        const other = {
          ...makeProject({
            canonicalKey: "github.com/acme/web",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:acme/web.git",
            },
            provider: "github",
            displayName: "acme/web",
            owner: "acme",
            name: "web",
          }),
          id: ProjectId.make("project-web"),
        };
        const harness = yield* makeHarness({ projects: [makeProject(), other] });
        const result = yield* harness.call("write_pull_request_guides", {
          pullRequests: [
            { url: "https://github.com/acme/web/pull/7" },
            { repository: "t3tools/t3code", number: 12 },
            { url: "https://github.com/someone/else/pull/1" },
          ],
        });
        expect(
          result.guides.map((guide) => [guide.repository, guide.number, guide.outcome]),
        ).toEqual([
          ["acme/web", 7, "started"],
          ["t3tools/t3code", 12, "started"],
          ["someone/else", 1, "failed"],
        ]);
        expect(result.guides[2]?.detail).toContain("No project in this environment");
        expect(
          (yield* Ref.get(harness.guideRequests)).map((ref) => [ref.projectId, ref.number]),
        ).toEqual([
          ["project-web", 7],
          [PROJECT_ID, 12],
        ]);
      }),
  );

  it.effect("reports an unreadable entry on its own and still writes the rest of the batch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [
          { url: "https://example.com/not-a-pull-request" },
          { repository: "t3tools/t3code" },
          { repository: "t3tools/t3code", number: 5 },
        ],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["failed", "failed", "started"]);
      expect(result.guides[0]?.detail).toContain("not a recognised pull request URL");
      expect(result.guides[1]?.detail).toContain("Pass either url");
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.number)).toEqual([5]);
    }),
  );

  it.effect("finds an Azure DevOps checkout for a pull request named by its full path", () =>
    Effect.gen(function* () {
      const azure = {
        ...makeProject({
          canonicalKey: "dev.azure.com/org/project/_git/web",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://dev.azure.com/org/project/_git/web",
          },
          provider: "azure-devops",
          displayName: "org/project/_git/web",
          owner: "org",
          name: "web",
        }),
        id: ProjectId.make("project-azure"),
      };
      const harness = yield* makeHarness({ projects: [makeProject(), azure] });
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [{ host: "dev.azure.com", repository: "org/project/_git/web", number: 9 }],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["started"]);
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.projectId)).toEqual([
        "project-azure",
      ]);
    }),
  );
});

it.effect("preserves typed resolution failures for host reads and actions", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const input = { url: "https://example.com/private?token=secret" };
    const readFailure = yield* harness
      .call("read_pull_request_host_details", input)
      .pipe(Effect.flip);
    const actionFailure = yield* harness
      .call("run_pull_request_host_action", {
        ...input,
        action: { type: "vote", vote: "reset" },
      })
      .pipe(Effect.flip);
    const guideFailure = yield* harness.call("read_pull_request_guide", input).pipe(Effect.flip);
    for (const failure of [readFailure, actionFailure, guideFailure]) {
      expect(failure).toMatchObject({ _tag: "PullRequestUrlInvalidError" });
      expect(failure.message).not.toContain(input.url);
      expect(failure).not.toHaveProperty("operation");
    }
    expect(yield* Ref.get(harness.guideRequests)).toEqual([]);
  }),
);

it.effect(
  "routes native PR reads and writes through the matching project and requires its capability",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("read_pull_request_host_details", {
        url: "https://github.com/t3tools/t3code/pull/7",
      });
      yield* harness.call("run_pull_request_host_action", {
        url: "https://github.com/t3tools/t3code/pull/7",
        action: { type: "vote", vote: "reset" },
      });
      expect(yield* Ref.get(harness.guideRequests)).toEqual([
        { projectId: PROJECT_ID, host: "github.com", repository: "t3tools/t3code", number: 7 },
        {
          projectId: PROJECT_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 7,
          action: { type: "vote", vote: "reset" },
        },
      ]);
      yield* harness
        .call(
          "run_pull_request_host_action",
          {
            url: "https://github.com/t3tools/t3code/pull/7",
            action: { type: "vote", vote: "reset" },
          },
          [],
        )
        .pipe(Effect.flip);
      expect(yield* Ref.get(harness.guideRequests)).toHaveLength(2);
    }),
);
