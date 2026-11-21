import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueComment,
  type IssueEvent,
  type IssueState,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueScopeTarget,
  type IssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";
import * as TanStackSourceApi from "./TanStackSourceApi.ts";
import * as Hosts from "./tanStackSourceHosts.ts";
import * as Json from "./tanStackSourceJson.ts";
import * as Listing from "./tanStackSourceListing.ts";

const KIND = IssueTrackerKind.make(definition.kind);

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  // Source documents no REST route for reactions.
  reactions: false,
  templates: false,
  linkedPullRequests: true,
  events: true,
  search: true,
};

const OPEN: IssueState = { category: "open", name: "Open" };
const CLOSED: IssueState = { category: "closed", name: "Closed" };
const STATES: ReadonlyArray<IssueState> = [OPEN, CLOSED];

/** Source keeps no update time; the newest timeline entry stands in where one was read. */
const EVENT_KINDS: Readonly<Record<string, IssueEvent["kind"]>> = {
  closed: "closed",
  reopened: "reopened",
  labeled: "labeled",
  unlabeled: "unlabeled",
  assigned: "assigned",
  unassigned: "unassigned",
  renamed: "renamed",
  linked_from: "referenced",
  referenced: "referenced",
};

const Assignee = Schema.Union([Schema.String, Schema.Struct({ username: Schema.String })]);
const IssueRow = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  author: Schema.NullOr(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  assignees: Schema.optional(Schema.Array(Assignee)),
  comments: Schema.optional(Schema.Int),
  createdAt: Schema.Finite,
  moderation: Schema.optional(Schema.String),
});
type IssueRow = typeof IssueRow.Type;
const IssueRows = Schema.Struct({
  items: Schema.Array(IssueRow),
  next: Schema.NullOr(Schema.String),
});

const TimelineEntry = Schema.Struct({
  id: Schema.optional(Schema.Int),
  comment: Schema.optional(Schema.NullOr(Schema.String)),
  event: Schema.optional(Schema.String),
  author: Schema.optional(Schema.NullOr(Schema.String)),
  actor: Schema.optional(Schema.NullOr(Schema.String)),
  at: Schema.Finite,
  moderation: Schema.optional(Schema.String),
});
const IssueDetail = Schema.Struct({
  ...IssueRow.fields,
  kind: Schema.optional(Schema.String),
  body: Schema.NullOr(Schema.String),
  locked: Schema.optional(Schema.Boolean),
  timeline: Schema.Array(TimelineEntry),
  next: Schema.NullOr(Schema.String),
  fixedBy: Schema.optional(
    Schema.Array(Schema.Struct({ number: Schema.Int, title: Schema.String, state: Schema.String })),
  ),
});
type IssueDetail = typeof IssueDetail.Type;
const Created = Schema.Struct({ number: Schema.Int });
const PAGE_LIMIT = 5;

const issueUrl = (host: string, scope: string, number: number | string) =>
  `https://${host}/@${scope}/issues/${number}`;
const assigneeLogin = (assignee: typeof Assignee.Type) =>
  typeof assignee === "string" ? assignee : assignee.username;
const pullState = (state: string) =>
  state === "merged"
    ? ("merged" as const)
    : state === "closed"
      ? ("closed" as const)
      : ("open" as const);

