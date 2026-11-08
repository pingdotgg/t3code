import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LinearPageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
export const LinearPerson = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});
export const LinearTeam = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
});
export const LinearState = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
  type: Schema.String,
});
export const LinearLabel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
});
export const LinearCycle = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  number: Schema.Number,
  startsAt: Schema.String,
  endsAt: Schema.String,
});
export const LinearProjectSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  url: Schema.String,
  status: LinearState,
  lead: Schema.NullOr(LinearPerson),
  startDate: Schema.NullOr(Schema.String),
  targetDate: Schema.NullOr(Schema.String),
});
export const LinearIssueSummary = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  priority: Schema.Number,
  priorityLabel: Schema.String,
  updatedAt: Schema.String,
  dueDate: Schema.NullOr(Schema.String),
  estimate: Schema.NullOr(Schema.Number),
  state: LinearState,
  team: LinearTeam,
  assignee: Schema.NullOr(LinearPerson),
  project: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  cycle: Schema.NullOr(LinearCycle),
  labels: Schema.Struct({ nodes: Schema.Array(LinearLabel) }),
});
export type LinearIssueSummary = typeof LinearIssueSummary.Type;
export const LinearComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  user: Schema.NullOr(LinearPerson),
});
export const LinearDocument = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  url: Schema.String,
});
export const LinearIssueDetail = Schema.Struct({
  ...LinearIssueSummary.fields,
  description: Schema.NullOr(Schema.String),
  branchName: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  creator: Schema.NullOr(LinearPerson),
  parent: Schema.NullOr(
    Schema.Struct({ id: Schema.String, identifier: Schema.String, title: Schema.String }),
  ),
  children: Schema.Struct({ nodes: Schema.Array(LinearIssueSummary), pageInfo: LinearPageInfo }),
  comments: Schema.Struct({ nodes: Schema.Array(LinearComment), pageInfo: LinearPageInfo }),
  attachments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ id: Schema.String, title: Schema.String, url: Schema.String }),
    ),
  }),
  relations: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.String,
        relatedIssue: Schema.Struct({
          id: Schema.String,
          identifier: Schema.String,
          title: Schema.String,
        }),
      }),
    ),
  }),
  inverseRelations: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.String,
        issue: Schema.Struct({
          id: Schema.String,
          identifier: Schema.String,
          title: Schema.String,
        }),
      }),
    ),
  }),
});
export type LinearIssueDetail = typeof LinearIssueDetail.Type;
export const LinearDocumentSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  updatedAt: Schema.String,
  url: Schema.String,
});
export const LinearWorkspace = Schema.Struct({
  viewer: LinearPerson,
  organization: Schema.Struct({ id: Schema.String, name: Schema.String, urlKey: Schema.String }),
  teams: Schema.Array(LinearTeam),
  users: Schema.Array(LinearPerson),
  projectStatuses: Schema.Array(LinearState),
});
export const LinearTeamContext = Schema.Struct({
  states: Schema.Array(LinearState),
  labels: Schema.Array(LinearLabel),
  cycles: Schema.Array(LinearCycle),
  projects: Schema.Array(LinearProjectSummary),
});
const optionalId = Schema.optional(Schema.String);
export const LinearIssuesInput = Schema.Struct({
  parentId: optionalId,
  teamId: optionalId,
  projectId: optionalId,
  cycleId: optionalId,
  assigneeId: optionalId,
  stateId: optionalId,
  labelId: optionalId,
  priority: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
  view: Schema.optional(
    Schema.Literals(["all", "mine", "created", "subscribed", "active", "backlog", "triage"]),
  ),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  after: optionalId,
  includeArchived: Schema.optional(Schema.Boolean),
});
export const LinearIssuePage = Schema.Struct({
  nodes: Schema.Array(LinearIssueSummary),
  pageInfo: LinearPageInfo,
});
export const LinearIdInput = Schema.Struct({ id: TrimmedNonEmptyString });
export const LinearCommentsInput = Schema.Struct({ id: TrimmedNonEmptyString, after: optionalId });
export const LinearCommentsPage = Schema.Struct({
  nodes: Schema.Array(LinearComment),
  pageInfo: LinearPageInfo,
});
export const LinearProjectsInput = Schema.Struct({ teamId: optionalId, after: optionalId });
export const LinearProjectPage = Schema.Struct({
  nodes: Schema.Array(LinearProjectSummary),
  pageInfo: LinearPageInfo,
});
export const LinearProjectDetail = Schema.Struct({
  ...LinearProjectSummary.fields,
  content: Schema.NullOr(Schema.String),
  documents: Schema.Struct({
    nodes: Schema.Array(LinearDocumentSummary),
    pageInfo: LinearPageInfo,
  }),
  projectMilestones: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        description: Schema.NullOr(Schema.String),
        targetDate: Schema.NullOr(Schema.String),
      }),
    ),
  }),
});
export const LinearDocumentsInput = Schema.Struct({
  teamId: optionalId,
  projectId: optionalId,
  after: optionalId,
});
export const LinearDocumentPage = Schema.Struct({
  nodes: Schema.Array(LinearDocumentSummary),
  pageInfo: LinearPageInfo,
});
export const LinearInboxInput = Schema.Struct({
  after: optionalId,
  unreadOnly: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  snoozed: Schema.optional(Schema.Boolean),
});
export const LinearNotification = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  subtitle: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  readAt: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  snoozedUntilAt: Schema.NullOr(Schema.String),
  project: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
  documentId: Schema.optional(Schema.NullOr(Schema.String)),
  issue: Schema.optional(
    Schema.Struct({ id: Schema.String, identifier: Schema.String, title: Schema.String }),
  ),
});
export const LinearInboxPage = Schema.Struct({
  nodes: Schema.Array(LinearNotification),
  pageInfo: LinearPageInfo,
});
export const LinearConnection = Schema.Struct({
  source: Schema.Literals(["environment", "saved", "disconnected"]),
  connected: Schema.Boolean,
});
export const LinearConfigureInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("save"), apiKey: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("disconnect") }),
  Schema.Struct({ kind: Schema.Literal("environment") }),
]);
const IssueFields = {
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  stateId: optionalId,
  assigneeId: Schema.optional(Schema.NullOr(Schema.String)),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  cycleId: Schema.optional(Schema.NullOr(Schema.String)),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  priority: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 4 })),
  ),
  estimate: Schema.optional(Schema.NullOr(Schema.Number)),
  dueDate: Schema.optional(Schema.NullOr(Schema.String)),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
};
export const LinearMutationInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("issueCreate"),
    input: Schema.Struct({
      ...IssueFields,
      title: TrimmedNonEmptyString,
      teamId: TrimmedNonEmptyString,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("issueUpdate"),
    id: TrimmedNonEmptyString,
    input: Schema.Struct(IssueFields),
  }),
  Schema.Struct({
    kind: Schema.Literals([
      "issueArchive",
      "issueUnarchive",
      "notificationArchive",
      "notificationUnarchive",
      "commentDelete",
      "issueRelationDelete",
      "attachmentDelete",
    ]),
    id: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("commentCreate"),
    input: Schema.Struct({
      issueId: TrimmedNonEmptyString,
      body: TrimmedNonEmptyString,
      parentId: optionalId,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("commentUpdate"),
    id: TrimmedNonEmptyString,
    input: Schema.Struct({ body: TrimmedNonEmptyString }),
  }),
  Schema.Struct({
    kind: Schema.Literal("projectCreate"),
    input: Schema.Struct({
      name: TrimmedNonEmptyString,
      teamIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
      description: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
      content: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("projectUpdate"),
    id: TrimmedNonEmptyString,
    input: Schema.Struct({
      name: Schema.optional(TrimmedNonEmptyString),
      description: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
      content: Schema.optional(Schema.String),
      statusId: optionalId,
      leadId: Schema.optional(Schema.NullOr(Schema.String)),
      startDate: Schema.optional(Schema.NullOr(Schema.String)),
      targetDate: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("documentCreate"),
    input: Schema.Struct({
      title: TrimmedNonEmptyString,
      content: Schema.String,
      projectId: optionalId,
      teamId: optionalId,
      issueId: optionalId,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("documentUpdate"),
    id: TrimmedNonEmptyString,
    input: Schema.Struct({
      title: Schema.optional(TrimmedNonEmptyString),
      content: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("notificationUpdate"),
    id: TrimmedNonEmptyString,
    input: Schema.Struct({
      readAt: Schema.optional(Schema.NullOr(Schema.String)),
      snoozedUntilAt: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("issueRelationCreate"),
    input: Schema.Struct({
      issueId: TrimmedNonEmptyString,
      relatedIssueId: TrimmedNonEmptyString,
      type: Schema.Literals(["blocks", "related", "duplicate"]),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("attachmentCreate"),
    input: Schema.Struct({
      issueId: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("projectMilestoneCreate"),
    input: Schema.Struct({
      projectId: TrimmedNonEmptyString,
      name: TrimmedNonEmptyString,
      description: Schema.optional(Schema.String),
      targetDate: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("projectMilestoneUpdate"),
    id: TrimmedNonEmptyString,
    input: Schema.Struct({
      name: Schema.optional(TrimmedNonEmptyString),
      description: Schema.optional(Schema.String),
      targetDate: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("cycleCreate"),
    input: Schema.Struct({
      teamId: TrimmedNonEmptyString,
      name: Schema.optional(Schema.String),
      startsAt: TrimmedNonEmptyString,
      endsAt: TrimmedNonEmptyString,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("cycleUpdate"),
    id: TrimmedNonEmptyString,
    input: Schema.Struct({
      name: Schema.optional(Schema.String),
      startsAt: Schema.optional(Schema.String),
      endsAt: Schema.optional(Schema.String),
    }),
  }),
]);
export type LinearMutationInput = typeof LinearMutationInput.Type;
export const LinearMutationResult = Schema.Struct({
  success: Schema.Boolean,
  id: Schema.NullOr(Schema.String),
});
export class LinearError extends Schema.TaggedError<LinearError>()("LinearError", {
  reason: Schema.Literals([
    "disconnected",
    "unauthorized",
    "rate-limit",
    "network",
    "api",
    "invalid-response",
    "storage",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "disconnected":
        return "Connect a Linear account to continue.";
      case "unauthorized":
        return "Linear rejected the API key or this account lacks permission. Reconnect in Linear settings.";
      case "rate-limit":
        return "Linear's API limit was reached. Wait a moment before retrying.";
      case "network":
        return "Linear could not be reached. Check the connection and retry.";
      case "api":
        return "Linear rejected the change. Refresh and check the selected values and account permissions.";
      case "invalid-response":
        return "Linear returned an unexpected response. Refresh and try again.";
      case "storage":
        return "The Linear credential could not be stored on this environment.";
    }
  }
}

export const LinearUploadInput = Schema.Struct({
  filename: TrimmedNonEmptyString,
  contentType: TrimmedNonEmptyString,
  base64: Schema.String.check(Schema.isMaxLength(11_184_812)),
});
export const LinearUploadResult = Schema.Struct({ assetUrl: Schema.String });
