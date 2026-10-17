import {
  EnvironmentId,
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueDetail,
  type IssueCandidates,
  type IssueListResult,
  type OrchestrationProjectShell,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, type Tool } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as RateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as JiraApi from "@t3tools/issue-tracker-jira/server/JiraApi";
import * as JiraIssueTracker from "@t3tools/issue-tracker-jira/server/JiraIssueTracker";

import * as LinearApi from "@t3tools/issue-tracker-linear/server/LinearApi";
import * as LinearIssueTracker from "@t3tools/issue-tracker-linear/server/LinearIssueTracker";
import {
  IssueDetail as NativeIssueDetail,
  IssueSearch as NativeIssueSearch,
  toIssueDetail,
  toIssueSearch,
} from "@t3tools/source-control-github/server/gitHubIssueJson";
import * as IssueService from "../../../issue/IssueService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as IssuesHandlers from "./handlers.ts";
import { IssuesToolkit } from "./tools.ts";

const decodeNativeIssueDetail = Schema.decodeUnknownResult(NativeIssueDetail.result);
const decodeNativeIssueSearch = Schema.decodeUnknownResult(NativeIssueSearch.result);

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const GITHUB = IssueTrackerKind.make("github");
const LINEAR = IssueTrackerKind.make("linear");
const encodeIssueTools = Object.fromEntries(
  Object.entries(IssuesToolkit.tools).map(([name, tool]) => [
    name,
    Schema.encodeUnknownSync(tool.parametersSchema),
  ]),
);
const gitHostSource: IssueService.ProjectTrackerBinding = {
  tracker: GITHUB,
  host: "github.com",
  scope: "T3Tools/T3Code",
};
const standaloneSource: IssueService.ProjectTrackerBinding = {
  tracker: LINEAR,
  host: "linear.app",
  scope: "ENG",
};
const jiraSource: IssueService.ProjectTrackerBinding = {
  tracker: IssueTrackerKind.make("jira"),
  host: "example.atlassian.net",
  scope: "ENG",
};
const candidates: IssueCandidates = { labels: [], assignees: [], truncated: false };

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  external = false,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: external
    ? undefined
    : {
        threadId: THREAD_ID,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
  client: external
    ? { sessionId: "external-read-session", label: "Read client", access: "read-only" }
    : undefined,
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

const standaloneDetail: IssueDetail = {
  ...detail,
  ...standaloneSource,
  key: "ENG-7",
  displayKey: "ENG-7",
  url: "https://linear.app/team/issue/ENG-7/seven",
};

const savedLink: ThreadIssueLink = {
  projectId: PROJECT_ID,
  ...gitHostSource,
  key: "7",
  url: detail.url,
  source: "manual",
  linkedAt: "2026-08-10T00:00:00.000Z",
  snapshot: null,
};

const makeHarness = Effect.fn("makeIssuesToolkitHarness")(function* (
  issues: ReadonlyArray<ThreadIssueLink> = [],
  options: {
    readonly project?: OrchestrationProjectShell;
    readonly sources?: ReadonlyArray<IssueService.ProjectTrackerBinding>;
    readonly discoverySources?: NonNullable<IssueListResult["sources"]>;
    readonly missingThread?: boolean;
    readonly detail?: IssueDetail;
    readonly candidates?: IssueCandidates;
    readonly update?: IssueService.IssueService["Service"]["update"];
    readonly templates?: IssueService.IssueService["Service"]["templates"];
    readonly comments?: IssueService.IssueService["Service"]["comments"];
    readonly history?: IssueService.IssueService["Service"]["history"];
  } = {},
) {
  const links = yield* Ref.make<ReadonlyArray<ThreadIssueService.LinkThreadIssueInput>>([]);
  const unlinks = yield* Ref.make<ReadonlyArray<ThreadIssueService.UnlinkThreadIssueInput>>([]);
  const resolutions = yield* Ref.make<ReadonlyArray<string>>([]);
  const calls = yield* Ref.make<ReadonlyArray<{ operation: string; input: unknown }>>([]);
  const record = <A>(operation: string, input: unknown, result: A) =>
    Ref.update(calls, (recorded) => [...recorded, { operation, input }]).pipe(Effect.as(result));
  const currentProject = options.project ?? project;
  const currentDetail = options.detail ?? detail;
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: (id) =>
        Effect.succeed(id === PROJECT_ID ? Option.some(currentProject) : Option.none()),
      listShells: () => Effect.succeed([currentProject]),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Effect.succeed(id === THREAD_ID && !options.missingThread ? makeThread(issues) : null),
    }),
    Layer.mock(IssueService.IssueService)({
      listSources: (input) =>
        record(
          "listSources",
          input,
          (
            options.discoverySources ??
            (options.sources ?? [gitHostSource]).map((source) => ({
              projectId: currentProject.id,
              projectTitle: currentProject.title,
              ...source,
              capabilities: currentDetail.capabilities,
            }))
          ).filter(
            (source) => input.projectId === undefined || source.projectId === input.projectId,
          ),
        ),
      sources: () =>
        Ref.update(resolutions, (recorded) => [...recorded, "sources"]).pipe(
          Effect.as(options.sources ?? [gitHostSource]),
        ),
      list: (input) =>
        record("list", input, {
          viewers: {},
          trackers: [],
          entries: [currentDetail],
          errors: [],
          nextCursors: {},
        }),
      create: (input) =>
        record("create", input, {
          key: currentDetail.key,
          displayKey: currentDetail.displayKey,
          url: currentDetail.url,
        }),
      detail: (input) => record("detail", input, currentDetail),
      comments: (input) =>
        record("comments", input, undefined).pipe(
          Effect.flatMap(() =>
            options.comments === undefined
              ? Effect.succeed({ comments: [], nextCursor: null })
              : options.comments(input),
          ),
        ),
      candidates: (input) => record("candidates", input, options.candidates ?? candidates),
      templates: (input) =>
        record("templates", input, undefined).pipe(
          Effect.flatMap(() =>
            options.templates === undefined
              ? Effect.succeed({ templates: [], blankIssuesEnabled: true })
              : options.templates(input),
          ),
        ),
      history: (input) =>
        record("history", input, undefined).pipe(
          Effect.flatMap(() =>
            options.history === undefined
              ? Effect.succeed({ items: [], nextCursor: "native-history-next" })
              : options.history(input),
          ),
        ),
      dependencies: (input) =>
        record("dependencies", input, { items: [], nextCursor: "dependency-next" }),
      setDependency: (input) => record("setDependency", input, undefined),
      hierarchy: (input) =>
        record("hierarchy", input, {
          parent: null,
          children: { items: [], nextCursor: "native-children-next" },
        }),
      linkedPullRequests: (input) =>
        record("linkedPullRequests", input, { items: [], nextCursor: null }),
      labelCandidates: (input) =>
        record("labelCandidates", input, { items: [], nextCursor: "native-labels-next" }),
      assigneeCandidates: (input) =>
        record("assigneeCandidates", input, { items: [], nextCursor: null }),
      update: (input) =>
        record("update", input, undefined).pipe(
          Effect.andThen(options.update === undefined ? Effect.void : options.update(input)),
        ),
      editComment: (input) => record("editComment", input, undefined),
      react: (input) => record("react", input, undefined),
      setParent: (input) => record("setParent", input, undefined),
      comment: (input) => record("comment", input, undefined),
      setState: (input) => record("setState", input, undefined),
      resolveUrl: (url) =>
        Ref.update(resolutions, (recorded) => [...recorded, "resolveUrl"]).pipe(
          Effect.as({
            projectId: PROJECT_ID,
            tracker: GITHUB,
            host: "github.com",
            scope: "t3tools/t3code",
            key: url.split("/").at(-1)!,
            writable: true,
          }),
        ),
    }),
    Layer.mock(ThreadIssueService.ThreadIssueService)({
      link: (input) =>
        Ref.update(links, (recorded) => [...recorded, input]).pipe(
          Effect.as({ alreadyLinked: false }),
        ),
      unlink: (input) =>
        Ref.update(unlinks, (recorded) => [...recorded, input]).pipe(
          Effect.as({ wasLinked: true }),
        ),
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
    params: Tool.Parameters<(typeof IssuesToolkit.tools)[Name]>,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["issues"],
    external = false,
  ) =>
    Effect.try(() => encodeIssueTools[name]!(params)).pipe(
      Effect.flatMap((encoded) =>
        toolkit.handle(name, encoded as Tool.ParametersEncoded<(typeof IssuesToolkit.tools)[Name]>),
      ),
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof IssuesToolkit.tools)[Name]>,
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(capabilities, external),
      ),
      Effect.provide(layerDependencies),
    );
  return { links, unlinks, resolutions, call, calls, layerDependencies };
});

