import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { IssueTrackerKind, type IssuePageInput } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/issue-tracker-core/server/IssueTracker";

import { GraphQL, GraphQLClient, GraphQLClientError, GraphQLGroup } from "effect/graphql";
import * as Native from "../../schema/linear.graphql.ts";
import * as Generated from "./linearIssueTracker.graphql.ts";
import * as LinearGraphQlClient from "./linearGraphQlClient.ts";

export const KIND = IssueTrackerKind.make("linear");

export const LinearUser = Schema.Struct({
  ...Generated.ViewerUser.fields,
  name: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});
export type LinearUser = typeof LinearUser.Type;
const LinearAssignableUser = Schema.Struct({ ...LinearUser.fields, active: Schema.Boolean });
const LinearTeam = Generated.T3ProbeCredentialTeamsNodesTeam;
type LinearTeam = typeof LinearTeam.Type;
const LinearOrganization = Generated.T3ProbeCredentialOrganizationOrganization;
type LinearOrganization = typeof LinearOrganization.Type;
const LinearTeamVisibility = Schema.Literals(["public", "private", "restricted"]);
const LinearAssignmentTeam = Schema.Struct({
  ...Generated.LinearAssignmentTeam.fields,
  ancestors: Schema.Array(
    Schema.Struct({
      id: Generated.LinearAssignmentTeam.fields.id,
      private: Generated.LinearAssignmentTeam.fields.private,
      visibility: Generated.LinearAssignmentTeam.fields.visibility,
      restrictedBy: Generated.LinearAssignmentTeam.fields.restrictedBy,
    }),
  ).check(Schema.isMaxLength(5)),
});
const assigneeTeamIds = (team: typeof LinearAssignmentTeam.Type): ReadonlyArray<string> | null => {
  if (
    team.visibility !== "public" &&
    team.visibility !== "private" &&
    team.visibility !== "restricted"
  )
    return null;
  if (team.private !== (team.visibility === "private")) return null;
  if (team.visibility !== "restricted")
    return team.restrictedBy === null ? (team.visibility === "public" ? [] : [team.id]) : null;
  const boundary = team.ancestors.findIndex((ancestor) => ancestor.id === team.restrictedBy?.id);
  if (boundary < 0 || team.ancestors[boundary]?.visibility !== "private") return null;
  const ancestors = team.ancestors.slice(boundary);
  if (
    ancestors.some((ancestor, index) =>
      index === 0
        ? !ancestor.private || ancestor.restrictedBy !== null
        : ancestor.visibility !== "restricted" ||
          ancestor.private ||
          ancestor.restrictedBy?.id !== team.restrictedBy?.id,
    )
  )
    return null;
  const ids = [...ancestors.map((ancestor) => ancestor.id), team.id];
  return new Set(ids).size === ids.length ? ids : null;
};

