import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type {
  IssueListState,
  IssueListOrder,
  IssueInvolvement,
  IssueTrackerAccount,
  IssueTrackerConnection,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

const API_URL = "https://api.linear.app/graphql";
const MAX_PAGE = 150;
const ISSUE_COMPLEXITY = 5_000;

const LINEAR_CREDENTIALS_SECRET = "issue-trackers.linear.credentials";

const Credential = Schema.Struct({
  credentialId: Schema.String,
  token: Schema.String,
});
const CredentialPool = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(Credential),
});
type Credential = typeof Credential.Type;
const CredentialPoolJson = Schema.fromJsonString(CredentialPool);
const decodeCredentialPool = Schema.decodeUnknownEffect(CredentialPoolJson);
const encodeCredentialPool = Schema.encodeSync(CredentialPoolJson);

const ApiConfig = Config.all({
  baseUrl: Config.String("T3CODE_LINEAR_API_BASE_URL").pipe(Config.withDefault(API_URL)),
  envToken: Config.String("T3CODE_LINEAR_API_TOKEN").pipe(Config.option),
});

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});
const Team = Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String });
const State = Schema.Struct({ name: Schema.String, type: Schema.String });
const Label = Schema.Struct({ name: Schema.String, color: Schema.optional(Schema.String) });
const Reaction = Schema.Struct({
  id: Schema.String,
  emoji: Schema.String,
  user: Schema.optional(Schema.NullOr(User)),
});
const Comment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(User)),
  reactions: Schema.optional(Schema.NullOr(Schema.Array(Reaction))),
});

// Links Linear's GitHub/GitLab integrations record on an issue; `metadata` is integration-defined.
const Attachment = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  sourceType: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});
interface Relative {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly team: { readonly key: string };
  readonly state: typeof State.Type;
  readonly attachments?:
    | { readonly nodes: ReadonlyArray<typeof Attachment.Type> }
    | null
    | undefined;
  readonly parent?: Relative | null | undefined;
  readonly children?: { readonly nodes: ReadonlyArray<Relative> } | null | undefined;
}
const Relative: Schema.Codec<Relative> = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  team: Schema.Struct({ key: Schema.String }),
  state: State,
  attachments: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Attachment) }))),
  parent: Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<Relative> => Relative))),
  children: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(Schema.suspend((): Schema.Codec<Relative> => Relative)),
      }),
    ),
  ),
});
const Issue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  canceledAt: Schema.optional(Schema.NullOr(Schema.String)),
  state: State,
  creator: Schema.optional(Schema.NullOr(User)),
  assignee: Schema.optional(Schema.NullOr(User)),
  labels: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Label) }))),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(Comment),
        pageInfo: Schema.optional(Schema.Struct({ hasNextPage: Schema.Boolean })),
      }),
    ),
  ),
  reactions: Schema.optional(Schema.NullOr(Schema.Array(Reaction))),
  attachments: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Attachment) }))),
  parent: Schema.optional(Schema.NullOr(Relative)),
  children: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Relative) }))),
});

const GraphQlError = Schema.Struct({
  message: Schema.String,
  extensions: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
});
const Errors = { errors: Schema.optional(Schema.Array(GraphQlError)) };
const decodeGraphQlErrors = Schema.decodeUnknownEffect(Schema.Struct(Errors));
const readGraphQlErrors = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ errors: Schema.Array(GraphQlError) }),
);
const ConnectionEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({
    viewer: Schema.NullOr(User),
    teams: Schema.Struct({ nodes: Schema.Array(Team) }),
  }),
});
const ViewerEnvelope = Schema.Struct({ ...Errors, data: Schema.Struct({ viewer: User }) });
const isViewerEnvelope = Schema.is(ViewerEnvelope);
const ListEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(Issue),
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        hasPreviousPage: Schema.Boolean,
        startCursor: Schema.optional(Schema.NullOr(Schema.String)),
        endCursor: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    }),
  }),
});
const IssueEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({ issue: Schema.NullOr(Issue) }),
});
const SummaryIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: State,
});
const SummaryEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({ issue: Schema.NullOr(SummaryIssue) }),
});
const ActivityEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({ viewer: User, issue: Schema.NullOr(Issue) }),
});
const ReactionLookupEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({
    viewer: User,
    issue: Schema.optional(Schema.NullOr(Schema.Struct({ reactions: Schema.Array(Reaction) }))),
    comment: Schema.optional(Schema.NullOr(Schema.Struct({ reactions: Schema.Array(Reaction) }))),
  }),
});
const MutationEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Record(Schema.String, Schema.Struct({ success: Schema.Boolean })),
});

