import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestActor, PullRequestLabel, PullRequestState } from "./pullRequest.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

/**
 * Which tracker an issue lives in. Git hosts reuse their `SourceControlProviderKind` spelling
 * (`github`, `gitlab`); standalone trackers get their own (`linear`, `jira`). Branded apart from
 * the source control kind because the two sets are not the same: Bitbucket is a git host with no
 * tracker, and Linear is a tracker with no git host.
 */
export const IssueTrackerKind = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
).pipe(Schema.brand("IssueTrackerKind"));
export type IssueTrackerKind = typeof IssueTrackerKind.Type;

const IssueTrackerConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export function issueAccountRequest<
  S extends Schema.Struct<{
    readonly [key: string]: Schema.Constraint & {
      readonly DecodingServices: never;
      readonly EncodingServices: never;
    };
  }>,
>(
  schema: S,
  field: "projectId" | "key" = "projectId",
  advancedField?: "title" | "state" | "body",
): Schema.Codec<S["Type"], Readonly<Record<string, unknown>>> &
  Pick<S, "~type.make.in" | "~type.make"> {
  const value = schema.fields[field] ?? Schema.optional(ProjectId);
  const account = Schema.Struct({ value, connectionId: IssueTrackerConnectionId }).annotate({
    description:
      "A saved issue account target. Copy this object from the returned reference; put the connection ID inside it, never at the request top level.",
  });
  const advancedKeys = ["fieldValues", "richBody", "transitionId"].filter(
    (key) => schema.fields[key] !== undefined,
  );
  const wire = Schema.Struct({
    ...schema.fields,
    connectionId: Schema.optional(Schema.Never),
    [field]: Schema.optional(Schema.Union([value, account])),
    ...(advancedField === undefined
      ? {}
      : {
          [advancedField]: Schema.optional(
            Schema.Union([
              schema.fields[advancedField]!,
              Schema.Struct({ value: schema.fields[advancedField]! }),
            ]),
          ),
        }),
  }).check(
    Schema.makeFilter(
      (raw) => {
        const input = raw as Readonly<Record<string, unknown>>;
        return (
          advancedField === undefined ||
          advancedKeys.every((key) => input[key] === undefined) ||
          typeof input[advancedField] === "object" ||
          `Native issue fields require a wrapped ${advancedField} value.`
        );
      },
      {
        toJsonSchema: () =>
          advancedField === undefined
            ? {}
            : {
                anyOf: [
                  { not: { anyOf: advancedKeys.map((key) => ({ required: [key] })) } },
                  {
                    required: [advancedField],
                    properties: { [advancedField]: { type: "object" } },
                  },
                ],
              },
      },
    ),
  );
  return wire.pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transform((raw) => {
        let input = raw as Readonly<Record<string, unknown>>;
        if (advancedField !== undefined) {
          const wrapped = input[advancedField];
          if (wrapped !== null && typeof wrapped === "object") {
            const { [advancedField]: _wrapped, ...rest } = input;
            input = "value" in wrapped ? { ...rest, [advancedField]: wrapped.value } : rest;
          }
        }
        const target = input[field];
        if (target !== null && typeof target === "object" && "connectionId" in target) {
          const { [field]: _qualified, ...rest } = input;
          const value = "value" in target ? target.value : undefined;
          return {
            ...rest,
            ...(value === undefined ? {} : { [field]: value }),
            connectionId: target.connectionId,
          } as S["Encoded"];
        }
        return input as S["Encoded"];
      }),
      encode: SchemaGetter.transform((raw) => {
        const plain = raw as Readonly<Record<string, unknown>>;
        const input =
          advancedField !== undefined &&
          (plain.fieldValues !== undefined ||
            plain.richBody !== undefined ||
            plain.transitionId !== undefined)
            ? {
                ...plain,
                [advancedField]:
                  plain[advancedField] === undefined ? {} : { value: plain[advancedField] },
              }
            : plain;
        const { connectionId, ...rest } = input;
        return (
          connectionId === undefined
            ? input
            : {
                ...rest,
                [field]: {
                  ...(input[field] === undefined ? {} : { value: input[field] }),
                  connectionId,
                },
              }
        ) as typeof wire.Type;
      }),
    }),
  );
}

export const IssueActor = Schema.Struct({
  ...PullRequestActor.fields,
  id: Schema.optional(TrimmedNonEmptyString),
});
export type IssueActor = typeof IssueActor.Type;

export const IssueLabel = Schema.Struct({
  ...PullRequestLabel.fields,
  id: Schema.optional(TrimmedNonEmptyString),
});
export type IssueLabel = typeof IssueLabel.Type;

/**
 * Where an issue stands, in two parts: the category every tracker has, and the name this tracker
 * gives it. GitHub only has the two; Linear and Jira have a workflow of their own ("In Review",
 * "Backlog"), which `name` carries verbatim so the page can show the tracker's word while every
 * filter and badge keys off `category`.
 */
export const IssueStateCategory = Schema.Literals(["open", "closed"]);
export type IssueStateCategory = typeof IssueStateCategory.Type;

