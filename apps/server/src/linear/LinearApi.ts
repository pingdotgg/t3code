import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  LinearAuthError,
  LinearRequestError,
  LinearTokenStoreError,
  type LinearApiOperation,
  type LinearAttachment,
  type LinearAuthStatus,
  type LinearComment,
  type LinearIssueDetail,
  type LinearIssueSummary,
  type LinearLinkedPullRequest,
  type LinearSubIssue,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const DEFAULT_API_BASE_URL = "https://api.linear.app/graphql";

/** Secret-store key holding the Linear personal access token. */
export const LINEAR_API_TOKEN_SECRET = "linear.api-token";

/** How many linked issues/comments/attachments to request per issue. */
const ISSUE_RELATION_LIMIT = 50;

const LinearApiEnvConfig = Config.all({
  baseUrl: Config.string("T3CODE_LINEAR_API_BASE_URL").pipe(
    Config.withDefault(DEFAULT_API_BASE_URL),
  ),
  envToken: Config.string("T3CODE_LINEAR_API_TOKEN").pipe(Config.option),
});

// ── GraphQL response schemas (partial — excess keys are ignored) ─────

const GraphQlErrorEntry = Schema.Struct({
  message: Schema.optional(Schema.String),
});

const NamedNode = Schema.Struct({ name: Schema.optional(Schema.String) });

const RawViewer = Schema.Struct({
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});

const RawIssueSummary = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  priorityLabel: Schema.optional(Schema.String),
  state: Schema.optional(Schema.NullOr(NamedNode)),
  assignee: Schema.optional(Schema.NullOr(NamedNode)),
  team: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.optional(Schema.String) }))),
});

const RawIssueConnection = Schema.Struct({
  nodes: Schema.Array(RawIssueSummary),
});

const RawIssueDetail = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  priorityLabel: Schema.optional(Schema.String),
  state: Schema.optional(Schema.NullOr(NamedNode)),
  assignee: Schema.optional(Schema.NullOr(NamedNode)),
  team: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.optional(Schema.String) }))),
  labels: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(NamedNode) }))),
  children: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            identifier: Schema.String,
            title: Schema.optional(Schema.String),
            state: Schema.optional(Schema.NullOr(NamedNode)),
          }),
        ),
      }),
    ),
  ),
  attachments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            title: Schema.optional(Schema.String),
            url: Schema.optional(Schema.String),
            sourceType: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    ),
  ),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            body: Schema.optional(Schema.String),
            createdAt: Schema.optional(Schema.String),
            user: Schema.optional(Schema.NullOr(NamedNode)),
          }),
        ),
      }),
    ),
  ),
});

const viewerEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(Schema.Struct({ viewer: Schema.optional(Schema.NullOr(RawViewer)) })),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

const searchEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        searchIssues: Schema.optional(Schema.NullOr(RawIssueConnection)),
        issues: Schema.optional(Schema.NullOr(RawIssueConnection)),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

const issueEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(Schema.Struct({ issue: Schema.optional(Schema.NullOr(RawIssueDetail)) })),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

// ── GraphQL documents ────────────────────────────────────────────────

const SUMMARY_FIELDS = `id identifier title url priorityLabel state { name } assignee { name } team { key }`;

const SEARCH_DOCUMENT = `query T3CodeLinearSearch($term: String!, $first: Int!) {
  searchIssues(term: $term, first: $first) { nodes { ${SUMMARY_FIELDS} } }
}`;

const RECENT_DOCUMENT = `query T3CodeLinearRecent($first: Int!) {
  issues(first: $first, orderBy: updatedAt) { nodes { ${SUMMARY_FIELDS} } }
}`;

const ISSUE_DOCUMENT = `query T3CodeLinearIssue($id: String!, $relations: Int!) {
  issue(id: $id) {
    id identifier title url description priorityLabel
    state { name }
    assignee { name }
    team { key }
    labels(first: $relations) { nodes { name } }
    children(first: $relations) { nodes { identifier title state { name } } }
    attachments(first: $relations) { nodes { title url sourceType } }
    comments(first: $relations) { nodes { body createdAt user { name } } }
  }
}`;

