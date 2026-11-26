import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
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
import { McpSchema, type Tool } from "effect/ai";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import * as IssueService from "../../../issue/IssueService.ts";
import * as IssueTrackerRegistry from "../../../issue/IssueTrackerRegistry.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as IssueTrackerBindings from "../../../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as McpClientInput from "../../McpClientInput.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as IssuesHandlers from "./handlers.ts";
import { T3_MCP_TOOLS_ASKED_BY_T3 } from "@t3tools/shared/t3McpToolPresentation";
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
  caller: {
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly runtimeModeCeiling?: RuntimeMode;
  } = {},
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
    // The access wrapper reads the caller's modes here.
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, caller)),
    }),
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
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation(capabilities),
        runtimeModeCeiling: caller.runtimeModeCeiling,
      }),
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
});

describe("issue writes below Full access", () => {
  const KEY = "outside-action";
  const OTHER_PROJECT = ProjectId.make("project-other");
  /** A tracker that records each write it is asked for. */
  const recordingTracker = () => {
    const writes: Array<string> = [];
    const wrote =
      (name: string) =>
      (input: { readonly scope: string; readonly key?: string; readonly projectId: ProjectId }) =>
        Effect.sync(
          () => void writes.push(`${name} ${input.projectId} ${input.scope}#${input.key ?? "new"}`),
        );
    const layer = Layer.mock(IssueService.IssueService)({
      projectScope: (projectId) =>
        Effect.succeed({
          projectId,
          tracker: GITHUB,
          host: "github.com",
          scope: projectId === OTHER_PROJECT ? "other-org/other" : "t3tools/t3code",
        }),
      create: (input) =>
        wrote("create")(input).pipe(
          Effect.as({ key: "9", url: "https://github.com/x/y/issues/9", displayKey: "#9" }),
        ) as never,
      comment: (input) => wrote("comment")(input),
      setState: (input) => wrote("setState")(input),
    });
    return { writes, layer };
  };
  const asClient = (reply?: { readonly action: string; readonly state: string }) => {
    const request = Ref.makeUnsafe<McpSchema.InputRequired | undefined>(undefined);
    const provide =
      (sessions: McpProviderSessions.McpProviderSessions["Service"]) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(McpClientInput.McpClientInput, { request, sessions }),
          Effect.provideService(
            McpSchema.McpRequestContext,
            McpSchema.McpRequestContext.of({
              clientId: 1,
              protocolVersion: "2026-07-28",
              clientCapabilities: new McpSchema.ClientCapabilities({ elicitation: {} }),
              ...(reply === undefined
                ? {}
                : {
                    inputResponses: { [KEY]: { action: reply.action } },
                    requestState: reply.state,
                  }),
            }),
          ),
        );
    return { request, provide };
  };
  const WRITES = [
    [
      "create_issue",
      { title: "Backup ran twice", body: "Twice." },
      "create project-1 t3tools/t3code#new",
      { action: "Create", target: "an issue", repository: "t3tools/t3code" },
    ],
    [
      "comment_on_issue",
      { key: "7", body: "Seen." },
      "comment project-1 t3tools/t3code#7",
      { action: "Comment on", target: "issue #7", repository: "t3tools/t3code" },
    ],
    [
      "set_issue_state",
      { key: "7", state: "closed" },
      "setState project-1 t3tools/t3code#7",
      { action: 'Set state "closed" on', target: "issue #7", repository: "t3tools/t3code" },
    ],
    [
      "comment_on_issue",
      { key: "7", body: "Seen.", projectId: OTHER_PROJECT },
      "comment project-other other-org/other#7",
      {
        action: "Comment on",
        target: "issue #7",
        repository: "other-org/other",
        otherRepository: true,
      },
    ],
  ] as const;

  it.effect.each([
    ["a Supervised thread", { runtimeMode: "approval-required" }],
    ["an Auto-accept edits thread", { runtimeMode: "auto-accept-edits" }],
    ["an Auto thread", { runtimeMode: "auto" }],
    ["a Full access thread in plan mode", { runtimeMode: "full-access", interactionMode: "plan" }],
    [
      "a Full access thread above the administrator's limit",
      { runtimeMode: "full-access", runtimeModeCeiling: "auto" },
    ],
  ] as const)("%s reaches the tracker only for what the person approved", ([, caller]) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.showsApprovalRequests(ProviderInstanceId.make("codex"));
      for (const [name, params, write, named] of WRITES) {
        const tracker = recordingTracker();
        const harness = yield* makeHarness([], tracker.layer, caller);
        const first = asClient();
        yield* harness.call(name, params as never).pipe(first.provide(sessions), Effect.flip);
        const asked = Ref.getUnsafe(first.request)!;
        const question = asked.inputRequests?.[KEY]?.params as
          | { readonly message: string }
          | undefined;
        const message = question?.message ?? "";
        expect(tracker.writes).toEqual([]);
        expect(
          message.startsWith(`${named.action} ${named.target} in ${named.repository}? (`),
        ).toBe(true);
        expect((yield* sessions.findApprovalRequest(THREAD_ID, message))?.toolAction).toEqual({
          tool: name,
          host: "github.com",
          ...named,
        });

        // Other arguments are another request, whatever the reply says.
        const changed = asClient({ action: "accept", state: asked.requestState! });
        yield* sessions.answerApprovalRequests(THREAD_ID, message, true);
        yield* harness
          .call(name, { ...params, key: "8", title: "Another" } as never)
          .pipe(changed.provide(sessions), Effect.flip);
        expect(Ref.getUnsafe(changed.request)?.requestState).not.toBe(asked.requestState);
        expect(tracker.writes).toEqual([]);

        yield* harness
          .call(name, params as never)
          .pipe(asClient({ action: "accept", state: asked.requestState! }).provide(sessions));
        expect(tracker.writes).toEqual([write]);
      }
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  // A provider client that asks about tool calls itself leaves the listed ones to this request.
  it("the tools listed as asked by T3 Code are the ones shown to ask above", () => {
    expect(
      T3_MCP_TOOLS_ASKED_BY_T3.filter((name) => name in IssuesToolkit.tools).toSorted(),
    ).toEqual([...new Set(WRITES.map(([name]) => name))].toSorted());
  });

  it.effect("a Full access thread writes without asking anyone", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.showsApprovalRequests(ProviderInstanceId.make("codex"));
      const tracker = recordingTracker();
      const harness = yield* makeHarness([], tracker.layer);
      for (const [name, params] of WRITES) {
        const client = asClient();
        yield* harness.call(name, params as never).pipe(client.provide(sessions));
        expect(Ref.getUnsafe(client.request)).toBeUndefined();
      }
      expect(tracker.writes).toEqual(WRITES.map(([, , write]) => write));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