export const IssueWorkflowCategory = Schema.Literals([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);
export type IssueWorkflowCategory = typeof IssueWorkflowCategory.Type;
export const IssueListSort = Schema.Literals(["created", "updated", "comments"]);
export type IssueListSort = typeof IssueListSort.Type;
export const IssueListOrder = Schema.Literals(["asc", "desc"]);
export type IssueListOrder = typeof IssueListOrder.Type;
export const IssuePageInput = Schema.Struct({
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type IssuePageInput = typeof IssuePageInput.Type;

export const IssueInputField = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  required: Schema.Boolean,
  kind: Schema.Literals([
    "text",
    "textarea",
    "number",
    "date",
    "datetime",
    "select",
    "multiselect",
    "cascading-select",
    "json",
  ]),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        value: Schema.String.check(Schema.isMaxLength(4096)),
        label: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
        children: Schema.optional(
          Schema.Array(
            Schema.Struct({
              value: Schema.String.check(Schema.isMaxLength(4096)),
              label: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
            }),
          ).check(Schema.isMaxLength(100)),
        ),
      }),
    ).check(Schema.isMaxLength(100)),
  ),
});
export type IssueInputField = typeof IssueInputField.Type;

export const IssueFieldValues = Schema.Record(
  TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  Schema.Union([
    Schema.String.check(Schema.isMaxLength(65_536)),
    Schema.Array(Schema.String.check(Schema.isMaxLength(65_536))).check(Schema.isMaxLength(100)),
  ]),
).check(
  Schema.makeFilter(
    (values) =>
      Object.keys(values).length <= 1000 &&
      Object.entries(values).reduce(
        (total, [key, value]) =>
          total +
          key.length +
          (typeof value === "string"
            ? value.length
            : value.reduce((length, item) => length + item.length, 0)),
        0,
      ) <= 65_536,
  ),
);
export type IssueFieldValues = typeof IssueFieldValues.Type;

export const IssueRichBody = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("adf"),
    document: Schema.String.check(Schema.isMaxLength(262_144)).check(
      Schema.makeFilter((value) => {
        try {
          JSON.parse(value);
          return true;
        } catch {
          return false;
        }
      }),
    ),
  }),
  Schema.Struct({
    format: Schema.Literal("jira-wiki"),
    document: Schema.String.check(Schema.isMaxLength(65_536)),
  }),
  Schema.Struct({
    format: Schema.Literal("azure-html"),
    document: Schema.String.check(Schema.isMaxLength(65_536)),
  }),
]);
export type IssueRichBody = typeof IssueRichBody.Type;

export const IssueState = Schema.Struct({
  transitionId: Schema.optional(TrimmedNonEmptyString),
  fields: Schema.optional(Schema.Array(IssueInputField).check(Schema.isMaxLength(1000))),
  workflowCategory: Schema.optional(IssueWorkflowCategory),
  id: Schema.optional(TrimmedNonEmptyString),
  category: IssueStateCategory,
  name: TrimmedNonEmptyString,
  /** Why it was closed, where the tracker records one (GitHub: `completed` / `not-planned`). */
  closeReason: Schema.optional(TrimmedNonEmptyString),
});
export type IssueState = typeof IssueState.Type;

/** What a listing asks for: either category, or both. */
export const IssueListState = Schema.Literals(["all", "open", "closed"]);
export type IssueListState = typeof IssueListState.Type;

export const IssueInvolvement = Schema.Literals(["all", "assigned", "authored", "mentioned"]);
export type IssueInvolvement = typeof IssueInvolvement.Type;

export const IssueReactionContent = Schema.Literals([
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);
export type IssueReactionContent = typeof IssueReactionContent.Type;

export const IssueReaction = Schema.Struct({
  content: IssueReactionContent,
  count: PositiveInt,
  /** Who reacted, as far as the tracker named them; the viewer is left out and shown as "You". */
  actors: Schema.Array(TrimmedNonEmptyString),
  viewerHasReacted: Schema.Boolean,
});
export type IssueReaction = typeof IssueReaction.Type;

/**
 * Addresses one issue. `tracker` picks the driver, `scope` is the tracker's own container — the
 * `owner/repo` path on a git host, a team or project key on Linear and Jira — and `key` is the
 * issue's native id within it: `"123"` on GitHub, `"ENG-123"` on Linear. `host` is where the
 * tracker is served from, for a kind that can be self-hosted (GitHub Enterprise, GitLab, Forgejo);
 * absent means the kind's public host.
 *
 * `projectId` names the project whose checkout and credentials serve the read. An issue outside
 * every project's own scope can still be read through any project on the same tracker and host,
 * but the service refuses to write to it.
 */
export const IssueRef = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  projectId: ProjectId,
  tracker: IssueTrackerKind,
  host: Schema.optional(TrimmedNonEmptyString),
  scope: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
});
export type IssueRef = typeof IssueRef.Type;

export const IssueResolveUrlInput = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  url: Schema.String,
  projectId: Schema.optional(ProjectId),
});
export type IssueResolveUrlInput = typeof IssueResolveUrlInput.Type;

export const IssueResolvedUrl = Schema.Struct({
  ...IssueRef.fields,
  host: TrimmedNonEmptyString,
  writable: Schema.Boolean,
});
export type IssueResolvedUrl = typeof IssueResolvedUrl.Type;

/** A scope with no issue in it, for reads about the container itself: templates, candidates. */
export const IssueScopeRef = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  projectId: ProjectId,
  tracker: IssueTrackerKind,
  host: Schema.optional(TrimmedNonEmptyString),
  scope: TrimmedNonEmptyString,
});
export type IssueScopeRef = typeof IssueScopeRef.Type;

export const IssueCandidatesInput = Schema.Struct({
  issueType: Schema.optional(TrimmedNonEmptyString),
  ...IssueScopeRef.fields,
  key: Schema.optional(TrimmedNonEmptyString),
});
export type IssueCandidatesInput = typeof IssueCandidatesInput.Type;

