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
  id: Schema.Int,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  fields: Schema.optional(Schema.NullOr(Fields)),
  relations: Schema.optional(Schema.NullOr(Schema.Array(Relation))),
});

const decodeWorkItemEntry = Schema.decodeUnknownExit(WorkItem);
const decodeUnknownList = decodeJsonResult(Schema.NullOr(Schema.Array(Schema.Unknown)));
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
  const match = /^(https?:\/\/[^/]+\/[^/]+)\/(?:[^/]+\/)?_apis\/wit\/workItems\//i.exec(apiUrl);
  return match === null ? null : `${match[1]}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
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
    body: fields["System.Description"] ?? "",
    project,
    relations: raw.relations ?? [],
  };
}

/** A flat WIQL answer; a row this cannot place is skipped rather than failing the page. */
export function decodeWorkItemsJson(
  raw: string,
): Result.Result<ReadonlyArray<AzureDevOpsWorkItem>, DecodeFailure> {
  return Result.map(decodeUnknownList(raw.trim().length === 0 ? "[]" : raw), (rows) =>
    (rows ?? []).flatMap((entry) => {
      const item = decodeWorkItemEntry(entry);
      if (Exit.isFailure(item)) return [];
      return toWorkItem(item.value) ?? [];
    }),
  );
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
  text: Schema.optional(Schema.NullOr(Schema.String)),
  createdDate: Schema.String,
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
  comments: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  continuationToken: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeCommentsPage = decodeJsonResult(CommentsPage);
const decodeCommentEntry = Schema.decodeUnknownExit(Comment);

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
): Result.Result<
  { readonly comments: ReadonlyArray<IssueComment>; readonly nextCursor: string | null },
  DecodeFailure
> {
  return Result.map(decodeCommentsPage(raw), (page) => ({
    comments: (page.comments ?? []).flatMap((entry) => {
      const comment = decodeCommentEntry(entry);
      if (Exit.isFailure(comment) || comment.value.isDeleted === true) return [];
      return [
        {
          id: String(comment.value.id),
          author: toActor(comment.value.createdBy),
          body: comment.value.text ?? "",
          createdAt: comment.value.createdDate,
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

const Update = Schema.Struct({
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

/**
 * The timeline, read out of each revision's field changes. Azure reads `9999-01-01` as the changed
 * date of the newest revision, so the revision's own date is what every event carries.
 */
export function decodeUpdatesJson(
  raw: string,
): Result.Result<ReadonlyArray<IssueEvent>, DecodeFailure> {
  return Result.map(decodeUpdatesPage(raw), (page) =>
    (page.value ?? []).flatMap((entry) => {
      const update = decodeUpdateEntry(entry);
      if (Exit.isFailure(update) || update.value.id === 1) return [];
      const { id, revisedBy, revisedDate } = update.value;
      const fields = update.value.fields ?? {};
      const events: IssueEvent[] = [];
      const add = (kind: IssueEvent["kind"], detail: string | null) =>
        events.push({
          id: `update-${id}-${events.length}`,
          kind,
          actor: toActor(revisedBy),
          createdAt: revisedDate,
          detail,
        });
      const state = fields["System.State"];
      if (typeof state?.oldValue === "string" && typeof state.newValue === "string") {
        const was = toIssueState(state.oldValue);
        const now = toIssueState(state.newValue);
        add(
          was.category === now.category
            ? "state-changed"
            : now.category === "closed"
              ? "closed"
              : "reopened",
          now.name,
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
      return events;
    }),
  );
}

/** A relation that links a pull request, as Azure spells it: `vstfs:///Git/PullRequestId/{project}/{repo}/{id}`. */
export function pullRequestNumberOf(relation: typeof Relation.Type): number | null {
  if (relation.rel !== "ArtifactLink") return null;
  const match = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/.exec(relation.url);
  if (match === null) return null;
  const number = decodeURIComponent(match[1]!).split("/").at(-1) ?? "";
  return /^[1-9]\d{0,9}$/.test(number) ? Number(number) : null;
}

const Profile = Schema.Struct({
  emailAddress: Schema.optional(Schema.NullOr(Schema.String)),
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeProfile = decodeJsonResult(Profile);

/** `GET profile/profiles/me` names the signed-in account, which WIQL's `@Me` compares against. */
export function decodeProfileJson(raw: string): Result.Result<string | null, DecodeFailure> {
  return Result.map(
    decodeProfile(raw),
    (profile) => trimmed(profile.emailAddress) ?? trimmed(profile.displayName),
  );
}
