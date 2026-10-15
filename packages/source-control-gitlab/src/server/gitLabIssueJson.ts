/**
 * Decoders for GitLab issues as `glab api` answers them. REST enums are decoded as plain strings
 * and normalized here, so a GitLab release that adds a state or a label action never fails a
 * whole payload; a row that cannot be read is skipped rather than failing its page.
 *
 * @module source-control-gitlab/server/gitLabIssueJson
 */
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  IssueActor,
  IssueAssigneeCandidate,
  IssueComment,
  IssueEvent,
  IssueEventKind,
  IssueLabel,
  IssueLabelCandidate,
  IssueReactionContent,
  IssueLinkedPullRequest,
  IssueTemplate,
  IssueViewerPermissions,
  PullRequestState,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import type { TrackerIssueSummary } from "@t3tools/issue-tracker-core/server/IssueTracker";
import { decodeAwardEmojiJson, decodeOwnAwardIdJson } from "./gitLabMergeRequestJson.ts";

/** GitLab's ceiling on `per_page`, which is what every bounded read asks for. */
export const PAGE_SIZE = 100;

const RawUserSchema = Schema.Struct({
  /** GitLab writes an issue's assignees as numeric ids, so the id travels with the handle. */
  id: Schema.optional(Schema.Int),
  username: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawIssueSchema = Schema.Struct({
  iid: Schema.Int,
  title: Schema.String,
  web_url: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RawUserSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  user_notes_count: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RawLabelEventSchema = Schema.Struct({
  id: Schema.Int,
  action: Schema.String,
  created_at: Schema.String,
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  /** Null once the label itself has been deleted, which leaves the event with no subject. */
  label: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) }))),
});

