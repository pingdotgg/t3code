/**
 * Decoders for Azure DevOps work items as `az boards` and the `wit` REST area answer them. Azure
 * keeps everything under `fields`, keyed by reference name, and a project may add fields of its
 * own, so only the ones every work item type carries are read.
 *
 * @module source-control-azure-devops/server/azureDevOpsIssueJson
 */
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  IssueActor,
  IssueComment,
  IssueEvent,
  IssueLabel,
  IssueReaction,
  IssueReactionContent,
  IssueRichBody,
  IssueState,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import type { TrackerIssueSummary } from "@t3tools/issue-tracker-core/server/IssueTracker";

/**
 * The states Azure's stock processes treat as finished. A project may rename its own columns, so
 * anything not named here reads as open: an item wrongly shown as open is one the reader can
 * still close, while one wrongly shown as closed disappears from the list they were looking at.
 */
const CLOSED_STATES: ReadonlySet<string> = new Set([
  "closed",
  "done",
  "removed",
  "resolved",
  "completed",
]);

const Identity = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

/** WIQL answers an identity as an object; a project rule can leave a plain "Name <email>" string. */
const IdentityValue = Schema.NullOr(Schema.Union([Identity, Schema.String]));

const Fields = Schema.Struct({
  "System.CommentCount": Schema.optional(Schema.NullOr(Schema.Int)),
  "System.WorkItemType": Schema.optional(Schema.NullOr(Schema.String)),
  "System.Title": Schema.optional(Schema.NullOr(Schema.String)),
  "System.State": Schema.optional(Schema.NullOr(Schema.String)),
  "System.CreatedDate": Schema.optional(Schema.NullOr(Schema.String)),
  "System.ChangedDate": Schema.optional(Schema.NullOr(Schema.String)),
  "Microsoft.VSTS.Common.ClosedDate": Schema.optional(Schema.NullOr(Schema.String)),
  "System.Description": Schema.optional(Schema.NullOr(Schema.String)),
  "System.Tags": Schema.optional(Schema.NullOr(Schema.String)),
  "System.TeamProject": Schema.optional(Schema.NullOr(Schema.String)),
  "System.CreatedBy": Schema.optional(IdentityValue),
  "System.AssignedTo": Schema.optional(IdentityValue),
});

const Relation = Schema.Struct({ rel: Schema.String, url: Schema.String });

const WorkItem = Schema.Struct({
  rev: Schema.optional(Schema.Int),
  multilineFieldsFormat: Schema.optional(Schema.Unknown),
  id: Schema.Int,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  fields: Schema.optional(Schema.NullOr(Fields)),
  relations: Schema.optional(Schema.NullOr(Schema.Array(Relation))),
});

const decodeWorkItemEntry = Schema.decodeUnknownExit(WorkItem);
const decodeWorkItemsPage = decodeJsonResult(
  Schema.Struct({ value: Schema.Array(Schema.Unknown) }),
);
const decodeWorkItem = decodeJsonResult(WorkItem);

type DecodeFailure =
  ReturnType<typeof decodeWorkItem> extends Result.Result<unknown, infer E> ? E : never;

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * The organization link `az` returns addresses the REST resource, which is not a page anybody can
 * open. The one a reader wants is the board's own item, which Azure spells this way.
 */
