import type { LinearIssueFilter } from "@t3tools/contracts";
import { type IssueTrackerError, NotFound, Unavailable } from "@t3tools/issue-tracker-core/errors";
import type { IssueTracker, IssueListPage } from "@t3tools/issue-tracker-core/IssueTracker";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import {
  mapIssue,
  mapIssueDetail,
  mapMilestones,
  mapProject,
  mapTeamMetadata,
  mapTeams,
} from "./mapping.ts";
import {
  ASSIGNED_ISSUES_QUERY,
  buildIssueFilter,
  CREATE_COMMENT_MUTATION,
  ISSUE_DETAIL_QUERY,
  ISSUE_QUERY,
  ISSUES_QUERY,
  LIST_ISSUE_CAP,
  MILESTONES_QUERY,
  MOVE_ISSUE_MUTATION,
  PROJECTS_QUERY,
  SEARCH_QUERY,
  SUB_ISSUES_QUERY,
  TEAM_METADATA_QUERY,
  TEAM_PROJECTS_QUERY,
  TEAMS_QUERY,
  UPDATE_COMMENT_MUTATION,
  VIEW_ISSUES_QUERY,
  VIEWER_QUERY,
  VIEWS_QUERY,
} from "./queries.ts";
import {
  AssignedIssuesResponse,
  CommentCreateResponse,
  CommentUpdateResponse,
  IssueDetailResponse,
  IssueResponse,
  IssuesResponse,
  IssueUpdateResponse,
  MilestonesResponse,
  ProjectsResponse,
  SearchResponse,
  SubIssuesResponse,
  TeamMetadataResponse,
  TeamProjectsResponse,
  TeamsResponse,
  ViewerResponse,
  ViewIssuesResponse,
  ViewsResponse,
} from "./responseSchemas.ts";
import { type LinearTransportOptions, makeLinearRequest } from "./transport.ts";

interface Page<Node> {
  readonly nodes: ReadonlyArray<Node>;
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
}

/**
 * Walks cursor pages until the connection ends or `cap` nodes were collected. `truncated` means
 * Linear still had more when the cap stopped us.
 */
const paginate = Effect.fn("LinearClient.paginate")(function* <Node, E>(
  fetchPage: (after: string | null) => Effect.Effect<Page<Node>, E>,
  cap: number,
) {
  const collected: Node[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Page<Node> = yield* fetchPage(after);
    collected.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) {
      return { nodes: collected.slice(0, cap), truncated: collected.length > cap };
    }
    if (collected.length >= cap) return { nodes: collected.slice(0, cap), truncated: true };
    after = page.pageInfo.endCursor;
  }
});

/** Stable order so equal filters yield equal cache keys regardless of how clients built them. */
export function normalizeIssueFilter(filter: LinearIssueFilter): LinearIssueFilter {
  const sorted = <A extends string | number>(values: ReadonlyArray<A> | undefined) =>
    values === undefined ? undefined : [...new Set(values)].toSorted();
  return {
    ...filter,
    ...(filter.stateIds === undefined ? {} : { stateIds: sorted(filter.stateIds)! }),
    ...(filter.stateTypes === undefined ? {} : { stateTypes: sorted(filter.stateTypes)! }),
    ...(filter.priorities === undefined ? {} : { priorities: sorted(filter.priorities)! }),
    ...(filter.labelIds === undefined ? {} : { labelIds: sorted(filter.labelIds)! }),
    ...(filter.issueIds === undefined ? {} : { issueIds: sorted(filter.issueIds)! }),
  };
}