describe("issue toolkit handlers", () => {
  it.effect(
    "preserves account selectors in registered tools and refuses default shorthand for explicit bindings",
    () =>
      Effect.gen(function* () {
        const source = { ...standaloneSource, connectionId: "Account" };
        const harness = yield* makeHarness(
          [
            {
              ...source,
              projectId: PROJECT_ID,
              key: "ENG-7",
              url: "https://linear.app/acme/issue/ENG-7",
              source: "agent",
              linkedAt: detail.createdAt,
              snapshot: null,
            },
          ],
          {
            sources: [source],
            detail: { ...detail, ...source },
          },
        );
        const client = McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          clientCapabilities: {},
          clientInfo: { name: "issues-test", version: "1" },
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "issues-test", version: "1" },
          },
          getClient: Effect.die("unused"),
        });
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const accountInput = {
            projectId: PROJECT_ID,
            tracker: LINEAR,
            connectionId: "Account",
            key: "ENG-7",
            cursor: "older",
            title: "Changed",
            body: "Body",
            state: "closed",
            commentId: "comment-1",
            subjectId: "issue",
            content: "thumbs-up",
            reacted: true,
            labels: [],
            assignees: [],
            parentKey: "ENG-8",
            direction: "blocks",
            targetScope: "ENG",
            targetKey: "ENG-9",
            linked: true,
          };
          expect(Object.keys(IssuesToolkit.tools)).toHaveLength(25);
          for (const name of Object.keys(IssuesToolkit.tools)) {
            if (name === "list_thread_issues") continue;
            const encoded = encodeIssueTools[name]!(accountInput);
            expect(encoded).toMatchObject({
              projectId: { value: PROJECT_ID, connectionId: "Account" },
            });
            expect(encoded).not.toHaveProperty("connectionId");
            const unsafe = yield* server
              .callTool({ name, arguments: accountInput })
              .pipe(Effect.result);
            expect(Result.isFailure(unsafe)).toBe(true);
          }
          expect(yield* Ref.get(harness.calls)).toEqual([]);
          expect(yield* Ref.get(harness.links)).toEqual([]);
          expect(yield* Ref.get(harness.unlinks)).toEqual([]);
          for (const name of Object.keys(IssuesToolkit.tools)) {
            if (["list_issues", "list_issue_sources", "list_thread_issues"].includes(name))
              continue;
            const result = yield* server.callTool({
              name,
              arguments: encodeIssueTools[name]!(accountInput),
            });
            expect(result.isError).toBe(false);
            if (
              typeof result.structuredContent === "object" &&
              result.structuredContent !== null &&
              "projectId" in result.structuredContent
            ) {
              expect(result.structuredContent).toMatchObject({
                projectId: { value: PROJECT_ID, connectionId: "Account" },
              });
              expect(result.structuredContent).not.toHaveProperty("connectionId");
            }
            if (
              name === "read_issue" &&
              typeof result.structuredContent === "object" &&
              result.structuredContent !== null &&
              "url" in result.structuredContent
            ) {
              expect(decodeReadIssue(result.structuredContent).connectionId).toBe("Account");
              const { url: _url, ...reference } = result.structuredContent;
              const reused = yield* server.callTool({
                name: "set_issue_state",
                arguments: { ...reference, state: "closed" },
              });
              expect(reused.isError).toBe(false);
            }
          }
          const sources = yield* server.callTool({
            name: "list_issue_sources",
            arguments: encodeIssueTools.list_issue_sources!({ connectionId: "Account" }),
          });
          expect(decodeSourcesResult(sources.structuredContent).sources[0]?.connectionId).toBe(
            "Account",
          );
          expect(sources.structuredContent).toMatchObject({
            sources: [
              {
                projectId: { value: PROJECT_ID, connectionId: "Account" },
              },
            ],
          });
          const listed = yield* server.callTool({
            name: "list_issues",
            arguments: encodeIssueTools.list_issues!({ connectionId: "Account" }),
          });
          expect(decodeListIssues(listed.structuredContent).issues[0]?.connectionId).toBe(
            "Account",
          );
          const beforeThreadList = (yield* Ref.get(harness.calls)).length;
          const saved = yield* server.callTool({ name: "list_thread_issues", arguments: {} });
          expect(saved.structuredContent).toMatchObject({
            issues: [
              {
                projectId: { value: PROJECT_ID, connectionId: "Account" },
              },
            ],
          });
          expect((yield* Ref.get(harness.calls)).length).toBe(beforeThreadList);
          const before = (yield* Ref.get(harness.calls)).length;
          for (const connectionId of [undefined, "account"]) {
            const result = yield* server
              .callTool({
                name: "read_issue",
                arguments: {
                  tracker: LINEAR,
                  key: "ENG-7",
                  ...(connectionId === undefined ? {} : { connectionId }),
                },
              })
              .pipe(Effect.result);
            expect(Result.isFailure(result) || result.success.isError === true).toBe(true);
          }
          expect((yield* Ref.get(harness.calls)).length).toBe(before);
          expect(
            (yield* Ref.get(harness.calls)).every(
              (call) => (call.input as { connectionId?: string }).connectionId === "Account",
            ),
          ).toBe(true);
          const denied = yield* server
            .callTool({
              name: "read_issue",
              arguments: encodeIssueTools.read_issue!(accountInput),
            })
            .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation([])));
          expect(denied.isError).toBe(true);
          expect((yield* Ref.get(harness.calls)).length).toBe(before);
        }).pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["issues"])),
          Effect.provide(
            McpHttpServer.toolkitRegistration(IssuesToolkit, IssuesHandlers.layer).pipe(
              Layer.provideMerge(McpServer.McpServer.layer),
              Layer.provide(harness.layerDependencies),
            ),
          ),
        );
      }),
  );

  it("protects host-only MCP lists while preserving the flat service input", () => {
    const input = { host: "github.com" };
    const wire = encodeIssueTools.list_issues!(input);
    expect(wire).toEqual({ state: { host: "github.com" } });
    expect(
      Schema.decodeUnknownSync(IssuesToolkit.tools.list_issues.parametersSchema)(wire),
    ).toEqual(input);
    expect(() =>
      Schema.decodeUnknownSync(IssuesToolkit.tools.list_issues.parametersSchema)(input),
    ).toThrow();
  });

  it.effect("forwards selected external list scope and keeps external writes denied", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const input = {
        projectId: PROJECT_ID,
        tracker: GITHUB,
        host: "github.com",
        scope: "acme/other",
        state: "all" as const,
      };
      yield* harness.call("list_issues", input, ["issues"], true);
      expect(yield* Ref.get(harness.calls)).toEqual([{ operation: "list", input }]);
      const denied = yield* harness
        .call(
          "update_issue",
          { tracker: GITHUB, host: input.host, scope: input.scope, key: "7", title: "Denied" },
          ["issues"],
          true,
        )
        .pipe(Effect.result);
      expect(Result.isFailure(denied)).toBe(true);
      expect((yield* Ref.get(harness.calls)).length).toBe(1);
    }),
  );

  it.effect("keeps mutation and saved-link selection on the exact account", () =>
    Effect.gen(function* () {
      const source = { ...standaloneSource, connectionId: "Account" };
      const saved = (connectionId: string): ThreadIssueLink => ({
        ...source,
        connectionId,
        projectId: PROJECT_ID,
        key: "ENG-7",
        url: "https://linear.app/acme/issue/ENG-7",
        source: "agent",
        linkedAt: detail.createdAt,
        snapshot: null,
      });
      const harness = yield* makeHarness([saved("Account"), saved("account")], {
        sources: [source],
        detail: { ...detail, ...source },
      });
      const denied = yield* harness
        .call(
          "update_issue",
          { tracker: LINEAR, connectionId: "Account", key: "ENG-7", title: "Denied" },
          ["issues"],
          true,
        )
        .pipe(Effect.flip);
      expect(denied).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "capability_denied" });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
      yield* harness.call("update_issue", {
        tracker: LINEAR,
        connectionId: "Account",
        key: "ENG-7",
        title: "Selected",
      });
      yield* harness.call("create_issue", {
        tracker: LINEAR,
        connectionId: "Account",
        title: "Created",
      });
      yield* harness.call("unlink_issue", {
        tracker: LINEAR,
        connectionId: "Account",
        key: "ENG-7",
      });
      const unlinks = yield* Ref.get(harness.unlinks);
      expect(unlinks.map((request) => request.key.connectionId)).toEqual(["Account"]);
      expect(
        (yield* Ref.get(harness.calls)).every(
          (call) => (call.input as { connectionId?: string }).connectionId === "Account",
        ),
      ).toBe(true);
      const output = yield* harness.call("list_thread_issues", {});
      expect(output.issues.map((issue) => issue.connectionId)).toEqual(["Account", "account"]);
    }),
  );

  const decodeSourcesResult = Schema.decodeUnknownSync(
    IssuesToolkit.tools.list_issue_sources.successSchema,
  );
  it.effect.each([
    { external: true, input: {}, projectId: undefined },
    { external: false, input: {}, projectId: PROJECT_ID },
    { external: true, input: { projectId: PROJECT_ID }, projectId: PROJECT_ID },
  ])("discovers source metadata for external=$external and project=$projectId", (mode) =>
    Effect.gen(function* () {
      const sources = [
        {
          projectId: PROJECT_ID,
          projectTitle: "Project",
          ...gitHostSource,
          capabilities: detail.capabilities,
        },
        {
          projectId: ProjectId.make("other"),
          projectTitle: "Other",
          ...standaloneSource,
          capabilities: detail.capabilities,
        },
      ];
      const harness = yield* makeHarness([], { discoverySources: sources });
      const result = yield* harness.call(
        "list_issue_sources",
        mode.input,
        ["issues"],
        mode.external,
      );
      const expected = sources.filter(
        (source) => mode.projectId === undefined || source.projectId === mode.projectId,
      );
      expect(decodeSourcesResult(result)).toEqual({ sources: expected });
      expect(yield* Ref.get(harness.calls)).toEqual([
        {
          operation: "listSources",
          input: mode.projectId === undefined ? {} : { projectId: mode.projectId },
        },
      ]);
    }),
  );

  it.effect(
    "denies source discovery before reads for missing grants, projects or thread context",
    () =>
      Effect.gen(function* () {
        for (const mode of [
          {
            input: {},
            capabilities: [] as const,
            external: true,
            missingThread: false,
            error: "McpCapabilityUnavailableError",
          },
          {
            input: { projectId: ProjectId.make("missing") },
            capabilities: ["issues"] as const,
            external: true,
            missingThread: false,
            error: "IssueProjectNotFoundError",
          },
          {
            input: {},
            capabilities: ["issues"] as const,
            external: false,
            missingThread: true,
            error: "IssueProjectRequiredError",
          },
        ]) {
          const harness = yield* makeHarness([], { missingThread: mode.missingThread });
          const result = yield* harness
            .call("list_issue_sources", mode.input, mode.capabilities, mode.external)
            .pipe(Effect.flip);
          expect(result._tag).toBe(mode.error);
          expect(yield* Ref.get(harness.calls)).toEqual([]);
          expect(yield* Ref.get(harness.resolutions)).toEqual([]);
        }
      }),
  );

  it.effect("preserves body edit safety and native states through registered MCP reads", () =>
    Effect.gen(function* () {
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "issues-test", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "issues-test", version: "1" },
        },
        getClient: Effect.die("unused"),
      });
      for (const metadata of [
        {},
        { bodyEditable: true, states: [] },
        {
          bodyEditable: false,
          states: [
            { id: "review-id", category: "open" as const, name: "Needs review" },
            { id: "shipped-id", category: "closed" as const, name: "Shipped" },
          ],
        },
      ]) {
        const harness = yield* makeHarness([], { detail: { ...detail, ...metadata } });
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const request = { name: "read_issue", arguments: { projectId: PROJECT_ID, key: "7" } };
          const result = yield* server.callTool(request);
          expect(result.isError).toBe(false);
          const read = decodeReadIssue(result.structuredContent);
          if (metadata.bodyEditable === undefined) {
            expect(read).not.toHaveProperty("bodyEditable");
            expect(read).not.toHaveProperty("states");
          } else {
            expect(read.bodyEditable).toBe(metadata.bodyEditable);
            expect(read.states).toEqual(metadata.states);
          }
          const denied = yield* server
            .callTool(request)
            .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation([])));
          expect(denied.isError).toBe(true);
          expect(yield* Ref.get(harness.calls)).toEqual([
            { operation: "detail", input: { projectId: PROJECT_ID, ...gitHostSource, key: "7" } },
          ]);
        }).pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["issues"])),
          Effect.provide(
            McpHttpServer.toolkitRegistration(IssuesToolkit, IssuesHandlers.layer).pipe(
              Layer.provideMerge(McpServer.McpServer.layer),
              Layer.provide(harness.layerDependencies),
            ),
          ),
        );
      }
    }),
  );

  const decodeReadIssue = Schema.decodeUnknownSync(IssuesToolkit.tools.read_issue.successSchema);
  const decodeListIssues = Schema.decodeUnknownSync(IssuesToolkit.tools.list_issues.successSchema);

  it.effect.each(["https://github.com/T3Tools/T3Code/issues/7#issuecomment-123456", null])(
    "preserves the nullable comment URL %s through the MCP output codec after native mapping",
    (url) =>
      Effect.gen(function* () {
        const comment = {
          __typename: "IssueComment",
          lastEditedAt: null,
          viewerCanUpdate: false,
          reactionGroups: null,
          id: "IC_nativeOpaqueId",
          author: null,
          body: "Native comment",
          createdAt: detail.createdAt,
          url: url ?? "https://github.com/T3Tools/T3Code/issues/7#issuecomment-123456",
        };
        const decoded = Result.map(
          decodeNativeIssueDetail({
            viewer: { login: "julius" },
            repository: {
              isArchived: false,
              viewerPermission: null,
              issue: {
                stateReason: null,
                closedAt: null,
                author: null,
                assignees: { nodes: [] },
                labels: null,
                milestone: null,
                body: "",
                locked: false,
                viewerCanUpdate: true,
                reactionGroups: null,
                closedByPullRequestsReferences: null,
                timelineItems: {
                  nodes: [],
                  pageInfo: {
                    startCursor: null,
                    hasPreviousPage: false,
                  },
                },
                number: 7,
                title: detail.title,
                url: detail.url,
                state: "OPEN",
                createdAt: detail.createdAt,
                updatedAt: detail.updatedAt,
                comments: {
                  totalCount: 1,
                  nodes: [comment],
                  pageInfo: {
                    startCursor: null,
                    hasPreviousPage: false,
                  },
                },
              },
            },
          }),
          toIssueDetail,
        );
        expect(Result.isSuccess(decoded)).toBe(true);
        if (Result.isFailure(decoded) || decoded.success === null)
          throw new Error("Fixture decode failed");
        expect(decoded.success.comments[0]?.url).toBe(comment.url);
        const harness = yield* makeHarness([], {
          detail: {
            ...detail,
            ...decoded.success,
            comments: decoded.success.comments.map((comment) => ({ ...comment, url })),
          },
        });
        const read = decodeReadIssue(yield* harness.call("read_issue", { key: "7" }));
        expect(read.commentsCursor).toBeNull();
        expect(read.comments[0]).toHaveProperty("url", url);
        const legacy = decodeReadIssue({
          ...read,
          comments: read.comments.map(({ url: _url, ...comment }) => comment),
        });
        expect(legacy.comments[0]).not.toHaveProperty("url");
        expect((yield* Ref.get(harness.calls)).map((call) => call.operation)).toEqual(["detail"]);
      }),
  );

  it.effect.each([true, false])(
    "retains native actors, dates and counts with IDs=%s through registered reads",
    (withIds) =>
      Effect.gen(function* () {
        const author = {
          login: "Same name",
          name: null,
          avatarUrl: null,
          ...(withIds ? { id: "author-id" } : {}),
        };
        const assignee = { ...author, ...(withIds ? { id: "assignee-id" } : {}) };
        const commentAuthor = { ...author, ...(withIds ? { id: "comment-author-id" } : {}) };
        const comment = {
          id: "native-comment",
          author: commentAuthor,
          body: "Native comment",
          createdAt: detail.createdAt,
          url: null,
        };
        const nativeDetail = {
          ...detail,
          author,
          assignees: [assignee],
          comments: [comment],
          closedAt: "2026-08-03T00:00:00.000Z",
          commentCount: 37,
        };
        const harness = yield* makeHarness([], {
          detail: nativeDetail,
          comments: () => Effect.succeed({ comments: [comment], nextCursor: null }),
        });
        const read = decodeReadIssue(yield* harness.call("read_issue", { key: "7" }));
        const listed = decodeListIssues(yield* harness.call("list_issues", {})).issues[0]!;
        for (const output of [read, listed]) {
          expect(output).toMatchObject({
            author: "Same name",
            assignees: ["Same name"],
            authorDetails: author,
            assigneeDetails: [assignee],
            createdAt: nativeDetail.createdAt,
            closedAt: nativeDetail.closedAt,
            commentCount: 37,
          });
        }
        expect(read.comments[0]).toMatchObject({
          author: "Same name",
          authorDetails: commentAuthor,
        });
        const page = yield* harness.call("read_issue_comments", { key: "7", cursor: "older" });
        expect(page.comments[0]?.author).toEqual(commentAuthor);
        expect((yield* Ref.get(harness.calls)).map((call) => call.operation)).toEqual([
          "detail",
          "list",
          "comments",
        ]);
      }),
  );

  it.effect("retains null actors and unknown native comment totals in registered reads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], {
        detail: {
          ...detail,
          commentCount: null,
          comments: [
            {
              id: "unknown-author",
              author: null,
              body: "Body",
              createdAt: detail.createdAt,
              url: null,
            },
          ],
        },
      });
      const read = decodeReadIssue(yield* harness.call("read_issue", { key: "7" }));
      const listed = decodeListIssues(yield* harness.call("list_issues", {})).issues[0]!;
      for (const output of [read, listed])
        expect(output).toMatchObject({
          author: null,
          authorDetails: null,
          assignees: [],
          assigneeDetails: [],
          closedAt: null,
          commentCount: null,
        });
      expect(read.comments[0]).toMatchObject({ author: null, authorDetails: null });
    }),
  );

  it.effect.each([
    undefined,
    [],
    [
      {
        content: "thumbs-up" as const,
        count: 27,
        viewerHasReacted: true,
        actors: ["actor"],
      },
    ],
  ])("retains native list reactions %s through the registered output schema", (reactions) =>
    Effect.gen(function* () {
      const nativeDetail =
        reactions === undefined
          ? detail
          : { ...detail, reactions, reactionsTruncated: reactions.length > 0 };
      const harness = yield* makeHarness([], { detail: nativeDetail });
      const output = decodeListIssues(yield* harness.call("list_issues", {})).issues[0]!;
      if (reactions === undefined) {
        expect(output).not.toHaveProperty("reactions");
        expect(output).not.toHaveProperty("reactionsTruncated");
      } else {
        expect(output).toMatchObject({ reactions, reactionsTruncated: reactions.length > 0 });
      }
      expect((yield* Ref.get(harness.calls)).map((call) => call.operation)).toEqual(["list"]);
    }),
  );

  it.effect.each(["Release 1", null, undefined])(
    "keeps native milestone %s in registered reads without extra calls",
    (milestone) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([], {
          detail: milestone === undefined ? detail : { ...detail, milestone },
        });
        const read = yield* harness.call("read_issue", { key: "7" });
        const listed = yield* harness.call("list_issues", {});
        for (const output of [read, listed.issues[0]!]) {
          if (milestone === undefined) expect(output).not.toHaveProperty("milestone");
          else expect(output).toHaveProperty("milestone", milestone);
        }
        expect((yield* Ref.get(harness.calls)).map((call) => call.operation)).toEqual([
          "detail",
          "list",
        ]);
      }),
  );

  it.effect.each([
    { tracker: LINEAR, key: "ENG-7" },
    { tracker: LINEAR, key: "eng-7" },
    { tracker: IssueTrackerKind.make("jira"), key: "ops-7" },
  ])("links accepted native $tracker/$key through registered MCP", (input) =>
    Effect.gen(function* () {
      const linear = input.tracker === LINEAR;
      const canonical = input.key.toUpperCase();
      const source = {
        tracker: input.tracker,
        host: linear ? "linear.app" : "example.atlassian.net",
        scope: linear ? "acme/ENG" : "OPS",
      };
      const url = linear
        ? `https://linear.app/acme/issue/${canonical}`
        : `https://example.atlassian.net/browse/${canonical}`;
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const nativeReads: string[] = [];
      const crypto = Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(1),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      );
      const nativeDependencies = Layer.mergeAll(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              let response: unknown;
              if (linear) {
                if (request.body._tag !== "Uint8Array") throw new Error("Expected GraphQL body");
                const body = JSON.parse(new TextDecoder().decode(request.body.body)) as {
                  readonly query: string;
                  readonly variables: { readonly id: string };
                };
                const operation = /^(?:query|mutation) (\w+)/.exec(body.query)?.[1];
                expect(["T3Issue", "T3Viewer"]).toContain(operation);
                nativeReads.push(operation!);
                if (operation === "T3Issue") expect(body.variables.id).toBe(canonical);
                response = {
                  data:
                    operation === "T3Viewer"
                      ? {
                          viewer: {
                            id: "viewer",
                            name: "Viewer",
                            displayName: "Viewer",
                            email: null,
                            avatarUrl: null,
                          },
                        }
                      : {
                          issue: {
                            id: "issue",
                            identifier: canonical,
                            number: 7,
                            title: "Seven",
                            url,
                            description: "Body",
                            createdAt: detail.createdAt,
                            updatedAt: detail.updatedAt,
                            completedAt: null,
                            canceledAt: null,
                            state: { id: "started", name: "Started", type: "started", position: 0 },
                            projectMilestone: null,
                            creator: null,
                            assignee: null,
                            team: { key: "ENG", states: empty },
                            labels: empty,
                            comments: empty,
                            history: empty,
                            attachments: empty,
                            reactions: [],
                          },
                        },
                };
              } else {
                const path = new URL(request.url).pathname.replace(/^\/rest\/api\/3/, "");
                nativeReads.push(path);
                expect([
                  `/issue/${input.key}`,
                  `/issue/${input.key}/remotelink`,
                  "/myself",
                  "/mypermissions",
                ]).toContain(path);
                response = path.endsWith("/remotelink")
                  ? []
                  : path === "/myself"
                    ? { accountId: "viewer", displayName: "Viewer" }
                    : path === "/mypermissions"
                      ? { permissions: {} }
                      : {
                          key: canonical,
                          changelog: { startAt: 0, total: 0, histories: [] },
                          fields: {
                            project: { id: "1", key: "OPS" },
                            summary: "Seven",
                            created: detail.createdAt,
                            updated: detail.updatedAt,
                            status: {
                              id: "1",
                              name: "Started",
                              statusCategory: { key: "indeterminate" },
                            },
                            comment: { total: 0, comments: [] },
                          },
                        };
              }
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(response), {
                  headers: { "content-type": "application/json" },
                }),
              );
            }),
          ),
        ),
        Layer.succeed(
          IssueTrackerHost.IssueTrackerHost,
          IssueTrackerHost.IssueTrackerHost.of({
            credentials: {
              get: () =>
                Effect.succeed(
                  Option.some(
                    linear
                      ? "fake-linear-token"
                      : JSON.stringify({
                          site: source.host,
                          email: "fake@example.test",
                          token: "fake-jira-token",
                        }),
                  ),
                ),
            },
          }),
        ),
        RateLimit.layer,
        crypto,
      );
      const api = yield* linear
        ? LinearIssueTracker.make.pipe(
            Effect.provide(LinearApi.layer.pipe(Layer.provide(nativeDependencies))),
          )
        : JiraIssueTracker.make.pipe(
            Effect.provideServiceEffect(
              JiraApi.JiraApi,
              JiraApi.make.pipe(Effect.provide(nativeDependencies)),
            ),
          );
      let reads = 0;
      let dispatches = 0;
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: () => Effect.succeed(makeThread([])),
          dispatch: (command) =>
            Effect.sync(() => {
              expect(command).toMatchObject({
                type: "thread.issue.link",
                key: input.key,
                snapshot: { displayKey: canonical, title: "Seven" },
              });
              dispatches++;
              return { sequence: dispatches, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getShell: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(IssueService.IssueService)({
          sources: () => Effect.succeed([source]),
          detail: (ref) =>
            Effect.sync(() => {
              reads++;
            }).pipe(
              Effect.andThen(
                api.getIssue({
                  cwd: project.workspaceRoot,
                  host: ref.host!,
                  scope: ref.scope,
                  key: ref.key,
                }),
              ),
              Effect.map((native) => {
                expect(native.key).toBe(canonical);
                return {
                  ...native,
                  ...ref,
                  key: native.key,
                  host: source.host,
                  projectTitle: project.title,
                  writable: true,
                  capabilities: api.capabilities,
                };
              }),
              Effect.mapError(
                (error) => new IssueOperationError({ operation: "detail", detail: error.detail }),
              ),
            ),
        }),
        McpToolAccessTestkit.liveThreadsLayer,
        crypto,
      );
      const threadIssues = yield* ThreadIssueService.ThreadIssueService.pipe(
        Effect.provide(ThreadIssueService.layer.pipe(Layer.provide(dependencies))),
      );
      const toolkit = yield* IssuesToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(IssuesHandlers.layer).pipe(
            Layer.provide(
              Layer.mergeAll(
                dependencies,
                Layer.succeed(ThreadIssueService.ThreadIssueService, threadIssues),
              ),
            ),
          ),
        ),
      );
      const result = yield* toolkit
        .handle("link_issue", { tracker: input.tracker, key: input.key })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["issues"])),
          Effect.provideService(ThreadIssueService.ThreadIssueService, threadIssues),
          Effect.provide(dependencies),
        );
      expect(result.at(-1)?.result).toMatchObject({ key: input.key, url, alreadyLinked: false });
      yield* threadIssues.drain;
      expect(reads).toBe(1);
      expect(dispatches).toBe(1);
      expect(nativeReads.sort()).toEqual(
        linear
          ? ["T3Issue", "T3Viewer"]
          : [`/issue/${input.key}`, `/issue/${input.key}/remotelink`, "/mypermissions", "/myself"],
      );
    }),
  );

  it.effect.each([standaloneSource, jiraSource])(
    "unlinks saved $tracker identifiers across case without resolving a source",
    (source) =>
      Effect.gen(function* () {
        for (const [savedKey, requestedKey] of [
          ["eng-7", "ENG-7"],
          ["ENG-7", "eng-7"],
        ] as const) {
          const link = { ...savedLink, ...source, key: savedKey };
          const harness = yield* makeHarness([link], { sources: [] });
          expect(
            yield* harness.call("unlink_issue", { tracker: source.tracker, key: requestedKey }),
          ).toMatchObject({ wasLinked: true, key: savedKey });
          expect(yield* Ref.get(harness.unlinks)).toEqual([{ threadId: THREAD_ID, key: link }]);
          expect(yield* Ref.get(harness.resolutions)).toEqual([]);
          expect(yield* Ref.get(harness.calls)).toEqual([]);
        }
      }),
  );

  it.effect(
    "reads a deferred template catalog then the selected body through the registered tool",
    () =>
      Effect.gen(function* () {
        const template = {
          key: "Bug",
          name: "Bug",
          about: "",
          title: "",
          body: "Describe the bug",
          labels: [],
          assignees: [],
        };
        const harness = yield* makeHarness([], {
          templates: (input) => {
            if (input.templateKey === "missing") {
              return Effect.fail(
                new IssueOperationError({ operation: "templates", detail: "Template not found" }),
              );
            }
            return Effect.succeed({
              templates: input.metadataOnly
                ? Array.from({ length: 100 }, (_, index) => ({
                    ...template,
                    key: `Bug-${index}`,
                    name: `Bug-${index}`,
                    body: "",
                    contentDeferred: true,
                  }))
                : [{ ...template, key: input.templateKey ?? template.key }],
              blankIssuesEnabled: true,
            });
          },
        });
        const legacy = yield* harness.call("read_issue_templates", {});
        expect(legacy.templates).toEqual([template]);
        const catalog = yield* harness.call("read_issue_templates", { metadataOnly: true });
        expect(catalog.templates).toHaveLength(100);
        expect(
          catalog.templates.every((entry) => entry.body === "" && entry.contentDeferred === true),
        ).toBe(true);
        const selectedKey = catalog.templates[99]!.key;
        const selected = yield* harness.call("read_issue_templates", { templateKey: selectedKey });
        expect(selected.templates).toEqual([{ ...template, key: selectedKey }]);
        const missing = yield* harness
          .call("read_issue_templates", { templateKey: "missing" })
          .pipe(Effect.result);
        expect(missing._tag).toBe("Failure");
        const ref = { projectId: PROJECT_ID, ...gitHostSource };
        expect(yield* Ref.get(harness.calls)).toEqual([
          { operation: "templates", input: ref },
          { operation: "templates", input: { ...ref, metadataOnly: true } },
          { operation: "templates", input: { ...ref, templateKey: selectedKey } },
          { operation: "templates", input: { ...ref, templateKey: "missing" } },
        ]);
      }),
  );

  it.effect(
    "preserves an archived current Linear label through registered tool reads and replacement",
    () =>
      Effect.gen(function* () {
        const oldBug = {
          id: "old-bug",
          name: "Bug",
          color: null,
          archivedAt: "2026-01-01T00:00:00Z",
        };
        const teamBug = { id: "team-bug", name: "Bug", color: null };
        const workspaceBug = { id: "workspace-bug", name: "Bug", color: null };
        const feature = { id: "new-feature", name: "Feature", color: null };
        const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        const nativeCalls: string[] = [];
        const writes: Record<string, unknown>[] = [];
        const native = yield* LinearIssueTracker.make.pipe(
          Effect.provide(
            Layer.mock(LinearApi.LinearApi)({
              getIssueReference: () =>
                Effect.sync(() => {
                  nativeCalls.push("reference");
                  return {
                    id: "issue",
                    identifier: "ENG-7",
                    team: { key: "ENG" },
                    url: standaloneDetail.url,
                  };
                }),
              getTeam: () =>
                Effect.sync(() => {
                  nativeCalls.push("team");
                  return {
                    organization: { id: "workspace", urlKey: "acme", templates: empty },
                    team: {
                      id: "team",
                      key: "ENG",
                      name: "Engineering",
                      private: false,
                      visibility: "public",
                      restrictedBy: null,
                      states: empty,
                      labels: {
                        ...empty,
                        nodes: [oldBug, teamBug, feature].map((label) => ({
                          ...label,
                          color: "#000000",
                          description: null,
                          archivedAt: label === oldBug ? oldBug.archivedAt : null,
                          isGroup: false,
                        })),
                      },
                      members: empty,
                      templates: empty,
                      ancestors: [],
                    },
                    workspaceLabels: [
                      {
                        ...workspaceBug,
                        color: "#000000",
                        description: null,
                        archivedAt: null,
                        isGroup: false,
                      },
                    ],
                    assigneeTeamIds: [],
                    templates: [],
                    templatesTruncated: false,
                    labelsTruncated: false,
                    truncated: false,
                  };
                }),
              updateIssue: (_id, patch) =>
                Effect.sync(() => {
                  nativeCalls.push("write");
                  writes.push(patch);
                }),
            }),
          ),
        );
        const harness = yield* makeHarness([], {
          sources: [standaloneSource],
          detail: { ...standaloneDetail, labels: [oldBug], labelsTruncated: false },
          candidates: {
            labels: [teamBug, workspaceBug, feature].map((label) => ({
              ...label,
              description: null,
            })),
            assignees: [],
            truncated: false,
          },
          update: (input) =>
            native.update!({
              cwd: "/fake",
              host: input.host!,
              scope: input.scope,
              key: input.key,
              labels: input.labels,
            }).pipe(
              Effect.mapError(
                (error) => new IssueOperationError({ operation: "update", detail: error.detail }),
              ),
            ),
        });
        const read = yield* harness.call("read_issue", { key: "ENG-7" });
        const listed = yield* harness.call("list_issues", {});
        const available = yield* harness.call("read_issue_candidates", { tracker: LINEAR });
        expect(read.labels).toEqual(["Bug"]);
        expect(available.labels.some((label) => label.id === oldBug.id)).toBe(false);
        const ambiguous = yield* harness
          .call("set_issue_labels", {
            key: "ENG-7",
            labels: [...read.labels, feature.id],
          })
          .pipe(Effect.result);
        expect(ambiguous._tag).toBe("Failure");
        expect(writes).toEqual([]);
        for (const output of [read, listed.issues[0]!]) {
          const selected =
            output.labelDetails?.map((label) => label.id ?? label.name) ?? output.labels;
          yield* harness.call("set_issue_labels", {
            key: "ENG-7",
            labels: [...selected, feature.id],
          });
        }
        expect(writes).toEqual([
          { labelIds: [oldBug.id, feature.id] },
          { labelIds: [oldBug.id, feature.id] },
        ]);
        expect(nativeCalls).toEqual([
          "reference",
          "team",
          "reference",
          "team",
          "write",
          "reference",
          "team",
          "write",
        ]);
        expect((yield* Ref.get(harness.calls)).map((call) => call.operation)).toEqual([
          "detail",
          "list",
          "candidates",
          "update",
          "update",
          "update",
        ]);
      }),
  );

  it.effect("keeps GitHub's twenty-label subset marked partial in registered list output", () =>
    Effect.gen(function* () {
      const nativeLabels = Array.from({ length: 21 }, (_, index) => ({
        name: `label-${index + 1}`,
        color: "abcdef",
      }));
      const native = Result.getOrThrow(
        Result.map(
          decodeNativeIssueSearch({
            search: {
              nodes: [
                {
                  state: "OPEN",
                  stateReason: null,
                  closedAt: null,
                  author: null,
                  assignees: { nodes: [] },
                  milestone: null,
                  comments: {
                    nodes: [],
                    pageInfo: { hasPreviousPage: false, startCursor: null },
                    totalCount: 0,
                  },
                  number: 7,
                  title: detail.title,
                  url: detail.url,
                  createdAt: detail.createdAt,
                  updatedAt: detail.updatedAt,
                  labels: {
                    nodes: nativeLabels.slice(0, 20),
                    pageInfo: {
                      endCursor: null,
                      hasNextPage: true,
                    },
                  },
                },
              ],
              pageInfo: {
                endCursor: null,
                hasNextPage: false,
              },
            },
          }),
          toIssueSearch,
        ),
      );
      const harness = yield* makeHarness([], { detail: { ...detail, ...native.items[0]! } });
      const listed = yield* harness.call("list_issues", {});
      const issue = listed.issues[0]!;
      expect(issue.labelsTruncated).toBe(true);
      expect(issue.labels).toEqual(nativeLabels.slice(0, 20).map((label) => label.name));
      expect(issue.labelDetails).toEqual(nativeLabels.slice(0, 20));
      expect(issue.labels).not.toContain("label-21");
      expect((yield* Ref.get(harness.calls)).map((call) => call.operation)).toEqual(["list"]);
    }),
  );

  it.effect("reports partial current labels and keeps name-only trackers compatible", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], {
        detail: { ...detail, labels: [{ name: "Bug", color: null }], labelsTruncated: true },
      });
      const read = yield* harness.call("read_issue", { key: "7" });
      const listed = yield* harness.call("list_issues", {});
      expect(read.labelsTruncated).toBe(true);
      expect(listed.issues[0]?.labelsTruncated).toBe(true);
      for (const output of [read, listed.issues[0]!]) {
        expect(output.labelDetails).toEqual([{ name: "Bug", color: null }]);
      }
      yield* harness.call("set_issue_labels", { key: "7", labels: [] });
      expect((yield* Ref.get(harness.calls)).map((call) => call.operation)).toEqual([
        "detail",
        "list",
        "update",
      ]);
    }),
  );

  it.effect("rejects omitted replacement arrays before writes and permits explicit clearing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (const tool of ["set_issue_labels", "set_issue_assignees"] as const) {
        const result = yield* harness.call(tool, { key: "7" } as never).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      expect(yield* Ref.get(harness.calls)).toEqual([]);
      yield* harness.call("set_issue_labels", { key: "7", labels: [] });
      yield* harness.call("set_issue_assignees", { key: "7", assignees: [] });
      expect((yield* Ref.get(harness.calls)).map((call) => call.input)).toEqual([
        { projectId: PROJECT_ID, ...gitHostSource, key: "7", labels: [] },
        { projectId: PROJECT_ID, ...gitHostSource, key: "7", assignees: [] },
      ]);
    }),
  );

  it.effect("retains all 121 existing labels through the registered replacement tool", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const labels = Array.from({ length: 121 }, (_, index) => `label-${index}`);
      yield* harness.call("set_issue_labels", { key: "7", labels });
      expect(yield* Ref.get(harness.calls)).toEqual([
        {
          operation: "update",
          input: { projectId: PROJECT_ID, ...gitHostSource, key: "7", labels },
        },
      ]);
    }),
  );

  it.effect("continues two older comment pages without reading or resolving the issue again", () =>
    Effect.gen(function* () {
      const olderComment = {
        id: "comment-2",
        author: null,
        body: "Older comment",
        createdAt: "2026-08-01T00:00:00.000Z",
        url: "https://linear.app/team/issue/ENG-7/seven#comment-2",
        reactions: [],
        reactionsTruncated: false,
      };
      const harness = yield* makeHarness([], {
        sources: [gitHostSource, standaloneSource],
        detail: { ...standaloneDetail, commentsCursor: "opaque-page-2" },
        comments: (input) =>
          Effect.gen(function* () {
            const context = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
            expect(Option.getOrThrow(context).environmentId).toBe(
              EnvironmentId.make("environment-1"),
            );
            return input.cursor === "opaque-page-2"
              ? { comments: [olderComment], nextCursor: "opaque-page-3" }
              : { comments: [{ ...olderComment, id: "comment-1" }], nextCursor: null };
          }),
      });
      const read = yield* harness.call("read_issue", { tracker: LINEAR, key: "ENG-7" });
      expect(read.commentsTruncated).toBe(true);
      expect(read.commentsCursor).toBe("opaque-page-2");
      const input = {
        projectId: read.projectId,
        tracker: read.tracker,
        host: read.host,
        scope: read.scope,
        key: read.key,
      };
      const older = yield* harness.call("read_issue_comments", {
        ...input,
        cursor: read.commentsCursor!,
      });
      expect(older).toEqual({ comments: [olderComment], nextCursor: "opaque-page-3" });
      const oldest = yield* harness.call("read_issue_comments", {
        ...input,
        cursor: older.nextCursor!,
      });
      expect(oldest).toEqual({
        comments: [{ ...olderComment, id: "comment-1" }],
        nextCursor: null,
      });
      expect(yield* Ref.get(harness.resolutions)).toEqual(["sources"]);
      expect(yield* Ref.get(harness.calls)).toEqual([
        { operation: "detail", input },
        { operation: "comments", input: { ...input, cursor: "opaque-page-2" } },
        { operation: "comments", input: { ...input, cursor: "opaque-page-3" } },
      ]);
    }),
  );

  it.effect("resolves comment URLs and key shorthand without full issue reads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("read_issue_comments", { url: detail.url, cursor: "url-page" });
      yield* harness.call("read_issue_comments", { key: "7", cursor: "key-page" });
      expect(yield* Ref.get(harness.calls)).toEqual([
        {
          operation: "comments",
          input: {
            projectId: PROJECT_ID,
            ...gitHostSource,
            scope: "t3tools/t3code",
            key: "7",
            cursor: "url-page",
          },
        },
        {
          operation: "comments",
          input: { projectId: PROJECT_ID, ...gitHostSource, key: "7", cursor: "key-page" },
        },
      ]);
    }),
  );

  it.effect("carries the detail viewer through explicit and shorthand comment continuations", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], { detail: { ...detail, viewer: "native-viewer" } });
      const read = yield* harness.call("read_issue", { key: "7" });
      expect(read.viewer).toBe("native-viewer");
      for (const target of [{ projectId: PROJECT_ID, ...gitHostSource, key: "7" }, { key: "7" }]) {
        yield* harness.call("read_issue_comments", {
          ...target,
          cursor: "older",
          viewer: read.viewer ?? undefined,
        });
      }
      expect(
        (yield* Ref.get(harness.calls))
          .filter((call) => call.operation === "comments")
          .map((call) => call.input),
      ).toEqual([
        {
          projectId: PROJECT_ID,
          ...gitHostSource,
          key: "7",
          cursor: "older",
          viewer: "native-viewer",
        },
        {
          projectId: PROJECT_ID,
          ...gitHostSource,
          key: "7",
          cursor: "older",
          viewer: "native-viewer",
        },
      ]);
    }),
  );

  it.effect("guards comment pages and preserves provider permission and cursor failures", () =>
    Effect.gen(function* () {
      const input = { projectId: PROJECT_ID, ...standaloneSource, key: "ENG-7", cursor: "page" };
      for (const detail of ["Permission denied by tracker", "Comment cursor expired"]) {
        const failure = new IssueOperationError({ operation: "comments", detail });
        const harness = yield* makeHarness([], { comments: () => Effect.fail(failure) });
        expect(
          yield* harness.call("read_issue_comments", input, []).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
          capability: "issues",
        });
        expect(yield* Ref.get(harness.calls)).toEqual([]);
        expect(yield* harness.call("read_issue_comments", input).pipe(Effect.flip)).toEqual(
          failure,
        );
        expect(yield* Ref.get(harness.calls)).toEqual([{ operation: "comments", input }]);
      }
    }),
  );

  it.effect("guards candidate reads with source selection and the issues capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], { sources: [gitHostSource, jiraSource] });
      const ambiguous = yield* harness.call("read_issue_candidates", {}).pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "IssueSourceSelectionError",
        sources: [gitHostSource, jiraSource],
      });
      const unbound = yield* harness
        .call("read_issue_candidates", { tracker: LINEAR })
        .pipe(Effect.flip);
      expect(unbound).toMatchObject({ _tag: "IssueSourceSelectionError", tracker: LINEAR });
      const denied = yield* harness
        .call(
          "read_issue_candidates",
          { projectId: PROJECT_ID, tracker: jiraSource.tracker, key: "OPS-7" },
          [],
        )
        .pipe(Effect.flip);
      expect(denied).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "issues" });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
      expect(yield* harness.call("read_issue_candidates", { tracker: jiraSource.tracker })).toEqual(
        candidates,
      );
      expect(yield* Ref.get(harness.calls)).toEqual([
        { operation: "candidates", input: { projectId: PROJECT_ID, ...jiraSource } },
      ]);
    }),
  );

  const decodeCandidateInput = Schema.decodeUnknownSync(
    IssuesToolkit.tools.read_issue_candidates.parametersSchema,
  );
  it.effect("keeps optional candidate keys through the registered MCP tool", () =>
    Effect.gen(function* () {
      const choices: IssueCandidates = {
        ...candidates,
        states: [{ id: "3", name: "In Progress", category: "open" }],
      };
      const harness = yield* makeHarness([], { sources: [jiraSource], candidates: choices });
      for (const selection of [{}, { key: "OPS-7" }]) {
        const input = { tracker: jiraSource.tracker, ...selection };
        expect(decodeCandidateInput(input)).toEqual(input);
        expect(yield* harness.call("read_issue_candidates", decodeCandidateInput(input))).toEqual(
          choices,
        );
      }
      expect(yield* Ref.get(harness.calls)).toEqual([
        { operation: "candidates", input: { projectId: PROJECT_ID, ...jiraSource } },
        {
          operation: "candidates",
          input: { projectId: PROJECT_ID, ...jiraSource, key: "OPS-7" },
        },
      ]);
      for (const key of ["", "  ", null, 7]) {
        expect(() => decodeCandidateInput({ tracker: jiraSource.tracker, key })).toThrow();
      }
    }),
  );

  it.effect("lists and uses the only standalone source without a Git remote", () =>
    Effect.gen(function* () {
      const { repositoryIdentity: _repositoryIdentity, ...standaloneProject } = project;
      const harness = yield* makeHarness([], {
        project: standaloneProject,
        sources: [standaloneSource],
        detail: standaloneDetail,
      });
      const listed = yield* harness.call("list_issues", {});
      expect(listed.issues).toMatchObject([{ tracker: LINEAR, scope: "ENG", key: "ENG-7" }]);
      const created = yield* harness.call("create_issue", { title: "New issue" });
      expect(created).toMatchObject({ tracker: LINEAR, host: "linear.app", scope: "ENG" });
      const read = yield* harness.call("read_issue", { key: "ENG-7" });
      expect(read).toMatchObject({ tracker: LINEAR, host: "linear.app", scope: "ENG" });
      yield* harness.call("comment_on_issue", { key: "ENG-7", body: "Comment" });
      yield* harness.call("set_issue_state", { key: "ENG-7", state: "Done" });
      yield* harness.call("link_issue", { key: "ENG-7" });
      expect(yield* Ref.get(harness.calls)).toEqual([
        { operation: "list", input: { projectId: PROJECT_ID, state: "open" } },
        {
          operation: "create",
          input: {
            projectId: PROJECT_ID,
            ...standaloneSource,
            title: "New issue",
            body: "",
            labels: [],
            assignees: [],
          },
        },
        {
          operation: "detail",
          input: { projectId: PROJECT_ID, ...standaloneSource, key: "ENG-7" },
        },
        {
          operation: "comment",
          input: { projectId: PROJECT_ID, ...standaloneSource, key: "ENG-7", body: "Comment" },
        },
        {
          operation: "setState",
          input: { projectId: PROJECT_ID, ...standaloneSource, key: "ENG-7", state: "Done" },
        },
        {
          operation: "detail",
          input: { projectId: PROJECT_ID, ...standaloneSource, key: "ENG-7" },
        },
      ]);
      expect((yield* Ref.get(harness.links))[0]).toMatchObject({
        ref: { projectId: PROJECT_ID, ...standaloneSource, key: "ENG-7" },
        url: standaloneDetail.url,
      });
    }),
  );

  it.effect("requires a tracker before reading or creating when two sources are bound", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], { sources: [gitHostSource, standaloneSource] });
      const read = yield* harness.call("read_issue", { key: "7" }).pipe(Effect.flip);
      const create = yield* harness
        .call("create_issue", { title: "Choose the tracker" })
        .pipe(Effect.flip);
      for (const error of [read, create])
        expect(error).toMatchObject({
          _tag: "IssueSourceSelectionError",
          projectId: PROJECT_ID,
          sources: [gitHostSource, standaloneSource],
        });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect("uses the explicit standalone tracker on a project with a Git tracker too", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], {
        sources: [gitHostSource, standaloneSource],
        detail: standaloneDetail,
      });
      const created = yield* harness.call("create_issue", {
        tracker: LINEAR,
        title: "Standalone issue",
      });
      expect(created).toMatchObject({ tracker: LINEAR, host: "linear.app", scope: "ENG" });
      const read = yield* harness.call("read_issue", { tracker: LINEAR, key: "ENG-7" });
      expect(read).toMatchObject({ tracker: LINEAR, scope: "ENG" });
      yield* harness.call("link_issue", { tracker: LINEAR, key: "ENG-7" });
      expect((yield* Ref.get(harness.calls))[0]).toEqual({
        operation: "create",
        input: {
          projectId: PROJECT_ID,
          ...standaloneSource,
          title: "Standalone issue",
          body: "",
          labels: [],
          assignees: [],
        },
      });
      expect((yield* Ref.get(harness.links))[0]?.ref.tracker).toBe(LINEAR);
    }),
  );

  it.effect("rejects an unbound tracker instead of using the remaining source", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], {
        sources: [standaloneSource],
        detail: standaloneDetail,
      });
      const error = yield* harness
        .call("create_issue", { tracker: GITHUB, title: "Wrong tracker" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "IssueSourceSelectionError",
        tracker: GITHUB,
        sources: [standaloneSource],
      });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect("refuses a credential without the issues capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_issues", {}, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "issues" });
    }),
  );

  it.effect("refuses explicit projects and URLs without the issues capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const capabilities = ["pull-requests"] as const;
      const errors = yield* Effect.all([
        harness.call("list_issues", { projectId: PROJECT_ID }, capabilities).pipe(Effect.flip),
        harness
          .call("read_issue", { projectId: PROJECT_ID, key: "7" }, capabilities)
          .pipe(Effect.flip),
        harness
          .call("read_issue", { projectId: PROJECT_ID, url: detail.url }, capabilities)
          .pipe(Effect.flip),
        harness
          .call("create_issue", { projectId: PROJECT_ID, title: "Issue" }, capabilities)
          .pipe(Effect.flip),
        harness
          .call(
            "comment_on_issue",
            { projectId: PROJECT_ID, url: detail.url, body: "Comment" },
            capabilities,
          )
          .pipe(Effect.flip),
        harness
          .call(
            "set_issue_state",
            { projectId: PROJECT_ID, key: "7", state: "closed" },
            capabilities,
          )
          .pipe(Effect.flip),
      ]);
      for (const error of errors)
        expect(error).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
          capability: "issues",
        });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
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
      expect((yield* Ref.get(harness.links))[0]?.detail).toEqual(detail);
      expect(
        (yield* Ref.get(harness.calls)).filter((call) => call.operation === "detail"),
      ).toHaveLength(1);
    }),
  );

  it.effect("unlinks a saved key after its source is disconnected or changed", () =>
    Effect.gen(function* () {
      for (const sources of [
        [],
        [standaloneSource],
        [{ ...gitHostSource, scope: "T3Tools/Other" }],
      ]) {
        const harness = yield* makeHarness([savedLink], { sources });
        const result = yield* harness.call("unlink_issue", { tracker: GITHUB, key: "7" });
        expect(result).toMatchObject({ ...gitHostSource, url: savedLink.url, wasLinked: true });
        expect(yield* Ref.get(harness.unlinks)).toEqual([{ threadId: THREAD_ID, key: savedLink }]);
        expect(yield* Ref.get(harness.resolutions)).toEqual([]);
        expect(yield* Ref.get(harness.calls)).toEqual([]);
      }
    }),
  );

  it.effect("unlinks only the saved URL on a disconnected host", () =>
    Effect.gen(function* () {
      const otherHost = {
        ...savedLink,
        host: "git.example.com",
        url: "https://git.example.com/T3Tools/T3Code/issues/7",
      };
      const harness = yield* makeHarness([savedLink, otherHost], { sources: [] });
      const result = yield* harness.call("unlink_issue", { url: otherHost.url });
      expect(result).toMatchObject({ host: otherHost.host, url: otherHost.url, wasLinked: true });
      expect(yield* Ref.get(harness.unlinks)).toEqual([{ threadId: THREAD_ID, key: otherHost }]);
      expect(yield* Ref.get(harness.resolutions)).toEqual([]);
    }),
  );

  it.effect("requires a saved URL when a key matches multiple tracker identities", () =>
    Effect.gen(function* () {
      const otherHost = {
        ...savedLink,
        host: "git.example.com",
        url: "https://git.example.com/T3Tools/T3Code/issues/7",
      };
      const otherScope = {
        ...savedLink,
        scope: "T3Tools/Other",
        url: "https://github.com/T3Tools/Other/issues/7",
      };
      const harness = yield* makeHarness([savedLink, otherHost, otherScope]);
      const error = yield* harness
        .call("unlink_issue", { tracker: GITHUB, key: "7" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "IssueOperationError", operation: "unlink" });
      expect(error.message).toContain("url");
      expect(yield* Ref.get(harness.unlinks)).toEqual([]);
      expect(yield* Ref.get(harness.resolutions)).toEqual([]);
      yield* harness.call("unlink_issue", { url: otherScope.url });
      expect(yield* Ref.get(harness.unlinks)).toEqual([{ threadId: THREAD_ID, key: otherScope }]);
    }),
  );

  it.effect("keeps saved key matches within the requested project and tracker", () =>
    Effect.gen(function* () {
      const otherProject = { ...savedLink, projectId: ProjectId.make("project-2") };
      const otherTracker = { ...savedLink, ...standaloneSource };
      const harness = yield* makeHarness([otherProject, otherTracker, savedLink], { sources: [] });
      const ambiguous = yield* harness.call("unlink_issue", { key: "7" }).pipe(Effect.flip);
      expect(ambiguous).toMatchObject({ _tag: "IssueOperationError", operation: "unlink" });
      yield* harness.call("unlink_issue", { tracker: GITHUB, key: "7" });
      yield* harness.call("unlink_issue", {
        projectId: otherProject.projectId,
        tracker: GITHUB,
        key: "7",
      });
      expect(yield* Ref.get(harness.unlinks)).toEqual([
        { threadId: THREAD_ID, key: savedLink },
        { threadId: THREAD_ID, key: otherProject },
      ]);
      expect(yield* Ref.get(harness.resolutions)).toEqual([]);
    }),
  );

  it.effect("honors explicit host and scope before unlinking a saved key", () =>
    Effect.gen(function* () {
      for (const input of [{ scope: "T3Tools/Other" }, { host: "git.example.com" }]) {
        const harness = yield* makeHarness([savedLink]);
        const result = yield* harness.call("unlink_issue", { tracker: GITHUB, key: "7", ...input });
        expect(result.wasLinked).toBe(false);
        expect(yield* Ref.get(harness.unlinks)).toEqual([]);
      }
      const otherScope = { ...savedLink, scope: "T3Tools/Other" };
      const harness = yield* makeHarness([savedLink, otherScope], { sources: [] });
      yield* harness.call("unlink_issue", {
        tracker: GITHUB,
        host: "GITHUB.COM",
        scope: "t3tools/other",
        key: "7",
      });
      expect(yield* Ref.get(harness.unlinks)).toEqual([{ threadId: THREAD_ID, key: otherScope }]);
      expect(yield* Ref.get(harness.resolutions)).toEqual([]);
    }),
  );

  it.effect("honors every explicit identity field with a saved URL", () =>
    Effect.gen(function* () {
      for (const input of [
        { projectId: ProjectId.make("project-2") },
        { tracker: LINEAR },
        { host: "git.example.com" },
        { scope: "T3Tools/Other" },
        { key: "8" },
      ]) {
        const harness = yield* makeHarness([savedLink]);
        const result = yield* harness.call("unlink_issue", { url: savedLink.url, ...input });
        expect(result.wasLinked).toBe(false);
        expect(yield* Ref.get(harness.unlinks)).toEqual([]);
      }
    }),
  );

  it.effect("keeps the issues capability check before unlinking a saved link", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([savedLink]);
      const error = yield* harness
        .call("unlink_issue", { url: savedLink.url }, [])
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "issues" });
      expect(yield* Ref.get(harness.unlinks)).toEqual([]);
      expect(yield* Ref.get(harness.resolutions)).toEqual([]);
    }),
  );

  it.effect("refuses a saved URL that matches more than one link", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        savedLink,
        { ...savedLink, projectId: ProjectId.make("project-2") },
      ]);
      const error = yield* harness.call("unlink_issue", { url: savedLink.url }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "IssueOperationError", operation: "unlink" });
      expect(yield* Ref.get(harness.unlinks)).toEqual([]);
      expect(yield* Ref.get(harness.resolutions)).toEqual([]);
    }),
  );

  it.effect("keeps an unlinked issue idempotent through normal target resolution", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("unlink_issue", { url: detail.url });
      expect(result).toMatchObject({ url: detail.url, wasLinked: false });
      expect(yield* Ref.get(harness.unlinks)).toEqual([]);
      expect(yield* Ref.get(harness.resolutions)).toEqual(["resolveUrl"]);
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

it.effect(
  "continues native history and hierarchy without another issue read or source selection",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const input = {
        projectId: PROJECT_ID,
        ...gitHostSource,
        key: "7",
        cursor: "opaque",
        limit: 13,
      };
      expect((yield* harness.call("read_issue_history", input)).nextCursor).toBe(
        "native-history-next",
      );
      expect((yield* harness.call("read_issue_hierarchy", input)).children.nextCursor).toBe(
        "native-children-next",
      );
      yield* harness.call("read_issue_linked_pull_requests", input);
      expect(yield* Ref.get(harness.resolutions)).toEqual([]);
      expect(
        (yield* Ref.get(harness.calls)).map(({ operation, input }) => ({ operation, input })),
      ).toEqual(
        ["history", "hierarchy", "linkedPullRequests"].map((operation) => ({ operation, input })),
      );
    }),
);