export const IssueTemplatesInput = Schema.Struct({
  ...IssueScopeRef.fields,
  metadataOnly: Schema.optional(Schema.Boolean),
  templateKey: Schema.optional(TrimmedNonEmptyString),
});
export type IssueTemplatesInput = typeof IssueTemplatesInput.Type;

/** One row of a listing. Carries everything a list needs and nothing a detail needs. */
export const IssueSummary = Schema.Struct({
  itemType: Schema.optional(TrimmedNonEmptyString),
  tracker: IssueTrackerKind,
  host: TrimmedNonEmptyString,
  scope: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  /** How the tracker writes the key for people: `#123` on a git host, `ENG-123` on Linear. */
  displayKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  state: IssueState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  assignees: Schema.Array(IssueActor),
  labels: Schema.Array(IssueLabel),
  milestone: Schema.optional(Schema.NullOr(Schema.String)),
  labelsTruncated: Schema.optional(Schema.Boolean),
  reactions: Schema.optional(Schema.Array(IssueReaction)),
  reactionsTruncated: Schema.optional(Schema.Boolean),
  commentCount: Schema.NullOr(NonNegativeInt),
});
export type IssueSummary = typeof IssueSummary.Type;

export const IssueListEntry = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  ...IssueSummary.fields,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
});
export type IssueListEntry = typeof IssueListEntry.Type;

export const IssueComment = Schema.Struct({
  richBody: Schema.optional(IssueRichBody),
  editedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  canEdit: Schema.optional(Schema.Boolean),
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
  /** Absent from a tracker with no reactions, which differs from none on this comment. */
  reactions: Schema.optional(Schema.Array(IssueReaction)),
  reactionsTruncated: Schema.optional(Schema.Boolean),
});
export type IssueComment = typeof IssueComment.Type;

/**
 * Something that happened to an issue that nobody wrote words for: it was closed, labelled,
 * assigned, renamed. Kinds are the common vocabulary; a tracker drops what it cannot map rather
 * than guessing.
 */
export const IssueEventKind = Schema.Literals([
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "renamed",
  "referenced",
  "state-changed",
  "changed",
  "updated",
]);
export type IssueEventKind = typeof IssueEventKind.Type;

export const IssueEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: IssueEventKind,
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  reference: Schema.optional(
    Schema.Struct({
      url: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
      title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
      identifier: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
    }),
  ),
  actor: Schema.NullOr(IssueActor),
  createdAt: IsoDateTime,
  /** What the event was about, where it has a subject: a label name, a login, a new title. */
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueEvent = typeof IssueEvent.Type;

/** A change request the tracker says closes or mentions this issue. */
export const IssueLinkedPullRequest = Schema.Struct({
  provider: Schema.optional(SourceControlProviderKind),
  host: Schema.optional(TrimmedNonEmptyString),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: Schema.NullOr(PullRequestState),
  isDraft: Schema.optional(Schema.Boolean),
  /** Merging it closes this issue, rather than only citing it. */
  closesIssue: Schema.Boolean,
});
export type IssueLinkedPullRequest = typeof IssueLinkedPullRequest.Type;

/**
 * What a tracker can do at all, so a surface never offers an action that would fail. The
 * service refuses a call outside these before it reaches the driver.
 */
export const IssueCapabilities = Schema.Struct({
  createFields: Schema.optional(Schema.Boolean),
  stateFields: Schema.optional(Schema.Boolean),
  richText: Schema.optional(Schema.Boolean),
  dependencies: Schema.optional(Schema.Boolean),
  subIssueNoun: Schema.optional(TrimmedNonEmptyString),
  editComment: Schema.optional(Schema.Boolean),
  subIssues: Schema.optional(Schema.Boolean),
  createSubIssue: Schema.optional(Schema.Boolean),
  updateParent: Schema.optional(Schema.Boolean),
  listSorts: Schema.optional(Schema.Array(IssueListSort)),
  listOrders: Schema.optional(Schema.Array(IssueListOrder)),
  commentOrders: Schema.optional(Schema.Array(IssueListOrder)),
  historyOrders: Schema.optional(Schema.Array(IssueListOrder)),
  create: Schema.Boolean,
  createIssueTypes: Schema.optional(Schema.Boolean),
  /** Title and body can be rewritten after filing. */
  edit: Schema.Boolean,
  comment: Schema.Boolean,
  labels: Schema.Boolean,
  assignees: Schema.Boolean,
  maxAssignees: Schema.optional(PositiveInt),
  reactions: Schema.Boolean,
  commentReactions: Schema.optional(Schema.Boolean),
  reactionContents: Schema.optional(
    Schema.Array(IssueReactionContent).check(Schema.isMaxLength(8)),
  ),
  /** The scope offers starting points for a new issue. */
  templates: Schema.Boolean,
  /** The tracker reports linked change requests of its own accord. */
  linkedPullRequests: Schema.Boolean,
  /** State changes arrive as events beside the comments, not only as comments. */
  events: Schema.Boolean,
  /** The tracker narrows a listing by free text itself. */
  search: Schema.Boolean,
  involvements: Schema.optional(
    Schema.Array(IssueInvolvement).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  ),
  /**
   * The states this tracker can be asked to move an issue into, by name. A git host offers
   * `open` and `closed`; a workflow tracker offers its own columns. Empty means state cannot be
   * changed from here.
   */
  states: Schema.Array(IssueState),
  /** Reasons a close can carry. Empty means a close takes none. */
  closeReasons: Schema.Array(TrimmedNonEmptyString),
});
export type IssueCapabilities = typeof IssueCapabilities.Type;