export type LinearWorkflowState = Generated.WorkflowState;
type LinearLabel = Generated.AncestorsLabelsNodesIssueLabel;
export type LinearReaction = Generated.Reaction;
export type LinearComment = Generated.NodesComment;
const BidirectionalPageInfo = Schema.Struct({
  ...Generated.TeamsPageInfoPageInfo.fields,
  hasPreviousPage: Schema.optional(Schema.Boolean),
  startCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const LinearIssue = Schema.Struct({
  ...Generated.LinearIssueRow.fields,
  labels: Generated.IssueLabelsIssueLabelConnection,
  projectMilestone: Schema.optional(Generated.LinearIssueRow.fields.projectMilestone),
  reactions: Schema.optional(Schema.Array(Generated.Reaction)),
});
export type LinearIssue = typeof LinearIssue.Type;
export type LinearAttachment = Generated.Attachment;
export type LinearHistoryEntry = Generated.IssueHistory;
type LinearIssueDetail = Generated.T3Issue.Result["issue"];
export type LinearIssueReference = Generated.T3IssueReference.Result["issue"];
export type LinearRelation = Generated.ParentIssue;
const LinearTemplateData = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.Unknown),
  descriptionData: Schema.optional(Schema.Unknown),
  labelIds: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  assigneeId: Schema.optional(Schema.NullOr(Schema.String)),
});
const LinearTemplate = Schema.Struct({
  ...Generated.Template.fields,
  templateData: Schema.Union([Schema.fromJsonString(LinearTemplateData), LinearTemplateData]),
});
export type LinearTemplate = typeof LinearTemplate.Type;
const LinearTemplates = Schema.Struct({
  ...Generated.TemplateConnection.fields,
  nodes: Schema.Array(LinearTemplate).check(Schema.isMaxLength(100)),
});
const AssignmentMembers = Schema.Struct({
  ...Generated.UserConnection.fields,
  nodes: Schema.Array(LinearAssignableUser),
});
const LinearTeamDetail = Schema.Struct({
  ...Generated.T3TeamTeamsNodesTeam.fields,
  members: AssignmentMembers,
  templates: LinearTemplates,
  ancestors: Schema.Array(
    Schema.Struct({
      ...Generated.AncestorsTeam.fields,
      templates: LinearTemplates,
      labels: Schema.optionalKey(
        Schema.Struct({
          ...Generated.AncestorsLabelsIssueLabelConnection.fields,
          nodes: Schema.Array(Generated.AncestorsLabelsNodesIssueLabel).check(
            Schema.isMaxLength(250),
          ),
        }),
      ),
    }),
  ).check(Schema.isMaxLength(5)),
});
type LinearTeamDetail = typeof LinearTeamDetail.Type;
const ViewerData = Schema.Struct({ ...Generated.T3Viewer.result.fields, viewer: LinearUser });
const ProbeData = Schema.Struct({
  ...Generated.T3ProbeCredential.result.fields,
  viewer: LinearUser,
});
const TeamData = Schema.Struct({
  ...Generated.T3Team.result.fields,
  organization: Schema.Struct({
    ...Generated.T3TeamOrganizationOrganization.fields,
    templates: LinearTemplates,
  }),
  teams: Schema.Struct({
    ...Generated.T3TeamTeamsTeamConnection.fields,
    nodes: Schema.Array(LinearTeamDetail),
  }),
});
const ListData = Schema.Struct({
  organization: LinearOrganization,
  viewer: Schema.optional(Schema.Struct({ id: Schema.String })),
  issues: Schema.Struct({
    nodes: Schema.Array(LinearIssue),
    pageInfo: BidirectionalPageInfo,
  }),
});
const LabelCandidatesData = Schema.Struct({
  organization: LinearOrganization,
  teams: Schema.Struct({ nodes: Schema.Array(LinearTeam) }),
  issueLabels: Generated.AncestorsLabelsIssueLabelConnection,
});
const AssigneeCandidatesData = Schema.Struct({
  organization: LinearOrganization,
  teams: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ ...LinearAssignmentTeam.fields, members: AssignmentMembers }),
    ),
  }),
});
const AssigneeCandidatesResponse = Schema.Struct({
  organization: LinearOrganization,
  teams: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        ...LinearAssignmentTeam.fields,
        members: Schema.optional(AssignmentMembers),
      }),
    ),
  }),
  users: Schema.optional(
    Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          ...LinearAssignableUser.fields,
          teams: Schema.optional(
            Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ id: Schema.String })).check(
                Schema.isMaxLength(1),
              ),
            }),
          ),
        }),
      ),
      pageInfo: Generated.TeamsPageInfoPageInfo,
    }),
  ),
});

interface NativePageInput {
  readonly identifier: string;
  readonly first: number;
  readonly after?: string | undefined;
}

/** The team with the workspace-wide labels that any of its issues may also carry. */
export interface LinearTeamScope {
  readonly organization: LinearOrganization;
  readonly team: LinearTeamDetail;
  readonly assigneeTeamIds: ReadonlyArray<string>;
  readonly workspaceLabels: ReadonlyArray<LinearLabel>;
  readonly templates: ReadonlyArray<LinearTemplate>;
  readonly templatesTruncated: boolean;
  readonly labelsTruncated: boolean;
  /** Linear had more than one page of something; a missing label or member may still exist. */
  readonly truncated: boolean;
}