const RawLinkedMergeRequestSchema = Schema.Struct({
  iid: Schema.Int,
  title: Schema.String,
  web_url: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  work_in_progress: Schema.optional(Schema.Boolean),
  /** `full` is `group/project!12`, which is the only place the merge request names its project. */
  references: Schema.optional(
    Schema.NullOr(Schema.Struct({ full: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const RawProjectLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

/** A row of `GET /projects/:id/templates/issues`, which names a template but carries none of it. */
const RawTemplateEntrySchema = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/\S/)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawTemplateSchema = Schema.Struct({ content: Schema.String });

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeIssue = decodeJsonResult(RawIssueSchema);
const decodeIssueEntry = Schema.decodeUnknownExit(RawIssueSchema);
const decodeLabelEventEntry = Schema.decodeUnknownExit(RawLabelEventSchema);
const decodeLinkedMergeRequestEntry = Schema.decodeUnknownExit(RawLinkedMergeRequestSchema);
const decodeProjectLabelEntry = Schema.decodeUnknownExit(RawProjectLabelSchema);
const decodeUserEntry = Schema.decodeUnknownExit(RawUserSchema);
const decodeTemplateEntry = Schema.decodeUnknownExit(RawTemplateEntrySchema);
const decodeTemplateEntries = decodeJsonResult(Schema.Array(RawTemplateEntrySchema));
const decodeTemplate = decodeJsonResult(RawTemplateSchema);

type DecodeFailure =
  ReturnType<typeof decodeIssue> extends Result.Result<unknown, infer E> ? E : never;

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function toActor(raw: typeof RawUserSchema.Type | null | undefined): IssueActor | null {
  const login = trimmed(raw?.username);
  return login === null
    ? null
    : {
        ...(raw?.id === undefined ? {} : { id: String(raw.id) }),
        login,
        name: trimmed(raw?.name),
        avatarUrl: trimmed(raw?.avatar_url),
      };
}

/** GitLab returns label names only on an issue, so there is no colour to carry. */
function toLabels(raw: ReadonlyArray<string> | null | undefined): ReadonlyArray<IssueLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label);
    return name === null ? [] : [{ name, color: null }];
  });
}

function toSummary(raw: typeof RawIssueSchema.Type): TrackerIssueSummary {
  return {
    key: String(raw.iid),
    displayKey: `#${raw.iid}`,
    title: raw.title,
    url: raw.web_url,
    author: toActor(raw.author),
    // GitLab has exactly the two states, calls the open one `opened`, and records no reason.
    state:
      raw.state?.trim().toLowerCase() === "closed"
        ? { category: "closed", name: "closed" }
        : { category: "open", name: "open" },
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: trimmed(raw.closed_at),
    assignees: (raw.assignees ?? []).flatMap((user) => toActor(user) ?? []),
    labels: toLabels(raw.labels),
    commentCount: Math.max(0, raw.user_notes_count ?? 0),
  };
}

interface GitLabIssueList {
  readonly items: ReadonlyArray<TrackerIssueSummary>;
  /** Rows GitLab returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

export function decodeIssueListJson(raw: string): Result.Result<GitLabIssueList, DecodeFailure> {
  return Result.map(decodeUnknownList(raw), (rows) => ({
    items: rows.flatMap((entry) => {
      const issue = decodeIssueEntry(entry);
      return Exit.isSuccess(issue) ? [toSummary(issue.value)] : [];
    }),
    rawCount: rows.length,
  }));
}

interface GitLabIssueDetail extends TrackerIssueSummary {
  readonly body: string;
}

export function decodeIssueDetailJson(
  raw: string,
): Result.Result<GitLabIssueDetail, DecodeFailure> {
  return Result.map(decodeIssue(raw), (issue) => ({
    ...toSummary(issue),
    body: issue.description ?? "",
  }));
}

export function decodeCreatedIssueJson(
  raw: string,
): Result.Result<
  { readonly number: number; readonly url: string; readonly assigneeIds: ReadonlyArray<string> },
  DecodeFailure
> {
  return Result.map(decodeIssue(raw), (issue) => ({
    number: issue.iid,
    url: issue.web_url,
    assigneeIds: (issue.assignees ?? []).flatMap((actor) =>
      actor.id === undefined ? [] : [String(actor.id)],
    ),
  }));
}

/**
 * The events GitLab records as notes of its own. A label note names its labels by id ("added ~7
 * label"), which is why labellings come from `/resource_label_events` instead and are dropped here.
 */
function toSystemEvent(
  body: string,
): { readonly kind: IssueEventKind; readonly detail: string | null } | null {
  const text = body.trim();
  if (text === "closed") return { kind: "closed", detail: null };
  if (text === "reopened") return { kind: "reopened", detail: null };
  if (text.startsWith("assigned to ")) {
    return {
      kind: "assigned",
      detail: trimmed(text.slice("assigned to ".length).replace(/^@/, "")),
    };
  }
  if (text.startsWith("unassigned ")) {
    return {
      kind: "unassigned",
      detail: trimmed(text.slice("unassigned ".length).replace(/^@/, "")),
    };
  }
  if (text.startsWith("mentioned in ")) {
    return { kind: "referenced", detail: trimmed(text.slice("mentioned in ".length)) };
  }
  if (text.startsWith("changed title")) {
    // GitLab marks the new title with its own inline-diff braces.
    return { kind: "renamed", detail: trimmed(/\{\+(.+)\+\}/.exec(text)?.[1]) };
  }
  return null;
}

interface GitLabIssueNotes {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly events: ReadonlyArray<IssueEvent>;
}

function toIssueNotes(
  rows: ReadonlyArray<typeof RawGraphNoteSchema.Type | null>,
): GitLabIssueNotes {
  const comments: IssueComment[] = [];
  const events: IssueEvent[] = [];
  for (const note of rows) {
    if (note === null) continue;
    const id = nativeId(note.id);
    if (id === undefined) continue;
    const body = note.body ?? "";
    const author = toActor(
      note.author === undefined || note.author === null
        ? note.author
        : {
            id: nativeId(note.author.id),
            username: note.author.username,
            name: note.author.name,
            avatar_url: note.author.avatarUrl,
          },
    );
    if (note.system === true) {
      const event = toSystemEvent(body);
      if (event === null) continue;
      events.push({
        id: `note-${id}`,
        kind: event.kind,
        actor: author,
        createdAt: note.createdAt,
        detail: event.detail,
      });
      continue;
    }
    comments.push({
      id: String(id),
      author,
      body,
      createdAt: note.createdAt,
      url: null,
    });
  }
  return { comments, events };
}

export function decodeLabelEventsJson(
  raw: string,
): Result.Result<
  { readonly events: ReadonlyArray<IssueEvent>; readonly rawCount: number },
  DecodeFailure
> {
  return Result.map(decodeUnknownList(raw), (rows) => ({
    rawCount: rows.length,
    events: rows.flatMap((entry) => {
      const event = decodeLabelEventEntry(entry);
      if (Exit.isFailure(event)) return [];
      const action = event.value.action.trim().toLowerCase();
      if (action !== "add" && action !== "remove") return [];
      return [
        {
          id: `label-${event.value.id}`,
          kind: action === "add" ? ("labeled" as const) : ("unlabeled" as const),
          actor: toActor(event.value.user),
          createdAt: event.value.created_at,
          detail: trimmed(event.value.label?.name),
        },
      ];
    }),
  }));
}

function toPullRequestState(value: string | null | undefined): PullRequestState {
  switch (value?.trim().toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      // `locked` is an open merge request whose discussion is locked.
      return "open";
  }
}

export function decodeLinkedMergeRequestsJson(
  raw: string,
  closesIssue: boolean,
): Result.Result<ReadonlyArray<IssueLinkedPullRequest>, DecodeFailure> {
  return Result.map(decodeUnknownList(raw), (rows) =>
    rows.flatMap((entry) => {
      const mergeRequest = decodeLinkedMergeRequestEntry(entry);
      if (Exit.isFailure(mergeRequest)) return [];
      const value = mergeRequest.value;
      const repository = trimmed(value.references?.full?.split("!")[0]);
      const title = trimmed(value.title);
      const url = trimmed(value.web_url);
      if (repository === null || title === null || url === null || value.iid <= 0) return [];
      return [
        {
          repository,
          number: value.iid,
          title,
          url,
          state: toPullRequestState(value.state),
          isDraft: value.draft ?? value.work_in_progress ?? false,
          closesIssue,
        },
      ];
    }),
  );
}

export function decodeProjectLabelsJson(
  raw: string,
): Result.Result<ReadonlyArray<IssueLabelCandidate>, DecodeFailure> {
  return Result.map(decodeUnknownList(raw), (rows) =>
    rows.flatMap((entry) => {
      const label = decodeProjectLabelEntry(entry);
      if (Exit.isFailure(label)) return [];
      const name = trimmed(label.value.name);
      return name === null
        ? []
        : [
            {
              name,
              color: trimmed(label.value.color),
              description: label.value.description ?? null,
            },
          ];
    }),
  );
}

/**
 * The people with access to the project as assignees. GitLab addresses an assignment by numeric
 * id and by nothing else, so a member it named no id for is dropped rather than offered under a
 * handle the write would discard.
 */
export function decodeProjectMembersJson(
  raw: string,
): Result.Result<ReadonlyArray<IssueAssigneeCandidate>, DecodeFailure> {
  return Result.map(decodeUnknownList(raw), (rows) =>
    rows.flatMap((entry) => {
      const user = decodeUserEntry(entry);
      if (Exit.isFailure(user) || user.value.id === undefined) return [];
      const actor = toActor(user.value);
      return actor === null ? [] : [{ ...actor, id: String(user.value.id) }];
    }),
  );
}

export interface GitLabTemplateEntry {
  readonly key: string;
  readonly name: string;
}

export function decodeTemplateEntriesJson(
  raw: string,
  strict = false,
): Result.Result<ReadonlyArray<GitLabTemplateEntry>, DecodeFailure> {
  return Result.map(strict ? decodeTemplateEntries(raw) : decodeUnknownList(raw), (rows) =>
    rows.flatMap((entry) => {
      const template = decodeTemplateEntry(entry);
      if (Exit.isFailure(template)) return [];
      const key = trimmed(template.value.key);
      return key === null ? [] : [{ key, name: trimmed(template.value.name) ?? key }];
    }),
  );
}

/** One template's own answer is the markdown a description starts out as; GitLab adds nothing else. */
export function decodeTemplateJson(
  entry: GitLabTemplateEntry,
  raw: string,
): Result.Result<IssueTemplate, DecodeFailure> {
  return Result.map(decodeTemplate(raw), (template) => ({
    key: entry.key,
    name: entry.name,
    about: "",
    title: "",
    body: template.content,
    labels: [],
    assignees: [],
  }));
}

const ISSUE_PERMISSION_FIELDS =
  "state userPermissions { updateIssue reopenIssue createNote adminIssue }";

export const ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    archived
    mergeRequest: issue(iid: $iid) { ${ISSUE_PERMISSION_FIELDS} }
  }
}`;

const RawIssuePermissionsSchema = Schema.Struct({
  state: Schema.String,
  userPermissions: Schema.Struct({
    updateIssue: Schema.Boolean,
    reopenIssue: Schema.Boolean,
    createNote: Schema.Boolean,
    adminIssue: Schema.Boolean,
  }),
});
const RawIssueAccessSchema = Schema.Struct({
  archived: Schema.Boolean,
  mergeRequest: RawIssuePermissionsSchema,
});
const decodeIssueAccess = decodeJsonResult(
  Schema.Struct({ data: Schema.Struct({ project: RawIssueAccessSchema }) }),
);

function toViewerPermissions(project: typeof RawIssueAccessSchema.Type): IssueViewerPermissions {
  const writable = !project.archived;
  const permission = project.mergeRequest.userPermissions;
  return {
    edit: writable && permission.updateIssue,
    setState:
      writable &&
      (project.mergeRequest.state === "closed" ? permission.reopenIssue : permission.updateIssue),
    comment: writable && permission.createNote,
    labels: writable && permission.adminIssue,
    assignees: writable && permission.adminIssue,
  };
}

export function decodeIssueViewerPermissionsJson(raw: string) {
  return Result.map(decodeIssueAccess(raw), ({ data }) => toViewerPermissions(data.project));
}

export const decodeIssueUpdatedMetadataJson = decodeJsonResult(
  Schema.Struct({
    labels: Schema.optional(Schema.Array(Schema.String)),
    assignees: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Int }))),
  }),
);

export const ISSUE_AWARD_EMOJI_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!, $cursor: String) {
  currentUser { username }
  project(fullPath: $fullPath) {
    archived
    mergeRequest: issue(iid: $iid) {
      ${ISSUE_PERMISSION_FIELDS}
      notes(last: ${PAGE_SIZE}, before: $cursor) {
        pageInfo { hasPreviousPage startCursor }
        nodes {
          id body createdAt system
          author { id username name avatarUrl }
          awardEmoji(first: ${PAGE_SIZE}) { pageInfo { hasNextPage } nodes { name user { username } } }
        }
      }
    }
  }
}`;

