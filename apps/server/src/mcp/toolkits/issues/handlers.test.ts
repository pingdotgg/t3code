import {
  EnvironmentId,
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueDetail,
  type IssueCandidates,
  type OrchestrationProjectShell,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, type Tool } from "effect/ai";

import * as LinearApi from "@t3tools/issue-tracker-linear/server/LinearApi";
import * as LinearIssueTracker from "@t3tools/issue-tracker-linear/server/LinearIssueTracker";

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

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const GITHUB = IssueTrackerKind.make("github");
const LINEAR = IssueTrackerKind.make("linear");
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
const decodeReadIssueResult = Schema.decodeUnknownEffect(
  IssuesToolkit.tools.read_issue.successSchema,
);

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
    readonly detail?: IssueDetail;
    readonly comments?: IssueService.IssueService["Service"]["comments"];
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
      getThreadShell: (id) => Effect.succeed(id === THREAD_ID ? makeThread(issues) : null),
    }),
    Layer.mock(IssueService.IssueService)({
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
      candidates: (input) => record("candidates", input, candidates),
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
  return { links, unlinks, resolutions, call, calls, layerDependencies };
});

describe("issue toolkit handlers", () => {
  it.effect("preserves optional body editing and native states through registered MCP output", () =>
    Effect.gen(function* () {
      const nativeDetail = {
        ...detail,
        bodyEditable: false,
        states: [
          { category: "open", name: "Needs review" },
          { category: "closed", name: "Shipped" },
        ],
      } satisfies IssueDetail;
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
      for (const currentDetail of [nativeDetail, detail]) {
        const harness = yield* makeHarness([], { detail: currentDetail });
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const result = yield* server.callTool({
            name: "read_issue",
            arguments: { projectId: PROJECT_ID, key: "7" },
          });
          expect(result.isError).toBe(false);
          const read = yield* decodeReadIssueResult(result.structuredContent);
          if (currentDetail.bodyEditable === undefined) {
            expect(read).not.toHaveProperty("bodyEditable");
            expect(read).not.toHaveProperty("states");
          } else {
            expect(read.bodyEditable).toBe(false);
            expect(read.states).toEqual(nativeDetail.states);
          }
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

  it.effect("preserves an archived Linear label ID when replacing labels from read and list", () =>
    Effect.gen(function* () {
      const oldBug = { id: "W", name: "Bug", color: null, archivedAt: "2026-01-01T00:00:00Z" };
      const teamBug = { id: "T", name: "Bug", color: null };
      const other = { id: "O", name: "Other", color: null };
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const writes: Record<string, unknown>[] = [];
      const native = yield* LinearIssueTracker.make.pipe(
        Effect.provide(
          Layer.mock(LinearApi.LinearApi)({
            getIssueReference: () =>
              Effect.succeed({
                id: "issue",
                identifier: "ENG-7",
                team: { key: "ENG" },
                url: standaloneDetail.url,
              }),
            getTeam: () =>
              Effect.succeed({
                organization: { id: "workspace", urlKey: "acme", templates: empty },
                team: {
                  id: "team",
                  key: "ENG",
                  name: "Engineering",
                  states: empty,
                  labels: { ...empty, nodes: [teamBug, other] },
                  members: empty,
                  templates: empty,
                  ancestors: [],
                },
                workspaceLabels: [oldBug],
                templates: [],
                templatesTruncated: false,
                labelsTruncated: false,
                truncated: false,
              }),
            updateIssue: (_id, patch) =>
              Effect.sync(() => {
                writes.push(patch);
              }),
          }),
        ),
      );
      const available = yield* native.listCandidates!({
        cwd: "/fake",
        host: "linear.app",
        scope: "ENG",
      });
      expect(available.labels.map((label) => label.id)).toEqual(["T", "O"]);
      const harness = yield* makeHarness([], {
        sources: [standaloneSource],
        detail: { ...standaloneDetail, labels: [oldBug], labelsTruncated: false },
      });
      const read = yield* harness.call("read_issue", { key: "ENG-7" });
      const listed = yield* harness.call("list_issues", {});
      const target = { cwd: "/fake", host: "linear.app", scope: "ENG", key: "ENG-7" };
      const failed = yield* native.update!({ ...target, labels: [...read.labels, other.id] }).pipe(
        Effect.flip,
      );
      expect(failed.detail).toContain("ambiguous");
      expect(writes).toEqual([]);
      for (const output of [read, listed.issues[0]!]) {
        expect(output.labels).toEqual(["Bug"]);
        const selected =
          output.labelDetails?.map((label) => label.id ?? label.name) ?? output.labels;
        yield* native.update!({ ...target, labels: [...selected, other.id] });
      }
      expect(writes).toEqual([{ labelIds: ["W", "O"] }, { labelIds: ["W", "O"] }]);
      expect((yield* Ref.get(harness.calls)).map((call) => call.operation)).toEqual([
        "detail",
        "list",
      ]);
    }),
  );

  it.effect("retains name-only labels and omits unknown truncation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], {
        detail: { ...detail, labels: [{ name: "Bug", color: null }] },
      });
      const read = yield* harness.call("read_issue", { key: "7" });
      const listed = yield* harness.call("list_issues", {});
      for (const output of [read, listed.issues[0]!]) {
        expect(output.labels).toEqual(["Bug"]);
        expect(output.labelDetails).toEqual([{ name: "Bug", color: null }]);
        expect(output).not.toHaveProperty("labelsTruncated");
      }
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
        .call("read_issue_candidates", { projectId: PROJECT_ID, tracker: jiraSource.tracker }, [])
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

  it.effect.each([
    { source: gitHostSource, issueDetail: detail, key: "7" },
    { source: standaloneSource, issueDetail: standaloneDetail, key: "eng-7" },
  ])(
    "links key $key through the thread's project and reads the native URL",
    ({ source, issueDetail, key }) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([], { sources: [source], detail: issueDetail });
        const result = yield* harness.call("link_issue", { key });
        expect(result.url).toBe(issueDetail.url);
        expect(result.scope).toBe(source.scope);
        expect((yield* Ref.get(harness.links))[0]).toMatchObject({
          ref: { ...source, key },
          url: issueDetail.url,
        });
        expect(yield* Ref.get(harness.calls)).toEqual([
          { operation: "detail", input: { projectId: PROJECT_ID, ...source, key } },
        ]);
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

  it.effect.each([
    { source: standaloneSource, key: "ENG-7", url: standaloneDetail.url },
    {
      source: { ...jiraSource, scope: "OPS" },
      key: "OPS-7",
      url: "https://example.atlassian.net/browse/OPS-7",
    },
  ])(
    "unlinks saved native $key without its source and refuses equivalent duplicates",
    ({ source, key, url }) =>
      Effect.gen(function* () {
        const link = { ...savedLink, ...source, key: key.toLowerCase(), url };
        const harness = yield* makeHarness([link], { sources: [] });
        const result = yield* harness.call("unlink_issue", { tracker: source.tracker, key });
        expect(result).toMatchObject({ ...source, key: link.key, url, wasLinked: true });
        expect(yield* Ref.get(harness.unlinks)).toEqual([{ threadId: THREAD_ID, key: link }]);
        expect(yield* Ref.get(harness.resolutions)).toEqual([]);
        expect(yield* Ref.get(harness.calls)).toEqual([]);

        const ambiguous = yield* makeHarness([link, { ...link, key }], { sources: [] });
        const error = yield* ambiguous
          .call("unlink_issue", { tracker: source.tracker, key })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "IssueOperationError", operation: "unlink" });
        expect(yield* Ref.get(ambiguous.unlinks)).toEqual([]);
        expect(yield* Ref.get(ambiguous.resolutions)).toEqual([]);
        expect(yield* Ref.get(ambiguous.calls)).toEqual([]);
      }),
  );

  it.effect("keeps custom tracker saved keys case exact while disconnected", () =>
    Effect.gen(function* () {
      const link = { ...savedLink, tracker: IssueTrackerKind.make("custom-tracker"), key: "eng-7" };
      const harness = yield* makeHarness([link], { sources: [] });
      const error = yield* harness
        .call("unlink_issue", { tracker: link.tracker, key: "ENG-7" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "IssueProjectNotFoundError" });
      expect(yield* Ref.get(harness.unlinks)).toEqual([]);
      expect(yield* Ref.get(harness.resolutions)).toEqual(["sources"]);
      expect(yield* Ref.get(harness.calls)).toEqual([]);
      yield* harness.call("unlink_issue", { tracker: link.tracker, key: link.key });
      expect(yield* Ref.get(harness.unlinks)).toEqual([{ threadId: THREAD_ID, key: link }]);
      expect(yield* Ref.get(harness.resolutions)).toEqual(["sources"]);
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