function browserUrl(
  apiUrl: string | null | undefined,
  id: number,
  project: string | null,
): string | null {
  if (apiUrl === null || apiUrl === undefined || project === null) return null;
  const url = URL.parse(apiUrl);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const match = (
    url.hostname.endsWith(".visualstudio.com")
      ? /^\/(DefaultCollection\/)?(?:[^/]+\/)?_apis\/wit\/workItems\//i
      : /^\/([^/]+\/)(?:[^/]+\/)?_apis\/wit\/workItems\//i
  ).exec(url.pathname);
  return match === null
    ? null
    : `${url.origin}/${match[1] ?? ""}${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

function toActor(value: typeof IdentityValue.Type | undefined): IssueActor | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const login = trimmed(value);
    return login === null ? null : { login, name: null, avatarUrl: null };
  }
  const login = trimmed(value.uniqueName) ?? trimmed(value.displayName);
  return login === null
    ? null
    : { login, name: trimmed(value.displayName), avatarUrl: trimmed(value.imageUrl) };
}

function toIssueState(name: string | null | undefined): IssueState {
  const state = trimmed(name) ?? "New";
  return { category: CLOSED_STATES.has(state.toLowerCase()) ? "closed" : "open", name: state };
}

/** Azure keeps tags as one `; `-separated string, with no colour anywhere. */
function toLabels(tags: string | null | undefined): ReadonlyArray<IssueLabel> {
  return [...new Set((tags ?? "").split(";").flatMap((tag) => trimmed(tag) ?? []))].map((name) => ({
    name,
    color: null,
  }));
}

export interface AzureDevOpsWorkItem extends TrackerIssueSummary {
  readonly body: string;
  readonly bodyFormat: "html" | "markdown" | null;
  readonly richBody?: IssueRichBody;
  readonly bodyEditable: boolean;
  readonly workItemType: string | null;
  readonly revision: number | null;
  readonly nativeUrl: string | null;
  readonly project: string | null;
  readonly relations: ReadonlyArray<typeof Relation.Type>;
}

/** Null for a row this cannot place: no title, no dates, or no project to build a link from. */
function toWorkItem(raw: typeof WorkItem.Type): AzureDevOpsWorkItem | null {
  const fields = raw.fields ?? {};
  const title = trimmed(fields["System.Title"]);
  const createdAt = trimmed(fields["System.CreatedDate"]);
  const updatedAt = trimmed(fields["System.ChangedDate"]) ?? createdAt;
  const project = trimmed(fields["System.TeamProject"]);
  const url = browserUrl(raw.url, raw.id, project);
  if (raw.id <= 0 || title === null || createdAt === null || updatedAt === null || url === null) {
    return null;
  }
  const assignee = toActor(fields["System.AssignedTo"]);
  const body = fields["System.Description"] ?? "";
  const formats = raw.multilineFieldsFormat;
  const nativeFormat =
    formats === undefined
      ? "html"
      : typeof formats === "object" && formats !== null && !Array.isArray(formats)
        ? "System.Description" in formats
          ? formats["System.Description"]
          : "html"
        : null;
  const bodyFormat = textFormatOf(nativeFormat);
  const bodyEditable = bodyFormat !== null && body.length <= 65_536;
  return {
    key: String(raw.id),
    displayKey: `#${raw.id}`,
    title,
    url,
    author: toActor(fields["System.CreatedBy"]),
    state: toIssueState(fields["System.State"]),
    createdAt,
    updatedAt,
    closedAt: trimmed(fields["Microsoft.VSTS.Common.ClosedDate"]),
    assignees: assignee === null ? [] : [assignee],
    labels: toLabels(fields["System.Tags"]),
    commentCount: Math.max(0, fields["System.CommentCount"] ?? 0),
    body,
    bodyFormat,
    bodyEditable,
    ...(bodyFormat === "html" && bodyEditable
      ? { richBody: { format: "azure-html" as const, document: body } }
      : {}),
    workItemType: fields["System.WorkItemType"] ?? null,
    revision: raw.rev ?? null,
    nativeUrl: raw.url ?? null,
    project,
    relations: raw.relations ?? [],
  };
}

/** A flat WIQL answer; a row this cannot place is skipped rather than failing the page. */
export function decodeWorkItemsJson(
  raw: string,
): Result.Result<ReadonlyArray<AzureDevOpsWorkItem>, DecodeFailure> {
  return Result.map(decodeWorkItemsPage(raw), (page) =>
    page.value.flatMap((entry) => {
      const item = decodeWorkItemEntry(entry);
      if (Exit.isFailure(item)) return [];
      return toWorkItem(item.value) ?? [];
    }),
  );
}

const decodeWorkItemsBatch = decodeJsonResult(
  Schema.Struct({
    count: Schema.optional(Schema.Int),
    value: Schema.Array(WorkItem),
  }).check(
    Schema.makeFilter((page) => page.count === undefined || page.count === page.value.length),
  ),
);

export function decodeWorkItemsBatchJson(raw: string) {
  return Result.map(decodeWorkItemsBatch(raw), (page) => page.value.map(toWorkItem));
}

/** Null where az answered with a work item this cannot place, which the caller reports as such. */
export function decodeWorkItemJson(
  raw: string,
): Result.Result<AzureDevOpsWorkItem | null, DecodeFailure> {
  return Result.map(decodeWorkItem(raw), toWorkItem);
}

/** Azure names comment reactions after its own icons; the six it has map onto the contract's. */
const CONTENT_BY_REACTION: Readonly<Record<string, IssueReactionContent>> = {
  like: "thumbs-up",
  dislike: "thumbs-down",
  heart: "heart",
  hooray: "hooray",
  smile: "laugh",
  confused: "confused",
};