export class LinearApi extends Context.Service<
  LinearApi,
  {
    readonly viewer: (
      token?: string,
    ) => Effect.Effect<{ readonly viewer: LinearUser }, IssueTrackerError>;
    readonly probeCredential: (token: string) => Effect.Effect<
      {
        readonly viewer: LinearUser;
        readonly organization: LinearOrganization;
        readonly teams: ReadonlyArray<LinearTeam>;
        readonly scopesTruncated: boolean;
        readonly scopesCursor: string | null;
      },
      IssueTrackerError
    >;
    readonly listScopes: (
      token: string,
      input: IssuePageInput,
    ) => Effect.Effect<
      {
        readonly organization: LinearOrganization;
        readonly teams: ReadonlyArray<LinearTeam>;
        readonly nextCursor: string | null;
      },
      IssueTrackerError
    >;
    readonly getScope: (
      key: string,
      token: string,
    ) => Effect.Effect<
      (LinearTeam & { readonly organization: LinearOrganization }) | null,
      IssueTrackerError
    >;
    readonly listIssues: (input: {
      readonly filter: Record<string, unknown>;
      readonly first: number;
      readonly after?: string | undefined;
      readonly sort?: "created" | "updated";
      readonly order?: "asc" | "desc";
    }) => Effect.Effect<
      {
        readonly organization: LinearOrganization;
        readonly viewerId: string | null;
        readonly nodes: ReadonlyArray<LinearIssue>;
        readonly nextCursor: string | null;
      },
      IssueTrackerError
    >;
    /** Null when Linear has no issue by that identifier, or the credential cannot see it. */
    readonly getIssue: (
      identifier: string,
      comments: number,
    ) => Effect.Effect<LinearIssueDetail | null, IssueTrackerError>;
    readonly getIssueReference: (
      identifier: string,
    ) => Effect.Effect<LinearIssueReference | null, IssueTrackerError>;
    readonly getCommentTarget: (
      identifier: string,
      commentId: string,
    ) => Effect.Effect<Generated.T3CommentTarget.Result, IssueTrackerError>;
    readonly getTeamStates: (key: string) => Effect.Effect<
      | (Generated.T3TeamStates.Result["teams"]["nodes"][number] & {
          readonly organization: LinearOrganization;
        })
      | null,
      IssueTrackerError
    >;
    readonly getComments: (input: {
      readonly identifier: string;
      readonly first: number;
      readonly after?: string | undefined;
      readonly order?: "asc" | "desc";
    }) => Effect.Effect<
      {
        readonly issue: LinearIssueReference;
        readonly nodes: ReadonlyArray<LinearComment>;
        readonly nextCursor: string | null;
      },
      IssueTrackerError
    >;

    readonly getHierarchy: (
      input: NativePageInput,
    ) => Effect.Effect<Generated.T3Hierarchy.Result, IssueTrackerError>;
    readonly getHistory: (
      input: NativePageInput & { readonly order?: "asc" | "desc" },
    ) => Effect.Effect<Generated.T3History.Result, IssueTrackerError>;
    readonly getAttachments: (
      input: NativePageInput,
    ) => Effect.Effect<Generated.T3Attachments.Result, IssueTrackerError>;
    readonly listLabelCandidates: (input: {
      readonly ids?: ReadonlyArray<string>;
      readonly teamIds: ReadonlyArray<string>;
      readonly key: string;
      readonly first: number;
      readonly after?: string | undefined;
    }) => Effect.Effect<typeof LabelCandidatesData.Type, IssueTrackerError>;
    readonly listAssigneeCandidates: (input: {
      readonly visibility?: typeof LinearTeamVisibility.Type;
      readonly membershipTeamIds?: ReadonlyArray<string>;
      readonly workspace?: string | undefined;
      readonly id?: string;
      readonly key: string;
      readonly first: number;
      readonly after?: string | undefined;
    }) => Effect.Effect<typeof AssigneeCandidatesData.Type, IssueTrackerError>;
    readonly updateComment: (id: string, body: string) => Effect.Effect<void, IssueTrackerError>;
    readonly getTeam: (
      key: string,
      includeAncestorLabels?: boolean,
    ) => Effect.Effect<LinearTeamScope | null, IssueTrackerError>;
    readonly createIssue: (
      input: Native.IssueCreateInput,
    ) => Effect.Effect<{ readonly identifier: string; readonly url: string }, IssueTrackerError>;
    readonly updateIssue: (
      identifier: string,
      input: Native.IssueUpdateInput,
    ) => Effect.Effect<void, IssueTrackerError>;
    readonly createComment: (input: {
      readonly issueId: string;
      readonly body: string;
    }) => Effect.Effect<void, IssueTrackerError>;
    readonly createReaction: (input: {
      readonly issueId?: string | undefined;
      readonly commentId?: string | undefined;
      readonly emoji: string;
    }) => Effect.Effect<void, IssueTrackerError>;
    readonly deleteReaction: (id: string) => Effect.Effect<void, IssueTrackerError>;
    /** Reactions on an issue (by identifier) or a comment (by id), to find the viewer's own. */
    readonly listReactions: (input: {
      readonly issueId?: string | undefined;
      readonly commentId?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<LinearReaction>, IssueTrackerError>;
  }
>()("@t3tools/issue-tracker-linear/server/LinearApi") {}

const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  extra: { readonly retryAt?: number; readonly cause?: unknown } = {},
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(extra.retryAt === undefined ? {} : { retryAt: extra.retryAt }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });

export const T3Issues = GraphQL.query("T3Issues", {
  document:
    "query T3Issues($first: Int, $last: Int, $after: String, $before: String, $orderBy: PaginationOrderBy!, $filter: IssueFilter!) {\n  organization { id urlKey }\n  viewer { id }\n  issues(first: $first, last: $last, after: $after, before: $before, filter: $filter, orderBy: $orderBy) {\n    nodes { \n  id identifier number title url description createdAt updatedAt completedAt canceledAt\n  team { key }\n  state { id name type position }\n  projectMilestone { name }\n  creator { id name displayName email avatarUrl }\n  assignee { id name displayName email avatarUrl }\n labels(first: 20, includeArchived: true) { nodes { id name color } pageInfo { hasNextPage endCursor hasPreviousPage startCursor } } reactions { id emoji user { id name displayName email avatarUrl } } }\n    pageInfo { hasNextPage endCursor hasPreviousPage startCursor }\n  }\n}",
  variables: {
    first: Schema.NullOr(Schema.Int),
    last: Schema.NullOr(Schema.Int),
    after: Schema.NullOr(Schema.String),
    before: Schema.NullOr(Schema.String),
    orderBy: Schema.Literals(["createdAt", "updatedAt"]),
    filter: Schema.Record(Schema.String, Schema.Unknown),
  },
  result: ListData,
});

export const T3LabelCandidates = GraphQL.query("T3LabelCandidates", {
  document:
    "query T3LabelCandidates($key: String!, $first: Int!, $after: String, $filter: IssueLabelFilter!) { organization { id urlKey } teams(first: 1, filter: { key: { eq: $key } }) { nodes { id key name } } issueLabels(first: $first, after: $after, includeArchived: true, filter: $filter) { nodes { id name color description archivedAt isGroup } pageInfo { hasNextPage endCursor } } }",
  variables: {
    key: Schema.String,
    first: Schema.Int,
    after: Schema.NullOr(Schema.String),
    filter: Schema.Record(Schema.String, Schema.Unknown),
  },
  result: LabelCandidatesData,
});

export const T3AssigneeCandidates = GraphQL.query("T3AssigneeCandidates", {
  document:
    "query T3AssigneeCandidates($key: String!, $first: Int!, $after: String, $filter: UserFilter!, $publicTeam: Boolean!, $readMembers: Boolean!, $restricted: Boolean!, $membershipTeamIds: [ID!]!) { organization { id urlKey } teams(first: 1, filter: { key: { eq: $key } }) { nodes { id key name private visibility restrictedBy { id } ancestors { id private visibility restrictedBy { id } } members(first: $first, after: $after, filter: $filter) @include(if: $readMembers) { nodes { id name displayName email avatarUrl active } pageInfo { hasNextPage endCursor } } } } users(first: $first, after: $after, filter: $filter) @include(if: $publicTeam) { nodes { id name displayName email avatarUrl active teams(first: 1, filter: { id: { in: $membershipTeamIds } }) @include(if: $restricted) { nodes { id } } } pageInfo { hasNextPage endCursor } } }",
  variables: {
    key: Schema.String,
    first: Schema.Int,
    after: Schema.NullOr(Schema.String),
    filter: Schema.Record(Schema.String, Schema.Unknown),
    publicTeam: Schema.Boolean,
    readMembers: Schema.Boolean,
    restricted: Schema.Boolean,
    membershipTeamIds: Schema.Array(Schema.String),
  },
  result: AssigneeCandidatesResponse,
});

const LinearGraphQLGroup = GraphQLGroup.make(
  GraphQL.query(Generated.T3Viewer.name, {
    document: Generated.T3Viewer.document,
    variables: Generated.T3Viewer.variables,
    result: ViewerData,
  }),
  GraphQL.query(Generated.T3ProbeCredential.name, {
    document: Generated.T3ProbeCredential.document,
    variables: Generated.T3ProbeCredential.variables,
    result: ProbeData,
  }),
  Generated.T3Scopes,
  Generated.T3Issue,
  Generated.T3IssueReference,
  Generated.T3CommentTarget,
  Generated.T3TeamStates,
  Generated.T3Scope,
  Generated.T3Comments,
  GraphQL.query(Generated.T3Team.name, {
    document: Generated.T3Team.document,
    variables: Generated.T3Team.variables,
    result: TeamData,
  }),
  Generated.T3IssueCreate,
  Generated.T3IssueUpdate,
  Generated.T3CommentCreate,
  Generated.T3ReactionCreate,
  Generated.T3ReactionDelete,
  Generated.T3IssueReactions,
  Generated.T3CommentReactions,
  Generated.T3Hierarchy,
  Generated.T3History,
  Generated.T3Attachments,
  Generated.T3CommentUpdate,
  T3Issues,
  T3LabelCandidates,
  T3AssigneeCandidates,
);

export const make = Effect.gen(function* () {
  const policy = yield* LinearGraphQlClient.make;
  const client = yield* GraphQLClient.make(
    LinearGraphQLGroup.middleware(LinearGraphQlClient.LinearGraphQlAuth),
  ).pipe(Effect.provide(policy.layer));
  const execute = <A, V>(
    operation: string,
    method: ((
      variables: V,
    ) => Effect.Effect<
      A,
      GraphQLClientError.GraphQLClientError,
      LinearGraphQlClient.LinearGraphQlTarget
    >) & { readonly operation: GraphQL.Any },
    variables: V,
    token?: string,
  ) => policy.call(operation, method.operation.document, method(variables), token);

  const mutate = <V>(
    operation: string,
    method: ((
      variables: V,
    ) => Effect.Effect<
      Readonly<Record<string, { readonly success: boolean }>>,
      GraphQLClientError.GraphQLClientError,
      LinearGraphQlClient.LinearGraphQlTarget
    >) & { readonly operation: GraphQL.Any },
    variables: V,
  ): Effect.Effect<void, IssueTrackerError> =>
    execute(operation, method, variables).pipe(
      Effect.mapError((error) =>
        error.reason === "failed" && error.detail === "Linear returned an unexpected response."
          ? fail(operation, "failed", "Linear did not apply the change.")
          : error,
      ),
      Effect.flatMap((data) =>
        Object.values(data).some((value) => value.success === true)
          ? Effect.void
          : Effect.fail(fail(operation, "failed", "Linear did not apply the change.")),
      ),
    );

  const viewer: LinearApi["Service"]["viewer"] = (token) =>
    execute("viewer", client.T3Viewer, {}, token);
  const probeCredential: LinearApi["Service"]["probeCredential"] = (token) =>
    execute("probeCredential", client.T3ProbeCredential, {}, token).pipe(
      Effect.flatMap((data) => {
        const cursor = data.teams.pageInfo.hasNextPage ? data.teams.pageInfo.endCursor : null;
        if (
          data.teams.nodes.length > 250 ||
          (data.teams.pageInfo.hasNextPage &&
            (cursor === null ||
              !cursor.trim() ||
              cursor.length > 4096 ||
              data.teams.nodes.length === 0))
        )
          return Effect.fail(
            fail("probeCredential", "failed", "Linear returned an inconsistent team page."),
          );
        return Effect.succeed({
          viewer: data.viewer,
          organization: data.organization,
          teams: data.teams.nodes,
          scopesTruncated: data.teams.pageInfo.hasNextPage,
          scopesCursor: cursor,
        });
      }),
    );
  const listScopes: LinearApi["Service"]["listScopes"] = (token, input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 100;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (input.cursor !== undefined && (!input.cursor.trim() || input.cursor.length > 4096))
      )
        return yield* fail("listScopes", "failed", "Invalid Linear scope page.");
      const data = yield* execute(
        "listScopes",
        client.T3Scopes,
        { first: limit, after: input.cursor ?? null },
        token,
      );
      const cursor = data.teams.pageInfo.hasNextPage ? data.teams.pageInfo.endCursor : null;
      if (
        data.teams.nodes.length > limit ||
        (data.teams.pageInfo.hasNextPage &&
          (cursor === null ||
            !cursor.trim() ||
            cursor.length > 4096 ||
            cursor === input.cursor ||
            data.teams.nodes.length === 0))
      )
        return yield* fail("listScopes", "failed", "Linear returned an inconsistent team page.");
      return { organization: data.organization, teams: data.teams.nodes, nextCursor: cursor };
    });
  const getScope: LinearApi["Service"]["getScope"] = (key, token) =>
    execute("getScope", client.T3Scope, { key }, token).pipe(
      Effect.map((data) =>
        data.teams.nodes[0] === undefined
          ? null
          : { ...data.teams.nodes[0], organization: data.organization },
      ),
    );

  const listIssues: LinearApi["Service"]["listIssues"] = (input) =>
    execute("listIssues", client.T3Issues, {
      first: input.order === "asc" ? null : Math.min(100, Math.max(1, input.first)),
      last: input.order === "asc" ? Math.min(100, Math.max(1, input.first)) : null,
      after: input.order === "asc" ? null : (input.after ?? null),
      before: input.order === "asc" ? (input.after ?? null) : null,
      orderBy: input.sort === "created" ? "createdAt" : "updatedAt",
      filter: input.filter,
    }).pipe(
      Effect.map((data) => ({
        organization: data.organization,
        viewerId: data.viewer?.id ?? null,
        nodes: input.order === "asc" ? data.issues.nodes.toReversed() : data.issues.nodes,
        nextCursor:
          input.order === "asc"
            ? data.issues.pageInfo.hasPreviousPage
              ? (data.issues.pageInfo.startCursor ?? null)
              : null
            : data.issues.pageInfo.hasNextPage
              ? data.issues.pageInfo.endCursor
              : null,
      })),
    );

  const getIssue: LinearApi["Service"]["getIssue"] = (identifier, comments) =>
    execute("getIssue", client.T3Issue, {
      id: identifier,
      comments: Math.min(100, Math.max(0, comments)),
    }).pipe(
      Effect.map((data) => data.issue),
      // Linear answers an unknown identifier with an error and no data, not with null.
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => Effect.succeed(null),
      ),
    );
  const getIssueReference: LinearApi["Service"]["getIssueReference"] = (identifier) =>
    execute("getIssueReference", client.T3IssueReference, { id: identifier }).pipe(
      Effect.map((data) => data.issue),
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => Effect.succeed(null),
      ),
    );
  const getCommentTarget: LinearApi["Service"]["getCommentTarget"] = (identifier, commentId) =>
    execute("getCommentTarget", client.T3CommentTarget, { id: identifier, commentId });
  const getTeamStates: LinearApi["Service"]["getTeamStates"] = (key) =>
    execute("getTeamStates", client.T3TeamStates, { key }).pipe(
      Effect.map((data) =>
        data.teams.nodes[0] === undefined
          ? null
          : { ...data.teams.nodes[0], organization: data.organization },
      ),
    );

  const getComments: LinearApi["Service"]["getComments"] = (input) =>
    execute("getComments", client.T3Comments, {
      id: input.identifier,
      first: input.order === "asc" ? null : Math.min(100, Math.max(1, input.first)),
      last: input.order === "asc" ? Math.min(100, Math.max(1, input.first)) : null,
      after: input.order === "asc" ? null : (input.after ?? null),
      before: input.order === "asc" ? (input.after ?? null) : null,
      backward: input.order === "asc",
    }).pipe(
      Effect.flatMap((data) => {
        const page = data.issue.comments;
        const more =
          input.order === "asc" ? page.pageInfo.hasPreviousPage : page.pageInfo.hasNextPage;
        const cursor = input.order === "asc" ? page.pageInfo.startCursor : page.pageInfo.endCursor;
        return more === undefined ||
          page.nodes.length > input.first ||
          (more && (!cursor?.trim() || cursor === input.after || page.nodes.length === 0))
          ? Effect.fail(fail("getComments", "failed", "Linear returned an inconsistent page."))
          : Effect.succeed({
              issue: data.issue,
              nodes: input.order === "asc" ? page.nodes.toReversed() : page.nodes,
              nextCursor: more ? cursor! : null,
            });
      }),
    );

  const getTeam: LinearApi["Service"]["getTeam"] = (key, includeAncestorLabels = false) =>
    execute("getTeam", client.T3Team, { key, includeAncestorLabels }).pipe(
      Effect.filterOrFail(
        (data) => data.teams.nodes.every((team) => assigneeTeamIds(team) !== null),
        () => fail("getTeam", "failed", "Linear returned an invalid team visibility boundary."),
      ),
      Effect.filterOrFail(
        (data) =>
          !includeAncestorLabels ||
          data.teams.nodes.every((team) =>
            team.ancestors.every((ancestor) => ancestor.labels !== undefined),
          ),
        () => fail("getTeam", "failed", "Linear omitted the requested ancestor labels."),
      ),
      Effect.map((data) => {
        const team = data.teams.nodes[0];
        if (team === undefined) return null;
        const templateCatalogs = [
          team.templates,
          ...team.ancestors.map((ancestor) => ancestor.templates),
          data.organization.templates,
        ];
        const templatesTruncated = templateCatalogs.some((catalog) => catalog.pageInfo.hasNextPage);
        return {
          organization: data.organization,
          team: {
            ...team,
            members: { ...team.members, nodes: team.members.nodes.filter((user) => user.active) },
          },
          assigneeTeamIds: assigneeTeamIds(team)!,
          workspaceLabels: data.issueLabels.nodes,
          templates: [
            ...new Map(
              templateCatalogs
                .flatMap((catalog) => catalog.nodes)
                .map((template) => [template.id, template]),
            ).values(),
          ],
          templatesTruncated,
          labelsTruncated:
            team.labels.pageInfo.hasNextPage ||
            data.issueLabels.pageInfo.hasNextPage ||
            team.ancestors.some((ancestor) => ancestor.labels?.pageInfo.hasNextPage),
          truncated:
            team.states.pageInfo.hasNextPage ||
            team.labels.pageInfo.hasNextPage ||
            team.members.pageInfo.hasNextPage ||
            data.issueLabels.pageInfo.hasNextPage ||
            team.ancestors.some((ancestor) => ancestor.labels?.pageInfo.hasNextPage) ||
            templatesTruncated,
        };
      }),
    );

  const createIssue: LinearApi["Service"]["createIssue"] = (input) =>
    execute("createIssue", client.T3IssueCreate, { input }).pipe(
      Effect.flatMap((data) =>
        data.issueCreate.success && data.issueCreate.issue !== null
          ? Effect.succeed(data.issueCreate.issue)
          : Effect.fail(fail("createIssue", "failed", "Linear did not create the issue.")),
      ),
    );

  const updateIssue: LinearApi["Service"]["updateIssue"] = (identifier, input) =>
    mutate("updateIssue", client.T3IssueUpdate, { id: identifier, input });

  const createComment: LinearApi["Service"]["createComment"] = (input) =>
    mutate("createComment", client.T3CommentCreate, { input });

  const createReaction: LinearApi["Service"]["createReaction"] = (input) =>
    mutate("createReaction", client.T3ReactionCreate, {
      input:
        input.commentId === undefined
          ? { issueId: input.issueId, emoji: input.emoji }
          : { commentId: input.commentId, emoji: input.emoji },
    });

  const deleteReaction: LinearApi["Service"]["deleteReaction"] = (id) =>
    mutate("deleteReaction", client.T3ReactionDelete, { id });

  const listReactions: LinearApi["Service"]["listReactions"] = (input) =>
    input.commentId === undefined
      ? execute("listReactions", client.T3IssueReactions, { id: input.issueId ?? "" }).pipe(
          Effect.map((data) => data.issue.reactions),
        )
      : execute("listReactions", client.T3CommentReactions, { id: input.commentId }).pipe(
          Effect.map((data) => data.comment.reactions),
        );

  const getHierarchy: LinearApi["Service"]["getHierarchy"] = (input) =>
    execute("getHierarchy", client.T3Hierarchy, {
      id: input.identifier,
      first: input.first,
      after: input.after ?? null,
    });
  const getHistory: LinearApi["Service"]["getHistory"] = (input) =>
    execute("getHistory", client.T3History, {
      id: input.identifier,
      first: input.order === "asc" ? null : input.first,
      last: input.order === "asc" ? input.first : null,
      after: input.order === "asc" ? null : (input.after ?? null),
      before: input.order === "asc" ? (input.after ?? null) : null,
      backward: input.order === "asc",
    });
  const getAttachments: LinearApi["Service"]["getAttachments"] = (input) =>
    execute("getLinkedPullRequests", client.T3Attachments, {
      id: input.identifier,
      first: input.first,
      after: input.after ?? null,
    });
  const listLabelCandidates: LinearApi["Service"]["listLabelCandidates"] = (input) =>
    execute("listLabelCandidates", client.T3LabelCandidates, {
      key: input.key,
      first: input.first,
      after: input.after ?? null,
      filter: {
        and: [
          { or: [{ team: { id: { in: input.teamIds } } }, { team: { null: true } }] },
          ...(input.ids === undefined ? [] : [{ id: { in: input.ids } }]),
        ],
      },
    });
  const listAssigneeCandidates: LinearApi["Service"]["listAssigneeCandidates"] = (input) =>
    Effect.gen(function* () {
      const data = yield* execute("listAssigneeCandidates", client.T3AssigneeCandidates, {
        key: input.key,
        first: input.first,
        after: input.after ?? null,
        publicTeam: input.visibility !== undefined && input.visibility !== "private",
        readMembers: input.visibility === "private",
        restricted: input.visibility === "restricted",
        membershipTeamIds: input.membershipTeamIds ?? [],
        filter: {
          active: { eq: true },
          ...(input.id === undefined ? {} : { id: { eq: input.id } }),
        },
      });
      const team = data.teams.nodes[0];
      if (team === undefined) return { organization: data.organization, teams: { nodes: [] } };
      if (
        input.workspace !== undefined &&
        data.organization.urlKey.toLowerCase() !== input.workspace
      )
        return yield* fail(
          "listAssigneeCandidates",
          "failed",
          "This scope belongs to another Linear workspace.",
        );
      const teamIds = assigneeTeamIds(team);
      if (
        teamIds === null ||
        (input.visibility !== undefined &&
          (team.visibility !== input.visibility ||
            input.membershipTeamIds === undefined ||
            teamIds.length !== input.membershipTeamIds.length ||
            teamIds.some((id, index) => id !== input.membershipTeamIds?.[index])))
      )
        return yield* fail(
          "listAssigneeCandidates",
          "failed",
          "This Linear team's privacy changed.",
        );
      if (input.visibility === undefined) {
        const page = yield* listAssigneeCandidates({
          ...input,
          visibility: team.visibility,
          membershipTeamIds: teamIds,
        });
        if (
          page.organization.id !== data.organization.id ||
          page.organization.urlKey !== data.organization.urlKey ||
          page.teams.nodes[0]?.id !== team.id
        )
          return yield* fail(
            "listAssigneeCandidates",
            "failed",
            "This Linear team or workspace changed.",
          );
        return page;
      }
      const members = input.visibility === "private" ? team.members : data.users;
      if (members === undefined)
        return yield* fail(
          "listAssigneeCandidates",
          "failed",
          "Linear omitted the assignee candidates.",
        );
      if (
        members.nodes.length > input.first ||
        (input.visibility === "restricted" &&
          data.users?.nodes.some((user) => user.teams === undefined))
      )
        return yield* fail(
          "listAssigneeCandidates",
          "failed",
          "Linear returned invalid assignee membership data.",
        );
      const eligibleUsers =
        input.visibility === "restricted"
          ? data.users!.nodes.filter((user) =>
              user.teams!.nodes.some(({ id }) => teamIds.includes(id)),
            )
          : members.nodes;
      return {
        organization: data.organization,
        teams: {
          nodes: [
            {
              ...team,
              members: { ...members, nodes: eligibleUsers.filter((user) => user.active) },
            },
          ],
        },
      };
    });
  const updateComment: LinearApi["Service"]["updateComment"] = (id, body) =>
    mutate("editComment", client.T3CommentUpdate, { id, input: { body } });

  return LinearApi.of({
    getHierarchy,
    getHistory,
    getAttachments,
    listLabelCandidates,
    listAssigneeCandidates,
    updateComment,
    viewer,
    probeCredential,
    listScopes,
    getScope,
    listIssues,
    getIssue,
    getIssueReference,
    getCommentTarget,
    getTeamStates,
    getComments,
    getTeam,
    createIssue,
    updateIssue,
    createComment,
    createReaction,
    deleteReaction,
    listReactions,
  });
});

export const layer = Layer.effect(LinearApi, make);