it.effect("exposes native issue writes through the shared service without a detail read", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const input = { projectId: PROJECT_ID, ...gitHostSource, key: "7" };
    yield* harness.call("update_issue", { ...input, title: "New title" });
    yield* harness.call("edit_issue_comment", { ...input, commentId: "comment-1", body: "Edited" });
    yield* harness.call("set_issue_reaction", {
      ...input,
      subjectId: "comment-1",
      content: "heart",
      reacted: false,
    });
    yield* harness.call("set_issue_labels", { ...input, labels: [] });
    yield* harness.call("set_issue_assignees", { ...input, assignees: [] });
    yield* harness.call("set_issue_parent", { ...input, parentKey: null });
    expect((yield* Ref.get(harness.calls)).map(({ operation }) => operation)).toEqual([
      "update",
      "editComment",
      "react",
      "update",
      "update",
      "setParent",
    ]);
    expect(yield* Ref.get(harness.resolutions)).toEqual([]);
  }),
);

it.effect("pages native candidates and keeps scope templates on the selected source", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([], { sources: [gitHostSource, standaloneSource] });
    const input = { projectId: PROJECT_ID, tracker: LINEAR, cursor: "opaque", limit: 11 };
    expect((yield* harness.call("list_issue_labels", input)).nextCursor).toBe("native-labels-next");
    yield* harness.call("list_issue_assignees", input);
    yield* harness.call("read_issue_templates", { projectId: PROJECT_ID, tracker: LINEAR });
    const sources = yield* harness.call("list_issue_sources", { projectId: PROJECT_ID });
    expect(sources.sources).toHaveLength(2);
    expect((yield* Ref.get(harness.calls)).map(({ operation }) => operation)).toEqual([
      "labelCandidates",
      "assigneeCandidates",
      "templates",
      "listSources",
    ]);
  }),
);