/**
 * What the signed-in account may do with this issue, which `capabilities` says nothing about.
 * A permission the tracker reports nothing about is granted, so a refusal comes from the
 * tracker, which says why, rather than from a missing control.
 */
export const IssueViewerPermissions = Schema.Struct({
  updateParent: Schema.optional(Schema.Boolean),
  updateDependencies: Schema.optional(Schema.Boolean),
  setState: Schema.Boolean,
  comment: Schema.Boolean,
  edit: Schema.Boolean,
  labels: Schema.Boolean,
  assignees: Schema.Boolean,
});
export type IssueViewerPermissions = typeof IssueViewerPermissions.Type;

export const IssueDetail = Schema.Struct({
  richBody: Schema.optional(IssueRichBody),
  externalLinks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: TrimmedNonEmptyString,
        url: TrimmedNonEmptyString,
      }),
    ).check(Schema.isMaxLength(100)),
  ),
  connectionId: Schema.optional(IssueTrackerConnectionId),
  states: Schema.optional(Schema.Array(IssueState)),
  ...IssueSummary.fields,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  /** False for an issue outside every project's scope, which is read-only through this server. */
  writable: Schema.Boolean,
  capabilities: IssueCapabilities,
  viewerPermissions: IssueViewerPermissions,
  /** The signed-in account, so a comment edit is offered only on the viewer's own remarks. */
  viewer: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.String,
  bodyEditable: Schema.optional(Schema.Boolean),
  reactions: Schema.optional(Schema.Array(IssueReaction)),
  reactionsTruncated: Schema.optional(Schema.Boolean),
  comments: Schema.Array(IssueComment),
  commentsCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  events: Schema.Array(IssueEvent),
  linkedPullRequests: Schema.Array(IssueLinkedPullRequest),
  historyTruncated: Schema.optional(Schema.Boolean),
});
export type IssueDetail = typeof IssueDetail.Type;

export const IssueCommentsPageInput = Schema.Struct({
  ...IssueRef.fields,
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  order: Schema.optional(IssueListOrder),
  viewer: Schema.optional(TrimmedNonEmptyString),
});
export type IssueCommentsPageInput = typeof IssueCommentsPageInput.Type;

export const IssueCommentsPage = Schema.Struct({
  comments: Schema.Array(IssueComment),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
});
export type IssueCommentsPage = typeof IssueCommentsPage.Type;

export function issueHostKey(host: string): string {
  return host.trim().replace(/^[^/]+/u, (authority) => authority.toLowerCase());
}

export function issueTrackerHostKey(source: {
  readonly tracker: string;
  readonly host: string;
}): string {
  return `${source.tracker} ${issueHostKey(source.host)}`;
}

export function issueListCursorKey(source: {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly connectionId?: string | undefined;
}): string {
  const key = `${issueTrackerHostKey(source)} ${source.scope}`;
  return source.connectionId === undefined
    ? key
    : `@${encodeURIComponent(source.connectionId)} ${key}`;
}

export const IssueListCursors = Schema.Record(
  TrimmedNonEmptyString,
  TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
);
export type IssueListCursors = typeof IssueListCursors.Type;

export const IssueListInput = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  tracker: Schema.optional(IssueTrackerKind),
  scope: Schema.optional(TrimmedNonEmptyString),
  stateCategories: Schema.optional(
    Schema.Array(IssueWorkflowCategory).check(Schema.isMaxLength(5)),
  ),
  sort: Schema.optional(IssueListSort),
  order: Schema.optional(IssueListOrder),
  state: IssueListState,
  involvement: Schema.optional(IssueInvolvement),
  projectId: Schema.optional(ProjectId),
  /** Narrows to one host, named as the host itself. Absent means every host the workspace has. */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Rows per scope, which with a continuation is rows per slice. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  /** Carry on from an earlier answer: only the scopes named here are read, one slice each. */
  cursors: Schema.optional(IssueListCursors),
  /** Free text the trackers themselves are asked to match. */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type IssueListInput = typeof IssueListInput.Type;

export function issueListRequest<
  S extends Schema.Struct<{
    readonly [key: string]: Schema.Constraint & {
      readonly DecodingServices: never;
      readonly EncodingServices: never;
    };
  }>,
>(
  schema: S,
  legacyHost = true,
): Schema.Codec<S["Type"], Readonly<Record<string, unknown>>> &
  Pick<S, "~type.make.in" | "~type.make"> {
  const selection = Schema.Struct({
    value: schema.fields.state!,
    host: IssueListInput.fields.host,
    tracker: IssueListInput.fields.tracker,
    scope: IssueListInput.fields.scope,
  });
  const wire = Schema.Struct({
    ...schema.fields,
    host: legacyHost ? schema.fields.host! : Schema.optional(Schema.Never),
    tracker: Schema.optional(Schema.Never),
    scope: Schema.optional(Schema.Never),
    state: Schema.optional(Schema.Union([schema.fields.state!, selection])),
  }).pipe(issueAccountRequest);
  return wire.pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transform((raw) => {
        const input = raw as Readonly<Record<string, unknown>>;
        const state = input.state;
        if (state !== null && typeof state === "object") {
          const { value, ...selection } = state as Readonly<Record<string, unknown>>;
          const { state: _state, ...rest } = input;
          return {
            ...rest,
            ...selection,
            ...(value === undefined ? {} : { state: value }),
          } as S["Encoded"];
        }
        return input as S["Encoded"];
      }),
      encode: SchemaGetter.transform((raw) => {
        const input = raw as Readonly<Record<string, unknown>>;
        const { tracker, scope, state, host, ...rest } = input;
        return (
          tracker === undefined && scope === undefined && (legacyHost || host === undefined)
            ? input
            : {
                ...rest,
                ...(legacyHost && host !== undefined ? { host } : {}),
                state: {
                  ...(state === undefined ? {} : { value: state }),
                  ...(!legacyHost && host !== undefined ? { host } : {}),
                  ...(tracker === undefined ? {} : { tracker }),
                  ...(scope === undefined ? {} : { scope }),
                },
              }
        ) as typeof wire.Type;
      }),
    }),
  );
}