const VIEWER_DOCUMENT = `query T3CodeLinearViewer { viewer { name email } }`;

// ── Helpers ──────────────────────────────────────────────────────────

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const PULL_REQUEST_URL_PATTERN =
  /(github\.com\/[^/]+\/[^/]+\/pull\/\d+)|(\/-\/merge_requests\/\d+)|(bitbucket\.org\/[^/]+\/[^/]+\/pull-requests\/\d+)/i;

function isPullRequestAttachment(url: string | undefined): boolean {
  // A Linear attachment is only treated as a linked PR when its URL matches a
  // known pull/merge-request path. The `sourceType` (e.g. "github") is too
  // broad on its own — it also covers commit and file links.
  return url !== undefined && PULL_REQUEST_URL_PATTERN.test(url);
}

function toSummary(raw: typeof RawIssueSummary.Type): LinearIssueSummary {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: clean(raw.title) ?? raw.identifier,
    url: raw.url ?? "",
    stateName: clean(raw.state?.name),
    priorityLabel: clean(raw.priorityLabel),
    assigneeName: clean(raw.assignee?.name),
    teamKey: clean(raw.team?.key),
  };
}

function toDetail(raw: typeof RawIssueDetail.Type): LinearIssueDetail {
  const labels: Array<string> = [];
  for (const label of raw.labels?.nodes ?? []) {
    const name = clean(label.name);
    if (name !== undefined) labels.push(name);
  }

  const subIssues: Array<LinearSubIssue> = (raw.children?.nodes ?? []).map((child) => ({
    identifier: child.identifier,
    title: clean(child.title) ?? child.identifier,
    stateName: clean(child.state?.name),
  }));

  const attachments: Array<LinearAttachment> = [];
  const linkedPullRequests: Array<LinearLinkedPullRequest> = [];
  for (const attachment of raw.attachments?.nodes ?? []) {
    const url = clean(attachment.url);
    if (url === undefined) continue;
    const title = clean(attachment.title);
    attachments.push({ url, title });
    if (isPullRequestAttachment(url)) {
      linkedPullRequests.push({ url, title });
    }
  }

  const comments: Array<LinearComment> = (raw.comments?.nodes ?? [])
    .map((comment) => ({
      author: clean(comment.user?.name),
      body: comment.body ?? "",
      createdAt: clean(comment.createdAt),
    }))
    .filter((comment) => comment.body.trim().length > 0);

  return {
    id: raw.id,
    identifier: raw.identifier,
    title: clean(raw.title) ?? raw.identifier,
    url: raw.url ?? "",
    stateName: clean(raw.state?.name),
    priorityLabel: clean(raw.priorityLabel),
    assigneeName: clean(raw.assignee?.name),
    teamKey: clean(raw.team?.key),
    description: raw.description ?? "",
    labels,
    subIssues,
    linkedPullRequests,
    attachments,
    comments,
  };
}

function firstGraphQlErrorMessage(
  errors: ReadonlyArray<typeof GraphQlErrorEntry.Type> | undefined,
): string | undefined {
  for (const entry of errors ?? []) {
    const message = clean(entry.message);
    if (message !== undefined) return message;
  }
  return undefined;
}

function isAuthMessage(message: string | undefined): boolean {
  if (message === undefined) return false;
  const lowered = message.toLowerCase();
  return (
    lowered.includes("authentication") ||
    lowered.includes("authorization") ||
    lowered.includes("unauthorized") ||
    lowered.includes("api key") ||
    lowered.includes("access token")
  );
}

// ── Service ──────────────────────────────────────────────────────────

