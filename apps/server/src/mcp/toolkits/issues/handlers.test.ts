import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueDetail,
  type PullRequestDetail,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as IssueService from "../../../issue/IssueService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as WorkItemLinks from "../../../workItems/WorkItemLinks.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
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

const thread = (issues: ReadonlyArray<ThreadIssueLink> = []): OrchestrationV2ThreadShell => ({
  ...v2PullRequestThread({
    id: threadId,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
  }),
  issues,
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
  current: OrchestrationV2ThreadShell | null = thread(),
  dispatchError?: Orchestrator.OrchestratorDispatchError,
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const detailRequests = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const pullRequestDetailRequests = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const routingRequests = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const savedLinkRequests = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) => Effect.succeed(id === threadId ? current : null),
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(
          Effect.andThen(
            dispatchError
              ? Effect.fail(dispatchError)
              : Effect.succeed({ sequence: 1, events: [], storedEvents: [] }),
          ),
        ),
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
      withRoutingCredential: (ref, operation) =>
        Ref.update(routingRequests, (recorded) => [...recorded, ref]).pipe(
          Effect.andThen(operation),
        ),
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
  return {
    commands,
    detailRequests,
    pullRequestDetailRequests,
    routingRequests,
    savedLinkRequests,
    call,
  };
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
          type: "thread.metadata.update",
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

  it.effect("returns an existing link without dispatching a second command", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(thread([issue]));
      expect(
        yield* harness.call("link_issue", { repository: "T3TOOLS/T3CODE", number: 7 }),
      ).toEqual({ issue, alreadyLinked: true });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links the authorized issue when the same repository and number use another host", () =>
    Effect.gen(function* () {
      const enterpriseIssue = { ...issue, url: "https://github.acme.test/t3tools/t3code/issues/7" };
      const harness = yield* makeHarness(thread([enterpriseIssue]));
      expect(
        yield* harness.call("link_issue", { repository: issue.repository, number: 7 }),
      ).toEqual({ issue, alreadyLinked: false });
      expect(yield* Ref.get(harness.commands)).toMatchObject([{ issueLink: issue }]);
    }),
  );

  it.effect("requires a URL for ambiguous hosts and unlinks only that saved URL", () =>
    Effect.gen(function* () {
      const enterpriseIssue = { ...issue, url: "https://github.acme.test/t3tools/t3code/issues/7" };
      const harness = yield* makeHarness(thread([issue, enterpriseIssue]));
      const input = { repository: issue.repository, number: 7, provider: "github" };
      expect(yield* harness.call("unlink_issue", input).pipe(Effect.flip)).toMatchObject({
        _tag: "IssueOperationError",
        detail: expect.stringContaining("Pass url"),
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
      expect(yield* harness.call("unlink_issue", { ...input, url: enterpriseIssue.url })).toEqual({
        wasLinked: true,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          issueUnlink: { ...input, url: enterpriseIssue.url },
        },
      ]);
    }),
  );

  it.effect("keeps links idempotent when another caller changes them before dispatch", () =>
    Effect.gen(function* () {
      const failure = (cause: string) =>
        new Orchestrator.OrchestratorDispatchError({
          commandId: CommandId.make("racing-command"),
          commandType: "thread.metadata.update",
          cause,
        });
      const linking = yield* makeHarness(thread(), failure("Issue is already linked"));
      expect(
        yield* linking.call("link_issue", { repository: issue.repository, number: 7 }),
      ).toEqual({ issue, alreadyLinked: true });
      const unlinking = yield* makeHarness(thread([issue]), failure("Issue is not linked"));
      expect(
        yield* unlinking.call("unlink_issue", { repository: issue.repository, number: 7 }),
      ).toEqual({ wasLinked: false });
      const rejected = yield* makeHarness(thread(), failure("Thread already has 20 linked issues"));
      expect(
        yield* rejected
          .call("link_issue", { repository: issue.repository, number: 7 })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "IssueThreadLinkFailedError" });
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
      expect(
        yield* harness.call("list_issue_pull_request_links", {
          source: { kind: "pull-request", ...refs.pullRequest },
        }),
      ).toEqual({ links: [savedLink], truncated: false });
      expect(yield* Ref.get(harness.detailRequests)).toEqual([
        { projectId, ...refs.issue },
        { projectId, ...refs.issue },
      ]);
      expect(yield* Ref.get(harness.pullRequestDetailRequests)).toEqual([
        { projectId, ...refs.pullRequest },
        { projectId, ...refs.pullRequest },
      ]);
      expect(yield* Ref.get(harness.routingRequests)).toEqual([
        { projectId, ...refs.pullRequest },
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
        { list: { source: { provider: "github", url: pullRequest.url } } },
      ]);
    }),
  );
});