/** One tracker account the workspace has projects on, and whether it can be read right now. */
export const IssueTrackerSummary = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  tracker: IssueTrackerKind,
  host: TrimmedNonEmptyString,
  projectCount: PositiveInt,
  capabilities: Schema.NullOr(IssueCapabilities),
  /** False when the tracker's tool or credentials are missing, with `detail` saying which. */
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueTrackerSummary = typeof IssueTrackerSummary.Type;

export const IssueListProjectError = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  tracker: Schema.optional(IssueTrackerKind),
  host: Schema.optional(TrimmedNonEmptyString),
});
export type IssueListProjectError = typeof IssueListProjectError.Type;

export const IssueListResult = Schema.Struct({
  sources: Schema.optional(
    Schema.Array(
      Schema.Struct({
        projectId: ProjectId,
        projectTitle: TrimmedNonEmptyString,
        tracker: IssueTrackerKind,
        host: TrimmedNonEmptyString,
        scope: TrimmedNonEmptyString,
        capabilities: IssueCapabilities,
        connectionId: Schema.optional(IssueTrackerConnectionId),
      }),
    ),
  ),
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  trackers: Schema.Array(IssueTrackerSummary),
  /** By update, newest first, across every scope this answer covers. */
  entries: Schema.Array(IssueListEntry),
  errors: Schema.Array(IssueListProjectError),
  /** Where each scope carries on, sent straight back as `cursors`. Absent once a scope is done. */
  nextCursors: IssueListCursors,
});
export type IssueListResult = typeof IssueListResult.Type;

const IssueTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
// Not trimmed: a body is markdown, where leading spaces open a code block. The bound keeps
// oversized payloads off the wire; the service rejects a comment that is only whitespace.
const IssueBody = Schema.String.check(Schema.isMaxLength(65_536));
const CommentBody = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536));

export const IssueCreateInput = Schema.Struct({
  fieldValues: Schema.optional(IssueFieldValues),
  ...IssueScopeRef.fields,
  title: IssueTitle,
  /** May be empty: an issue with a title and nothing else is a legitimate one. */
  body: IssueBody,
  labels: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50)),
  assignees: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(25)),
  issueType: Schema.optional(TrimmedNonEmptyString),
  parentKey: Schema.optional(TrimmedNonEmptyString),
  templateKey: Schema.optional(TrimmedNonEmptyString),
});
export type IssueCreateInput = typeof IssueCreateInput.Type;

export const IssueCreateResult = Schema.Struct({
  parentLinked: Schema.optional(Schema.Boolean),
  key: TrimmedNonEmptyString,
  displayKey: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  warnings: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(10))),
});
export type IssueCreateResult = typeof IssueCreateResult.Type;

export const IssueCommentInput = Schema.Struct({
  ...IssueRef.fields,
  body: CommentBody,
});
export type IssueCommentInput = typeof IssueCommentInput.Type;

/**
 * Rewrites the issue's own fields. Every field is optional and only the present ones are
 * written; `labels` and `assignees` are the whole set, which is how every tracker writes them.
 * The service refuses a request with nothing present.
 */
export const IssueUpdateInput = Schema.Struct({
  richBody: Schema.optional(IssueRichBody),
  ...IssueRef.fields,
  title: Schema.optional(IssueTitle),
  body: Schema.optional(IssueBody),
  labels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  assignees: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(25))),
});
export type IssueUpdateInput = typeof IssueUpdateInput.Type;

export const IssueSetStateInput = Schema.Struct({
  transitionId: Schema.optional(TrimmedNonEmptyString),
  fieldValues: Schema.optional(IssueFieldValues),
  ...IssueRef.fields,
  state: TrimmedNonEmptyString,
  /** Only meaningful for a closing state on a tracker that declared `closeReasons`. */
  closeReason: Schema.optional(TrimmedNonEmptyString),
});
export type IssueSetStateInput = typeof IssueSetStateInput.Type;

export const IssueReactionInput = Schema.Struct({
  ...IssueRef.fields,
  /** Absent reacts to the issue itself; present names a comment id as the detail carried it. */
  subjectId: Schema.optional(TrimmedNonEmptyString),
  content: IssueReactionContent,
  reacted: Schema.Boolean,
});
export type IssueReactionInput = typeof IssueReactionInput.Type;