it.effect("keeps an explicit foreign scope when the host defaults to the selected source", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.call("edit_issue_comment", {
      projectId: PROJECT_ID,
      tracker: GITHUB,
      scope: "other/repo",
      key: "7",
      commentId: "2",
      body: "Edited",
    });
    expect(yield* Ref.get(harness.calls)).toEqual([
      {
        operation: "editComment",
        input: {
          projectId: PROJECT_ID,
          tracker: GITHUB,
          host: gitHostSource.host,
          scope: "other/repo",
          key: "7",
          commentId: "2",
          body: "Edited",
        },
      },
    ]);
  }),
);

it.effect("keeps native fields, rich bodies and dependency actions on the selected source", () =>
  Effect.gen(function* () {
    const source = { ...standaloneSource, connectionId: "ExactB" };
    const richBody = {
      format: "adf" as const,
      document: '{"type":"doc","version":1,"content":[]}',
    };
    const fieldValues = { custom: "value" };
    const harness = yield* makeHarness([], { sources: [standaloneSource, source] });
    const input = { projectId: PROJECT_ID, ...source, key: "ENG-7" };
    yield* harness.call("read_issue_candidates", { ...input, issueType: "Bug" });
    yield* harness.call("create_issue", { ...input, title: "New", fieldValues });
    yield* harness.call("set_issue_state", {
      ...input,
      state: "3",
      transitionId: "31",
      fieldValues,
    });
    yield* harness.call("update_issue", { ...input, richBody });
    yield* harness.call("edit_issue_comment", {
      ...input,
      commentId: "c",
      body: "fallback",
      richBody,
    });
    expect(
      (yield* harness.call("read_issue_dependencies", {
        ...input,
        direction: "blocks",
        cursor: "native",
        limit: 7,
      })).nextCursor,
    ).toBe("dependency-next");
    yield* harness.call("set_issue_dependency", {
      ...input,
      direction: "blocked-by",
      targetScope: "OPS",
      targetKey: "OPS-1",
      linked: false,
    });
    expect(yield* Ref.get(harness.calls)).toMatchObject([
      { operation: "candidates", input: { connectionId: "ExactB", issueType: "Bug" } },
      { operation: "create", input: { connectionId: "ExactB", fieldValues } },
      {
        operation: "setState",
        input: { connectionId: "ExactB", state: "3", transitionId: "31", fieldValues },
      },
      { operation: "update", input: { connectionId: "ExactB", richBody } },
      { operation: "editComment", input: { connectionId: "ExactB", richBody } },
      {
        operation: "dependencies",
        input: { connectionId: "ExactB", direction: "blocks", cursor: "native", limit: 7 },
      },
      {
        operation: "setDependency",
        input: {
          connectionId: "ExactB",
          direction: "blocked-by",
          targetScope: "OPS",
          targetKey: "OPS-1",
          linked: false,
        },
      },
    ]);
    const before = yield* Ref.get(harness.calls);
    yield* harness
      .call(
        "set_issue_dependency",
        { ...input, direction: "blocks", targetScope: "OPS", targetKey: "OPS-1", linked: true },
        ["issues"],
        true,
      )
      .pipe(Effect.flip);
    expect(yield* Ref.get(harness.calls)).toEqual(before);
  }),
);