export class LinearApi extends Context.Service<
  LinearApi,
  {
    readonly probeAuth: Effect.Effect<LinearAuthStatus, LinearTokenStoreError>;
    readonly searchIssues: (input: {
      readonly query: string;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly issues: ReadonlyArray<LinearIssueSummary>; readonly truncated: boolean },
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly fetchIssues: (input: {
      readonly ids: ReadonlyArray<string>;
    }) => Effect.Effect<
      ReadonlyArray<LinearIssueDetail>,
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly setToken: (token: string) => Effect.Effect<LinearAuthStatus, LinearTokenStoreError>;
    readonly clearToken: Effect.Effect<LinearAuthStatus, LinearTokenStoreError>;
  }
>()("t3/linear/LinearApi") {}

export const make = Effect.gen(function* () {
  const config = yield* LinearApiEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  const resolveToken = (
    operation: LinearApiOperation,
  ): Effect.Effect<Option.Option<string>, LinearTokenStoreError> =>
    secrets.get(LINEAR_API_TOKEN_SECRET).pipe(
      Effect.mapError(
        (cause) =>
          new LinearTokenStoreError({
            operation,
            detail: "Failed to read the stored Linear token.",
            cause,
          }),
      ),
      Effect.map(
        Option.match({
          onSome: (bytes) => {
            const token = clean(bytesToString(bytes));
            return token !== undefined ? Option.some(token) : config.envToken;
          },
          onNone: () => config.envToken,
        }),
      ),
    );

  const requireToken = (operation: LinearApiOperation) =>
    resolveToken(operation).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new LinearAuthError({
                operation,
                detail: "Connect Linear in Settings to continue.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const runGraphql = <S extends Schema.Top>(
    operation: LinearApiOperation,
    token: string,
    document: string,
    variables: Record<string, unknown>,
    envelopeSchema: S,
  ): Effect.Effect<S["Type"], LinearAuthError | LinearRequestError, S["DecodingServices"]> => {
    const request = HttpClientRequest.post(config.baseUrl).pipe(
      HttpClientRequest.setHeader("authorization", token),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({ query: document, variables }),
    );
    return httpClient.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new LinearRequestError({
            operation,
            detail: "Failed to reach the Linear API.",
            cause,
          }),
      ),
      Effect.flatMap((response) =>
        HttpClientResponse.matchStatus({
          "2xx": (success) =>
            HttpClientResponse.schemaBodyJson(envelopeSchema)(success).pipe(
              Effect.mapError(
                (cause) =>
                  new LinearRequestError({
                    operation,
                    status: success.status,
                    detail: "Linear returned a response that could not be decoded.",
                    cause,
                  }),
              ),
            ),
          orElse: (failed) =>
            failed.status === 401 || failed.status === 403
              ? Effect.fail(
                  new LinearAuthError({
                    operation,
                    detail: "Linear rejected the API token.",
                  }),
                )
              : Effect.fail(
                  new LinearRequestError({
                    operation,
                    status: failed.status,
                    detail: `Linear returned HTTP ${failed.status}.`,
                  }),
                ),
        })(response),
      ),
    );
  };

  const failFromGraphQlErrors = (
    operation: LinearApiOperation,
    errors: ReadonlyArray<typeof GraphQlErrorEntry.Type> | undefined,
  ): Effect.Effect<never, LinearAuthError | LinearRequestError> => {
    const message = firstGraphQlErrorMessage(errors);
    return isAuthMessage(message)
      ? Effect.fail(new LinearAuthError({ operation, ...(message ? { detail: message } : {}) }))
      : Effect.fail(
          new LinearRequestError({
            operation,
            detail: message ?? "Linear reported an error for the request.",
          }),
        );
  };

  const probeAuth: LinearApi["Service"]["probeAuth"] = resolveToken("probeAuth").pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed<LinearAuthStatus>({
            status: "unauthenticated",
            detail: "No Linear API token is configured.",
          }),
        onSome: (token) =>
          runGraphql("probeAuth", token, VIEWER_DOCUMENT, {}, viewerEnvelope).pipe(
            Effect.map((envelope): LinearAuthStatus => {
              if (envelope.errors !== undefined && envelope.errors.length > 0) {
                return {
                  status: "unauthenticated",
                  detail: "The stored Linear token was rejected.",
                };
              }
              const viewer = envelope.data?.viewer ?? undefined;
              const name = clean(viewer?.name);
              return {
                status: "authenticated",
                account: {
                  name: name ?? "Linear account",
                  ...(clean(viewer?.email) ? { email: clean(viewer?.email) } : {}),
                },
              };
            }),
            Effect.orElseSucceed(
              (): LinearAuthStatus => ({
                status: "unauthenticated",
                detail: "The stored Linear token was rejected.",
              }),
            ),
          ),
      }),
    ),
  );

  const searchIssues: LinearApi["Service"]["searchIssues"] = (input) => {
    const term = input.query.trim();
    return requireToken("searchIssues").pipe(
      Effect.flatMap((token) =>
        term.length === 0
          ? runGraphql(
              "searchIssues",
              token,
              RECENT_DOCUMENT,
              { first: input.limit },
              searchEnvelope,
            )
          : runGraphql(
              "searchIssues",
              token,
              SEARCH_DOCUMENT,
              { term, first: input.limit },
              searchEnvelope,
            ),
      ),
      Effect.flatMap((envelope) => {
        if (envelope.errors !== undefined && envelope.errors.length > 0) {
          return failFromGraphQlErrors("searchIssues", envelope.errors);
        }
        const connection = envelope.data?.searchIssues ?? envelope.data?.issues ?? null;
        const nodes = connection?.nodes ?? [];
        return Effect.succeed({
          issues: nodes.map(toSummary),
          truncated: nodes.length >= input.limit,
        });
      }),
    );
  };

  const fetchIssue = (
    token: string,
    id: string,
  ): Effect.Effect<LinearIssueDetail | null, LinearAuthError | LinearRequestError> =>
    runGraphql(
      "fetchIssues",
      token,
      ISSUE_DOCUMENT,
      { id, relations: ISSUE_RELATION_LIMIT },
      issueEnvelope,
    ).pipe(
      Effect.flatMap((envelope) => {
        if (envelope.errors !== undefined && envelope.errors.length > 0) {
          return failFromGraphQlErrors("fetchIssues", envelope.errors);
        }
        const issue = envelope.data?.issue ?? null;
        return Effect.succeed(issue === null ? null : toDetail(issue));
      }),
    );

  const fetchIssues: LinearApi["Service"]["fetchIssues"] = (input) =>
    requireToken("fetchIssues").pipe(
      Effect.flatMap((token) =>
        Effect.forEach(input.ids, (id) => fetchIssue(token, id), { concurrency: 4 }),
      ),
      Effect.map((results) =>
        results.filter((issue): issue is LinearIssueDetail => issue !== null),
      ),
    );

  const persistToken = (
    operation: LinearApiOperation,
    token: string,
  ): Effect.Effect<void, LinearTokenStoreError> =>
    secrets.set(LINEAR_API_TOKEN_SECRET, stringToBytes(token)).pipe(
      Effect.mapError(
        (cause) =>
          new LinearTokenStoreError({
            operation,
            detail: "Failed to store the Linear token.",
            cause,
          }),
      ),
    );

  const setToken: LinearApi["Service"]["setToken"] = (token) =>
    persistToken("setToken", token.trim()).pipe(Effect.flatMap(() => probeAuth));

  const clearToken: LinearApi["Service"]["clearToken"] = secrets
    .remove(LINEAR_API_TOKEN_SECRET)
    .pipe(
      Effect.mapError(
        (cause) =>
          new LinearTokenStoreError({
            operation: "clearToken",
            detail: "Failed to remove the Linear token.",
            cause,
          }),
      ),
      Effect.flatMap(() => probeAuth),
    );

  return LinearApi.of({
    probeAuth,
    searchIssues,
    fetchIssues,
    setToken,
    clearToken,
  });
});

export const layer = Layer.effect(LinearApi, make);
