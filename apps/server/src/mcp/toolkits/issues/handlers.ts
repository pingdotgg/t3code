import {
  CommandId,
  IssueOperationError,
  type IssueRef,
  type ProjectId,
  normalizeWorkItemLinkKey,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as IssueService from "../../../issue/IssueService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as WorkItemLinks from "../../../workItems/WorkItemLinks.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  IssueTargetInput,
  IssueThreadLinkFailedError,
  IssueThreadNotFoundError,
  IssuesToolkit,
} from "./tools.ts";

const issueRef = (projectId: ProjectId, ref: typeof IssueTargetInput.Type): IssueRef => ({
  projectId,
  repository: ref.repository,
  number: ref.number,
  ...(ref.provider === undefined ? {} : { provider: ref.provider }),
});

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const issues = yield* IssueService.IssueService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const workItemLinks = yield* WorkItemLinks.WorkItemLinks;
  const crypto = yield* Crypto.Crypto;

  const requireThread = Effect.fn("IssuesToolkit.requireThread")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError((cause) => new IssueThreadLinkFailedError({ cause })));
    if (Option.isNone(thread)) {
      return yield* new IssueThreadNotFoundError({ threadId: scope.threadId });
    }
    return thread.value;
  });

  const commandId = (threadId: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:mcp-issue:${threadId}:${uuid}`)),
    );

  const dispatchFailure = <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new IssueThreadLinkFailedError({ cause }));

  return IssuesToolkit.of({
    link_issue: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread();
        const detail = yield* issues.detail({
          projectId: thread.projectId,
          repository: input.repository,
          number: input.number,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
        });
        const issue: ThreadIssueLink = {
          provider: detail.provider,
          repository: detail.repository,
          number: detail.number,
          url: detail.url,
          title: detail.title,
        };
        const alreadyLinked = yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* commandId(thread.id),
            threadId: thread.id,
            issueLink: issue,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTags({
              OrchestrationCommandInvariantError: (error) =>
                error.detail.includes("already linked") ? Effect.succeed(true) : Effect.fail(error),
            }),
            Effect.catchCause(dispatchFailure),
          );
        return { issue, alreadyLinked };
      }),
    unlink_issue: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread();
        const matches = (thread.issues ?? []).filter(
          (issue) =>
            issue.repository.toLowerCase() === input.repository.toLowerCase() &&
            issue.number === input.number &&
            (input.provider === undefined || issue.provider === input.provider),
        );
        if (matches.length > 1) {
          return yield* new IssueOperationError({
            operation: "unlink",
            detail: "More than one provider matches this issue. Pass provider.",
          });
        }
        const issue = matches[0];
        if (!issue) return { wasLinked: false };
        const wasLinked = yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* commandId(thread.id),
            threadId: thread.id,
            issueUnlink: {
              provider: issue.provider,
              repository: issue.repository,
              number: issue.number,
            },
          })
          .pipe(
            Effect.as(true),
            Effect.catchTags({
              OrchestrationCommandInvariantError: (error) =>
                error.detail.includes("not linked") ? Effect.succeed(false) : Effect.fail(error),
            }),
            Effect.catchCause(dispatchFailure),
          );
        return { wasLinked };
      }),
    list_thread_issues: () =>
      requireThread().pipe(Effect.map((thread) => ({ issues: thread.issues ?? [] }))),
    link_issue_to_pull_request: (input) =>
      requireThread().pipe(
        Effect.flatMap((thread) =>
          workItemLinks.link({
            issue: issueRef(thread.projectId, input.issue),
            pullRequest: { projectId: thread.projectId, ...input.pullRequest },
          }),
        ),
      ),
    unlink_issue_from_pull_request: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread();
        const [issue, pullRequest] = yield* Effect.all([
          issues.detail(issueRef(thread.projectId, input.issue)),
          pullRequests.detail({ projectId: thread.projectId, ...input.pullRequest }),
        ]);
        yield* workItemLinks.unlink({
          issue: normalizeWorkItemLinkKey({ provider: issue.provider, url: issue.url }),
          pullRequest: normalizeWorkItemLinkKey({
            provider: pullRequest.provider,
            url: pullRequest.url,
          }),
        });
      }),
    list_issue_pull_request_links: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread();
        const { kind, ...reference } = input.source;
        const detail =
          kind === "issue"
            ? yield* issues.detail(issueRef(thread.projectId, reference))
            : yield* pullRequests.detail({ projectId: thread.projectId, ...reference });
        return yield* workItemLinks.list({
          source: normalizeWorkItemLinkKey({ provider: detail.provider, url: detail.url }),
        });
      }),
  });
});

export const IssuesToolkitHandlersLive = IssuesToolkit.toLayer(make);