const decodeLegacyIssueWrite = Schema.decodeUnknownSync(
  Schema.Struct({
    title: Schema.optional(Schema.String),
    state: Schema.optional(Schema.String),
    body: Schema.optional(Schema.String),
  }),
);

it.each([
  ["create_issue", { title: "New", fieldValues: { custom: "value" } }],
  ["set_issue_state", { key: "ENG-7", state: "3", transitionId: "31" }],
  ["update_issue", { key: "ENG-7", richBody: { format: "adf", document: "{}" } }],
  [
    "edit_issue_comment",
    { key: "ENG-7", commentId: "c", body: "fallback", richBody: { format: "adf", document: "{}" } },
  ],
] as const)("protects advanced %s tool requests from old-server partial writes", (tool, input) => {
  const codec = IssuesToolkit.tools[tool].parametersSchema;
  for (const selection of [{}, { connectionId: "ExactB" }]) {
    const selected = { projectId: PROJECT_ID, ...input, ...selection };
    const encoded = Schema.encodeUnknownSync(codec)(selected);
    expect(Schema.decodeUnknownSync(codec)(encoded)).toEqual(selected);
    expect(() => Schema.decodeUnknownSync(codec)(selected)).toThrow();
    expect(() => decodeLegacyIssueWrite(encoded)).toThrow();
  }
});

