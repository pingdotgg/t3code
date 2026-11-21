/**
 * Jira Cloud's REST API (v3), signed with the account email and API token saved in Settings and
 * sent to the site saved beside them. Jira writes its refusals for people, so they pass through.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { IssueTrackerKind } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerCredential,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import type { AdfNode } from "./adf.ts";

export const KIND = IssueTrackerKind.make("jira");
const REQUEST_TIMEOUT = "30 seconds";
const PAGE = 100;
/** Pages read of a list that only feeds a picker; past it the list is reported truncated. */
const MAX_PAGES = 5;
/** Jira's agile API pages boards and a board's projects 50 at a time. */
const BOARD_PAGE = 50;
const MAX_BOARD_PROJECT_PAGES = 10;

const User = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  emailAddress: Schema.optional(Schema.NullOr(Schema.String)),
  accountType: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrls: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
});
export type JiraUser = typeof User.Type;

const Status = Schema.Struct({
  name: Schema.String,
  statusCategory: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.String }))),
});
export type JiraStatus = typeof Status.Type;

const Transition = Schema.Struct({ id: Schema.String, name: Schema.String, to: Status });
export type JiraTransition = typeof Transition.Type;

const History = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(User)),
  created: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      fromString: Schema.optional(Schema.NullOr(Schema.String)),
      toString: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type JiraHistory = typeof History.Type;

const Issue = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  fields: Schema.Struct({
    summary: Schema.String,
    status: Status,
    project: Schema.optional(Schema.Struct({ key: Schema.String })),
    reporter: Schema.optional(Schema.NullOr(User)),
    assignee: Schema.optional(Schema.NullOr(User)),
    labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    created: Schema.String,
    updated: Schema.String,
    resolutiondate: Schema.optional(Schema.NullOr(Schema.String)),
    description: Schema.optional(Schema.Unknown),
  }),
  transitions: Schema.optional(Schema.Array(Transition)),
  changelog: Schema.optional(Schema.Struct({ histories: Schema.Array(History) })),
});
export type JiraIssue = typeof Issue.Type;

const Board = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  location: Schema.optional(
    Schema.NullOr(Schema.Struct({ projectKey: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
export type JiraBoard = typeof Board.Type;

const NamedStatus = Schema.Struct({ id: Schema.String, name: Schema.String });

const Comment = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(User)),
  body: Schema.optional(Schema.Unknown),
  created: Schema.String,
});
export type JiraComment = typeof Comment.Type;

const ISSUE_FIELDS = [
  "summary",
  "status",
  "project",
  "reporter",
  "assignee",
  "labels",
  "created",
  "updated",
  "resolutiondate",
];

const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    errorMessages: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    errors: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    message: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

interface JiraSite {
  readonly origin: string;
  readonly email: string;
  readonly token: string;
}

export const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  extra: { readonly retryAt?: number | undefined; readonly cause?: unknown } = {},
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(extra.retryAt === undefined ? {} : { retryAt: extra.retryAt }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });

/**
 * `acme`, `acme.atlassian.net` or any page of the site, as the origin requests go to. Https only:
 * the email and token ride on every request.
 */
export function siteOrigin(site: string): string | null {
  const trimmed = site.trim();
  const named = /^[a-z0-9-]+$/i.test(trimmed) ? `${trimmed}.atlassian.net` : trimmed;
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(named) ? named : `https://${named}`);
  return url === null || url.protocol !== "https:" || !url.hostname.includes(".")
    ? null
    : url.origin;
}

const toSite = (operation: string, credential: IssueTrackerCredential) => {
  const origin = siteOrigin(credential.fields["site"] ?? "");
  const email = credential.fields["email"]?.trim() ?? "";
  if (origin === null) {
    return Effect.fail(
      fail(operation, "unauthenticated", "Enter the Jira site as yourteam.atlassian.net."),
    );
  }
  if (email.length === 0) {
    return Effect.fail(fail(operation, "unauthenticated", "Enter the Jira account's email."));
  }
  return Effect.succeed<JiraSite>({ origin, email, token: credential.token });
};

function retryAt(value: string | undefined, now: number): number | undefined {
  const seconds = /^\d+$/u.test(value?.trim() ?? "") ? Number(value) : Number.NaN;
  return Number.isSafeInteger(seconds) ? now + seconds * 1_000 : undefined;
}