const IssueTemplateFieldBase = {
  id: TrimmedNonEmptyString,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  required: Schema.Boolean,
};
export const IssueTemplateField = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("markdown"), value: Schema.String }),
  Schema.Struct({
    ...IssueTemplateFieldBase,
    kind: Schema.Literal("input"),
    placeholder: Schema.NullOr(Schema.String),
    value: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...IssueTemplateFieldBase,
    kind: Schema.Literal("textarea"),
    placeholder: Schema.NullOr(Schema.String),
    value: Schema.NullOr(Schema.String),
    render: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...IssueTemplateFieldBase,
    kind: Schema.Literal("dropdown"),
    multiple: Schema.Boolean,
    options: Schema.Array(Schema.String),
    defaultValues: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(100))),
  }),
  Schema.Struct({
    ...IssueTemplateFieldBase,
    kind: Schema.Literal("checkboxes"),
    options: Schema.Array(Schema.Struct({ label: Schema.String, required: Schema.Boolean })),
  }),
]);
export type IssueTemplateField = typeof IssueTemplateField.Type;
export const IssueTemplate = Schema.Struct({
  fields: Schema.optional(Schema.Array(IssueTemplateField).check(Schema.isMaxLength(100))),
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  about: Schema.String,
  title: Schema.String,
  body: Schema.String,
  contentDeferred: Schema.optional(Schema.Boolean),
  labels: Schema.Array(TrimmedNonEmptyString),
  assignees: Schema.Array(TrimmedNonEmptyString),
});
export type IssueTemplate = typeof IssueTemplate.Type;

/** A starting point only the tracker's own site can render: Linear's form and rich templates. */
export const IssueExternalTemplate = Schema.Struct({
  name: TrimmedNonEmptyString,
  about: Schema.String,
  /** Opens the exact template on the tracker, ready to fill in. */
  url: TrimmedNonEmptyString,
});
export type IssueExternalTemplate = typeof IssueExternalTemplate.Type;

export const IssueTemplateList = Schema.Struct({
  contactLinks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        about: Schema.String,
        url: TrimmedNonEmptyString,
      }),
    ).check(Schema.isMaxLength(100)),
  ),
  contributingGuidelinesUrl: Schema.optional(TrimmedNonEmptyString),
  templates: Schema.Array(IssueTemplate),
  /** Absent from a tracker whose every template is body-shaped. */
  externalTemplates: Schema.optional(Schema.Array(IssueExternalTemplate)),
  /** False where the scope's config forbids an issue filed from nothing. */
  blankIssuesEnabled: Schema.Boolean,
});
export type IssueTemplateList = typeof IssueTemplateList.Type;

export const IssueLabelCandidate = Schema.Struct({
  ...IssueLabel.fields,
  description: Schema.NullOr(Schema.String),
});
export type IssueLabelCandidate = typeof IssueLabelCandidate.Type;

export const IssueAssigneeCandidate = Schema.Struct({
  ...IssueActor.fields,
  /** How the tracker addresses this person on a write, which is not always the login. */
  id: TrimmedNonEmptyString,
});
export type IssueAssigneeCandidate = typeof IssueAssigneeCandidate.Type;

/** The labels and people a scope offers, read when a picker opens rather than with every issue. */
export const IssueCandidates = Schema.Struct({
  fields: Schema.optional(Schema.Array(IssueInputField).check(Schema.isMaxLength(1000))),
  states: Schema.optional(Schema.Array(IssueState)),
  labels: Schema.Array(IssueLabelCandidate),
  assignees: Schema.Array(IssueAssigneeCandidate),
  issueTypes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        name: TrimmedNonEmptyString,
      }),
    ).check(Schema.isMaxLength(100)),
  ),
  /** The tracker has more than were read, so somebody missing is not necessarily ineligible. */
  truncated: Schema.Boolean,
});
export type IssueCandidates = typeof IssueCandidates.Type;

export const IssuePageRef = Schema.Struct({ ...IssueRef.fields, ...IssuePageInput.fields });
export type IssuePageRef = typeof IssuePageRef.Type;
export const IssueHistoryInput = Schema.Struct({
  ...IssuePageRef.fields,
  order: Schema.optional(IssueListOrder),
});
export type IssueHistoryInput = typeof IssueHistoryInput.Type;
export const IssueScopePageRef = Schema.Struct({
  ...IssueScopeRef.fields,
  ...IssuePageInput.fields,
});
export type IssueScopePageRef = typeof IssueScopePageRef.Type;
export const IssueRelation = Schema.Struct({
  itemType: Schema.optional(TrimmedNonEmptyString),
  externalOnly: Schema.optional(Schema.Boolean),
  scope: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  displayKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: IssueState,
});
export type IssueRelation = typeof IssueRelation.Type;
export const IssueDependencyDirection = Schema.Literals(["blocks", "blocked-by"]);
export type IssueDependencyDirection = typeof IssueDependencyDirection.Type;
export const IssueDependency = Schema.Struct({
  ...IssueRelation.fields,
  kind: Schema.Literals(["issue", "pull-request"]),
});
export type IssueDependency = typeof IssueDependency.Type;
export const IssueDependenciesPage = Schema.Struct({
  items: Schema.Array(IssueDependency).check(Schema.isMaxLength(200)),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  truncated: Schema.optional(Schema.Boolean),
});
export type IssueDependenciesPage = typeof IssueDependenciesPage.Type;
export const IssueDependenciesInput = Schema.Struct({
  ...IssuePageRef.fields,
  direction: IssueDependencyDirection,
});
export type IssueDependenciesInput = typeof IssueDependenciesInput.Type;
export const IssueSetDependencyInput = Schema.Struct({
  ...IssueRef.fields,
  direction: IssueDependencyDirection,
  targetScope: TrimmedNonEmptyString,
  targetKey: TrimmedNonEmptyString,
  linked: Schema.Boolean,
});
export type IssueSetDependencyInput = typeof IssueSetDependencyInput.Type;

