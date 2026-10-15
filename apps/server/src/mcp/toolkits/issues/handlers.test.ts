import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueDetail,
  type OrchestrationProjectShell,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as IssueService from "../../../issue/IssueService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as IssuesHandlers from "./handlers.ts";
import { IssuesToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const GITHUB = IssueTrackerKind.make("github");

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

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
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
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function makeThread(issues: ReadonlyArray<ThreadIssueLink>) {
  return {
    ...v2PullRequestThread({
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    }),
    issues,
  };
}

const detail: IssueDetail = {
  tracker: GITHUB,
  host: "github.com",
  scope: "t3tools/t3code",
  key: "7",
  displayKey: "#7",
  title: "Seven",
  url: "https://github.com/T3Tools/T3Code/issues/7",
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  projectId: PROJECT_ID,
  projectTitle: "Project",
  writable: true,
  capabilities: {
    create: true,
    edit: true,
    comment: true,
    labels: true,
    assignees: true,
    reactions: false,
    templates: false,
    linkedPullRequests: true,
    events: true,
    search: true,
    states: [],
    closeReasons: [],
  },
  viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
  viewer: null,
  body: "",
  comments: [],
  commentsCursor: null,
  events: [],
  linkedPullRequests: [],
};

const makeHarness = Effect.fn("makeIssuesToolkitHarness")(function* (
  issues: ReadonlyArray<ThreadIssueLink> = [],
) {
  const links = yield* Ref.make<ReadonlyArray<ThreadIssueService.LinkThreadIssueInput>>([]);
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: (id) => Effect.succeed(id === PROJECT_ID ? Option.some(project) : Option.none()),
      listShells: () => Effect.succeed([project]),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) => Effect.succeed(id === THREAD_ID ? makeThread(issues) : null),
    }),
    Layer.mock(IssueService.IssueService)({
      detail: () => Effect.succeed(detail),
      resolveUrl: (url) =>
        Effect.succeed({
          projectId: PROJECT_ID,
          tracker: GITHUB,
          host: "github.com",
          scope: "t3tools/t3code",
          key: url.split("/").at(-1)!,
          writable: true,
        }),
    }),
    Layer.mock(ThreadIssueService.ThreadIssueService)({
      link: (input) =>
        Ref.update(links, (recorded) => [...recorded, input]).pipe(
          Effect.as({ alreadyLinked: false }),
        ),
      unlink: () => Effect.succeed({ wasLinked: true }),
    }),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* IssuesToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(IssuesHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof IssuesToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["issues"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof IssuesToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(layerDependencies),
    );
  return { links, call };
});

describe("issue toolkit handlers", () => {
  it.effect("refuses a credential without the issues capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_issues", {}, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "issues" });
    }),
  );

  it.effect("links by URL with source agent on the token's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_issue", {
        url: "https://github.com/T3Tools/T3Code/issues/7",
      });
      expect(result).toEqual({
        projectId: PROJECT_ID,
        tracker: "github",
        host: "github.com",
        scope: "t3tools/t3code",
        key: "7",
        url: "https://github.com/T3Tools/T3Code/issues/7",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.links)).toEqual([
        {
          threadId: THREAD_ID,
          ref: {
            projectId: PROJECT_ID,
            tracker: "github",
            host: "github.com",
            scope: "t3tools/t3code",
            key: "7",
          },
          url: "https://github.com/T3Tools/T3Code/issues/7",
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("links by key through the thread's project and reads the URL from the tracker", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_issue", { key: "7" });
      expect(result.url).toBe(detail.url);
      expect(result.scope).toBe("T3Tools/T3Code");
      expect((yield* Ref.get(harness.links))[0]?.url).toBe(detail.url);
    }),
  );

  it.effect("lists linked issues from the thread shell with their snapshots", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        {
          tracker: GITHUB,
          host: "github.com",
          scope: "t3tools/t3code",
          key: "7",
          projectId: PROJECT_ID,
          url: detail.url,
          source: "manual",
          linkedAt: "2026-08-10T00:00:00.000Z",
          snapshot: {
            displayKey: "#7",
            title: "Seven",
            state: { category: "open", name: "open" },
            syncedAt: "2026-08-10T00:00:00.000Z",
          },
        },
      ]);
      const result = yield* harness.call("list_thread_issues", {});
      expect(result.issues).toMatchObject([{ key: "7", title: "Seven", displayKey: "#7" }]);
      const unlinked = yield* harness.call("unlink_issue", { url: detail.url });
      expect(unlinked.wasLinked).toBe(true);
    }),
  );
});