it.effect("preserves native rich bodies, item types and external links through issue tools", () =>
  Effect.gen(function* () {
    const richBody = {
      format: "adf" as const,
      document: '{"type":"doc","version":1,"content":[]}',
    };
    const native = {
      ...detail,
      itemType: "Task",
      richBody,
      externalLinks: [{ title: "Design", url: "https://design.example/item" }],
      comments: [
        {
          id: "c",
          author: null,
          body: "fallback",
          richBody,
          url: null,
          createdAt: detail.createdAt,
        },
      ],
    };
    const harness = yield* makeHarness([], { detail: native });
    const result = yield* harness.call("read_issue", {
      projectId: PROJECT_ID,
      ...gitHostSource,
      key: "7",
    });
    expect(result).toMatchObject({
      richBody,
      itemType: "Task",
      externalLinks: native.externalLinks,
      comments: [{ richBody }],
    });
  }),
);

it.effect("reads ascending history through the registered schema on the selected account", () =>
  Effect.gen(function* () {
    const source = { ...standaloneSource, connectionId: "Account" };
    const event = {
      id: "oldest",
      kind: "updated" as const,
      actor: null,
      createdAt: detail.createdAt,
      detail: null,
    };
    const harness = yield* makeHarness([], {
      sources: [source],
      history: (input) =>
        input.order === "asc"
          ? Effect.succeed({ items: [event], nextCursor: null })
          : Effect.fail(
              new IssueOperationError({
                operation: "history",
                detail: "Native history supports asc only",
              }),
            ),
    });
    const input = {
      projectId: PROJECT_ID,
      ...source,
      key: "ENG-7",
      order: "asc" as const,
      cursor: "opaque",
      limit: 1,
    };
    expect(yield* harness.call("read_issue_history", input)).toEqual({
      items: [event],
      nextCursor: null,
    });
    expect(yield* Ref.get(harness.calls)).toEqual([{ operation: "history", input }]);
    expect(yield* Ref.get(harness.resolutions)).toEqual([]);
    expect((yield* harness.call("read_issue_history", input, []).pipe(Effect.flip))._tag).toBe(
      "McpCapabilityUnavailableError",
    );
    expect(yield* Ref.get(harness.calls)).toHaveLength(1);
  }),
);

