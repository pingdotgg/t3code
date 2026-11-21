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
  IssueLinkedPullRequest,
  IssueProperty,
  IssueState,
  IssueTemplate,
  PullRequestState,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import {
  issueProperties,
  type TrackerIssueDetail,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

/** GitLab's ceiling on `per_page`, which is what every bounded read asks for. */
export const PAGE_SIZE = 100;

const RawUserSchema = Schema.Struct({
  /** GitLab writes an issue's assignees as numeric ids, so the id travels with the handle. */
  id: Schema.optional(Schema.Int),
  username: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

/** `with_labels_details=true` returns label objects; hosts that ignore it still send names. */
const RawLabelRefSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    name: Schema.String,
    color: Schema.optional(Schema.NullOr(Schema.String)),
    description: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);

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
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawLabelRefSchema))),
  user_notes_count: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RawTitledSchema = Schema.NullOr(
  Schema.Struct({ title: Schema.optional(Schema.NullOr(Schema.String)) }),
);

/**
 * The fields a detail shows beyond its row. Several exist only on paid tiers, and a key GitLab
 * leaves out is left out of the properties rather than shown as unset.
 */
const RawIssueDetailSchema = Schema.Struct({
  ...RawIssueSchema.fields,
  issue_type: Schema.optional(Schema.NullOr(Schema.String)),
  milestone: Schema.optional(RawTitledSchema),
  iteration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        title: Schema.optional(Schema.NullOr(Schema.String)),
        start_date: Schema.optional(Schema.NullOr(Schema.String)),
        due_date: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  epic: Schema.optional(RawTitledSchema),
  due_date: Schema.optional(Schema.NullOr(Schema.String)),
  weight: Schema.optional(Schema.NullOr(Schema.Number)),
  health_status: Schema.optional(Schema.NullOr(Schema.String)),
  time_stats: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        human_time_estimate: Schema.optional(Schema.NullOr(Schema.String)),
        human_total_time_spent: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  confidential: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const RawNoteSchema = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_at: Schema.String,
  /** True for the notes GitLab writes itself ("closed", "assigned to @x"), which are events. */
  system: Schema.optional(Schema.Boolean),
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
  key: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawTemplateSchema = Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) });

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeIssue = decodeJsonResult(RawIssueSchema);
const decodeIssueDetailList = decodeJsonResult(Schema.Array(RawIssueDetailSchema));
const decodeIssueEntry = Schema.decodeUnknownExit(RawIssueSchema);
const decodeNoteEntry = Schema.decodeUnknownExit(RawNoteSchema);
const decodeLabelEventEntry = Schema.decodeUnknownExit(RawLabelEventSchema);
const decodeLinkedMergeRequestEntry = Schema.decodeUnknownExit(RawLinkedMergeRequestSchema);
const decodeProjectLabelEntry = Schema.decodeUnknownExit(RawProjectLabelSchema);
const decodeUserEntry = Schema.decodeUnknownExit(RawUserSchema);
const decodeTemplateEntry = Schema.decodeUnknownExit(RawTemplateEntrySchema);
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
    : { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatar_url) };
}

function toLabels(
  raw: ReadonlyArray<typeof RawLabelRefSchema.Type> | null | undefined,
): ReadonlyArray<IssueLabel> {
  return (raw ?? []).flatMap((label): ReadonlyArray<IssueLabel> => {
    if (typeof label === "string") {
      const name = trimmed(label);
      return name === null ? [] : [{ name, color: null }];
    }
    const name = trimmed(label.name);
    return name === null
      ? []
      : [{ name, color: trimmed(label.color), description: trimmed(label.description) }];
  });
}

const OPEN: IssueState = { category: "open", name: "Open" };
const CLOSED: IssueState = { category: "closed", name: "Closed" };

/** GitLab has exactly the two states and records no reason for a close. */
export const ISSUE_STATES: ReadonlyArray<IssueState> = [OPEN, CLOSED];

