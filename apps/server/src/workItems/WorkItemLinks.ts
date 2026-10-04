import {
  WorkItemLinkError,
  WorkItemLinksInput,
  normalizeWorkItemLinkKey,
  type WorkItemLink,
  type WorkItemLinkInput,
  type WorkItemLinksResult,
  type WorkItemUnlinkInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as IssueService from "../issue/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";

const MAX_LINKS = 100;

const LinkRow = Schema.Struct({
  issueProvider: Schema.String,
  issueUrl: Schema.String,
  issueRepository: Schema.String,
  issueNumber: Schema.Finite,
  issueTitle: Schema.String,
  pullRequestProvider: Schema.String,
  pullRequestUrl: Schema.String,
  pullRequestRepository: Schema.String,
  pullRequestNumber: Schema.Finite,
  pullRequestTitle: Schema.String,
});

const fromRow = (row: typeof LinkRow.Type): WorkItemLink => ({
  issue: {
    provider: row.issueProvider,
    url: row.issueUrl,
    repository: row.issueRepository,
    number: row.issueNumber,
    title: row.issueTitle,
  },
  pullRequest: {
    provider: row.pullRequestProvider,
    url: row.pullRequestUrl,
    repository: row.pullRequestRepository,
    number: row.pullRequestNumber,
    title: row.pullRequestTitle,
  },
});

const failure = (operation: WorkItemLinkError["operation"], detail: string) => (cause: unknown) =>
  new WorkItemLinkError({ operation, detail, cause });

export class WorkItemLinks extends Context.Service<
  WorkItemLinks,
  {
    readonly list: (
      input: WorkItemLinksInput,
    ) => Effect.Effect<WorkItemLinksResult, WorkItemLinkError>;
    readonly link: (
      input: WorkItemLinkInput,
    ) => Effect.Effect<
      WorkItemLink,
      WorkItemLinkError,
      IssueService.IssueService | PullRequestService.PullRequestService
    >;
    readonly unlink: (input: WorkItemUnlinkInput) => Effect.Effect<void, WorkItemLinkError>;
  }
>()("t3/workItems/WorkItemLinks") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: WorkItemLinksInput,
    Result: LinkRow,
    execute: ({ source }) => {
      const key = normalizeWorkItemLinkKey(source);
      return sql`
      SELECT
        issue_provider AS "issueProvider",
        issue_url AS "issueUrl",
        issue_repository AS "issueRepository",
        issue_number AS "issueNumber",
        issue_title AS "issueTitle",
        pull_request_provider AS "pullRequestProvider",
        pull_request_url AS "pullRequestUrl",
        pull_request_repository AS "pullRequestRepository",
        pull_request_number AS "pullRequestNumber",
        pull_request_title AS "pullRequestTitle"
      FROM work_item_links
      WHERE (issue_provider = ${key.provider} AND issue_url = ${key.url})
        OR (pull_request_provider = ${key.provider} AND pull_request_url = ${key.url})
      ORDER BY issue_provider, issue_url, pull_request_provider, pull_request_url
      LIMIT ${MAX_LINKS + 1}
    `;
    },
  });

  return WorkItemLinks.of({
    list: (input) =>
      listRows(input).pipe(
        Effect.map((rows) => ({
          links: rows.slice(0, MAX_LINKS).map(fromRow),
          truncated: rows.length > MAX_LINKS,
        })),
        Effect.mapError(failure("list", "Could not read saved links.")),
      ),
    link: (input) =>
      Effect.gen(function* () {
        const issues = yield* IssueService.IssueService;
        const pullRequests = yield* PullRequestService.PullRequestService;
        const [issue, pullRequest] = yield* Effect.all([
          issues.detail(input.issue),
          pullRequests.withRoutingCredential(
            input.pullRequest,
            pullRequests.detail(input.pullRequest),
          ),
        ]).pipe(Effect.mapError(failure("link", "Could not read both work items.")));
        const link: WorkItemLink = {
          issue: {
            ...normalizeWorkItemLinkKey({ provider: issue.provider, url: issue.url }),
            repository: issue.repository,
            number: issue.number,
            title: issue.title,
          },
          pullRequest: {
            ...normalizeWorkItemLinkKey({ provider: pullRequest.provider, url: pullRequest.url }),
            repository: pullRequest.repository,
            number: pullRequest.number,
            title: pullRequest.title,
          },
        };
        yield* sql`
          INSERT INTO work_item_links (
            issue_provider, issue_url, issue_repository, issue_number, issue_title,
            pull_request_provider, pull_request_url, pull_request_repository,
            pull_request_number, pull_request_title
          ) VALUES (
            ${link.issue.provider}, ${link.issue.url}, ${link.issue.repository},
            ${link.issue.number}, ${link.issue.title}, ${link.pullRequest.provider},
            ${link.pullRequest.url}, ${link.pullRequest.repository},
            ${link.pullRequest.number}, ${link.pullRequest.title}
          )
          ON CONFLICT (issue_provider, issue_url, pull_request_provider, pull_request_url)
          DO UPDATE SET
            issue_repository = excluded.issue_repository,
            issue_number = excluded.issue_number,
            issue_title = excluded.issue_title,
            pull_request_repository = excluded.pull_request_repository,
            pull_request_number = excluded.pull_request_number,
            pull_request_title = excluded.pull_request_title
        `.pipe(Effect.mapError(failure("link", "Could not save the link.")));
        return link;
      }),
    unlink: (input) => {
      const issue = normalizeWorkItemLinkKey(input.issue);
      const pullRequest = normalizeWorkItemLinkKey(input.pullRequest);
      return sql`
        DELETE FROM work_item_links
        WHERE issue_provider = ${issue.provider}
          AND issue_url = ${issue.url}
          AND pull_request_provider = ${pullRequest.provider}
          AND pull_request_url = ${pullRequest.url}
      `.pipe(Effect.asVoid, Effect.mapError(failure("unlink", "Could not remove the link.")));
    },
  });
});

export const layer = Layer.effect(WorkItemLinks, make);