export const IssueHistoryPage = Schema.Struct({
  items: Schema.Array(IssueEvent),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  truncated: Schema.optional(Schema.Boolean),
});
export type IssueHistoryPage = typeof IssueHistoryPage.Type;
export const IssueLinkedPullRequestsPage = Schema.Struct({
  items: Schema.Array(IssueLinkedPullRequest),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  truncated: Schema.optional(Schema.Boolean),
});
export type IssueLinkedPullRequestsPage = typeof IssueLinkedPullRequestsPage.Type;
export const IssueLabelCandidatesPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      ...IssueLabel.fields,
      description: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  truncated: Schema.optional(Schema.Boolean),
});
export type IssueLabelCandidatesPage = typeof IssueLabelCandidatesPage.Type;
export const IssueAssigneeCandidatesPage = Schema.Struct({
  items: Schema.Array(IssueActor),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  truncated: Schema.optional(Schema.Boolean),
});
export type IssueAssigneeCandidatesPage = typeof IssueAssigneeCandidatesPage.Type;
export const IssueHierarchyPage = Schema.Struct({
  parent: Schema.NullOr(IssueRelation),
  children: Schema.Struct({
    items: Schema.Array(IssueRelation),
    nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
    truncated: Schema.optional(Schema.Boolean),
  }),
});
export type IssueHierarchyPage = typeof IssueHierarchyPage.Type;
export const IssueEditCommentInput = Schema.Struct({
  richBody: Schema.optional(IssueRichBody),
  ...IssueRef.fields,
  commentId: TrimmedNonEmptyString,
  body: IssueBody,
});
export type IssueEditCommentInput = typeof IssueEditCommentInput.Type;
export const IssueSetParentInput = Schema.Struct({
  ...IssueRef.fields,
  parentKey: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueSetParentInput = typeof IssueSetParentInput.Type;

export const IssueUnavailableReason = Schema.Literals([
  "tool-missing",
  "unauthenticated",
  "tracker-unsupported",
]);
export type IssueUnavailableReason = typeof IssueUnavailableReason.Type;

/** The tracker cannot be read at all for this project, as opposed to one request failing. */
export class IssueUnavailableError extends Schema.TaggedError<IssueUnavailableError>()(
  "IssueUnavailableError",
  {
    reason: IssueUnavailableReason,
    tracker: Schema.optional(IssueTrackerKind),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(IssueUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    switch (this.reason) {
      case "tool-missing":
        return "The tool this tracker is read through is not installed or set up.";
      case "unauthenticated":
        return "This tracker has no working credentials.";
      case "tracker-unsupported":
        return "Issues cannot be browsed for this project yet.";
    }
  }
}

export class IssueOperationError extends Schema.TaggedError<IssueOperationError>()(
  "IssueOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    reason: Schema.optional(Schema.Literals(["not-found", "read-only", "rate-limited"])),
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(IssueOperationError)(this, { status: 502 });
  }

  override get message(): string {
    return `Issue operation ${this.operation} failed: ${this.detail}`;
  }
}

export type IssueError = IssueUnavailableError | IssueOperationError;

/** Who created a thread ↔ issue link. */
export const ThreadIssueLinkSource = Schema.Literals(["manual", "agent"]);
export type ThreadIssueLinkSource = typeof ThreadIssueLinkSource.Type;

/**
 * Identity of an issue as a thread link sees it: tracker-level, so the same issue linked through
 * two projects compares equal. `host` is always written here, unlike `IssueRef`, because a link
 * outlives the project whose binding supplied the default.
 */
export const ThreadIssueKey = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  tracker: IssueTrackerKind,
  host: TrimmedNonEmptyString,
  scope: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
});
export type ThreadIssueKey = typeof ThreadIssueKey.Type;

/** What a thread shows about a linked issue without a tracker read; null until first sync. */
export const ThreadIssueSnapshot = Schema.Struct({
  displayKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  state: IssueState,
  syncedAt: IsoDateTime,
});
export type ThreadIssueSnapshot = typeof ThreadIssueSnapshot.Type;

/**
 * An issue linked to a thread. `projectId` is the project the issue is read through, which the
 * refresh and the detail panel both need; `url` is what the agent or user handed over.
 */
export const ThreadIssueLink = Schema.Struct({
  ...ThreadIssueKey.fields,
  linkId: Schema.optional(CommandId),
  projectId: ProjectId,
  url: TrimmedNonEmptyString,
  source: ThreadIssueLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadIssueSnapshot),
}).pipe(issueAccountRequest);
export type ThreadIssueLink = typeof ThreadIssueLink.Type;

export function issueScopeKeyOf(
  ref: Pick<IssueScopeRef, "scope"> & { readonly tracker: string },
): string {
  const scope = ref.scope.trim();
  if (ref.tracker !== "forgejo") return scope.toLowerCase();
  const segments = scope.split("/");
  return segments
    .map((segment, index) => (index < segments.length - 2 ? segment : segment.toLowerCase()))
    .join("/");
}

export function threadIssueKeyOf(
  key: Pick<ThreadIssueKey, "host" | "scope" | "key" | "connectionId"> & {
    readonly tracker: string;
  },
): string {
  const nativeKey =
    key.tracker === "linear" || key.tracker === "jira"
      ? key.key.trim().toUpperCase()
      : key.key.trim();
  const identity = `${key.tracker}\u0000${issueHostKey(key.host)}\u0000${issueScopeKeyOf(key)}\u0000${nativeKey}`;
  return key.connectionId === undefined
    ? identity
    : `@${encodeURIComponent(key.connectionId)}\u0000${identity}`;
}

export function threadIssueKeysEqual(left: ThreadIssueKey, right: ThreadIssueKey): boolean {
  return threadIssueKeyOf(left) === threadIssueKeyOf(right);
}

