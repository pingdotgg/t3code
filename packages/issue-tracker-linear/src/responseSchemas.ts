import * as Schema from "effect/Schema";

/**
 * Wire shapes of the GraphQL responses we request. Decoding is deliberately lenient about values
 * Linear may extend (state types, priorities as numbers) and strict about the structure mapping needs.
 */

const NullableString = Schema.NullOr(Schema.String);

export const PageInfoNode = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: NullableString,
});

const nodes = <S extends Schema.Top>(node: S) => Schema.Struct({ nodes: Schema.Array(node) });

const connection = <S extends Schema.Top>(node: S) =>
  Schema.Struct({ nodes: Schema.Array(node), pageInfo: PageInfoNode });

const UserNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatarUrl: NullableString,
});

const LabelNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
});

const AttachmentNode = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  sourceType: NullableString,
  metadata: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

export const IssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  priority: Schema.Number,
  priorityLabel: Schema.String,
  branchName: Schema.String,
  updatedAt: Schema.String,
  state: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    type: Schema.String,
    color: Schema.String,
  }),
  assignee: Schema.NullOr(UserNode),
  labels: nodes(LabelNode),
  cycle: Schema.NullOr(Schema.Struct({ id: Schema.String, number: Schema.Number })),
  projectMilestone: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  project: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  team: Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String }),
  parent: Schema.NullOr(Schema.Struct({ id: Schema.String, identifier: Schema.String })),
  children: nodes(
    Schema.Struct({ id: Schema.String, state: Schema.Struct({ type: Schema.String }) }),
  ),
  attachments: nodes(AttachmentNode),
});
export type IssueNode = typeof IssueNode.Type;

export const ViewerResponse = Schema.Struct({
  viewer: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    avatarUrl: NullableString,
  }),
  organization: Schema.Struct({ id: Schema.String, name: Schema.String, urlKey: Schema.String }),
});

export const TeamsResponse = Schema.Struct({
  teams: connection(
    Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      name: Schema.String,
      description: NullableString,
      color: NullableString,
      icon: NullableString,
      projects: nodes(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

export const AssignedIssuesResponse = Schema.Struct({
  viewer: Schema.Struct({
    assignedIssues: nodes(Schema.Struct({ team: Schema.Struct({ id: Schema.String }) })),
  }),
});

export const TeamMetadataResponse = Schema.Struct({
  team: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      states: nodes(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          type: Schema.String,
          color: Schema.String,
          position: Schema.Number,
        }),
      ),
      labels: nodes(LabelNode),
      cycles: nodes(
        Schema.Struct({
          id: Schema.String,
          number: Schema.Number,
          name: NullableString,
          startsAt: NullableString,
          endsAt: NullableString,
        }),
      ),
      members: nodes(UserNode),
    }),
  ),
});

const ProjectNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  progress: Schema.Number,
  targetDate: NullableString,
  status: Schema.Struct({ name: Schema.String, type: Schema.String, color: NullableString }),
  teams: nodes(Schema.Struct({ id: Schema.String })),
});
export type ProjectNode = typeof ProjectNode.Type;

export const TeamProjectsResponse = Schema.Struct({
  team: Schema.NullOr(Schema.Struct({ projects: connection(ProjectNode) })),
});

export const ProjectsResponse = Schema.Struct({ projects: connection(ProjectNode) });

export const MilestonesResponse = Schema.Struct({
  project: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      projectMilestones: nodes(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          progress: Schema.Number,
          targetDate: NullableString,
          sortOrder: Schema.Number,
          status: NullableString,
          issues: nodes(Schema.Struct({ id: Schema.String })),
        }),
      ),
    }),
  ),
});

export const IssuesResponse = Schema.Struct({ issues: connection(IssueNode) });

export const ViewIssuesResponse = Schema.Struct({
  customView: Schema.NullOr(Schema.Struct({ issues: connection(IssueNode) })),
});

export const IssueResponse = Schema.Struct({ issue: Schema.NullOr(IssueNode) });

export const IssueDetailResponse = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      ...IssueNode.fields,
      description: NullableString,
      projectMilestone: Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          progress: Schema.NullOr(Schema.Number),
        }),
      ),
      comments: nodes(
        Schema.Struct({
          id: Schema.String,
          body: Schema.String,
          createdAt: Schema.String,
          user: Schema.NullOr(UserNode),
        }),
      ),
    }),
  ),
});

export const SubIssuesResponse = Schema.Struct({
  issue: Schema.NullOr(Schema.Struct({ children: connection(IssueNode) })),
});

export const ViewsResponse = Schema.Struct({
  customViews: connection(
    Schema.Struct({ id: Schema.String, name: Schema.String, description: NullableString }),
  ),
});

export const SearchResponse = Schema.Struct({ searchIssues: nodes(IssueNode) });

export const IssueUpdateResponse = Schema.Struct({
  issueUpdate: Schema.Struct({ success: Schema.Boolean }),
});

export const CommentCreateResponse = Schema.Struct({
  commentCreate: Schema.Struct({
    success: Schema.Boolean,
    comment: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  }),
});

export const CommentUpdateResponse = Schema.Struct({
  commentUpdate: Schema.Struct({ success: Schema.Boolean }),
});
