/**
 * Jira Cloud's REST API (v3), signed with the credential saved in Settings: the site, the
 * account's email and an API token, stored together as one JSON value. Every call goes to that
 * credential's own site, so a stored credential never reaches another one.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";

import { JIRA_KIND } from "../shared/issueUrl.ts";

export const KIND = JIRA_KIND;
const REQUEST_TIMEOUT = "30 seconds";

const Credential = Schema.Struct({
  site: Schema.String,
  email: Schema.String,
  token: Schema.String,
});
const decodeCredential = Schema.decodeUnknownOption(Schema.fromJsonString(Credential));

export interface JiraCredential {
  /** The site's subdomain: `acme` for `acme.atlassian.net`. */
  readonly site: string;
  readonly email: string;
  readonly token: string;
}

/**
 * The credential as Settings stores it, or null when a field is missing or the site is not a
 * Jira Cloud site: the host must never come from anything but `<site>.atlassian.net`.
 */
export function parseJiraCredential(value: string): JiraCredential | null {
  const decoded = decodeCredential(value);
  if (decoded._tag === "None") return null;
  const site = decoded.value.site
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\.atlassian\.net$/, "");
  const email = decoded.value.email.trim();
  const token = decoded.value.token.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(site) || email === "" || token === "") return null;
  return { site, email, token };
}

export const JiraUser = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.optional(Schema.String),
  emailAddress: Schema.optional(Schema.String),
  avatarUrls: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type JiraUser = typeof JiraUser.Type;

export const JiraStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  statusCategory: Schema.Struct({ key: Schema.String }),
});
export type JiraStatus = typeof JiraStatus.Type;

/** Jira documents are Atlassian Document Format; `jiraAdf.ts` reads and writes them. */
const Document = Schema.NullOr(Schema.Unknown);

const IssueFields = Schema.Struct({
  summary: Schema.String,
  status: JiraStatus,
  created: Schema.String,
  updated: Schema.String,
  resolutiondate: Schema.optional(Schema.NullOr(Schema.String)),
  creator: Schema.optional(Schema.NullOr(JiraUser)),
  reporter: Schema.optional(Schema.NullOr(JiraUser)),
  assignee: Schema.optional(Schema.NullOr(JiraUser)),
  labels: Schema.optional(Schema.Array(Schema.String)),
  project: Schema.Struct({ key: Schema.String }),
  description: Schema.optional(Document),
});

export const JiraIssue = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  fields: IssueFields,
});
export type JiraIssue = typeof JiraIssue.Type;

export const JiraComment = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(JiraUser)),
  body: Document,
  created: Schema.String,
});
export type JiraComment = typeof JiraComment.Type;

const HistoryItem = Schema.Struct({
  field: Schema.String,
  fromString: Schema.optional(Schema.NullOr(Schema.String)),
  toString: Schema.optional(Schema.NullOr(Schema.String)),
});
export const JiraHistory = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(JiraUser)),
  created: Schema.String,
  items: Schema.Array(HistoryItem),
});
export type JiraHistory = typeof JiraHistory.Type;

export const JiraTransition = Schema.Struct({
  id: Schema.String,
  to: JiraStatus,
});
export type JiraTransition = typeof JiraTransition.Type;

export const JiraIssueDetail = Schema.Struct({
  ...JiraIssue.fields,
  changelog: Schema.optional(Schema.Struct({ histories: Schema.Array(JiraHistory) })),
  transitions: Schema.optional(Schema.Array(JiraTransition)),
});
export type JiraIssueDetail = typeof JiraIssueDetail.Type;

const SearchPage = Schema.Struct({
  issues: Schema.Array(JiraIssue),
  nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
});

const CommentPage = Schema.Struct({
  startAt: Schema.Number,
  total: Schema.Number,
  comments: Schema.Array(JiraComment),
});
export type JiraCommentPage = typeof CommentPage.Type;

const MAX_PROJECTS = 1_000;
const ProjectPage = Schema.Struct({
  isLast: Schema.optional(Schema.Boolean),
  values: Schema.Array(
    Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String }),
  ),
});

