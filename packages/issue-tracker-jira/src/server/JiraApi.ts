/**
 * Jira's REST API. An account email in the credential means Cloud (v3, basic auth); without one
 * it is Data Center (v2, bearer, no redirect followed) and answers are read into Cloud's shapes.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { IssueTrackerKind } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerCredential,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

export const KIND = IssueTrackerKind.make("jira");
const REQUEST_TIMEOUT = "30 seconds";
const PAGE = 100;
/** Pages read of a list that only feeds a picker; past it the list is reported truncated. */
const MAX_PAGES = 5;
const MAX_DETAIL = 300;
/** Data Center answers a redirect to be read, never followed: the token stays on its server. */
const NO_REDIRECT: RequestInit = { redirect: "manual" };

const UserProfile = {
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  emailAddress: Schema.optional(Schema.NullOr(Schema.String)),
  accountType: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrls: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
};

/** Cloud names a person by `accountId`; Data Center by login (`name`), or `key` on old accounts. */
const User = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  ...UserProfile,
}).pipe(
  Schema.check(
    Schema.makeFilter((user) => (user.accountId ?? user.name ?? user.key) !== undefined),
  ),
  Schema.decodeTo(
    Schema.Struct({ accountId: Schema.String, ...UserProfile }),
    SchemaTransformation.transform({
      decode: ({ accountId, name, key, ...profile }) => ({
        ...profile,
        accountId: (accountId ?? name ?? key)!,
      }),
      encode: (user) => user,
    }),
  ),
);
export type JiraUser = typeof User.Type;

const Status = Schema.Struct({
  name: Schema.String,
  statusCategory: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.String }))),
});
export type JiraStatus = typeof Status.Type;

const TransitionField = Schema.Struct({
  required: Schema.optional(Schema.Boolean),
  hasDefaultValue: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  // Jira's untyped `List<Object>`: any field on the screen, plugins' included, may send null,
  // strings or objects here, so only a name that is a string is read, by `allowedNames`.
  allowedValues: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
export type JiraTransitionField = typeof TransitionField.Type;

/** The names among a transition field's allowed values; values that carry none are skipped. */
export function allowedNames(field: JiraTransitionField): ReadonlyArray<string> {
  return (field.allowedValues ?? []).flatMap((value) =>
    typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
      ? [value.name]
      : [],
  );
}

const Transition = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  to: Status,
  /** What the move asks for; only read with `expand=transitions.fields`. */
  fields: Schema.optional(Schema.Record(Schema.String, TransitionField)),
});
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

const IssueProject = Schema.Struct({
  key: Schema.String,
  projectTypeKey: Schema.optional(Schema.String),
});