export function azureDevOpsReactionType(content: IssueReactionContent): string | null {
  return Object.entries(CONTENT_BY_REACTION).find(([, mapped]) => mapped === content)?.[0] ?? null;
}

const Comment = Schema.Struct({
  id: Schema.Int,
  format: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  createdDate: Schema.String,
  modifiedDate: Schema.optional(Schema.String),
  createdBy: Schema.optional(Schema.NullOr(Identity)),
  isDeleted: Schema.optional(Schema.Boolean),
  reactions: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          type: Schema.String,
          count: Schema.Int,
          isCurrentUserEngaged: Schema.optional(Schema.Boolean),
        }),
      ),
    ),
  ),
});

const CommentsPage = Schema.Struct({
  count: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  totalCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  comments: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  continuationToken: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeCommentsPage = decodeJsonResult(CommentsPage);
const decodeCommentEntry = Schema.decodeUnknownExit(Comment);
const decodeComment = decodeJsonResult(Comment);

function textFormatOf(format: unknown): "html" | "markdown" | null {
  if (format === 0 || (typeof format === "string" && format.toLowerCase() === "markdown"))
    return "markdown";
  if (format === 1 || (typeof format === "string" && format.toLowerCase() === "html"))
    return "html";
  return null;
}

export function decodeCommentFormatJson(raw: string) {
  return Result.map(decodeComment(raw), (comment) => ({
    id: String(comment.id),
    format: textFormatOf(comment.format),
    isDeleted: comment.isDeleted === true,
  }));
}

function toReactions(raw: (typeof Comment.Type)["reactions"]): ReadonlyArray<IssueReaction> {
  return (raw ?? []).flatMap((reaction) => {
    const content = CONTENT_BY_REACTION[reaction.type.toLowerCase()];
    return content === undefined || reaction.count <= 0
      ? []
      : [
          {
            content,
            count: reaction.count,
            // Azure counts reactions and says whether the reader is among them, but names nobody.
            actors: [],
            viewerHasReacted: reaction.isCurrentUserEngaged ?? false,
          },
        ];
  });
}

export function decodeCommentsJson(
  raw: string,
  viewer?: string,
): Result.Result<
  {
    readonly comments: ReadonlyArray<IssueComment>;
    readonly nextCursor: string | null;
    readonly rawCount: number;
    readonly rawIds: ReadonlyArray<number | null>;
    readonly count: number | undefined;
    readonly totalCount: number | undefined;
  },
  DecodeFailure
> {
  return Result.map(decodeCommentsPage(raw), (page) => ({
    count: page.count,
    totalCount: page.totalCount,
    rawCount: page.comments?.length ?? 0,
    rawIds: (page.comments ?? []).map((entry) => {
      const comment = decodeCommentEntry(entry);
      return Exit.isSuccess(comment) ? comment.value.id : null;
    }),
    comments: (page.comments ?? []).flatMap((entry) => {
      const comment = decodeCommentEntry(entry);
      if (Exit.isFailure(comment) || comment.value.isDeleted === true) return [];
      const body = comment.value.text ?? "";
      const format = textFormatOf(comment.value.format);
      const editable = format !== null && body.length <= 65_536;
      return [
        {
          id: String(comment.value.id),
          author: toActor(comment.value.createdBy),
          body,
          ...(format === "html" && editable
            ? { richBody: { format: "azure-html" as const, document: body } }
            : {}),
          createdAt: comment.value.createdDate,
          editedAt:
            comment.value.modifiedDate && comment.value.modifiedDate !== comment.value.createdDate
              ? comment.value.modifiedDate
              : null,
          canEdit: !editable
            ? false
            : viewer === undefined
              ? undefined
              : toActor(comment.value.createdBy)?.login.toLowerCase() === viewer.toLowerCase(),
          url: null,
          reactions: toReactions(comment.value.reactions),
        },
      ];
    }),
    nextCursor: trimmed(page.continuationToken),
  }));
}

const FieldChange = Schema.Struct({
  oldValue: Schema.optional(Schema.Unknown),
  newValue: Schema.optional(Schema.Unknown),
});

const encodeUpdate = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Update = Schema.Struct({
  relations: Schema.optional(Schema.Unknown),
  id: Schema.Int,
  revisedDate: Schema.String,
  revisedBy: Schema.optional(Schema.NullOr(Identity)),
  fields: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, FieldChange))),
});