type Query = Readonly<Record<string, string | number | undefined>>;

export class JiraApi extends Context.Service<
  JiraApi,
  {
    /** The site issues are linked on. Fails when Jira is not connected. */
    readonly origin: Effect.Effect<string, IssueTrackerError>;
    /** Takes the credential so it can vet a new one before it is stored. */
    readonly myself: (
      credential?: IssueTrackerCredential,
    ) => Effect.Effect<JiraUser, IssueTrackerError>;
    readonly projects: (
      credential?: IssueTrackerCredential,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly key: string; readonly name: string }>,
      IssueTrackerError
    >;
    readonly search: (input: {
      readonly jql: string;
      readonly limit: number;
      readonly pageToken?: string | undefined;
    }) => Effect.Effect<
      { readonly issues: ReadonlyArray<JiraIssue>; readonly nextPageToken: string | null },
      IssueTrackerError
    >;
    /** With the description, the transitions the account may make, and the change history. */
    readonly getIssue: (key: string) => Effect.Effect<JiraIssue, IssueTrackerError>;
    /** Newest first, `startAt` counting from the newest. */
    readonly getComments: (input: {
      readonly key: string;
      readonly startAt: number;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly comments: ReadonlyArray<JiraComment>; readonly total: number },
      IssueTrackerError
    >;
    /** Which of the named permissions the account holds on the issue. */
    readonly permissions: (
      key: string,
      names: ReadonlyArray<string>,
    ) => Effect.Effect<Readonly<Record<string, boolean>>, IssueTrackerError>;
    readonly issueTypes: (
      project: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly name: string; readonly subtask: boolean }>,
      IssueTrackerError
    >;
    readonly createIssue: (
      fields: Record<string, unknown>,
    ) => Effect.Effect<{ readonly key: string }, IssueTrackerError>;
    readonly updateIssue: (
      key: string,
      fields: Record<string, unknown>,
    ) => Effect.Effect<void, IssueTrackerError>;
    readonly transition: (key: string, id: string) => Effect.Effect<void, IssueTrackerError>;
    readonly addComment: (key: string, body: AdfNode) => Effect.Effect<void, IssueTrackerError>;
    readonly labels: Effect.Effect<
      { readonly names: ReadonlyArray<string>; readonly truncated: boolean },
      IssueTrackerError
    >;
    readonly assignable: (
      project: string,
    ) => Effect.Effect<
      { readonly users: ReadonlyArray<JiraUser>; readonly truncated: boolean },
      IssueTrackerError
    >;
    /** People matching a name or email, for turning what a client sent into an account id. */
    readonly findUsers: (
      query: string,
    ) => Effect.Effect<ReadonlyArray<JiraUser>, IssueTrackerError>;
    /** One page of the boards whose names hold `name`, or of one project's boards. */
    readonly boards: (input: {
      readonly name?: string | undefined;
      readonly projectKey?: string | undefined;
      readonly startAt: number;
    }) => Effect.Effect<
      { readonly boards: ReadonlyArray<JiraBoard>; readonly isLast: boolean },
      IssueTrackerError
    >;
    readonly board: (id: string) => Effect.Effect<JiraBoard, IssueTrackerError>;
    /** The keys of every project whose issues the board shows. */
    readonly boardProjects: (id: string) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError>;
    /** The ids of the statuses the board's columns hold, in column order. */
    readonly boardStatusIds: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError>;
    readonly status: (
      id: string,
    ) => Effect.Effect<{ readonly id: string; readonly name: string }, IssueTrackerError>;
    readonly project: (
      key: string,
    ) => Effect.Effect<{ readonly key: string; readonly name: string }, IssueTrackerError>;
    /** A project's statuses, one list per issue type, each in its workflow's order. */
    readonly projectStatuses: (
      key: string,
    ) => Effect.Effect<
      ReadonlyArray<ReadonlyArray<{ readonly id: string; readonly name: string }>>,
      IssueTrackerError
    >;
    /** The status id of each issue the query finds, up to `limit`. */
    readonly issueStatuses: (input: {
      readonly jql: string;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly key: string; readonly statusId: string }>,
      IssueTrackerError
    >;
  }
>()("@t3tools/issue-tracker-jira/server/JiraApi") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const storedSite = (operation: string) =>
    host.credentials.get(KIND).pipe(
      Effect.flatMap(
        Effect.fromOption(() =>
          fail(operation, "unauthenticated", "Jira is not connected on this server."),
        ),
      ),
      Effect.flatMap((credential) => toSite(operation, credential)),
    );

  const refusal = Effect.fn("JiraApi.refusal")(function* (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.fn.Return<never, IssueTrackerError> {
    const now = yield* Clock.currentTimeMillis;
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const said = Option.match(decodeErrorBody(body), {
      onNone: () => undefined,
      onSome: (error) =>
        [...(error.errorMessages ?? []), ...Object.values(error.errors ?? {}), error.message]
          .find((message) => message != null && message.trim().length > 0)
          ?.trim(),
    });
    if (response.status === 429) {
      return yield* fail(operation, "rate-limited", "Jira's rate limit was reached.", {
        retryAt: retryAt(response.headers["retry-after"], now),
      });
    }
    if (response.status === 401) {
      return yield* fail(operation, "unauthenticated", "Jira rejected the email or API token.");
    }
    if (response.status === 404) {
      return yield* fail(operation, "not-found", said ?? "Jira has nothing at that address.");
    }
    return yield* fail(
      operation,
      "failed",
      said ??
        (response.status === 403
          ? "This Jira account is not allowed to do that."
          : `Jira returned HTTP ${response.status}.`),
    );
  });

  const send = Effect.fn("JiraApi.send")(function* <S extends Schema.Top>(
    operation: string,
    schema: S,
    request: {
      readonly method: "GET" | "POST" | "PUT";
      readonly path: string;
      readonly query?: Query;
      readonly body?: unknown;
      readonly credential?: IssueTrackerCredential | undefined;
    },
  ): Effect.fn.Return<S["Type"], IssueTrackerError, S["DecodingServices"]> {
    yield* Effect.annotateCurrentSpan({ "jira.operation": operation });
    const site =
      request.credential === undefined
        ? yield* storedSite(operation)
        : yield* toSite(operation, request.credential);
    const base = HttpClientRequest.make(request.method)(`${site.origin}${request.path}`, {
      urlParams: Object.entries(request.query ?? {}).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, String(value)] as const],
      ),
    }).pipe(HttpClientRequest.acceptJson, HttpClientRequest.basicAuth(site.email, site.token));
    const response = yield* httpClient
      .execute(
        request.body === undefined
          ? base
          : base.pipe(HttpClientRequest.bodyJsonUnsafe(request.body)),
      )
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) =>
          fail(operation, "failed", "Jira could not be reached.", { cause }),
        ),
      );
    if (response.status < 200 || response.status >= 300) return yield* refusal(operation, response);
    // A write answers 204 with no body; `Schema.Void` reads nothing.
    if (response.status === 204) return undefined as S["Type"];
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError((cause) =>
        fail(operation, "failed", "Jira returned an unexpected body.", { cause }),
      ),
    );
  });

  /** Reads `startAt` pages until Jira has no more or the cap is reached. */
  const paged = Effect.fn("JiraApi.paged")(function* <A>(
    read: (startAt: number) => Effect.Effect<ReadonlyArray<A>, IssueTrackerError>,
  ): Effect.fn.Return<
    { readonly items: ReadonlyArray<A>; readonly truncated: boolean },
    IssueTrackerError
  > {
    const items: A[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = yield* read(page * PAGE);
      items.push(...batch);
      if (batch.length < PAGE) return { items, truncated: false };
    }
    return { items, truncated: true };
  });

  const myself: JiraApi["Service"]["myself"] = (credential) =>
    send("myself", User, { method: "GET", path: "/rest/api/3/myself", credential });

  const projects: JiraApi["Service"]["projects"] = (credential) =>
    paged((startAt) =>
      send(
        "projects",
        Schema.Struct({
          values: Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String })),
        }),
        {
          method: "GET",
          path: "/rest/api/3/project/search",
          query: { startAt, maxResults: PAGE, orderBy: "name" },
          credential,
        },
      ).pipe(Effect.map((page) => page.values)),
    ).pipe(Effect.map((page) => page.items));

  const search: JiraApi["Service"]["search"] = (input) =>
    send(
      "search",
      Schema.Struct({
        issues: Schema.Array(Issue),
        nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      {
        method: "POST",
        path: "/rest/api/3/search/jql",
        body: {
          jql: input.jql,
          maxResults: input.limit,
          fields: ISSUE_FIELDS,
          ...(input.pageToken === undefined ? {} : { nextPageToken: input.pageToken }),
        },
      },
    ).pipe(
      Effect.map((page) => ({ issues: page.issues, nextPageToken: page.nextPageToken ?? null })),
    );

  const getIssue: JiraApi["Service"]["getIssue"] = (key) =>
    send("getIssue", Issue, {
      method: "GET",
      path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
      query: {
        fields: [...ISSUE_FIELDS, "description"].join(","),
        expand: "transitions,changelog",
      },
    });

  const getComments: JiraApi["Service"]["getComments"] = (input) =>
    send("getComments", Schema.Struct({ comments: Schema.Array(Comment), total: Schema.Number }), {
      method: "GET",
      path: `/rest/api/3/issue/${encodeURIComponent(input.key)}/comment`,
      query: { startAt: input.startAt, maxResults: input.limit, orderBy: "-created" },
    });

  const permissions: JiraApi["Service"]["permissions"] = (key, names) =>
    send(
      "permissions",
      Schema.Struct({
        permissions: Schema.Record(
          Schema.String,
          Schema.Struct({ havePermission: Schema.Boolean }),
        ),
      }),
      {
        method: "GET",
        path: "/rest/api/3/mypermissions",
        query: { issueKey: key, permissions: names.join(",") },
      },
    ).pipe(
      Effect.map((answer) =>
        Object.fromEntries(
          names.map((name) => [name, answer.permissions[name]?.havePermission === true]),
        ),
      ),
    );

  const issueTypes: JiraApi["Service"]["issueTypes"] = (project) =>
    send(
      "issueTypes",
      Schema.Struct({
        issueTypes: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            subtask: Schema.optional(Schema.Boolean),
          }),
        ),
      }),
      {
        method: "GET",
        path: `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`,
        query: { maxResults: PAGE },
      },
    ).pipe(
      Effect.map((answer) =>
        answer.issueTypes.map((type) => ({ ...type, subtask: type.subtask === true })),
      ),
    );

  const createIssue: JiraApi["Service"]["createIssue"] = (fields) =>
    send("createIssue", Schema.Struct({ key: Schema.String }), {
      method: "POST",
      path: "/rest/api/3/issue",
      body: { fields },
    });

  const updateIssue: JiraApi["Service"]["updateIssue"] = (key, fields) =>
    send("updateIssue", Schema.Void, {
      method: "PUT",
      path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
      body: { fields },
    });

  const transition: JiraApi["Service"]["transition"] = (key, id) =>
    send("transition", Schema.Void, {
      method: "POST",
      path: `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      body: { transition: { id } },
    });

  const addComment: JiraApi["Service"]["addComment"] = (key, body) =>
    send("addComment", Schema.Unknown, {
      method: "POST",
      path: `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      body: { body },
    }).pipe(Effect.asVoid);

  const labels: JiraApi["Service"]["labels"] = paged((startAt) =>
    send("labels", Schema.Struct({ values: Schema.Array(Schema.String) }), {
      method: "GET",
      path: "/rest/api/3/label",
      query: { startAt, maxResults: PAGE },
    }).pipe(Effect.map((page) => page.values)),
  ).pipe(Effect.map((page) => ({ names: page.items, truncated: page.truncated })));

  const assignable: JiraApi["Service"]["assignable"] = (project) =>
    paged((startAt) =>
      send("assignable", Schema.Array(User), {
        method: "GET",
        path: "/rest/api/3/user/assignable/search",
        query: { project, startAt, maxResults: PAGE },
      }),
    ).pipe(Effect.map((page) => ({ users: page.items, truncated: page.truncated })));

  const findUsers: JiraApi["Service"]["findUsers"] = (query) =>
    send("findUsers", Schema.Array(User), {
      method: "GET",
      path: "/rest/api/3/user/search",
      query: { query, maxResults: 20 },
    });

  const boards: JiraApi["Service"]["boards"] = (input) =>
    send(
      "boards",
      Schema.Struct({ values: Schema.Array(Board), isLast: Schema.optional(Schema.Boolean) }),
      {
        method: "GET",
        path: "/rest/agile/1.0/board",
        query: {
          startAt: input.startAt,
          maxResults: BOARD_PAGE,
          name: input.name,
          projectKeyOrId: input.projectKey,
        },
      },
    ).pipe(
      Effect.map((page) => ({
        boards: page.values,
        isLast: page.isLast ?? page.values.length < BOARD_PAGE,
      })),
    );

  const board: JiraApi["Service"]["board"] = (id) =>
    send("board", Board, {
      method: "GET",
      path: `/rest/agile/1.0/board/${encodeURIComponent(id)}`,
    });

  const boardProjects = Effect.fn("JiraApi.boardProjects")(function* (id: string) {
    const keys: string[] = [];
    for (let page = 0; page < MAX_BOARD_PROJECT_PAGES; page += 1) {
      const answer = yield* send(
        "boardProjects",
        Schema.Struct({
          values: Schema.Array(Schema.Struct({ key: Schema.String })),
          isLast: Schema.optional(Schema.Boolean),
        }),
        {
          method: "GET",
          path: `/rest/agile/1.0/board/${encodeURIComponent(id)}/project`,
          query: { startAt: keys.length, maxResults: BOARD_PAGE },
        },
      );
      keys.push(...answer.values.map((project) => project.key));
      if ((answer.isLast ?? answer.values.length < BOARD_PAGE) || answer.values.length === 0)
        return keys;
    }
    return yield* fail("boardProjects", "failed", "This Jira board spans too many projects.");
  });

  const boardStatusIds: JiraApi["Service"]["boardStatusIds"] = (id) =>
    send(
      "boardStatusIds",
      Schema.Struct({
        columnConfig: Schema.Struct({
          columns: Schema.Array(
            Schema.Struct({ statuses: Schema.Array(Schema.Struct({ id: Schema.String })) }),
          ),
        }),
      }),
      { method: "GET", path: `/rest/agile/1.0/board/${encodeURIComponent(id)}/configuration` },
    ).pipe(
      Effect.map((config) => [
        ...new Set(
          config.columnConfig.columns.flatMap((column) =>
            column.statuses.map((status) => status.id),
          ),
        ),
      ]),
    );

  const status: JiraApi["Service"]["status"] = (id) =>
    send("status", NamedStatus, {
      method: "GET",
      path: `/rest/api/3/status/${encodeURIComponent(id)}`,
    });

  const project: JiraApi["Service"]["project"] = (key) =>
    send("project", Schema.Struct({ key: Schema.String, name: Schema.String }), {
      method: "GET",
      path: `/rest/api/3/project/${encodeURIComponent(key)}`,
    });

  const projectStatuses: JiraApi["Service"]["projectStatuses"] = (key) =>
    send("projectStatuses", Schema.Array(Schema.Struct({ statuses: Schema.Array(NamedStatus) })), {
      method: "GET",
      path: `/rest/api/3/project/${encodeURIComponent(key)}/statuses`,
    }).pipe(Effect.map((types) => types.map((type) => type.statuses)));

  const issueStatuses: JiraApi["Service"]["issueStatuses"] = (input) =>
    send(
      "issueStatuses",
      Schema.Struct({
        issues: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            fields: Schema.Struct({ status: Schema.Struct({ id: Schema.String }) }),
          }),
        ),
      }),
      {
        method: "POST",
        path: "/rest/api/3/search/jql",
        body: { jql: input.jql, maxResults: input.limit, fields: ["status"] },
      },
    ).pipe(
      Effect.map((page) =>
        page.issues.map((issue) => ({ key: issue.key, statusId: issue.fields.status.id })),
      ),
    );

  return JiraApi.of({
    origin: storedSite("origin").pipe(Effect.map((site) => site.origin)),
    myself,
    projects,
    search,
    getIssue,
    getComments,
    permissions,
    issueTypes,
    createIssue,
    updateIssue,
    transition,
    addComment,
    labels,
    assignable,
    findUsers,
    boards,
    board,
    boardProjects,
    boardStatusIds,
    status,
    project,
    projectStatuses,
    issueStatuses,
  });
});

export const layer = Layer.effect(JiraApi, make);