export const make = Effect.gen(function* () {
  const api = yield* TanStackSourceApi.TanStackSourceApi;

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const base = (operation: string, input: IssueScopeTarget) => {
    const repository = Hosts.tanStackSourceRepositoryPath(input.scope);
    return Hosts.tanStackSourceHost(input.host) !== null && repository !== null
      ? Effect.succeed(`/repos/${repository}`)
      : Effect.fail(failure(operation, "TanStack Source issues live in owner/name repositories."));
  };

  const send = (
    operation: string,
    input: Pick<IssueScopeTarget, "host">,
    request: Omit<TanStackSourceApi.TanStackSourceApiRequest, "operation" | "host">,
  ) =>
    api.request({ ...request, host: input.host, operation }).pipe(
      Effect.mapError(
        (error) =>
          new IssueTrackerError({
            tracker: KIND,
            operation,
            // A refused write is the request's, not a reason to switch the tracker off.
            reason: error.reason === "forbidden" ? "failed" : error.reason,
            detail: error.detail,
            ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
            cause: error,
          }),
      ),
    );

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: Pick<IssueScopeTarget, "host">,
    request: Omit<TanStackSourceApi.TanStackSourceApiRequest, "operation" | "host">,
    schema: S,
  ) =>
    send(operation, input, request).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            failure(operation, "TanStack Source returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const toSummary = (
    issue: IssueRow,
    input: IssueScopeTarget,
    updatedAt = issue.createdAt,
  ): TrackerIssueSummary => {
    const created = Json.iso(issue.createdAt);
    return {
      key: String(issue.number),
      displayKey: `#${issue.number}`,
      title: issue.title.trim() || `#${issue.number}`,
      url: issueUrl(input.host, input.scope, issue.number),
      author: Json.toActor(issue.author, input.host),
      state: issue.state === "closed" ? CLOSED : OPEN,
      createdAt: created,
      updatedAt: Json.iso(Math.max(updatedAt, issue.createdAt)),
      // Source reports no close time.
      closedAt: null,
      assignees: (issue.assignees ?? []).flatMap((assignee) => {
        const actor = Json.toActor(assigneeLogin(assignee), input.host);
        return actor === null ? [] : [actor];
      }),
      labels: (issue.labels ?? []).map((name) => ({ name, color: null })),
      commentCount: issue.comments ?? 0,
    };
  };

  const toConversation = (detail: IssueDetail, input: IssueScopeTarget & { key: string }) => {
    const comments: Array<IssueComment> = [];
    const events: Array<IssueEvent> = [];
    for (const [index, entry] of detail.timeline.entries()) {
      if (entry.moderation !== undefined && entry.moderation !== "visible") continue;
      if (entry.event !== undefined) {
        const kind = EVENT_KINDS[entry.event];
        if (kind !== undefined)
          events.push({
            id: `${input.key}:${entry.at}:${index}`,
            kind,
            actor: Json.toActor(entry.actor ?? null, input.host),
            createdAt: Json.iso(entry.at),
            detail: null,
          });
        continue;
      }
      if (entry.id === undefined) continue;
      comments.push({
        id: String(entry.id),
        author: Json.toActor(entry.author ?? null, input.host),
        body: entry.comment ?? "",
        createdAt: Json.iso(entry.at),
        url: `${issueUrl(input.host, input.scope, input.key)}#comment-${entry.id}`,
      });
    }
    return { comments, events };
  };

  const readDetail = Effect.fn("TanStackSourceIssueTracker.readDetail")(function* (
    operation: string,
    input: IssueScopeTarget & { readonly key: string },
  ) {
    const path = yield* base(operation, input);
    if (!/^\d+$/u.test(input.key))
      return yield* failure(operation, "TanStack Source issue keys are numbers.");
    return yield* read(operation, input, { path: `${path}/issues/${input.key}` }, IssueDetail);
  });

  const tracker: IssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    getViewer: (input) =>
      read("getViewer", input, { path: "/user" }, Json.SourceUser).pipe(
        Effect.map((user) => user.username),
      ),

    listIssues: Effect.fn("TanStackSourceIssueTracker.listIssues")(function* (input) {
      const path = yield* base("listIssues", input);
      const query = new URLSearchParams();
      if (input.query?.trim()) query.set("query", input.query.trim());
      // Source narrows by one label; the rest are matched below.
      const [label, ...moreLabels] = input.labels ?? [];
      if (label !== undefined) query.set("label", label);
      // An explicit assignee narrows on Source; being assigned too is checked on the rows.
      if (input.assignee !== undefined) query.set("assignee", input.assignee);
      else if (input.involvement === "assigned") query.set("assignee", "@me");
      if (input.involvement === "authored") query.set("author", "@me");
      if (input.involvement === "mentioned") query.set("mention", "@me");
      const viewer = input.involvement === "all" ? null : input.viewer.toLowerCase();
      const listing = yield* Listing.readMerged({
        states: input.state === "all" ? ["open", "closed"] : [input.state],
        cursor: input.cursor,
        limit: Math.max(1, input.limit),
        maxPages: PAGE_LIMIT,
        readPage: (state, page) => {
          const params = new URLSearchParams(query);
          params.set("state", state);
          if (page !== null) params.set("cursor", page);
          return read("listIssues", input, { path: `${path}/issues?${params}` }, IssueRows);
        },
        keep: (issue) =>
          (issue.moderation === undefined || issue.moderation === "visible") &&
          moreLabels.every((name) => issue.labels?.includes(name) === true) &&
          (input.involvement !== "assigned" ||
            input.assignee === undefined ||
            (issue.assignees ?? []).some(
              (assignee) => assigneeLogin(assignee).toLowerCase() === viewer,
            )),
      });
      return {
        items: listing.items.map((issue) => toSummary(issue, input)),
        nextCursor: listing.next,
      };
    }),

    getIssue: Effect.fn("TanStackSourceIssueTracker.getIssue")(function* (input) {
      const [detail, viewer] = yield* Effect.all(
        [
          readDetail("getIssue", input),
          tracker.getViewer(input).pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 2 },
      );
      if (detail.kind === "pull")
        return yield* failure("getIssue", `#${input.key} is a pull request, not an issue.`);
      const { comments, events } = toConversation(detail, input);
      const latest = detail.timeline.reduce((newest, entry) => Math.max(newest, entry.at), 0);
      return {
        ...toSummary(detail, input, latest),
        commentCount: detail.comments ?? comments.length,
        body: detail.body ?? "",
        viewer,
        viewerPermissions: {
          setState: viewer !== null,
          comment: viewer !== null && detail.locked !== true,
          edit: viewer !== null,
          labels: viewer !== null,
          assignees: viewer !== null,
        },
        states: STATES,
        comments,
        commentsCursor: detail.next,
        events,
        linkedPullRequests: (detail.fixedBy ?? []).map((pull) => ({
          repository: input.scope,
          number: pull.number,
          title: pull.title.trim() || `#${pull.number}`,
          url: Json.pullUrl(input.host, input.scope, pull.number),
          state: pullState(pull.state),
          isDraft: false,
          closesIssue: true,
        })),
      };
    }),

    getComments: Effect.fn("TanStackSourceIssueTracker.getComments")(function* (input) {
      const path = yield* base("getComments", input);
      const detail = yield* read(
        "getComments",
        input,
        {
          path: `${path}/issues/${input.key}?${new URLSearchParams({ cursor: input.cursor })}`,
        },
        IssueDetail,
      );
      return { comments: toConversation(detail, input).comments, nextCursor: detail.next };
    }),

    create: Effect.fn("TanStackSourceIssueTracker.create")(function* (input) {
      const path = yield* base("create", input);
      const created = yield* read(
        "create",
        input,
        {
          method: "POST",
          path: `${path}/issues`,
          body: {
            title: input.title,
            ...(input.body.trim() === "" ? {} : { body: input.body }),
          },
        },
        Created,
      );
      const key = String(created.number);
      // Source takes labels and assignees on their own routes.
      if (input.labels.length > 0)
        yield* send("create", input, {
          method: "PUT",
          path: `${path}/issues/${key}/labels`,
          body: { labels: input.labels },
        });
      if (input.assignees.length > 0)
        yield* send("create", input, {
          method: "PUT",
          path: `${path}/issues/${key}/assignees`,
          body: { assignees: input.assignees },
        });
      return { key, displayKey: `#${key}`, url: issueUrl(input.host, input.scope, key) };
    }),

    comment: Effect.fn("TanStackSourceIssueTracker.comment")(function* (input) {
      const path = yield* base("comment", input);
      yield* send("comment", input, {
        method: "POST",
        path: `${path}/issues/${input.key}/comments`,
        body: { body: input.body },
      });
    }),

    update: Effect.fn("TanStackSourceIssueTracker.update")(function* (input) {
      const path = `${yield* base("update", input)}/issues/${input.key}`;
      if (input.title !== undefined || input.body !== undefined)
        yield* send("update", input, {
          method: "PATCH",
          path,
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        });
      if (input.labels !== undefined)
        yield* send("update", input, {
          method: "PUT",
          path: `${path}/labels`,
          body: { labels: input.labels },
        });
      if (input.assignees !== undefined)
        yield* send("update", input, {
          method: "PUT",
          path: `${path}/assignees`,
          body: { assignees: input.assignees },
        });
    }),

    setState: Effect.fn("TanStackSourceIssueTracker.setState")(function* (input) {
      const state = STATES.find((candidate) => candidate.name === input.state);
      if (state === undefined)
        return yield* failure("setState", `TanStack Source issues have no "${input.state}" state.`);
      const path = yield* base("setState", input);
      yield* send("setState", input, {
        method: "PATCH",
        path: `${path}/issues/${input.key}`,
        body: { state: state.category },
      });
    }),

    listCandidates: Effect.fn("TanStackSourceIssueTracker.listCandidates")(function* (input) {
      const path = yield* base("listCandidates", input);
      const [labels, viewer] = yield* Effect.all(
        [
          read("listCandidates", input, { path: `${path}/labels` }, Json.SourceLabels),
          tracker.getViewer(input).pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 2 },
      );
      const self = Json.toActor(viewer, input.host);
      return {
        labels: labels.map((label) => ({
          name: label.name,
          color: label.color,
          description: label.description ?? null,
        })),
        // Source lists no collaborators, so only the viewer is offered.
        assignees: self === null ? [] : [{ ...self, id: self.login }],
        truncated: true,
      };
    }),
  };
  return tracker;
});