it.effect.each(["explicit", "shorthand"] as const)(
  "continues ascending comments through %s targets without extra detail reads",
  (shape) =>
    Effect.gen(function* () {
      const source = { ...standaloneSource, connectionId: "Account" };
      const comment = {
        id: "older",
        author: null,
        body: "Older",
        createdAt: detail.createdAt,
        url: null,
        canEdit: true,
      };
      const harness = yield* makeHarness([], {
        sources: [source],
        comments: (input) =>
          input.order === "asc"
            ? Effect.succeed({ comments: [comment], nextCursor: "opaque-next" })
            : Effect.fail(
                new IssueOperationError({ operation: "comments", detail: "Cursor order mismatch" }),
              ),
      });
      const target =
        shape === "explicit"
          ? { projectId: PROJECT_ID, ...source, key: "ENG-7" }
          : { key: "ENG-7", connectionId: "Account" };
      const input = { ...target, order: "asc" as const, cursor: "opaque", viewer: "viewer" };
      expect(yield* harness.call("read_issue_comments", input)).toEqual({
        comments: [comment],
        nextCursor: "opaque-next",
      });
      expect(yield* Ref.get(harness.calls)).toEqual([
        {
          operation: "comments",
          input: {
            projectId: PROJECT_ID,
            ...source,
            key: "ENG-7",
            order: "asc",
            cursor: "opaque",
            viewer: "viewer",
          },
        },
      ]);
      expect(yield* Ref.get(harness.resolutions)).toEqual(shape === "explicit" ? [] : ["sources"]);
    }),
);