function toSummary(raw: typeof RawIssueSchema.Type): TrackerIssueSummary {
  return {
    key: String(raw.iid),
    displayKey: `#${raw.iid}`,
    title: raw.title,
    url: raw.web_url,
    author: toActor(raw.author),
    // GitLab calls the open one `opened`.
    state: raw.state?.trim().toLowerCase() === "closed" ? CLOSED : OPEN,
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

type GitLabIssueDetail = TrackerIssueSummary & Pick<TrackerIssueDetail, "body" | "properties">;

/** `health_status` and `issue_type` are snake_case words: `needs_attention` reads "Needs attention". */
function words(value: string | null | undefined): string | null {
  const text = trimmed(value?.replaceAll("_", " "));
  return text === null ? null : text.charAt(0).toUpperCase() + text.slice(1);
}

function toProperties(raw: typeof RawIssueDetailSchema.Type): ReadonlyArray<IssueProperty> {
  const { iteration, time_stats: time } = raw;
  const fields: ReadonlyArray<readonly [keyof typeof raw, IssueProperty]> = [
    ["issue_type", { id: "issue_type", label: "Type", value: words(raw.issue_type) }],
    ["milestone", { id: "milestone", label: "Milestone", value: trimmed(raw.milestone?.title) }],
    [
      "iteration",
      {
        id: "iteration",
        label: "Iteration",
        // An iteration in a cadence has no title of its own, only its dates.
        value: iteration
          ? (trimmed(iteration.title) ??
            trimmed([iteration.start_date, iteration.due_date].filter(Boolean).join(" – ")))
          : null,
      },
    ],
    ["epic", { id: "epic", label: "Epic", value: trimmed(raw.epic?.title) }],
    ["due_date", { id: "due_date", label: "Due date", value: trimmed(raw.due_date) }],
    ["weight", { id: "weight", label: "Weight", value: raw.weight ?? null }],
    [
      "health_status",
      { id: "health_status", label: "Health status", value: words(raw.health_status) },
    ],
    [
      "time_stats",
      { id: "time_estimate", label: "Time estimate", value: trimmed(time?.human_time_estimate) },
    ],
    [
      "time_stats",
      { id: "time_spent", label: "Time spent", value: trimmed(time?.human_total_time_spent) },
    ],
    [
      "confidential",
      { id: "confidential", label: "Confidential", value: raw.confidential ?? null },
    ],
  ];
  return fields.flatMap(([key, property]) => (raw[key] === undefined ? [] : [property]));
}

/** GitLab's GET /issues/:iid ignores `with_labels_details`, so the detail is read as an `iids[]` list. */
export function decodeIssueDetailListJson(
  raw: string,
): Result.Result<GitLabIssueDetail | null, DecodeFailure> {
  return Result.map(decodeIssueDetailList(raw), ([issue]) => {
    if (issue === undefined) return null;
    const summary = toSummary(issue);
    return {
      ...summary,
      body: issue.description ?? "",
      properties: issueProperties(summary, toProperties(issue)),
    };
  });
}

/** The ids of the users a `/users?username=` lookup answered with: one, or none. */
export function decodeUserIdsJson(
  raw: string,
): Result.Result<ReadonlyArray<number>, DecodeFailure> {
  return Result.map(decodeUnknownList(raw), (rows) =>
    rows.flatMap((entry) => {
      const user = decodeUserEntry(entry);
      return Exit.isSuccess(user) && user.value.id !== undefined ? [user.value.id] : [];
    }),
  );
}

export function decodeCreatedIssueJson(
  raw: string,
): Result.Result<{ readonly number: number; readonly url: string }, DecodeFailure> {
  return Result.map(decodeIssue(raw), (issue) => ({ number: issue.iid, url: issue.web_url }));
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
  readonly rawCount: number;
}

/** One page of notes, split into what people wrote and what GitLab wrote about the issue. */
export function decodeIssueNotesJson(raw: string): Result.Result<GitLabIssueNotes, DecodeFailure> {
  return Result.map(decodeUnknownList(raw), (rows) => {
    const comments: IssueComment[] = [];
    const events: IssueEvent[] = [];
    for (const entry of rows) {
      const note = decodeNoteEntry(entry);
      if (Exit.isFailure(note)) continue;
      const value = note.value;
      const body = value.body ?? "";
      if (value.system === true) {
        const event = toSystemEvent(body);
        if (event === null) continue;
        events.push({
          // Notes and label events are numbered separately, so each carries where it came from.
          id: `note-${value.id}`,
          kind: event.kind,
          actor: toActor(value.author),
          createdAt: value.created_at,
          detail: event.detail,
        });
        continue;
      }
      comments.push({
        id: String(value.id),
        author: toActor(value.author),
        body,
        createdAt: value.created_at,
        url: null,
      });
    }
    return { comments, events, rawCount: rows.length };
  });
}

export function decodeLabelEventsJson(
  raw: string,
): Result.Result<ReadonlyArray<IssueEvent>, DecodeFailure> {
  return Result.map(decodeUnknownList(raw), (rows) =>
    rows.flatMap((entry) => {
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
  );
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
): Result.Result<ReadonlyArray<GitLabTemplateEntry>, DecodeFailure> {
  return Result.map(decodeUnknownList(raw), (rows) =>
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
    body: template.content ?? "",
    labels: [],
    assignees: [],
  }));
}

/**
 * Awards on every note of the issue, shaped like the merge request query so its decoder answers
 * for both: `mergeRequest` is an alias for the issue field. GitLab's `Issue` type has no
 * `awardEmoji`, so the issue's own awards are read from REST `award_emoji` instead.
 */
export const ISSUE_AWARD_EMOJI_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!, $cursor: String) {
  currentUser { username }
  project(fullPath: $fullPath) {
    mergeRequest: issue(iid: $iid) {
      notes(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id awardEmoji { nodes { name user { username } } } }
      }
    }
  }
}`;