const Issue = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  fields: Schema.Struct({
    summary: Schema.String,
    status: Status,
    project: Schema.optional(IssueProject),
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

const ServerInfo = Schema.Struct({
  version: Schema.optional(Schema.String),
  versionNumbers: Schema.Array(Schema.Number),
});

/** Personal access tokens arrived in Jira 8.14. */
const MIN_DATA_CENTER: readonly [number, number] = [8, 14];

const belowMinimum = ([major = 0, minor = 0]: ReadonlyArray<number>) =>
  major < MIN_DATA_CENTER[0] || (major === MIN_DATA_CENTER[0] && minor < MIN_DATA_CENTER[1]);

type JiraSite =
  | {
      readonly deployment: "cloud";
      readonly origin: string;
      readonly email: string;
      readonly token: string;
    }
  | { readonly deployment: "datacenter"; readonly origin: string; readonly token: string };

export type Deployment = JiraSite["deployment"];

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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A Data Center server as requests go to it: https, or http on this machine only, since the token
 * rides on every request. The host's own port and context path (`https://example.com/jira`) stay;
 * credentials, query, fragment and a trailing slash do not.
 */
export function serverOrigin(server: string): string | null {
  const url = URL.parse(server.trim());
  if (
    url === null ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && LOOPBACK.has(url.hostname.toLowerCase()))) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/** An account email makes the site Jira Cloud; without one it is a Data Center server. */
const toSite = (operation: string, credential: IssueTrackerCredential) => {
  const email = credential.fields["email"]?.trim() ?? "";
  if (email.length === 0) {
    const origin = serverOrigin(credential.fields["site"] ?? "");
    if (origin === null) {
      return Effect.fail(
        fail(
          operation,
          "unauthenticated",
          "Enter the Data Center server as https://jira.example.com, or add the account email for Jira Cloud.",
        ),
      );
    }
    if (URL.parse(origin)?.hostname.endsWith(".atlassian.net") === true) {
      return Effect.fail(fail(operation, "unauthenticated", "Jira Cloud needs the account email."));
    }
    return Effect.succeed<JiraSite>({ deployment: "datacenter", origin, token: credential.token });
  }
  const origin = siteOrigin(credential.fields["site"] ?? "");
  if (origin === null) {
    return Effect.fail(
      fail(operation, "unauthenticated", "Enter the Jira site as yourteam.atlassian.net."),
    );
  }
  return Effect.succeed<JiraSite>({ deployment: "cloud", origin, email, token: credential.token });
};

/** Where a credential's requests go, by the same rule as `toSite`. */
export const credentialOrigin = (credential: IssueTrackerCredential) =>
  (credential.fields["email"]?.trim() ? siteOrigin : serverOrigin)(credential.fields["site"] ?? "");

function retryAt(value: string | undefined, now: number): number | undefined {
  const seconds = /^\d+$/u.test(value?.trim() ?? "") ? Number(value) : Number.NaN;
  return Number.isSafeInteger(seconds) ? now + seconds * 1_000 : undefined;
}

/**
 * The server address a redirect names. The redirect points at the route that was asked for, so
 * the address is what comes before `/rest/api/2`; without one, only the origin is trusted.
 */
function movedTo(requestUrl: string, location: string | undefined): string {
  const url = location?.trim() ? URL.parse(location, requestUrl) : null;
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return "another address";
  }
  const at = url.pathname.indexOf("/rest/api/2");
  const address = at === -1 ? url.origin : `${url.origin}${url.pathname.slice(0, at)}`;
  return address.length > MAX_DETAIL ? `${address.slice(0, MAX_DETAIL)}…` : address;
}

/** Login failures Data Center reports in `X-Seraph-LoginReason`, lower case. */
const SIGNED_OUT_REASONS = ["authentication_denied", "authenticated_failed", "out"];

/**
 * A proxy or SSO front end answers a rejected token with its own page, or a 200 for anonymous.
 * A request sent without the token is anonymous by design.
 */
const isSignInPage = (response: HttpClientResponse.HttpClientResponse, signed: boolean) =>
  (signed && response.headers["x-ausername"] === "anonymous") ||
  (response.headers["content-type"] ?? "").toLowerCase().includes("text/html");

type Query = Readonly<Record<string, string | number | undefined>>;

export class JiraApi extends Context.Service<
  JiraApi,
  {
    /** The site issues are linked on. Fails when Jira is not connected. */
    readonly origin: Effect.Effect<string, IssueTrackerError>;
    /** Which Jira the stored credential reaches. Fails when Jira is not connected. */
    readonly deployment: Effect.Effect<Deployment, IssueTrackerError>;
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
    /** Which of the named permissions the account holds on the issue. Cloud only. */
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
    /** The moves open to the account, with the fields each asks for. */
    readonly transitions: (
      key: string,
    ) => Effect.Effect<ReadonlyArray<JiraTransition>, IssueTrackerError>;
    readonly transition: (
      key: string,
      id: string,
      fields?: Record<string, unknown>,
    ) => Effect.Effect<void, IssueTrackerError>;
    /** A document on Cloud, wiki markup on Data Center. */
    readonly addComment: (key: string, body: unknown) => Effect.Effect<void, IssueTrackerError>;
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

  /** Runs the branch for the Jira a credential reaches: the stored one, or one being vetted. */
  const byDeployment = <A>(
    operation: string,
    credential: IssueTrackerCredential | undefined,
    branches: Readonly<Record<Deployment, () => Effect.Effect<A, IssueTrackerError>>>,
  ) =>
    (credential === undefined ? storedSite(operation) : toSite(operation, credential)).pipe(
      Effect.flatMap((site) => branches[site.deployment]()),
    );

  const refusal = Effect.fn("JiraApi.refusal")(function* (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
    deployment: Deployment,
  ): Effect.fn.Return<never, IssueTrackerError> {
    const now = yield* Clock.currentTimeMillis;
    if (deployment === "datacenter" && response.status >= 300 && response.status < 400) {
      return yield* response.status === 301 || response.status === 308
        ? fail(
            operation,
            "failed",
            `Jira moved to ${movedTo(response.request.url, response.headers["location"])}. Connect with that address as the server URL.`,
          )
        : fail(operation, "unauthenticated", "Jira sent the request to a sign-in page.");
    }
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
      return yield* fail(
        operation,
        "unauthenticated",
        deployment === "cloud"
          ? "Jira rejected the email or API token."
          : "Jira rejected the access token.",
      );
    }
    // Several reasons arrive as one comma-separated value: `OUT, AUTHENTICATION_DENIED`.
    const loginReasons = (response.headers["x-seraph-loginreason"] ?? "")
      .toLowerCase()
      .split(",")
      .map((reason) => reason.trim());
    if (
      deployment === "datacenter" &&
      response.status === 403 &&
      loginReasons.some((reason) => SIGNED_OUT_REASONS.includes(reason))
    ) {
      return yield* fail(
        operation,
        "unauthenticated",
        "Jira refused to sign in with the access token.",
      );
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
      /** Below the REST root of the site's API version. */
      readonly path: string;
      readonly query?: Query;
      readonly body?: unknown;
      readonly credential?: IssueTrackerCredential | undefined;
      /** Sent without the credential, for what Jira answers anyone. */
      readonly anonymous?: boolean;
    },
  ): Effect.fn.Return<S["Type"], IssueTrackerError, S["DecodingServices"]> {
    yield* Effect.annotateCurrentSpan({ "jira.operation": operation });
    const site =
      request.credential === undefined
        ? yield* storedSite(operation)
        : yield* toSite(operation, request.credential);
    const base = HttpClientRequest.make(request.method)(
      `${site.origin}${site.deployment === "cloud" ? "/rest/api/3" : "/rest/api/2"}${request.path}`,
      {
        urlParams: Object.entries(request.query ?? {}).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, String(value)] as const],
        ),
      },
    ).pipe(
      HttpClientRequest.acceptJson,
      request.anonymous === true
        ? (unsigned) => unsigned
        : site.deployment === "cloud"
          ? HttpClientRequest.basicAuth(site.email, site.token)
          : HttpClientRequest.bearerToken(site.token),
    );
    const unreachable = (cause: unknown) =>
      fail(operation, "failed", "Jira could not be reached.", { cause });
    const execution = httpClient
      .execute(
        request.body === undefined
          ? base
          : base.pipe(HttpClientRequest.bodyJsonUnsafe(request.body)),
      )
      .pipe(
        // Client spans carry the query string, which holds names searched for.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      );
    // The deadline covers the body too: a site can send its headers and then stall.
    return yield* Effect.gen(function* () {
      const response = yield* (
        site.deployment === "cloud"
          ? execution
          : execution.pipe(Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT))
      ).pipe(Effect.mapError(unreachable));
      if (response.status < 200 || response.status >= 300) {
        return yield* refusal(operation, response, site.deployment);
      }
      if (site.deployment === "datacenter" && isSignInPage(response, request.anonymous !== true)) {
        return yield* fail(operation, "unauthenticated", "Jira did not accept the access token.");
      }
      // A write answers 204 with no body; `Schema.Void` reads nothing.
      if (response.status === 204) return undefined as S["Type"];
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError((cause) =>
          fail(operation, "failed", "Jira returned an unexpected body.", { cause }),
        ),
      );
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((error) => (Cause.isTimeoutError(error) ? unreachable(error) : error)),
    );
  });

  /**
   * Reads `startAt` pages until Jira has no more or the cap is reached. A `filtered` endpoint
   * drops entries after paging, so only an empty page ends it.
   */
  const paged = Effect.fn("JiraApi.paged")(function* <A>(
    read: (startAt: number) => Effect.Effect<ReadonlyArray<A>, IssueTrackerError>,
    filtered = false,
  ): Effect.fn.Return<
    { readonly items: ReadonlyArray<A>; readonly truncated: boolean },
    IssueTrackerError
  > {
    const items: A[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = yield* read(page * PAGE);
      items.push(...batch);
      if (filtered ? batch.length === 0 : batch.length < PAGE) return { items, truncated: false };
    }
    return { items, truncated: true };
  });

  const me = (credential: IssueTrackerCredential | undefined) =>
    send("myself", User, { method: "GET", path: "/myself", credential });

  // A server too old for access tokens rejects one with a bare 401, so connecting names the version.
  // Jira answers `serverInfo` without sign-in; when a proxy hides it, `/myself` decides.
  const supportedServer = (credential: IssueTrackerCredential) =>
    send("myself", ServerInfo, {
      method: "GET",
      path: "/serverInfo",
      credential,
      anonymous: true,
    }).pipe(
      Effect.option,
      Effect.flatMap((info) =>
        Option.isSome(info) && belowMinimum(info.value.versionNumbers)
          ? Effect.fail(
              fail(
                "myself",
                "failed",
                `Jira ${info.value.version ?? info.value.versionNumbers.join(".")} has no personal access tokens. T3 Code needs Jira Data Center 8.14 or later.`,
              ),
            )
          : Effect.void,
      ),
    );

  const myself: JiraApi["Service"]["myself"] = (credential) =>
    credential === undefined
      ? me(undefined)
      : byDeployment("myself", credential, {
          cloud: () => me(credential),
          datacenter: () => supportedServer(credential).pipe(Effect.andThen(me(credential))),
        });

  const projects: JiraApi["Service"]["projects"] = (credential) =>
    byDeployment("projects", credential, {
      cloud: () =>
        paged((startAt) =>
          send(
            "projects",
            Schema.Struct({
              values: Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String })),
            }),
            {
              method: "GET",
              path: "/project/search",
              query: { startAt, maxResults: PAGE, orderBy: "name" },
              credential,
            },
          ).pipe(Effect.map((page) => page.values)),
        ).pipe(Effect.map((page) => page.items)),
      datacenter: () =>
        send("projects", Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String })), {
          method: "GET",
          path: "/project",
          credential,
        }),
    });

  const search: JiraApi["Service"]["search"] = (input) =>
    byDeployment("search", undefined, {
      cloud: () =>
        send(
          "search",
          Schema.Struct({
            issues: Schema.Array(Issue),
            nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
          }),
          {
            method: "POST",
            path: "/search/jql",
            body: {
              jql: input.jql,
              maxResults: input.limit,
              fields: ISSUE_FIELDS,
              ...(input.pageToken === undefined ? {} : { nextPageToken: input.pageToken }),
            },
          },
        ).pipe(
          Effect.map((page) => ({
            issues: page.issues,
            nextPageToken: page.nextPageToken ?? null,
          })),
        ),
      // Data Center pages by offset, which is the token it hands back.
      datacenter: () => {
        const offset = Number(input.pageToken ?? 0);
        const startAt = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
        return send(
          "search",
          Schema.Struct({ total: Schema.Number, issues: Schema.Array(Issue) }),
          {
            method: "POST",
            path: "/search",
            body: {
              jql: input.jql,
              startAt,
              maxResults: input.limit,
              // A `key = X` clause for an issue that does not exist is a 400 under strict validation.
              validateQuery: false,
              fields: ISSUE_FIELDS,
            },
          },
        ).pipe(
          Effect.map((page) => {
            const reached = startAt + page.issues.length;
            return {
              issues: page.issues,
              nextPageToken:
                page.issues.length > 0 && reached < page.total ? String(reached) : null,
            };
          }),
        );
      },
    });

  const getIssue: JiraApi["Service"]["getIssue"] = (key) =>
    send("getIssue", Issue, {
      method: "GET",
      path: `/issue/${encodeURIComponent(key)}`,
      query: {
        fields: [...ISSUE_FIELDS, "description"].join(","),
        expand: "transitions,transitions.fields,changelog",
      },
    });

  const getComments: JiraApi["Service"]["getComments"] = (input) =>
    send("getComments", Schema.Struct({ comments: Schema.Array(Comment), total: Schema.Number }), {
      method: "GET",
      path: `/issue/${encodeURIComponent(input.key)}/comment`,
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
        path: "/mypermissions",
        query: { issueKey: key, permissions: names.join(",") },
      },
    ).pipe(
      Effect.map((answer) =>
        Object.fromEntries(
          names.map((name) => [name, answer.permissions[name]?.havePermission === true]),
        ),
      ),
    );

  const issueTypes: JiraApi["Service"]["issueTypes"] = (project) => {
    const type = Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      subtask: Schema.optional(Schema.Boolean),
    });
    return send(
      "issueTypes",
      // Data Center answers `values`; the same route on Cloud answers `issueTypes`.
      Schema.Struct({
        issueTypes: Schema.optional(Schema.Array(type)),
        values: Schema.optional(Schema.Array(type)),
      }),
      {
        method: "GET",
        path: `/issue/createmeta/${encodeURIComponent(project)}/issuetypes`,
        query: { maxResults: PAGE },
      },
    ).pipe(
      Effect.map((answer) =>
        (answer.issueTypes ?? answer.values ?? []).map((candidate) => ({
          ...candidate,
          subtask: candidate.subtask === true,
        })),
      ),
    );
  };

  const createIssue: JiraApi["Service"]["createIssue"] = (fields) =>
    send("createIssue", Schema.Struct({ key: Schema.String }), {
      method: "POST",
      path: "/issue",
      body: { fields },
    });

  const updateIssue: JiraApi["Service"]["updateIssue"] = (key, fields) =>
    send("updateIssue", Schema.Void, {
      method: "PUT",
      path: `/issue/${encodeURIComponent(key)}`,
      body: { fields },
    });

  const transitions: JiraApi["Service"]["transitions"] = (key) =>
    send("transitions", Schema.Struct({ transitions: Schema.Array(Transition) }), {
      method: "GET",
      path: `/issue/${encodeURIComponent(key)}/transitions`,
      query: { expand: "transitions.fields" },
    }).pipe(Effect.map((answer) => answer.transitions));

  const transition: JiraApi["Service"]["transition"] = (key, id, fields) =>
    send("transition", Schema.Void, {
      method: "POST",
      path: `/issue/${encodeURIComponent(key)}/transitions`,
      body: { transition: { id }, ...(fields === undefined ? {} : { fields }) },
    });

  const addComment: JiraApi["Service"]["addComment"] = Effect.fn("JiraApi.addComment")(
    function* (key, body) {
      const issue = yield* send(
        "addComment",
        Schema.Struct({ fields: Schema.Struct({ project: Schema.optional(IssueProject) }) }),
        {
          method: "GET",
          path: `/issue/${encodeURIComponent(key)}`,
          query: { fields: "project" },
        },
      );
      // A service desk comment is a reply the customer sees unless marked internal.
      const internal = issue.fields.project?.projectTypeKey === "service_desk";
      yield* send("addComment", Schema.Unknown, {
        method: "POST",
        path: `/issue/${encodeURIComponent(key)}/comment`,
        body: internal
          ? { body, properties: [{ key: "sd.public.comment", value: { internal: true } }] }
          : { body },
      });
    },
  );

  const labels: JiraApi["Service"]["labels"] = byDeployment("labels", undefined, {
    cloud: () =>
      paged((startAt) =>
        send("labels", Schema.Struct({ values: Schema.Array(Schema.String) }), {
          method: "GET",
          path: "/label",
          query: { startAt, maxResults: PAGE },
        }).pipe(Effect.map((page) => page.values)),
      ).pipe(Effect.map((page) => ({ names: page.items, truncated: page.truncated }))),
    // Data Center has no label list; its JQL autocomplete suggests a capped few.
    datacenter: () =>
      send(
        "labels",
        Schema.Struct({
          results: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String }))),
        }),
        {
          method: "GET",
          path: "/jql/autocompletedata/suggestions",
          query: { fieldName: "labels", fieldValue: "" },
        },
      ).pipe(
        Effect.map((answer) => ({
          names: (answer.results ?? []).map((result) => result.value),
          truncated: true,
        })),
      ),
  });

  const assignable: JiraApi["Service"]["assignable"] = (project) =>
    byDeployment("assignable", undefined, {
      cloud: () =>
        paged(
          (startAt) =>
            send("assignable", Schema.Array(User), {
              method: "GET",
              path: "/user/assignable/search",
              query: { project, startAt, maxResults: PAGE },
            }),
          // Jira drops users the caller may not see after paging, so a short page is not the last.
          true,
        ).pipe(Effect.map((page) => ({ users: page.items, truncated: page.truncated }))),
      datacenter: () =>
        send("assignable", Schema.Array(User), {
          method: "GET",
          path: "/user/assignable/search",
          // An empty `username` asks for everyone assignable.
          query: { project, username: "", maxResults: PAGE },
        }).pipe(Effect.map((users) => ({ users, truncated: users.length >= PAGE }))),
    });

  const findUsers: JiraApi["Service"]["findUsers"] = (query) =>
    byDeployment("findUsers", undefined, {
      cloud: () =>
        send("findUsers", Schema.Array(User), {
          method: "GET",
          path: "/user/search",
          query: { query, maxResults: 20 },
        }),
      datacenter: () =>
        send("findUsers", Schema.Array(User), {
          method: "GET",
          path: "/user/search",
          query: { username: query, maxResults: 20 },
        }),
    });

  return JiraApi.of({
    origin: storedSite("origin").pipe(Effect.map((site) => site.origin)),
    deployment: storedSite("deployment").pipe(Effect.map((site) => site.deployment)),
    myself,
    projects,
    search,
    getIssue,
    getComments,
    permissions,
    issueTypes,
    createIssue,
    updateIssue,
    transitions,
    transition,
    addComment,
    labels,
    assignable,
    findUsers,
  });
});

export const layer = Layer.effect(JiraApi, make);