const IssueTypes = Schema.Struct({
  issueTypes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      subtask: Schema.optional(Schema.Boolean),
    }),
  ),
});

const Labels = Schema.Struct({
  values: Schema.Array(Schema.String),
  isLast: Schema.optional(Schema.Boolean),
});

const Created = Schema.Struct({ key: Schema.String });

const SUMMARY_FIELDS = [
  "summary",
  "status",
  "created",
  "updated",
  "resolutiondate",
  "creator",
  "reporter",
  "assignee",
  "labels",
  "project",
];

/** What a write sends as a field, already in Jira's own shape. */
export type JiraFields = Record<string, unknown>;

export class JiraApi extends Context.Service<
  JiraApi,
  {
    /** The stored credential's site, which every issue URL and request is for. */
    readonly site: Effect.Effect<string, IssueTrackerError>;
    /** Who a credential is and which projects it reaches. Takes one so it can vet a new one. */
    readonly probe: (credential?: string) => Effect.Effect<
      {
        readonly site: string;
        readonly user: JiraUser;
        readonly projects: ReadonlyArray<{ readonly key: string; readonly name: string }>;
      },
      IssueTrackerError
    >;
    readonly myself: Effect.Effect<JiraUser, IssueTrackerError>;
    readonly search: (input: {
      readonly jql: string;
      readonly limit: number;
      readonly cursor?: string | undefined;
    }) => Effect.Effect<
      { readonly issues: ReadonlyArray<JiraIssue>; readonly nextCursor: string | null },
      IssueTrackerError
    >;
    /** Null when Jira has no such issue, or the credential cannot see it. */
    readonly getIssue: (key: string) => Effect.Effect<JiraIssueDetail | null, IssueTrackerError>;
    /** Newest first, so the first page is the latest conversation. */
    readonly getComments: (input: {
      readonly key: string;
      readonly startAt: number;
      readonly limit: number;
    }) => Effect.Effect<JiraCommentPage, IssueTrackerError>;
    readonly createIssue: (fields: JiraFields) => Effect.Effect<string, IssueTrackerError>;
    readonly updateIssue: (
      key: string,
      fields: JiraFields,
    ) => Effect.Effect<void, IssueTrackerError>;
    readonly addComment: (key: string, body: unknown) => Effect.Effect<void, IssueTrackerError>;
    readonly transition: (key: string, id: string) => Effect.Effect<void, IssueTrackerError>;
    readonly issueTypes: (
      project: string,
    ) => Effect.Effect<typeof IssueTypes.Type.issueTypes, IssueTrackerError>;
    readonly assignableUsers: (input: {
      readonly project?: string | undefined;
      readonly issueKey?: string | undefined;
      readonly query?: string | undefined;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<JiraUser>, IssueTrackerError>;
    readonly labels: (
      limit: number,
    ) => Effect.Effect<
      { readonly values: ReadonlyArray<string>; readonly truncated: boolean },
      IssueTrackerError
    >;
  }
>()("@t3tools/issue-tracker-jira/server/JiraApi") {}

const fail = (
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

const ErrorBody = Schema.Struct({
  errorMessages: Schema.optional(Schema.Array(Schema.String)),
  errors: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** Jira writes its refusals for people; the first one is what the user is shown. */
const refusal = Effect.fn("JiraApi.refusal")(function* (
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
) {
  const now = yield* Clock.currentTimeMillis;
  if (response.status === 429) {
    return fail(operation, "rate-limited", "Jira's rate limit was reached.", {
      retryAt: retryAtFromHeader(response.headers["retry-after"], now),
    });
  }
  if (response.status === 401) {
    return fail(operation, "unauthenticated", "Jira rejected the email and API token.");
  }
  const body = yield* HttpClientResponse.schemaBodyJson(ErrorBody)(response).pipe(
    Effect.orElseSucceed(() => ({ errorMessages: [], errors: {} })),
  );
  const messages = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].filter(
    (text): text is string => typeof text === "string",
  );
  const message = messages.map((text) => text.trim()).find((text) => text !== "");
  if (response.status === 404) {
    return fail(operation, "not-found", message ?? "Jira has no such issue or project.");
  }
  return fail(operation, "failed", message ?? `Jira returned HTTP ${response.status}.`);
});

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const credential = (operation: string, given?: string) =>
    (given === undefined
      ? host.credentials
          .get(KIND)
          .pipe(
            Effect.flatMap(
              Effect.fromOption(() =>
                fail(operation, "unauthenticated", "Jira is not connected on this server."),
              ),
            ),
          )
      : Effect.succeed(given)
    ).pipe(
      Effect.flatMap((value) => {
        const parsed = parseJiraCredential(value);
        return parsed === null
          ? Effect.fail(
              fail(
                operation,
                "unauthenticated",
                "Enter a Jira Cloud site, the account's email and an API token.",
              ),
            )
          : Effect.succeed(parsed);
      }),
    );

  const call = Effect.fn("JiraApi.call")(function* <
    S extends Schema.Top & { readonly DecodingServices: never },
  >(input: {
    readonly operation: string;
    readonly method: "GET" | "POST" | "PUT";
    readonly path: string;
    readonly params?: Record<string, string> | undefined;
    readonly body?: unknown;
    /** Null for a call that answers with no body. */
    readonly schema: S | null;
    readonly credential?: string | undefined;
  }): Effect.fn.Return<S["Type"] | null, IssueTrackerError> {
    yield* Effect.annotateCurrentSpan({ "jira.operation": input.operation });
    const { site, email, token } = yield* credential(input.operation, input.credential);
    const url = `https://${site}.atlassian.net/rest/api/3${input.path}`;
    let request = HttpClientRequest.make(input.method)(url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.basicAuth(email, token),
      HttpClientRequest.setUrlParams(input.params ?? {}),
    );
    if (input.body !== undefined) {
      request = yield* HttpClientRequest.bodyJson(request, input.body).pipe(
        Effect.mapError((cause) =>
          fail(input.operation, "failed", "The request could not be encoded.", { cause }),
        ),
      );
    }
    const unreachable = (cause?: unknown) =>
      fail(input.operation, "failed", "Jira could not be reached.", { cause });
    const exchange = Effect.gen(function* () {
      const response = yield* httpClient.execute(request).pipe(Effect.mapError(unreachable));
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.flatMap(refusal(input.operation, response), Effect.fail);
      }
      if (input.schema === null) return null;
      return yield* HttpClientResponse.schemaBodyJson(input.schema)(response).pipe(
        Effect.mapError((cause) =>
          fail(input.operation, "failed", "Jira returned an unexpected body.", { cause }),
        ),
      );
    });
    // The deadline covers the body too: Jira can send its headers, then stall.
    return yield* exchange.pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(unreachable()),
      }),
    );
  });

  const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
    input: Omit<Parameters<typeof call<S>>[0], "schema"> & { readonly schema: S },
  ) => call(input) as Effect.Effect<S["Type"], IssueTrackerError>;
  const write = (input: Omit<Parameters<typeof call>[0], "schema">) =>
    call({ ...input, schema: null }).pipe(Effect.asVoid);

  const myself = (operation: string, given?: string) =>
    read({ operation, method: "GET", path: "/myself", schema: JiraUser, credential: given });

  const probe: JiraApi["Service"]["probe"] = Effect.fn("JiraApi.probe")(function* (given) {
    const { site } = yield* credential("probe", given);
    const user = yield* myself("probe", given);
    const projects: Array<{ readonly key: string; readonly name: string }> = [];
    // shortcut: stops at MAX_PROJECTS, page the picker itself if sites outgrow it.
    while (projects.length < MAX_PROJECTS) {
      const page = yield* read({
        operation: "probe",
        method: "GET",
        path: "/project/search",
        params: { startAt: String(projects.length), maxResults: "100", orderBy: "key" },
        schema: ProjectPage,
        credential: given,
      });
      projects.push(...page.values.map(({ key, name }) => ({ key, name })));
      if (page.isLast !== false || page.values.length === 0) break;
    }
    return { site, user, projects };
  });

  const getIssue: JiraApi["Service"]["getIssue"] = (key) =>
    read({
      operation: "getIssue",
      method: "GET",
      path: `/issue/${encodeURIComponent(key)}`,
      params: {
        fields: [...SUMMARY_FIELDS, "description"].join(","),
        expand: "changelog,transitions",
      },
      schema: JiraIssueDetail,
    }).pipe(
      Effect.map((issue): JiraIssueDetail | null => issue),
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => Effect.succeed(null),
      ),
    );

  const search: JiraApi["Service"]["search"] = Effect.fn("JiraApi.search")(function* (input) {
    const page = yield* read({
      operation: "listIssues",
      method: "POST",
      path: "/search/jql",
      body: {
        jql: input.jql,
        maxResults: input.limit,
        fields: SUMMARY_FIELDS,
        ...(input.cursor === undefined ? {} : { nextPageToken: input.cursor }),
      },
      schema: SearchPage,
    });
    return { issues: page.issues, nextCursor: page.nextPageToken ?? null };
  });

  const getComments: JiraApi["Service"]["getComments"] = Effect.fn("JiraApi.getComments")(
    function* (input) {
      return yield* read({
        operation: "getComments",
        method: "GET",
        path: `/issue/${encodeURIComponent(input.key)}/comment`,
        params: {
          startAt: String(input.startAt),
          maxResults: String(input.limit),
          orderBy: "-created",
        },
        schema: CommentPage,
      });
    },
  );

  const createIssue: JiraApi["Service"]["createIssue"] = Effect.fn("JiraApi.createIssue")(
    function* (fields) {
      const created = yield* read({
        operation: "createIssue",
        method: "POST",
        path: "/issue",
        body: { fields },
        schema: Created,
      });
      return created.key;
    },
  );

  const updateIssue: JiraApi["Service"]["updateIssue"] = Effect.fn("JiraApi.updateIssue")(
    function* (key, fields) {
      yield* write({
        operation: "updateIssue",
        method: "PUT",
        path: `/issue/${encodeURIComponent(key)}`,
        body: { fields },
      });
    },
  );

  const addComment: JiraApi["Service"]["addComment"] = Effect.fn("JiraApi.addComment")(
    function* (key, body) {
      yield* write({
        operation: "addComment",
        method: "POST",
        path: `/issue/${encodeURIComponent(key)}/comment`,
        body: { body },
      });
    },
  );

  const transition: JiraApi["Service"]["transition"] = Effect.fn("JiraApi.transition")(
    function* (key, id) {
      yield* write({
        operation: "transition",
        method: "POST",
        path: `/issue/${encodeURIComponent(key)}/transitions`,
        body: { transition: { id } },
      });
    },
  );

  const issueTypes: JiraApi["Service"]["issueTypes"] = Effect.fn("JiraApi.issueTypes")(
    function* (project) {
      const types = yield* read({
        operation: "issueTypes",
        method: "GET",
        path: `/issue/createmeta/${encodeURIComponent(project)}/issuetypes`,
        schema: IssueTypes,
      });
      return types.issueTypes;
    },
  );

  const assignableUsers: JiraApi["Service"]["assignableUsers"] = Effect.fn(
    "JiraApi.assignableUsers",
  )(function* (input) {
    return yield* read({
      operation: "assignableUsers",
      method: "GET",
      path: "/user/assignable/search",
      params: {
        maxResults: String(input.limit),
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.issueKey === undefined ? {} : { issueKey: input.issueKey }),
        ...(input.query === undefined ? {} : { query: input.query }),
      },
      schema: Schema.Array(JiraUser),
    });
  });

  const labels: JiraApi["Service"]["labels"] = Effect.fn("JiraApi.labels")(function* (limit) {
    const page = yield* read({
      operation: "labels",
      method: "GET",
      path: "/label",
      params: { maxResults: String(limit) },
      schema: Labels,
    });
    return { values: page.values, truncated: page.isLast === false };
  });

  return JiraApi.of({
    site: credential("site").pipe(Effect.map(({ site }) => site)),
    probe,
    myself: myself("myself"),
    search,
    getIssue,
    getComments,
    createIssue,
    updateIssue,
    addComment,
    transition,
    issueTypes,
    assignableUsers,
    labels,
  });
});

export const layer = Layer.effect(JiraApi, make);