const USER_FIELDS = "id name email avatarUrl";
const REACTION_FIELDS = `id emoji user { ${USER_FIELDS} }`;
// Three levels each way bounds the query's complexity; deeper relatives open from the tree.
const RELATIVE_FIELDS = "number title url team { key } state { name type }";
// Pull requests only on the levels nearest the issue, which keeps the query under Linear's cost limit.
const RELATIVE_WITH_PULL_REQUESTS = `${RELATIVE_FIELDS} attachments(first: 5) { nodes { url title sourceType metadata } }`;
const ISSUE_FIELDS = `
  id identifier number title url description createdAt updatedAt completedAt canceledAt
  state { name type }
  creator { ${USER_FIELDS} }
  assignee { ${USER_FIELDS} }
  labels { nodes { name color } }
`;

const CONNECTION_QUERY = `query T3LinearConnection {
  viewer { ${USER_FIELDS} }
  teams(first: 250) { nodes { id key name } }
}`;
const VIEWER_QUERY = `query T3LinearViewer { viewer { ${USER_FIELDS} } }`;
const LIST_QUERY = `query T3LinearIssues($first: Int, $last: Int, $after: String, $before: String, $filter: IssueFilter!) {
  issues(first: $first, last: $last, after: $after, before: $before, filter: $filter, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
}`;
const ISSUE_QUERY = `query T3LinearIssue($id: String!) {
  issue(id: $id) {
    ${ISSUE_FIELDS}
    attachments(first: 50) { nodes { url title sourceType metadata } }
    parent { ${RELATIVE_WITH_PULL_REQUESTS} parent { ${RELATIVE_FIELDS} parent { ${RELATIVE_FIELDS} } } }
    children(first: 20) {
      nodes {
        ${RELATIVE_WITH_PULL_REQUESTS}
        children(first: 10) {
          nodes { ${RELATIVE_FIELDS} children(first: 5) { nodes { ${RELATIVE_FIELDS} } } }
        }
      }
    }
  }
}`;
const SUMMARY_QUERY = `query T3LinearIssueSummary($id: String!) {
  issue(id: $id) { number title url state { name type } }
}`;
const ACTIVITY_QUERY = `query T3LinearIssueActivity($id: String!, $comments: Int!) {
  viewer { id name email avatarUrl }
  issue(id: $id) {
    ${ISSUE_FIELDS}
    comments(first: $comments) {
      nodes { id body createdAt url user { ${USER_FIELDS} } reactions { ${REACTION_FIELDS} } }
      pageInfo { hasNextPage }
    }
    reactions { ${REACTION_FIELDS} }
  }
}`;
const COMMENT_MUTATION = `mutation T3LinearComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;
const REACTION_CREATE_MUTATION = `mutation T3LinearReactionCreate($input: ReactionCreateInput!) {
  reactionCreate(input: $input) { success }
}`;
const REACTION_DELETE_MUTATION = `mutation T3LinearReactionDelete($id: String!) {
  reactionDelete(id: $id) { success }
}`;
const ISSUE_REACTIONS_QUERY = `query T3LinearIssueReactions($id: String!) {
  viewer { id name email avatarUrl }
  issue(id: $id) { reactions { ${REACTION_FIELDS} } }
}`;
const COMMENT_REACTIONS_QUERY = `query T3LinearCommentReactions($id: String!) {
  viewer { id name email avatarUrl }
  comment(id: $id) { reactions { ${REACTION_FIELDS} } }
}`;
const QUERY_ENDPOINTS = new Map<string, ReadonlyArray<string>>([
  [CONNECTION_QUERY, ["viewer", "teams"]],
  [VIEWER_QUERY, ["viewer"]],
  [LIST_QUERY, ["issues"]],
  [ISSUE_QUERY, ["issue"]],
  [SUMMARY_QUERY, ["issue"]],
  [ACTIVITY_QUERY, ["viewer", "issue"]],
  [ISSUE_REACTIONS_QUERY, ["viewer", "issue"]],
  [COMMENT_REACTIONS_QUERY, ["viewer", "comment"]],
  [COMMENT_MUTATION, ["commentCreate"]],
  [REACTION_CREATE_MUTATION, ["reactionCreate"]],
  [REACTION_DELETE_MUTATION, ["reactionDelete"]],
]);

export class LinearApiError extends Schema.TaggedError<LinearApiError>()("LinearApiError", {
  operation: Schema.String,
  reason: Schema.Literals(["unauthenticated", "rate-limited", "failed"]),
  retryAt: Schema.optional(Schema.Finite),
  status: Schema.optional(Schema.Int),
  identifier: Schema.optional(Schema.String),
  connectedAccounts: Schema.optional(Schema.Int),
  projectId: Schema.optional(Schema.String),
  credentialId: Schema.optional(Schema.String),
  teamKey: Schema.optional(Schema.String),
  bindingRejection: Schema.optional(
    Schema.Literals([
      "unknown-credential",
      "account-unavailable",
      "team-unavailable",
      "environment-account-unavailable",
    ]),
  ),
  cause: Schema.optional(Schema.Defect()),
}) {
  get detail(): string {
    if (this.reason === "rate-limited")
      return "Linear requests are paused until the rate limit resets.";
    if (this.reason === "unauthenticated") {
      return `Linear authentication failed during ${this.operation}.`;
    }
    if (this.status !== undefined)
      return `Linear ${this.operation} failed with HTTP ${this.status}.`;
    if (this.identifier !== undefined) return `Linear issue ${this.identifier} was not found.`;
    if (this.bindingRejection === "unknown-credential")
      return `Linear account ${this.credentialId} is not connected for project ${this.projectId}.`;
    if (this.bindingRejection === "account-unavailable")
      return `Linear account ${this.credentialId} is unavailable for project ${this.projectId}.`;
    if (this.bindingRejection === "team-unavailable")
      return `Linear team ${this.teamKey} is unavailable to account ${this.credentialId} for project ${this.projectId}.`;
    if (this.bindingRejection === "environment-account-unavailable")
      return `Linear environment account cannot use team ${this.teamKey} for project ${this.projectId}.`;
    return `Linear ${this.operation} failed.`;
  }

  override get message(): string {
    return `Linear failed in ${this.operation}: ${this.detail}`;
  }
}
export const isLinearApiError = Schema.is(LinearApiError);

export type LinearUser = typeof User.Type;
export type LinearIssue = typeof Issue.Type;
export type LinearAttachment = typeof Attachment.Type;
export type LinearRelative = Relative;
export type LinearComment = typeof Comment.Type;
export type LinearReaction = typeof Reaction.Type;
export class LinearApi extends Context.Service<
  LinearApi,
  {
    readonly connection: Effect.Effect<IssueTrackerConnection, LinearApiError>;
    readonly connect: (token: string) => Effect.Effect<IssueTrackerConnection, LinearApiError>;
    readonly disconnect: (input: {
      readonly credentialId: string;
    }) => Effect.Effect<IssueTrackerConnection, LinearApiError>;
    readonly getViewer: (input: {
      readonly credentialId?: string;
    }) => Effect.Effect<LinearUser, LinearApiError>;
    readonly listIssues: (input: {
      readonly teamKey: string;
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly order?: IssueListOrder | undefined;
      readonly query?: string;
      readonly cursor?: ProviderListCursor | undefined;
      readonly credentialId?: string;
    }) => Effect.Effect<
      { readonly issues: ReadonlyArray<LinearIssue>; readonly truncated: boolean },
      LinearApiError
    >;
    readonly getIssueSummary: (input: {
      readonly identifier: string;
      readonly credentialId?: string;
    }) => Effect.Effect<typeof SummaryIssue.Type, LinearApiError>;
    readonly getIssue: (input: {
      readonly identifier: string;
      readonly credentialId?: string;
    }) => Effect.Effect<LinearIssue, LinearApiError>;
    readonly getActivity: (input: {
      readonly identifier: string;
      readonly credentialId?: string;
    }) => Effect.Effect<
      {
        readonly viewerId: string;
        readonly comments: ReadonlyArray<LinearComment>;
        readonly reactions: ReadonlyArray<LinearReaction>;
        readonly commentsTruncated: boolean;
      },
      LinearApiError
    >;
    readonly comment: (input: {
      readonly issueId: string;
      readonly body: string;
      readonly credentialId?: string;
    }) => Effect.Effect<void, LinearApiError>;
    readonly setReaction: (input: {
      readonly issueId: string;
      readonly commentId?: string;
      readonly emoji: string;
      readonly reacted: boolean;
      readonly credentialId?: string;
    }) => Effect.Effect<void, LinearApiError>;
  }
>()("t3/issue/LinearApi") {}

const clean = (value: string | null | undefined) => value?.trim() || null;
const isAuthError = (error: typeof GraphQlError.Type) =>
  error.extensions?.code === "AUTHENTICATION_ERROR" ||
  /\b(authentication|unauthenticated|api key|access token)\b/i.test(error.message);

const make = Effect.gen(function* () {
  const config = yield* ApiConfig;
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const rateLimits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const rateLimitKey = { provider: "linear", host: new URL(config.baseUrl).host };
  const credentialPoolMutex = yield* Semaphore.make(1);
  // ponytail: one shared request slot; use per-account slots if throughput becomes a constraint.
  const requestGate = yield* Semaphore.make(1);
  const complexityBudgets = new Map<string, { remaining: number; reset: number }>();
  const documentCosts = new Map<string, number>();
  const verifiedTokenScopes = new Map<string, string>();
  const tokenEndpoints = new Map<string, Set<string>>();

  const readSecret = (name: string, operation: string) =>
    secrets.get(name).pipe(
      Effect.mapError(
        (cause) =>
          new LinearApiError({
            operation,
            reason: "failed",
            cause,
          }),
      ),
      Effect.map((value) => Option.map(value, (bytes) => new TextDecoder().decode(bytes).trim())),
    );
  const storedCredentials = readSecret(LINEAR_CREDENTIALS_SECRET, "read-accounts").pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<ReadonlyArray<Credential>>([]),
        onSome: (value) =>
          decodeCredentialPool(value).pipe(
            Effect.map((pool) => pool.credentials),
            Effect.mapError((cause) =>
              isLinearApiError(cause)
                ? cause
                : new LinearApiError({
                    operation: "read-accounts",
                    reason: "failed",
                    cause,
                  }),
            ),
          ),
      }),
    ),
  );
  const writeCredentials = (credentials: ReadonlyArray<Credential>) =>
    secrets
      .set(
        LINEAR_CREDENTIALS_SECRET,
        new TextEncoder().encode(encodeCredentialPool({ version: 1, credentials })),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new LinearApiError({
              operation: "save-accounts",
              reason: "failed",
              cause,
            }),
        ),
      );
  const checkRateLimit = (operation: string, scope: string, allowPaused = false) =>
    rateLimits.check(rateLimitKey, { allowPaused }).pipe(
      Effect.provideService(SourceControlRateLimit.CredentialScope, scope),
      Effect.mapError(
        (cause) =>
          new LinearApiError({ operation, reason: "rate-limited", retryAt: cause.retryAt, cause }),
      ),
    );
  const requestWithToken = <S extends Schema.Codec<unknown, unknown, never, never>>(
    key: string,
    operation: string,
    document: string,
    variables: Record<string, unknown>,
    schema: S,
  ): Effect.Effect<S["Type"], LinearApiError> =>
    Effect.gen(function* () {
      const tokenScope = Hex.encode(sha256(new TextEncoder().encode(key)));
      let credentialScope = verifiedTokenScopes.get(tokenScope) ?? tokenScope;
      const queryEndpoints = QUERY_ENDPOINTS.get(document)!;
      if (credentialScope === tokenScope) {
        const endpoints = tokenEndpoints.get(tokenScope) ?? new Set<string>();
        for (const endpoint of queryEndpoints) endpoints.add(endpoint);
        tokenEndpoints.set(tokenScope, endpoints);
      }
      let lease = yield* checkRateLimit(operation, credentialScope);
      let endpointLeases = yield* Effect.forEach(queryEndpoints, (endpoint) =>
        checkRateLimit(operation, `${credentialScope}\0${endpoint}`),
      );
      const now = yield* Clock.currentTimeMillis;
      const costKey = [document, variables.first, variables.last].join("\0");
      const cost =
        document === ISSUE_QUERY
          ? ISSUE_COMPLEXITY
          : document === LIST_QUERY
            ? Math.max(
                Math.ceil(66 * Number(variables.first ?? variables.last) + 1.4),
                documentCosts.get(costKey) ?? 0,
              )
            : (documentCosts.get(costKey) ?? 0);
      const budget = complexityBudgets.get(credentialScope);
      if (budget !== undefined && budget.reset <= now) complexityBudgets.delete(credentialScope);
      if (budget !== undefined && budget.reset > now) {
        if (budget.remaining < cost)
          return yield* new LinearApiError({
            operation,
            reason: "rate-limited",
            retryAt: budget.reset,
          });
        budget.remaining = Math.max(0, budget.remaining - cost);
      }
      return yield* http
        .execute(
          HttpClientRequest.post(config.baseUrl).pipe(
            HttpClientRequest.setHeader("authorization", key),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({ query: document, variables }),
          ),
        )
        .pipe(
          Effect.mapError((cause) => new LinearApiError({ operation, reason: "failed", cause })),
          Effect.flatMap((response) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const reportedCost = Number(response.headers["x-complexity"]);
              if (Number.isFinite(reportedCost) && reportedCost >= 0) {
                documentCosts.set(costKey, reportedCost);
                if (budget !== undefined && budget.reset > now)
                  budget.remaining = Math.max(
                    0,
                    budget.remaining - Math.max(0, reportedCost - cost),
                  );
              }
              const remaining = Number(response.headers["x-ratelimit-complexity-remaining"]);
              const reset = Number(
                response.headers["x-ratelimit-complexity-reset"] ?? budget?.reset,
              );
              if (
                Number.isFinite(remaining) &&
                remaining >= 0 &&
                Number.isFinite(reset) &&
                reset > now
              )
                complexityBudgets.set(credentialScope, { remaining, reset });
              const resets = ["requests", "complexity"].flatMap((kind) => {
                const remaining = response.headers[`x-ratelimit-${kind}-remaining`];
                const reset = Number(response.headers[`x-ratelimit-${kind}-reset`]);
                return remaining !== undefined &&
                  Number(remaining) <= 0 &&
                  Number.isFinite(reset) &&
                  reset > now
                  ? [reset]
                  : [];
              });
              const endpointRemaining = response.headers["x-ratelimit-endpoint-requests-remaining"];
              const endpointReset = Number(response.headers["x-ratelimit-endpoint-requests-reset"]);
              const reportedEndpoint = response.headers["x-ratelimit-endpoint-name"];
              const limitedEndpoints =
                reportedEndpoint !== undefined && queryEndpoints.includes(reportedEndpoint)
                  ? [reportedEndpoint]
                  : queryEndpoints;
              const recordEndpoints = (retryAt?: number) =>
                Effect.forEach(limitedEndpoints, (endpoint) => {
                  const input = {
                    ...rateLimitKey,
                    lease: endpointLeases[queryEndpoints.indexOf(endpoint)]!,
                    retryAt,
                  };
                  return (
                    retryAt === undefined
                      ? rateLimits.recordSuccess(input)
                      : rateLimits.recordRateLimit(input)
                  ).pipe(
                    Effect.provideService(
                      SourceControlRateLimit.CredentialScope,
                      `${credentialScope}\0${endpoint}`,
                    ),
                  );
                });
              const endpointRetryAt =
                endpointRemaining !== undefined &&
                Number(endpointRemaining) <= 0 &&
                Number.isFinite(endpointReset) &&
                endpointReset > now
                  ? endpointReset
                  : undefined;
              const retryAfter = SourceControlRateLimit.retryAtFromHeader(
                response.headers["retry-after"],
                now,
              );
              const retryTimes = [
                ...resets,
                ...(endpointRetryAt === undefined ? [] : [endpointRetryAt]),
                ...(retryAfter === undefined ? [] : [retryAfter]),
              ];
              const retryAt = retryTimes.length === 0 ? undefined : Math.max(...retryTimes);
              const limited = () =>
                Effect.gen(function* () {
                  if (resets.length > 0 || endpointRetryAt === undefined)
                    yield* rateLimits
                      .recordRateLimit({
                        ...rateLimitKey,
                        lease,
                        retryAt: endpointRetryAt === undefined ? retryAt : Math.max(...resets),
                      })
                      .pipe(
                        Effect.provideService(
                          SourceControlRateLimit.CredentialScope,
                          credentialScope,
                        ),
                      );
                  if (endpointRetryAt !== undefined)
                    yield* recordEndpoints(Math.max(endpointRetryAt, retryAfter ?? 0));
                  return yield* new LinearApiError({
                    operation,
                    reason: "rate-limited",
                    status: response.status,
                    ...(retryAt === undefined ? {} : { retryAt }),
                  });
                }).pipe(Effect.uninterruptible);
              if (response.status === 429) return yield* limited();
              if (response.status === 401 || response.status === 403)
                return yield* new LinearApiError({ operation, reason: "unauthenticated" });
              if (response.status < 200 || response.status >= 300) {
                if (response.status === 400) {
                  const errors = yield* readGraphQlErrors(response).pipe(Effect.option);
                  if (
                    Option.isSome(errors) &&
                    errors.value.errors.some((error) => error.extensions?.code === "RATELIMITED")
                  )
                    return yield* limited();
                }
                return yield* new LinearApiError({
                  operation,
                  reason: "failed",
                  status: response.status,
                });
              }
              const payload = yield* response.json.pipe(
                Effect.mapError(
                  (cause) => new LinearApiError({ operation, reason: "failed", cause }),
                ),
              );
              const { errors } = yield* decodeGraphQlErrors(payload).pipe(
                Effect.mapError(
                  (cause) => new LinearApiError({ operation, reason: "failed", cause }),
                ),
              );
              if (errors?.some((error) => error.extensions?.code === "RATELIMITED"))
                return yield* limited();
              if (errors !== undefined && errors.length > 0)
                return yield* new LinearApiError({
                  operation,
                  reason: errors.some(isAuthError) ? "unauthenticated" : "failed",
                  cause: errors,
                });
              const envelope = yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
                Effect.mapError(
                  (cause) => new LinearApiError({ operation, reason: "failed", cause }),
                ),
              );
              return yield* Effect.gen(function* () {
                if (isViewerEnvelope(envelope)) {
                  const userScope = `user:${envelope.data.viewer.id}`;
                  verifiedTokenScopes.set(tokenScope, userScope);
                  if (credentialScope !== userScope) {
                    const tokenBudget = complexityBudgets.get(credentialScope);
                    const sharedBudget = complexityBudgets.get(userScope);
                    if (tokenBudget !== undefined && tokenBudget.reset > now) {
                      complexityBudgets.set(
                        userScope,
                        sharedBudget === undefined || sharedBudget.reset <= now
                          ? tokenBudget
                          : {
                              remaining: Math.min(sharedBudget.remaining, tokenBudget.remaining),
                              reset: Math.max(sharedBudget.reset, tokenBudget.reset),
                            },
                      );
                      complexityBudgets.delete(credentialScope);
                    }
                    credentialScope = userScope;
                    for (const endpoint of tokenEndpoints.get(tokenScope) ?? []) {
                      const retryAt = yield* rateLimits.check(rateLimitKey).pipe(
                        Effect.provideService(
                          SourceControlRateLimit.CredentialScope,
                          `${tokenScope}\0${endpoint}`,
                        ),
                        Effect.match({
                          onFailure: (error) => error.retryAt,
                          onSuccess: () => undefined,
                        }),
                      );
                      if (retryAt !== undefined) {
                        const scope = `${userScope}\0${endpoint}`;
                        yield* rateLimits
                          .recordRateLimit({
                            ...rateLimitKey,
                            lease: yield* checkRateLimit(operation, scope, true),
                            retryAt,
                          })
                          .pipe(
                            Effect.provideService(SourceControlRateLimit.CredentialScope, scope),
                          );
                      }
                    }
                    tokenEndpoints.delete(tokenScope);
                    lease = yield* checkRateLimit(operation, credentialScope, true);
                    endpointLeases = yield* Effect.forEach(queryEndpoints, (endpoint) =>
                      checkRateLimit(operation, `${credentialScope}\0${endpoint}`, true),
                    );
                  }
                }
                if (resets.length > 0)
                  yield* rateLimits
                    .recordRateLimit({
                      ...rateLimitKey,
                      lease,
                      retryAt: Math.max(...resets),
                    })
                    .pipe(
                      Effect.provideService(
                        SourceControlRateLimit.CredentialScope,
                        credentialScope,
                      ),
                    );
                else
                  yield* rateLimits
                    .recordSuccess({ ...rateLimitKey, lease })
                    .pipe(
                      Effect.provideService(
                        SourceControlRateLimit.CredentialScope,
                        credentialScope,
                      ),
                    );
                yield* recordEndpoints(endpointRetryAt);
                return envelope;
              }).pipe(Effect.uninterruptible);
            }),
          ),
        );
    }).pipe(requestGate.withPermits(1));

  const credentialToken = (credentialId?: string) =>
    storedCredentials.pipe(
      Effect.flatMap((credentials) => {
        if (credentialId === undefined) {
          if (Option.isSome(config.envToken)) return Effect.succeed(config.envToken.value);
          return Effect.fail(
            new LinearApiError({
              operation: "select-account",
              reason: "unauthenticated",
              connectedAccounts: credentials.length,
            }),
          );
        }
        const credential = credentials.find((candidate) => candidate.credentialId === credentialId);
        if (credential !== undefined) return Effect.succeed(credential.token);
        return Effect.fail(
          new LinearApiError({
            operation: "select-account",
            reason: "unauthenticated",
          }),
        );
      }),
    );

  const request = <S extends Schema.Codec<unknown, unknown, never, never>>(
    credentialId: string | undefined,
    operation: string,
    document: string,
    variables: Record<string, unknown>,
    schema: S,
  ): Effect.Effect<S["Type"], LinearApiError> =>
    credentialToken(credentialId).pipe(
      Effect.flatMap((key) => requestWithToken(key, operation, document, variables, schema)),
    );

  const probeToken = (key: string): Effect.Effect<IssueTrackerAccount, LinearApiError> =>
    requestWithToken(key, "connection", CONNECTION_QUERY, {}, ConnectionEnvelope).pipe(
      Effect.flatMap(({ data }) =>
        data.viewer === null
          ? Effect.fail(
              new LinearApiError({
                operation: "connection",
                reason: "unauthenticated",
              }),
            )
          : Effect.succeed({
              credentialId: data.viewer.id,
              status: "authenticated" as const,
              accountName: clean(data.viewer.name) ?? "Linear account",
              accountEmail: clean(data.viewer.email),
              projects: data.teams.nodes.map((team) => ({
                id: team.id,
                key: team.key,
                name: team.name,
              })),
            }),
      ),
    );

  const inspectCredential = (credential: Credential): Effect.Effect<IssueTrackerAccount> =>
    probeToken(credential.token).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          credentialId: credential.credentialId,
          status: error.reason === "unauthenticated" ? "unauthenticated" : "unverified",
          accountName: "Linear account",
          accountEmail: null,
          projects: [],
        } as const),
      ),
    );

  const inspectToken = (token: string) =>
    probeToken(token).pipe(
      Effect.map((account) => ({ _tag: "Success" as const, account })),
      Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
    );

  const connectionOf = (
    accounts: ReadonlyArray<IssueTrackerAccount>,
    hasStoredToken: boolean,
    environmentAccount?: IssueTrackerConnection["environmentAccount"],
  ): IssueTrackerConnection => {
    const primary =
      environmentAccount ??
      accounts.find((account) => account.status === "authenticated") ??
      accounts[0];
    return {
      status: primary?.status ?? "unauthenticated",
      hasStoredToken,
      accountName: primary?.accountName ?? null,
      accountEmail: primary?.accountEmail ?? null,
      projects: primary?.projects ?? [],
      accounts,
      ...(environmentAccount === undefined ? {} : { environmentAccount }),
    };
  };
  const inspectEnvironmentAccount = Option.match(config.envToken, {
    onNone: () => Effect.succeed<IssueTrackerConnection["environmentAccount"]>(undefined),
    onSome: (token) =>
      inspectToken(token).pipe(
        Effect.map((inspected) => {
          if (inspected._tag === "Failure") {
            return {
              status:
                inspected.error.reason === "unauthenticated"
                  ? ("unauthenticated" as const)
                  : ("unverified" as const),
              accountName: "Environment account",
              accountEmail: null,
              projects: [],
            };
          }
          return {
            status: inspected.account.status,
            accountName: inspected.account.accountName,
            accountEmail: inspected.account.accountEmail,
            projects: inspected.account.projects,
          };
        }),
      ),
  });

  const connectionUnlocked = Effect.gen(function* () {
    const credentials = yield* storedCredentials;
    const accounts = yield* Effect.forEach(credentials, inspectCredential);
    return connectionOf(accounts, credentials.length > 0, yield* inspectEnvironmentAccount);
  });
  const connection = credentialPoolMutex.withPermits(1)(connectionUnlocked);

  const getViewer = ({ credentialId }: { readonly credentialId?: string }) =>
    request(credentialId, "viewer", VIEWER_QUERY, {}, ViewerEnvelope).pipe(
      Effect.map(({ data }) => data.viewer),
    );

  const issueOrFail = (identifier: string, issue: LinearIssue | null) =>
    issue === null
      ? Effect.fail(
          new LinearApiError({
            operation: "getIssue",
            reason: "failed",
            identifier,
          }),
        )
      : Effect.succeed(issue);

  const mutation = (
    credentialId: string | undefined,
    operation: string,
    document: string,
    variables: Record<string, unknown>,
  ) =>
    request(credentialId, operation, document, variables, MutationEnvelope).pipe(
      Effect.flatMap(({ data }) =>
        Object.values(data).some((payload) => payload.success)
          ? Effect.void
          : Effect.fail(new LinearApiError({ operation, reason: "failed" })),
      ),
    );

  return LinearApi.of({
    connection,
    connect: (value) =>
      credentialPoolMutex.withPermits(1)(
        Effect.gen(function* () {
          const credentials = [...(yield* storedCredentials)];
          const token = value.trim();
          const account = yield* probeToken(token);
          const index = credentials.findIndex(
            (credential) => credential.credentialId === account.credentialId,
          );
          const credential = { credentialId: account.credentialId, token };
          if (index === -1) credentials.push(credential);
          else credentials[index] = credential;
          yield* writeCredentials(credentials);
          return yield* connectionUnlocked;
        }),
      ),
    disconnect: (input) =>
      credentialPoolMutex.withPermits(1)(
        Effect.gen(function* () {
          const credentials = yield* storedCredentials;
          const { credentialId } = input;
          const remaining = credentials.filter(
            (credential) => credential.credentialId !== credentialId,
          );
          const accounts = yield* Effect.forEach(remaining, inspectCredential);
          const environmentAccount = yield* inspectEnvironmentAccount;
          yield* writeCredentials(remaining);
          return connectionOf(accounts, remaining.length > 0, environmentAccount);
        }),
      ),
    getViewer,
    listIssues: (input) => {
      const filter: Record<string, unknown> = { team: { key: { eq: input.teamKey } } };
      if (input.state !== "all") {
        const closed = ["completed", "canceled", "duplicate"];
        filter.state = { type: { [input.state === "closed" ? "in" : "nin"]: closed } };
      }
      if (input.involvement !== "all") {
        const relation =
          input.involvement === "assigned"
            ? "assignee"
            : input.involvement === "authored"
              ? "creator"
              : "subscribers";
        filter[relation] =
          relation === "subscribers"
            ? { some: { id: { eq: input.viewer } } }
            : { id: { eq: input.viewer } };
      }
      if (input.query !== undefined) {
        filter.or = [
          { title: { containsIgnoreCase: input.query } },
          { description: { containsIgnoreCase: input.query } },
        ];
        // `ENG-12`, `#12` or `12` asks for one issue of this team by its number.
        const reference = /^(?:([a-z][a-z0-9]*)-|#)?(\d+)$/iu.exec(input.query.trim());
        if (
          reference !== null &&
          (reference[1] === undefined || reference[1].toUpperCase() === input.teamKey.toUpperCase())
        ) {
          filter.or = [...(filter.or as Array<unknown>), { number: { eq: Number(reference[2]) } }];
        }
      }
      if (input.cursor !== undefined) filter.updatedAt = { lte: input.cursor.updatedBefore };
      if (input.cursor?.seenAt?.length) filter.number = { nin: input.cursor.seenAt };
      const ascending = input.order === "asc";
      return Effect.gen(function* () {
        const issues: LinearIssue[] = [];
        let cursor: string | undefined;
        let truncated = false;
        for (let page = 0; page < 4; page++) {
          const size = Math.min(input.limit + 1 - issues.length, MAX_PAGE);
          const { data } = yield* request(
            input.credentialId,
            "issue list",
            LIST_QUERY,
            {
              [ascending ? "last" : "first"]: size,
              ...(cursor === undefined ? {} : { [ascending ? "before" : "after"]: cursor }),
              filter,
            },
            ListEnvelope,
          );
          issues.push(...(ascending ? data.issues.nodes.toReversed() : data.issues.nodes));
          truncated = ascending
            ? data.issues.pageInfo.hasPreviousPage
            : data.issues.pageInfo.hasNextPage;
          const next = ascending
            ? data.issues.pageInfo.startCursor
            : data.issues.pageInfo.endCursor;
          if (issues.length > input.limit || !truncated || !next || next === cursor) break;
          cursor = next;
        }
        return {
          issues: issues.slice(0, input.limit),
          truncated: issues.length > input.limit || truncated,
        };
      });
    },
    getIssueSummary: ({ identifier, credentialId }) =>
      request(
        credentialId,
        "issue summary",
        SUMMARY_QUERY,
        { id: identifier },
        SummaryEnvelope,
      ).pipe(
        Effect.flatMap(({ data }) =>
          data.issue === null
            ? Effect.fail(
                new LinearApiError({ operation: "getIssueSummary", reason: "failed", identifier }),
              )
            : Effect.succeed(data.issue),
        ),
      ),
    getIssue: ({ identifier, credentialId }) =>
      request(credentialId, "issue", ISSUE_QUERY, { id: identifier }, IssueEnvelope).pipe(
        Effect.flatMap(({ data }) => issueOrFail(identifier, data.issue)),
      ),
    getActivity: ({ identifier, credentialId }) =>
      request(
        credentialId,
        "issue activity",
        ACTIVITY_QUERY,
        { id: identifier, comments: 50 },
        ActivityEnvelope,
      ).pipe(
        Effect.flatMap(({ data }) =>
          Effect.gen(function* () {
            const issue = yield* issueOrFail(identifier, data.issue);
            return {
              viewerId: data.viewer.id,
              comments: (issue.comments?.nodes ?? []).toSorted((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
              ),
              reactions: issue.reactions ?? [],
              commentsTruncated: issue.comments?.pageInfo?.hasNextPage ?? false,
            };
          }),
        ),
      ),
    comment: ({ issueId, body, credentialId }) =>
      mutation(credentialId, "comment", COMMENT_MUTATION, { input: { issueId, body } }),
    setReaction: (input) => {
      if (input.reacted) {
        return mutation(input.credentialId, "reaction", REACTION_CREATE_MUTATION, {
          input:
            input.commentId === undefined
              ? { issueId: input.issueId, emoji: input.emoji }
              : { commentId: input.commentId, emoji: input.emoji },
        });
      }
      const document =
        input.commentId === undefined ? ISSUE_REACTIONS_QUERY : COMMENT_REACTIONS_QUERY;
      const id = input.commentId ?? input.issueId;
      return request(
        input.credentialId,
        "reaction lookup",
        document,
        { id },
        ReactionLookupEnvelope,
      ).pipe(
        Effect.flatMap(({ data }) => {
          const reactions = (data.comment ?? data.issue)?.reactions ?? [];
          const reaction = reactions.find(
            (item) => item.emoji === input.emoji && item.user?.id === data.viewer.id,
          );
          return reaction === undefined
            ? Effect.void
            : mutation(input.credentialId, "reaction", REACTION_DELETE_MUTATION, {
                id: reaction.id,
              });
        }),
      );
    },
  });
});

export const layer = Layer.effect(LinearApi, make).pipe(
  Layer.provideMerge(SourceControlRateLimit.layer),
);
