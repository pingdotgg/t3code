import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueDetail,
  type PullRequestDetail,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as IssueService from "../../../issue/IssueService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as WorkItemLinks from "../../../workItems/WorkItemLinks.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssuesToolkitHandlersLive } from "./handlers.ts";
import { IssuesToolkit } from "./tools.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const issue: ThreadIssueLink = {
  provider: "github",
  repository: "t3tools/t3code",
  number: 7,
  url: "https://github.com/t3tools/t3code/issues/7",
  title: "Canonical issue",
};
const pullRequest = {
  provider: "github",
  repository: "t3tools/t3code",
  number: 9,
  url: "https://github.com/t3tools/t3code/pull/9",
  title: "Canonical pull request",
};
const savedLink = { issue, pullRequest };

const thread = (issues: ReadonlyArray<ThreadIssueLink> = []): OrchestrationThreadShell => ({
  id: threadId,
  projectId,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  issues,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.fn("makeIssuesToolkitHarness")(function* (
  current: OrchestrationThreadShell | null = thread(),
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const detailRequests = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const pullRequestDetailRequests = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const savedLinkRequests = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 }));
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.succeed(id === threadId ? Option.fromNullishOr(current) : Option.none()),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(IssueService.IssueService)({
      detail: (ref) =>
        Ref.update(detailRequests, (recorded) => [...recorded, ref]).pipe(
          Effect.as(issue as IssueDetail),
        ),
    }),
    Layer.mock(WorkItemLinks.WorkItemLinks)({
      list: (input) =>
        Ref.update(savedLinkRequests, (requests) => [...requests, { list: input }]).pipe(
          Effect.as({ links: [savedLink], truncated: false }),
        ),
      link: (input) =>
        Ref.update(savedLinkRequests, (requests) => [...requests, { link: input }]).pipe(
          Effect.as(savedLink),
        ),
      unlink: (input) =>
        Ref.update(savedLinkRequests, (requests) => [...requests, { unlink: input }]),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      withRoutingCredential: (_ref, operation) => operation,
      detail: (ref) =>
        Ref.update(pullRequestDetailRequests, (recorded) => [...recorded, ref]).pipe(
          Effect.as(pullRequest as PullRequestDetail),
        ),
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(7),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  const toolkit = yield* IssuesToolkit.pipe(
    Effect.provide(IssuesToolkitHandlersLive.pipe(Layer.provide(dependencies))),
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
      Effect.provide(dependencies),
    );
  return { commands, detailRequests, pullRequestDetailRequests, savedLinkRequests, call };
});

describe("issue toolkit handlers", () => {
  it.effect("links the canonical issue to the credential's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_issue", {
        repository: "T3Tools/T3Code",
        number: 7,
      });
      expect(result).toEqual({ issue, alreadyLinked: false });
      expect(yield* Ref.get(harness.detailRequests)).toEqual([
        {
          projectId,
          repository: "T3Tools/T3Code",
          number: 7,
        },
      ]);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.meta.update",
          threadId,
          issueLink: issue,
        },
      ]);
    }),
  );

  it.effect("unlinks a local issue without requiring a host read", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(thread([issue]));
      expect(
        yield* harness.call("unlink_issue", {
          repository: "T3TOOLS/T3CODE",
          number: 7,
        }),
      ).toEqual({ wasLinked: true });
      expect(yield* Ref.get(harness.detailRequests)).toEqual([]);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          issueUnlink: { provider: "github", repository: "t3tools/t3code", number: 7 },
        },
      ]);
    }),
  );

  it.effect("shows only this thread's links and rejects a credential without issue access", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(thread([issue]));
      expect(yield* harness.call("list_thread_issues", {})).toEqual({ issues: [issue] });
      const error = yield* harness
        .call("list_thread_issues", {}, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "issues",
        threadId,
      });
    }),
  );

  it.effect("uses the thread project to resolve saved link tools", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refs = {
        issue: { repository: "t3tools/t3code", number: 7, provider: "github" },
        pullRequest: { repository: "t3tools/t3code", number: 9 },
      };
      expect(yield* harness.call("link_issue_to_pull_request", refs)).toEqual(savedLink);
      expect(
        yield* harness.call("list_issue_pull_request_links", {
          source: { kind: "issue", ...refs.issue },
        }),
      ).toEqual({ links: [savedLink], truncated: false });
      yield* harness.call("unlink_issue_from_pull_request", refs);
      expect(yield* Ref.get(harness.detailRequests)).toEqual([
        { projectId, ...refs.issue },
        { projectId, ...refs.issue },
      ]);
      expect(yield* Ref.get(harness.pullRequestDetailRequests)).toEqual([
        { projectId, ...refs.pullRequest },
      ]);
      expect(yield* Ref.get(harness.savedLinkRequests)).toEqual([
        {
          link: {
            issue: { projectId, ...refs.issue },
            pullRequest: { projectId, ...refs.pullRequest },
          },
        },
        { list: { source: { provider: "github", url: issue.url } } },
        {
          unlink: {
            issue: { provider: "github", url: issue.url },
            pullRequest: { provider: "github", url: pullRequest.url },
          },
        },
      ]);
    }),
  );
});