const decodeUpdatesPage = decodeJsonResult(
  Schema.Struct({ value: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))) }),
);
const decodeUpdateEntry = Schema.decodeUnknownExit(Update);
const decodeIdentityValue = Schema.decodeUnknownExit(IdentityValue);

function identityLogin(value: unknown): string | null {
  const decoded = decodeIdentityValue(value);
  return Exit.isSuccess(decoded) ? (toActor(decoded.value)?.login ?? null) : null;
}

export function decodeUpdatesJson(
  raw: string,
  states?: ReadonlyArray<IssueState>,
  order: "asc" | "desc" = "asc",
): Result.Result<
  {
    readonly events: ReadonlyArray<IssueEvent>;
    readonly rawCount: number;
    readonly rawIds: ReadonlyArray<number | null>;
  },
  DecodeFailure
> {
  return Result.map(decodeUpdatesPage(raw), (page) => ({
    rawCount: page.value?.length ?? 0,
    rawIds: (page.value ?? []).map((entry) => {
      const update = decodeUpdateEntry(entry);
      return Exit.isSuccess(update) ? update.value.id : null;
    }),
    events: (order === "desc" ? (page.value ?? []).toReversed() : (page.value ?? [])).flatMap(
      (entry) => {
        const update = decodeUpdateEntry(entry);
        if (
          Exit.isFailure(update) ||
          (update.value.id === 1 && update.value.relations === undefined)
        )
          return [];
        const { id, revisedBy, revisedDate } = update.value;
        const fields = update.value.fields ?? {};
        const changedAt = fields["System.ChangedDate"]?.newValue;
        const createdAt = typeof changedAt === "string" ? changedAt : revisedDate;
        const events: IssueEvent[] = [];
        const add = (kind: IssueEvent["kind"], detail: string | null) =>
          events.push({
            id: `update-${id}-${events.length}`,
            kind,
            actor: toActor(revisedBy),
            createdAt,
            detail,
          });
        const state = fields["System.State"];
        if (typeof state?.oldValue === "string" && typeof state.newValue === "string") {
          const was = states?.find((candidate) => candidate.name === state.oldValue);
          const now = states?.find((candidate) => candidate.name === state.newValue);
          add(
            was === undefined || now === undefined || was.category === now.category
              ? "state-changed"
              : now.category === "closed"
                ? "closed"
                : "reopened",
            state.newValue,
          );
        }
        const title = fields["System.Title"];
        if (typeof title?.oldValue === "string" && typeof title.newValue === "string") {
          add("renamed", trimmed(title.newValue));
        }
        const tags = fields["System.Tags"];
        if (tags !== undefined) {
          const before = toLabels(typeof tags.oldValue === "string" ? tags.oldValue : null);
          const after = toLabels(typeof tags.newValue === "string" ? tags.newValue : null);
          for (const tag of before)
            if (!after.some((label) => label.name === tag.name)) add("unlabeled", tag.name);
          for (const tag of after)
            if (!before.some((label) => label.name === tag.name)) add("labeled", tag.name);
        }
        const assigned = fields["System.AssignedTo"];
        if (assigned !== undefined) {
          const before = identityLogin(assigned.oldValue);
          const after = identityLogin(assigned.newValue);
          if (before !== after) {
            if (before !== null) add("unassigned", before);
            if (after !== null) add("assigned", after);
          }
        }
        if (
          update.value.relations !== undefined ||
          Object.keys(fields).some(
            (name) =>
              ![
                "System.State",
                "System.Title",
                "System.Tags",
                "System.AssignedTo",
                "System.ChangedDate",
              ].includes(name),
          )
        )
          add(
            "updated",
            encodeUpdate({
              fields,
              ...(update.value.relations === undefined
                ? {}
                : { relations: update.value.relations }),
            }),
          );
        return events;
      },
    ),
  }));
}

/** A relation that links a pull request, as Azure spells it: `vstfs:///Git/PullRequestId/{project}/{repo}/{id}`. */
export function pullRequestNumberOf(relation: typeof Relation.Type): number | null {
  if (relation.rel !== "ArtifactLink") return null;
  const match = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/.exec(relation.url);
  if (match === null) return null;
  try {
    const number = decodeURIComponent(match[1]!).split("/").at(-1) ?? "";
    return /^[1-9]\d{0,9}$/.test(number) ? Number(number) : null;
  } catch {
    return null;
  }
}
