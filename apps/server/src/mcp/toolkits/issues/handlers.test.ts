import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueDetail,
  type OrchestrationProjectShell,
  type ThreadIssueLink,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as IssueService from "../../../issue/IssueService.ts";
import * as IssueTrackerRegistry from "../../../issue/IssueTrackerRegistry.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as IssueTrackerBindings from "../../../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
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
    provider: SourceControlProviderKind.make("github"),
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
  },
  states: [],
  viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
  viewer: null,
  body: "",
  comments: [],
  commentsCursor: null,
  events: [],
  linkedPullRequests: [],
};

const projectLayer = Layer.mock(ProjectService.ProjectService)({
  getShell: (id) => Effect.succeed(id === PROJECT_ID ? Option.some(project) : Option.none()),
  listShells: () => Effect.succeed([project]),
});

const makeHarness = Effect.fn("makeIssuesToolkitHarness")(function* (
  issues: ReadonlyArray<ThreadIssueLink> = [],
  issueLayer?: Layer.Layer<IssueService.IssueService>,
) {
  const links = yield* Ref.make<ReadonlyArray<ThreadIssueService.LinkThreadIssueInput>>([]);
  const layerDependencies = Layer.mergeAll(
    projectLayer,
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) => Effect.succeed(id === THREAD_ID ? makeThread(issues) : null),
    }),
    issueLayer ??
      Layer.mock(IssueService.IssueService)({
        detail: () => Effect.succeed(detail),
        linkMetadata: () => Effect.succeed(detail),
        projectScope: (projectId) =>
          Effect.succeed({
            projectId,
            tracker: GITHUB,
            host: "github.com",
            scope: "t3tools/t3code",
          }),
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
  it.effect("returns a Linear issue by URL with one issue read left before the rate limit", () =>
    Effect.gen(function* () {
      const tracker = IssueTrackerKind.make("linear");
      const host = "linear.app";
      const url = "https://linear.app/acme/issue/ENG-7/seven";
      const readsLeft = yield* Ref.make(1);
      const linear: StandaloneIssueTrackerApi = {
        kind: tracker,
        capabilities: detail.capabilities,
        standalone: {
          tracker,
          displayName: "Linear",
          host,
          scopeNoun: "team",
          credential: { label: "Personal API key", helpUrl: null },
        },
        parseIssueUrl: (link) =>
          link.href === url ? { host, workspace: "acme", scope: "ENG", key: "ENG-7" } : null,
        probeCredential: () => Effect.succeed({ account: "user", scopes: [] }),
        getViewer: () => Effect.succeed("user"),
        listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
        getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
        getIssue: ({ key }) =>
          Ref.getAndUpdate(readsLeft, (left) => left - 1).pipe(
            Effect.flatMap((left) =>
              left > 0
                ? Effect.succeed({
                    ...detail,
                    reactions: [],
                    key,
                    url,
                    displayKey: key,
                    body: "Repro steps",
                  })
                : Effect.fail(
                    new IssueTrackerError({
                      tracker,
                      operation: "getIssue",
                      reason: "rate-limited",
                      detail: "Linear's rate limit was reached.",
                    }),
                  ),
            ),
          ),
      };
      const issueLayer = IssueService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            projectLayer,
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
            Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
              list: () => Effect.succeed(new Map([[PROJECT_ID, { tracker, scope: "ENG" }]])),
            }),
            Layer.succeed(
              IssueTrackerRegistry.IssueTrackerRegistry,
              IssueTrackerRegistry.fromTrackers([linear]),
            ),
          ),
        ),
      );
      const harness = yield* makeHarness([], issueLayer);
      const result = yield* harness.call("read_issue", { url }).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Success",
        success: { url, displayKey: "ENG-7", title: "Seven", body: "Repro steps" },
      });
    }),
  );

  it.effect("files an issue in the bound Linear team an agent names", () =>
    Effect.gen(function* () {
      const tracker = IssueTrackerKind.make("linear");
      const host = "linear.app";
      const filedIn = yield* Ref.make<ReadonlyArray<string>>([]);
      const linear: StandaloneIssueTrackerApi = {
        kind: tracker,
        capabilities: detail.capabilities,
        standalone: {
          tracker,
          displayName: "Linear",
          host,
          scopeNoun: "team",
          credential: { label: "Personal API key", helpUrl: null },
        },
        parseIssueUrl: () => null,
        probeCredential: () => Effect.succeed({ account: "user", scopes: [] }),
        getViewer: () => Effect.succeed("user"),
        listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
        getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
        getIssue: () => Effect.die("unused"),
        create: ({ scope }) =>
          Ref.update(filedIn, (teams) => [...teams, scope]).pipe(
            Effect.as({
              key: `${scope}-1`,
              url: `https://linear.app/acme/issue/${scope}-1`,
              displayKey: `${scope}-1`,
            }),
          ),
      };
      const issueLayer = IssueService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            projectLayer,
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
            Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
              list: () =>
                Effect.succeed(
                  new Map([[PROJECT_ID, { tracker, scope: "ENG", additionalScopes: ["OPS"] }]]),
                ),
            }),
            Layer.succeed(
              IssueTrackerRegistry.IssueTrackerRegistry,
              IssueTrackerRegistry.fromTrackers([linear]),
            ),
          ),
        ),
      );
      const harness = yield* makeHarness([], issueLayer);

      expect(
        yield* harness.call("create_issue", { title: "Backup ran twice", scope: "ops" }),
      ).toMatchObject({ tracker, scope: "OPS", key: "OPS-1" });
      expect(yield* harness.call("create_issue", { title: "Label typo" })).toMatchObject({
        scope: "ENG",
        key: "ENG-1",
      });
      const unbound = yield* harness
        .call("create_issue", { title: "Flaky test", scope: "QA" })
        .pipe(Effect.flip);
      expect(unbound).toMatchObject({ _tag: "IssueOperationError", reason: "not-found" });
      expect(unbound.message).toContain("Use one of: ENG, OPS.");
      expect(yield* Ref.get(filedIn)).toEqual(["OPS", "ENG"]);
    }),
  );

  it.effect("refuses a credential without the issues capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_issues", {}, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "issues" });
      // Naming the project or the issue outright must not skip the check.
      const refused = { _tag: "McpCapabilityUnavailableError", capability: "issues" };
      expect(
        yield* harness
          .call("list_issues", { projectId: PROJECT_ID }, ["pull-requests"])
          .pipe(Effect.flip),
      ).toMatchObject(refused);
      expect(
        yield* harness
          .call("read_issue", { projectId: PROJECT_ID, key: "7" }, ["pull-requests"])
          .pipe(Effect.flip),
      ).toMatchObject(refused);
      expect(
        yield* harness
          .call("read_issue", { projectId: PROJECT_ID, url: detail.url }, ["pull-requests"])
          .pipe(Effect.flip),
      ).toMatchObject(refused);
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
          displayKey: detail.displayKey,
          title: detail.title,
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
      expect((yield* Ref.get(harness.links))[0]?.url).toBe(detail.url);
      // Named by key and never read: the identity has no URL rather than an empty one, so it can
      // be handed to another issue tool as it is.
      const unlinked = yield* harness.call("unlink_issue", { key: "7" });
      expect(unlinked).toMatchObject({ key: "7", wasLinked: false });
      expect(unlinked).not.toHaveProperty("url");
    }),
  );

  it.effect("lists linked issues from the thread shell as they were named when linked", () =>
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
          displayKey: "#7",
          title: "Seven",
        },
      ]);
      const result = yield* harness.call("list_thread_issues", {});
      expect(result.issues).toMatchObject([{ key: "7", title: "Seven", displayKey: "#7" }]);
      const unlinked = yield* harness.call("unlink_issue", { url: detail.url });
      expect(unlinked.wasLinked).toBe(true);
    }),
  );

  it.effect(
    "supports native Linear sub-issues, blocking deps, metadata, and project dependencies via MCP",
    () =>
      Effect.gen(function* () {
        const tracker = IssueTrackerKind.make("linear");
        const host = "linear.app";
        const calls = yield* Ref.make<Array<unknown>>([]);
        const linearCaps = {
          ...detail.capabilities,
          relations: true,
          subIssues: true,
          projects: true,
          cycles: true,
          priority: true,
          estimate: true,
          dueDate: true,
        };
        const linear: StandaloneIssueTrackerApi = {
          kind: tracker,
          capabilities: linearCaps,
          standalone: {
            tracker,
            displayName: "Linear",
            host,
            scopeNoun: "team",
            credential: { label: "Personal API key", helpUrl: null },
          },
          parseIssueUrl: () => null,
          probeCredential: () => Effect.succeed({ account: "user", scopes: [] }),
          getViewer: () => Effect.succeed("user"),
          listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
          getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
          getIssue: () =>
            Effect.succeed({
              ...detail,
              key: "AI-1527",
              displayKey: "AI-1527",
              url: "https://linear.app/ai-dmc/issue/AI-1527",
              priority: "high",
              parent: {
                scope: "AI",
                key: "AI-1524",
                displayKey: "AI-1524",
                title: "Spec",
                url: "https://linear.app/ai-dmc/issue/AI-1524",
                state: { category: "open", name: "In Progress" },
              },
              subIssues: [],
              relations: [
                {
                  id: "rel_1",
                  kind: "blocked-by",
                  issue: {
                    scope: "AI",
                    key: "AI-1525",
                    displayKey: "AI-1525",
                    title: "Step 1",
                    url: "https://linear.app/ai-dmc/issue/AI-1525",
                    state: { category: "open", name: "Todo" },
                  },
                },
              ],
            }),
          listCandidates: () =>
            Effect.succeed({
              labels: [{ name: "Backend", color: "#00f", description: null }],
              assignees: [{ id: "u1", login: "max", name: "Max", avatarUrl: null }],
              projects: [{ id: "p1", name: "Catalog", milestones: [], relations: [] }],
              cycles: [{ id: "c1", number: 12, name: "Cycle 12" }],
              states: [{ category: "open", name: "Todo" }],
              truncated: false,
            }),
          create: (input) =>
            Ref.update(calls, (all) => [...all, { op: "create", input }]).pipe(
              Effect.as({
                key: "AI-1527",
                displayKey: "AI-1527",
                url: "https://linear.app/ai-dmc/issue/AI-1527",
              }),
            ),
          update: (input) => Ref.update(calls, (all) => [...all, { op: "update", input }]),
          setRelation: (input) =>
            Ref.update(calls, (all) => [...all, { op: "setRelation", input }]),
          createProject: (input) =>
            Ref.update(calls, (all) => [...all, { op: "createProject", input }]).pipe(
              Effect.as({ id: "p2", name: input.name, milestones: [], relations: [] }),
            ),
          setProjectRelation: (input) =>
            Ref.update(calls, (all) => [...all, { op: "setProjectRelation", input }]),
        };
        const issueLayer = IssueService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              projectLayer,
              Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
              Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
                list: () => Effect.succeed(new Map([[PROJECT_ID, { tracker, scope: "AI" }]])),
              }),
              Layer.succeed(
                IssueTrackerRegistry.IssueTrackerRegistry,
                IssueTrackerRegistry.fromTrackers([linear]),
              ),
            ),
          ),
        );
        const harness = yield* makeHarness([], issueLayer);

        const metadata = yield* harness.call("list_issue_metadata", {});
        expect(metadata.projects).toEqual([
          { id: "p1", name: "Catalog", milestones: [], relations: [] },
        ]);

        const created = yield* harness.call("create_issue", {
          title: "Step 2",
          parent: "AI-1524",
          project: "Catalog",
          priority: "high",
          blockedBy: ["AI-1525"],
        });
        expect(created.key).toBe("AI-1527");

        yield* harness.call("update_issue", {
          key: "AI-1527",
          parent: "AI-1524",
          project: "Catalog",
          estimate: 2,
        });

        yield* harness.call("set_issue_deps", {
          key: "AI-1527",
          blockedBy: ["AI-1525"],
          blocks: ["AI-1528"],
        });

        const createdProject = yield* harness.call("create_issue_project", {
          name: "Rollout",
          milestones: [{ name: "M1" }],
        });
        expect(createdProject.project).toMatchObject({ id: "p2", name: "Rollout" });

        yield* harness.call("set_issue_project_deps", {
          project: "Catalog",
          kind: "blocks",
          targetProject: "Rollout",
        });

        const read = yield* harness.call("read_issue", { key: "AI-1527" });
        expect(read.parent).toMatchObject({ key: "AI-1524" });
        expect(read.relations).toEqual([
          expect.objectContaining({
            kind: "blocked-by",
            issue: expect.objectContaining({ key: "AI-1525" }),
          }),
        ]);

        const recorded = yield* Ref.get(calls);
        expect(recorded).toEqual([
          expect.objectContaining({
            op: "create",
            input: expect.objectContaining({
              parent: "AI-1524",
              project: "Catalog",
              priority: "high",
              blockedBy: ["AI-1525"],
            }),
          }),
          expect.objectContaining({
            op: "update",
            input: expect.objectContaining({
              key: "AI-1527",
              parent: "AI-1524",
              project: "Catalog",
              estimate: 2,
            }),
          }),
          expect.objectContaining({
            op: "setRelation",
            input: expect.objectContaining({
              key: "AI-1527",
              action: "add",
              kind: "blocks",
              targetKey: "AI-1528",
            }),
          }),
          expect.objectContaining({
            op: "setRelation",
            input: expect.objectContaining({
              key: "AI-1527",
              action: "add",
              kind: "blocked-by",
              targetKey: "AI-1525",
            }),
          }),
          expect.objectContaining({
            op: "createProject",
            input: expect.objectContaining({ name: "Rollout", milestones: [{ name: "M1" }] }),
          }),
          expect.objectContaining({
            op: "setProjectRelation",
            input: expect.objectContaining({
              action: "add",
              project: "Catalog",
              kind: "blocks",
              targetProject: "Rollout",
            }),
          }),
        ]);
      }),
  );
});