it.effect.each(["asc", "desc", undefined] as const)(
  "starts true comment pages in order %s without a cursor or detail read",
  (order) =>
    Effect.gen(function* () {
      const oldest = {
        id: "oldest",
        author: null,
        body: "Oldest",
        createdAt: detail.createdAt,
        url: null,
      };
      const newest = { ...oldest, id: "newest", body: "Newest" };
      const harness = yield* makeHarness([], {
        comments: (input) =>
          Effect.succeed({ comments: [input.order === "asc" ? oldest : newest], nextCursor: null }),
      });
      const input = {
        projectId: PROJECT_ID,
        ...gitHostSource,
        key: "7",
        ...(order === undefined ? {} : { order }),
      };
      expect(yield* harness.call("read_issue_comments", input)).toEqual({
        comments: [order === "asc" ? oldest : newest],
        nextCursor: null,
      });
      expect(yield* Ref.get(harness.calls)).toEqual([{ operation: "comments", input }]);
      expect(yield* Ref.get(harness.resolutions)).toEqual([]);
    }),
);

it.effect(
  "keeps oldest-only detail readable and continues its native order without preflight reads",
  () =>
    Effect.gen(function* () {
      const source = {
        ...gitHostSource,
        tracker: IssueTrackerKind.make("gitcafe"),
        host: "git.cafe",
      };
      const first = {
        id: "oldest",
        author: null,
        body: "First",
        createdAt: detail.createdAt,
        url: null,
      };
      const next = { ...first, id: "next", body: "Next" };
      const refusal = new IssueOperationError({
        operation: "comments",
        detail: "Native comments support asc only",
      });
      const harness = yield* makeHarness([], {
        sources: [source],
        detail: {
          ...detail,
          ...source,
          url: "https://git.cafe/T3Tools/T3Code/issues/7",
          comments: [first],
          commentsCursor: "native-asc-cursor",
          capabilities: { ...detail.capabilities, commentOrders: ["asc"] },
        },
        comments: (input) =>
          input.order === "asc"
            ? Effect.succeed({ comments: [next], nextCursor: null })
            : Effect.fail(refusal),
      });
      const read = yield* harness.call("read_issue", { key: "7" });
      expect(read.comments).toMatchObject([{ id: "oldest" }]);
      expect(read.capabilities.commentOrders).toEqual(["asc"]);
      const input = {
        projectId: read.projectId,
        tracker: read.tracker,
        host: read.host,
        scope: read.scope,
        key: read.key,
        cursor: read.commentsCursor!,
        order: read.capabilities.commentOrders![0],
      };
      expect(yield* harness.call("read_issue_comments", input)).toEqual({
        comments: [next],
        nextCursor: null,
      });
      expect(
        yield* harness.call("read_issue_comments", { ...input, order: "desc" }).pipe(Effect.flip),
      ).toEqual(refusal);
      expect((yield* Ref.get(harness.calls)).map(({ operation }) => operation)).toEqual([
        "detail",
        "comments",
        "comments",
      ]);
      expect(yield* Ref.get(harness.resolutions)).toEqual(["sources"]);
    }),
);