export const makeLinearTracker = Effect.fn("LinearClient.make")(function* (
  options: LinearTransportOptions,
) {
  const request = yield* makeLinearRequest(options);

  const pagedIssues = <Response>(
    query: string,
    variables: Record<string, unknown>,
    schema: Schema.Decoder<Response>,
    select: (response: Response) => Page<Parameters<typeof mapIssue>[0]> | null,
    cap: number,
  ): Effect.Effect<IssueListPage, IssueTrackerError> =>
    paginate(
      (after) =>
        request(query, { ...variables, after }, schema).pipe(
          Effect.flatMap((response) => {
            const page = select(response);
            return page === null
              ? Effect.fail(new NotFound({ message: "Linear could not find that item." }))
              : Effect.succeed(page);
          }),
        ),
      cap,
    ).pipe(Effect.map(({ nodes, truncated }) => ({ issues: nodes.map(mapIssue), truncated })));

  const issue = (issueId: string) =>
    request(ISSUE_QUERY, { issueId }, IssueResponse).pipe(
      Effect.flatMap(({ issue }) =>
        issue === null
          ? Effect.fail(new NotFound({ message: "Linear could not find that issue." }))
          : Effect.succeed(mapIssue(issue)),
      ),
    );

  const subIssues = (issueId: string) =>
    pagedIssues(
      SUB_ISSUES_QUERY,
      { issueId },
      SubIssuesResponse,
      (response) => response.issue?.children ?? null,
      LIST_ISSUE_CAP,
    ).pipe(Effect.map((page) => page.issues));

  const mutationFailed = new Unavailable({ message: "Linear did not apply the change." });

  return {
    verify: request(VIEWER_QUERY, {}, ViewerResponse),
    teams: Effect.gen(function* () {
      const [teams, assigned] = yield* Effect.all(
        [
          paginate(
            (after) =>
              request(TEAMS_QUERY, { after }, TeamsResponse).pipe(
                Effect.map((response) => response.teams),
              ),
            LIST_ISSUE_CAP,
          ),
          // Counts are best effort: a failure here must not hide the teams themselves.
          request(ASSIGNED_ISSUES_QUERY, {}, AssignedIssuesResponse).pipe(
            Effect.map((response) => response.viewer.assignedIssues.nodes.map((n) => n.team.id)),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          ),
        ],
        { concurrency: 2 },
      );
      return mapTeams(teams.nodes, assigned);
    }),
    teamMetadata: Effect.fn("LinearClient.teamMetadata")(function* (teamId) {
      const { team } = yield* request(TEAM_METADATA_QUERY, { teamId }, TeamMetadataResponse);
      if (team === null) {
        return yield* new NotFound({ message: "Linear could not find that team." });
      }
      return mapTeamMetadata(team, yield* Clock.currentTimeMillis);
    }),
    projects: (teamId) =>
      (teamId === undefined
        ? paginate(
            (after) =>
              request(PROJECTS_QUERY, { after }, ProjectsResponse).pipe(
                Effect.map((response) => response.projects),
              ),
            LIST_ISSUE_CAP,
          )
        : paginate(
            (after) =>
              request(TEAM_PROJECTS_QUERY, { teamId, after }, TeamProjectsResponse).pipe(
                Effect.flatMap(({ team }) =>
                  team === null
                    ? Effect.fail(new NotFound({ message: "Linear could not find that team." }))
                    : Effect.succeed(team.projects),
                ),
              ),
            LIST_ISSUE_CAP,
          )
      ).pipe(Effect.map(({ nodes }) => nodes.map(mapProject))),
    milestones: (projectId) =>
      request(MILESTONES_QUERY, { projectId }, MilestonesResponse).pipe(
        Effect.flatMap(({ project }) =>
          project === null
            ? Effect.fail(new NotFound({ message: "Linear could not find that project." }))
            : Effect.succeed(mapMilestones(project)),
        ),
      ),
    issues: (filter) =>
      filter.viewId === undefined
        ? pagedIssues(
            ISSUES_QUERY,
            { filter: buildIssueFilter(filter) },
            IssuesResponse,
            (response) => response.issues,
            LIST_ISSUE_CAP,
          )
        : pagedIssues(
            VIEW_ISSUES_QUERY,
            { viewId: filter.viewId },
            ViewIssuesResponse,
            (response) => response.customView?.issues ?? null,
            LIST_ISSUE_CAP,
          ),
    issue,
    issueDetail: Effect.fn("LinearClient.issueDetail")(function* (issueId) {
      const [detail, children] = yield* Effect.all(
        [request(ISSUE_DETAIL_QUERY, { issueId }, IssueDetailResponse), subIssues(issueId)],
        { concurrency: 2 },
      );
      if (detail.issue === null) {
        return yield* new NotFound({ message: "Linear could not find that issue." });
      }
      return mapIssueDetail(detail.issue, children);
    }),
    subIssues,
    views: paginate(
      (after) =>
        request(VIEWS_QUERY, { after }, ViewsResponse).pipe(
          Effect.map((response) => response.customViews),
        ),
      LIST_ISSUE_CAP,
    ).pipe(
      Effect.map(({ nodes }) =>
        nodes.map((view) => ({
          id: view.id,
          name: view.name,
          description: view.description,
          filterDescription: null,
        })),
      ),
    ),
    search: (term) =>
      request(SEARCH_QUERY, { term }, SearchResponse).pipe(
        Effect.map((response) => response.searchIssues.nodes.map(mapIssue)),
      ),
    moveIssueToState: (issueId, stateId) =>
      request(MOVE_ISSUE_MUTATION, { issueId, stateId }, IssueUpdateResponse).pipe(
        Effect.flatMap((response) =>
          response.issueUpdate.success ? Effect.void : Effect.fail(mutationFailed),
        ),
      ),
    createComment: (issueId, body) =>
      request(CREATE_COMMENT_MUTATION, { issueId, body }, CommentCreateResponse).pipe(
        Effect.flatMap(({ commentCreate }) =>
          commentCreate.success && commentCreate.comment !== null
            ? Effect.succeed({ id: commentCreate.comment.id })
            : Effect.fail(mutationFailed),
        ),
      ),
    updateComment: (commentId, body) =>
      request(UPDATE_COMMENT_MUTATION, { commentId, body }, CommentUpdateResponse).pipe(
        Effect.flatMap((response) =>
          response.commentUpdate.success ? Effect.void : Effect.fail(mutationFailed),
        ),
      ),
  } satisfies IssueTracker;
});
