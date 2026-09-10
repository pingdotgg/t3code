import type * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { IssueState, IssueActor } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * A work item as this wrapper needs it. Azure keeps everything under `fields`, keyed by reference
 * name, and reports no shape of its own for what a project has added — so only the fields every
 * work item type carries are read, and anything else is left where it is.
 */
export interface AzureDevOpsWorkItem {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: IssueActor | null;
  readonly assignees: ReadonlyArray<IssueActor>;
  readonly state: IssueState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly description: string;
}

/**
 * The states Azure treats as finished. A project may rename its own columns, so anything not
 * named here reads as open: an issue wrongly shown as open is one the reader can still close,
 * while one wrongly shown as closed disappears from the list they were looking at.
 */
const CLOSED_STATES = new Set(["closed", "done", "removed", "resolved", "completed"]);

const Identity = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const Fields = Schema.Struct({
  "System.Title": Schema.optional(Schema.NullOr(Schema.String)),
  "System.State": Schema.optional(Schema.NullOr(Schema.String)),
  "System.CreatedDate": Schema.optional(Schema.NullOr(Schema.String)),
  "System.ChangedDate": Schema.optional(Schema.NullOr(Schema.String)),
  "Microsoft.VSTS.Common.ClosedDate": Schema.optional(Schema.NullOr(Schema.String)),
  "System.Description": Schema.optional(Schema.NullOr(Schema.String)),
  "System.CreatedBy": Schema.optional(Schema.NullOr(Schema.Union([Identity, Schema.String]))),
  "System.AssignedTo": Schema.optional(Schema.NullOr(Schema.Union([Identity, Schema.String]))),
});

const WorkItem = Schema.Struct({
  id: Schema.Union([Schema.Int, Schema.String]),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  fields: Schema.optional(Schema.NullOr(Fields)),
});

const decodeWorkItem = Schema.decodeUnknownResult(WorkItem);
const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeUnknownItem = decodeJsonResult(Schema.Unknown);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/**
 * The organization link `az` returns addresses the REST resource, which is not a page anybody
 * can open. The one a reader wants is the board's own item, which Azure spells this way.
 */
function browserUrl(apiUrl: string | null | undefined, id: number): string | null {
  if (apiUrl === null || apiUrl === undefined) return null;
  const match = /^(https?:\/\/[^/]+\/[^/]+)\/(?:[^/]+\/)?_apis\/wit\/workItems\//iu.exec(apiUrl);
  return match === null ? null : `${match[1]}/_workitems/edit/${id}`;
}

function actorOf(value: unknown): IssueActor | null {
  if (typeof value === "string") {
    const login = value.trim();
    return login.length === 0 ? null : { login, name: null, avatarUrl: null };
  }
  if (value === null || typeof value !== "object") return null;
  const identity = value as typeof Identity.Type;
  const login = (identity.uniqueName ?? identity.displayName ?? "").trim();
  if (login.length === 0) return null;
  return {
    login,
    name: identity.displayName ?? null,
    avatarUrl: identity.imageUrl ?? null,
  };
}

function toWorkItem(raw: unknown): AzureDevOpsWorkItem | null {
  const decoded = decodeWorkItem(raw);
  if (!Result.isSuccess(decoded)) return null;
  const item = decoded.success;
  const number = typeof item.id === "string" ? Number.parseInt(item.id, 10) : item.id;
  if (!Number.isInteger(number) || number <= 0) return null;
  const fields = item.fields ?? {};
  const title = (fields["System.Title"] ?? "").trim();
  const createdAt = fields["System.CreatedDate"] ?? null;
  const updatedAt = fields["System.ChangedDate"] ?? createdAt;
  const url = browserUrl(item.url, number);
  if (title.length === 0 || createdAt === null || updatedAt === null || url === null) return null;
  const assignee = actorOf(fields["System.AssignedTo"]);
  return {
    number,
    title,
    url,
    author: actorOf(fields["System.CreatedBy"]),
    assignees: assignee === null ? [] : [assignee],
    state: CLOSED_STATES.has((fields["System.State"] ?? "").trim().toLowerCase())
      ? "closed"
      : "open",
    createdAt,
    updatedAt,
    closedAt: fields["Microsoft.VSTS.Common.ClosedDate"] ?? null,
    description: fields["System.Description"] ?? "",
  };
}

/**
 * A flat WIQL answer. Rows Azure returned but this cannot place are skipped rather than failing
 * the page: one work item type with a field this does not read is not a reason to show none.
 */
export function decodeWorkItemsJson(
  raw: string,
): Result.Result<
  { readonly items: ReadonlyArray<AzureDevOpsWorkItem>; readonly rawCount: number },
  DecodeFailure
> {
  const rows = decodeUnknownList(raw.trim().length === 0 ? "[]" : raw);
  if (!Result.isSuccess(rows)) return Result.fail(rows.failure);
  const items = rows.success.map(toWorkItem).filter((item) => item !== null);
  return Result.succeed({ items, rawCount: rows.success.length });
}

/** Null where az answered with a work item this cannot place, which the caller reports as such. */
export function decodeWorkItemJson(
  raw: string,
): Result.Result<AzureDevOpsWorkItem | null, DecodeFailure> {
  const decoded = decodeUnknownItem(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toWorkItem(decoded.success))
    : Result.fail(decoded.failure);
}