const RawAwardPageInfoSchema = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      pageInfo: Schema.optional(Schema.Struct({ hasNextPage: Schema.Boolean })),
    }),
  ),
);
const RawGraphNoteSchema = Schema.Struct({
  id: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  system: Schema.optional(Schema.Boolean),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        username: Schema.String,
        name: Schema.optional(Schema.NullOr(Schema.String)),
        avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  awardEmoji: RawAwardPageInfoSchema,
});
const decodeIssueAwardPage = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      currentUser: Schema.Struct({ username: Schema.String.check(Schema.isPattern(/\S/)) }),
      project: Schema.Struct({
        archived: Schema.Boolean,
        mergeRequest: Schema.Struct({
          ...RawIssuePermissionsSchema.fields,
          notes: Schema.Struct({
            pageInfo: Schema.Struct({
              hasPreviousPage: Schema.Boolean,
              startCursor: Schema.NullOr(Schema.String),
            }),
            nodes: Schema.Array(Schema.NullOr(RawGraphNoteSchema)),
          }),
        }),
      }),
    }),
  }),
);

export const decodeIssueAwardsJson = decodeJsonResult(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      user: Schema.optional(Schema.NullOr(Schema.Struct({ username: Schema.String }))),
    }),
  ),
);

function nativeId(id: string | undefined): number | undefined {
  const value = id?.split("/").at(-1);
  return value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

export function decodeIssueAwardPageJson(raw: string) {
  return Result.flatMap(decodeIssueAwardPage(raw), ({ data }) =>
    Result.map(decodeAwardEmojiJson(raw), (awards) => {
      const issue = data.project.mergeRequest;
      const notes = toIssueNotes(issue.notes.nodes);
      const partialNotes = new Set(
        issue.notes.nodes.flatMap((note) =>
          note?.awardEmoji?.pageInfo?.hasNextPage === true ? [String(nativeId(note.id))] : [],
        ),
      );
      return {
        ...awards,
        viewer: data.currentUser.username.trim(),
        viewerPermissions: toViewerPermissions(data.project),
        nextCursor:
          issue.notes.pageInfo.hasPreviousPage === true
            ? trimmed(issue.notes.pageInfo.startCursor)
            : null,
        events: notes.events,
        comments: notes.comments.map((comment) => ({
          ...comment,
          reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
          ...(partialNotes.has(comment.id) ? { reactionsTruncated: true } : {}),
        })),
      };
    }),
  );
}

export function decodeIssueOwnAwardPageJson(
  raw: string,
  input: { readonly content: IssueReactionContent; readonly viewer: string },
) {
  return Result.flatMap(decodeUnknownList(raw), (rows) =>
    Result.map(decodeOwnAwardIdJson(raw, input), (id) => ({ id, rawCount: rows.length })),
  );
}