/** The `IssueRef` a link is read through. */
export function threadIssueRefOf(link: ThreadIssueLink): IssueRef {
  return {
    projectId: link.projectId,
    ...(link.connectionId === undefined ? {} : { connectionId: link.connectionId }),
    tracker: link.tracker,
    host: link.host,
    scope: link.scope,
    key: link.key,
  };
}

/**
 * A tracker that is not a git host: it is reached with its own credential rather than a
 * checkout's, and a project opts into it by binding one of the tracker's scopes. Everything a
 * client needs to draw the connect flow for any such tracker without knowing which one it is.
 */
export const StandaloneIssueTrackerDescriptor = Schema.Struct({
  tracker: IssueTrackerKind,
  displayName: TrimmedNonEmptyString,
  /** Where the tracker is served from; what `IssueRef.host` carries for its issues. */
  host: Schema.NullOr(TrimmedNonEmptyString),
  /** What the tracker calls its container, in the singular: "team" on Linear, "project" on Jira. */
  scopeNoun: TrimmedNonEmptyString,
  credential: Schema.Struct({
    /** What the tracker calls the credential: "Personal API key", "API token". */
    label: TrimmedNonEmptyString,
    /** Where to mint one, or null when the tracker has no stable page for it. */
    helpUrl: Schema.NullOr(TrimmedNonEmptyString),
    fields: Schema.optional(
      Schema.Array(
        Schema.Struct({
          key: TrimmedNonEmptyString,
          label: TrimmedNonEmptyString,
          secret: Schema.Boolean,
          optional: Schema.optional(Schema.Boolean),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    ),
  }),
});
export type StandaloneIssueTrackerDescriptor = typeof StandaloneIssueTrackerDescriptor.Type;

/** Which standalone tracker scope a project's issues come from, beside its git host's own. */
export const IssueTrackerProjectBinding = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  tracker: IssueTrackerKind,
  scope: TrimmedNonEmptyString,
  host: Schema.optional(TrimmedNonEmptyString),
});
export type IssueTrackerProjectBinding = typeof IssueTrackerProjectBinding.Type;

/** One container the connected account can read, offered when a project is bound. */
export const IssueTrackerScope = Schema.Struct({
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type IssueTrackerScope = typeof IssueTrackerScope.Type;

export const IssueTrackerScopePage = Schema.Struct({
  items: Schema.Array(IssueTrackerScope),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
});
export type IssueTrackerScopePage = typeof IssueTrackerScopePage.Type;

export const IssueTrackerScopesInput = Schema.Struct({
  tracker: IssueTrackerKind,
  connectionId: Schema.optional(IssueTrackerConnectionId),
  cursor: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type IssueTrackerScopesInput = typeof IssueTrackerScopesInput.Type;

/**
 * A standalone tracker as the settings page sees it: the descriptor, whether a credential is
 * stored and still works, and the scopes it can reach. `scopes` is empty until connected.
 */
export const IssueTrackerConnection = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  ...StandaloneIssueTrackerDescriptor.fields,
  /** A credential is stored. It may still be rejected, which `account` being null reports. */
  connected: Schema.Boolean,
  /** Who the credential signs in as, or null when there is none or it was refused. */
  account: Schema.NullOr(TrimmedNonEmptyString),
  /** Why a stored credential did not work, when it did not. */
  detail: Schema.NullOr(TrimmedNonEmptyString),
  scopes: Schema.Array(IssueTrackerScope),
  scopesTruncated: Schema.optional(Schema.Boolean),
  scopesCursor: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type IssueTrackerConnection = typeof IssueTrackerConnection.Type;

export const IssueTrackerConnectionList = Schema.Struct({
  accounts: Schema.optional(Schema.Array(IssueTrackerConnection)),
  projectBindings: Schema.optional(
    Schema.Record(ProjectId, Schema.Array(IssueTrackerProjectBinding)),
  ),
  trackers: Schema.Array(IssueTrackerConnection),
  /** Which standalone tracker scope each bound project reads; a project absent here reads none. */
  bindings: Schema.Record(ProjectId, IssueTrackerProjectBinding),
});
export type IssueTrackerConnectionList = typeof IssueTrackerConnectionList.Type;

/** A credential for one standalone tracker; `null` disconnects it and unbinds its projects. */
export const IssueTrackerConnectInput = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  addAccount: Schema.optional(Schema.Boolean),
  tracker: IssueTrackerKind,
  token: Schema.Union([
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
    Schema.Struct({ value: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))) }),
  ]),
});
export type IssueTrackerConnectInput = typeof IssueTrackerConnectInput.Type;

export const IssueTrackerBindProjectInput = Schema.Struct({
  connectionId: Schema.optional(IssueTrackerConnectionId),
  tracker: Schema.optional(IssueTrackerKind),
  projectId: ProjectId,
  /** Null unbinds. */
  binding: Schema.Union([
    Schema.NullOr(IssueTrackerProjectBinding),
    Schema.Struct({ value: Schema.NullOr(IssueTrackerProjectBinding) }),
  ]),
});
export type IssueTrackerBindProjectInput = typeof IssueTrackerBindProjectInput.Type;

/**
 * A standalone tracker the connect flow could not reach or that refused the credential, or a
 * binding that could not be saved.
 */
export class IssueTrackerConnectionError extends Schema.TaggedError<IssueTrackerConnectionError>()(
  "IssueTrackerConnectionError",
  {
    tracker: IssueTrackerKind,
    reason: Schema.Literals(["unknown-tracker", "rejected", "failed"]),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(IssueTrackerConnectionError)(this, { status: 502 });
  }

  override get message(): string {
    return `${this.tracker} connection failed: ${this.detail}`;
  }
}
