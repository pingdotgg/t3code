import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type {
  IssueListState,
  IssueInvolvement,
  LinearAccount,
  LinearConnection,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const API_URL = "https://api.linear.app/graphql";
const MAX_PAGE = 250;

export const LINEAR_API_TOKEN_SECRET = "linear.api-token";
export const LINEAR_CREDENTIALS_SECRET = "linear.credentials";

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
  baseUrl: Config.string("T3CODE_LINEAR_API_BASE_URL").pipe(Config.withDefault(API_URL)),
  envToken: Config.string("T3CODE_LINEAR_API_TOKEN").pipe(Config.option),
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
});

const Errors = { errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))) };
const ConnectionEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({
    viewer: Schema.NullOr(User),
    teams: Schema.Struct({ nodes: Schema.Array(Team) }),
  }),
});
const ViewerEnvelope = Schema.Struct({ ...Errors, data: Schema.Struct({ viewer: User }) });
const ListEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(Issue),
      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
    }),
  }),
});
const IssueEnvelope = Schema.Struct({
  ...Errors,
  data: Schema.Struct({ issue: Schema.NullOr(Issue) }),
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
const LIST_QUERY = `query T3LinearIssues($first: Int!, $filter: IssueFilter!) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage }
  }
}`;
const ISSUE_QUERY = `query T3LinearIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
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

export class LinearApiError extends Schema.TaggedErrorClass<LinearApiError>()("LinearApiError", {
  operation: Schema.String,
  reason: Schema.Literals(["unauthenticated", "failed"]),
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

export class LinearAccountSelectionRequiredError extends Schema.TaggedErrorClass<LinearAccountSelectionRequiredError>()(
  "LinearAccountSelectionRequiredError",
  {},
) {
  readonly detail = "Choose the Linear account to disconnect.";

  override get message(): string {
    return this.detail;
  }
}
export const isLinearAccountSelectionRequiredError = Schema.is(LinearAccountSelectionRequiredError);

export type LinearUser = typeof User.Type;
export type LinearIssue = typeof Issue.Type;
export type LinearComment = typeof Comment.Type;
export type LinearReaction = typeof Reaction.Type;
export type LinearConnectResult = LinearConnection & {
  readonly connectedCredentialId: string;
};
export type LinearConnectionResult = LinearConnection & {
  readonly migratedCredentialId?: string;
};

export class LinearApi extends Context.Service<
  LinearApi,
  {
    readonly environmentTokenConfigured: boolean;
    readonly connection: Effect.Effect<LinearConnectionResult, LinearApiError>;
    readonly completeLegacyMigration: Effect.Effect<void, LinearApiError>;
    readonly connect: (token: string) => Effect.Effect<LinearConnectResult, LinearApiError>;
    readonly disconnect: (input?: {
      readonly credentialId: string;
    }) => Effect.Effect<LinearConnection, LinearApiError | LinearAccountSelectionRequiredError>;
    readonly getViewer: (input: {
      readonly credentialId?: string;
    }) => Effect.Effect<LinearUser, LinearApiError>;
    readonly listIssues: (input: {
      readonly teamKey: string;
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string;
      readonly updatedBefore?: string;
      readonly credentialId?: string;
    }) => Effect.Effect<
      { readonly issues: ReadonlyArray<LinearIssue>; readonly truncated: boolean },
      LinearApiError
    >;
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
const isAuthError = (message: string) => /auth|api key|access token/i.test(message);

export const make = Effect.gen(function* () {
  const config = yield* ApiConfig;
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const credentialPoolMutex = yield* Semaphore.make(1);

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
  const storedToken = readSecret(LINEAR_API_TOKEN_SECRET, "read-token");
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
  const removeLegacyToken = secrets.remove(LINEAR_API_TOKEN_SECRET).pipe(
    Effect.mapError(
      (cause) =>
        new LinearApiError({
          operation: "remove-token",
          reason: "failed",
          cause,
        }),
    ),
  );

  const requestWithToken = <S extends Schema.Codec<unknown, unknown, never, never>>(
    key: string,
    operation: string,
    document: string,
    variables: Record<string, unknown>,
    schema: S,
  ): Effect.Effect<S["Type"], LinearApiError> =>
    http
      .execute(
        HttpClientRequest.post(config.baseUrl).pipe(
          HttpClientRequest.setHeader("authorization", key),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({ query: document, variables }),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          isLinearApiError(cause)
            ? cause
            : new LinearApiError({
                operation,
                reason: "failed",
                cause,
              }),
        ),
        Effect.flatMap((response) =>
          response.status === 401 || response.status === 403
            ? Effect.fail(
                new LinearApiError({
                  operation,
                  reason: "unauthenticated",
                }),
              )
            : response.status < 200 || response.status >= 300
              ? Effect.fail(
                  new LinearApiError({
                    operation,
                    reason: "failed",
                    status: response.status,
                  }),
                )
              : HttpClientResponse.schemaBodyJson(schema)(response).pipe(
                  Effect.mapError(
                    (cause) =>
                      new LinearApiError({
                        operation,
                        reason: "failed",
                        cause,
                      }),
                  ),
                ),
        ),
        Effect.flatMap((envelope) => {
          const errors = (envelope as { errors?: ReadonlyArray<{ message: string }> }).errors;
          const message = errors?.[0]?.message;
          return message === undefined
            ? Effect.succeed(envelope)
            : Effect.fail(
                new LinearApiError({
                  operation,
                  reason: isAuthError(message) ? "unauthenticated" : "failed",
                  cause: errors,
                }),
              );
        }),
      );

  const credentialToken = (credentialId?: string) =>
    storedCredentials.pipe(
      Effect.flatMap((credentials) => {
        if (credentialId === undefined) {
          return storedToken.pipe(
            Effect.flatMap((legacy) => {
              if (Option.isSome(legacy)) return Effect.succeed(legacy.value);
              if (Option.isSome(config.envToken)) return Effect.succeed(config.envToken.value);
              const onlyCredential = credentials.length === 1 ? credentials[0] : undefined;
              if (onlyCredential !== undefined) return Effect.succeed(onlyCredential.token);
              return Effect.fail(
                new LinearApiError({
                  operation: "select-account",
                  reason: "unauthenticated",
                  connectedAccounts: credentials.length,
                }),
              );
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

  const probeToken = (key: string): Effect.Effect<LinearAccount, LinearApiError> =>
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
              teams: data.teams.nodes.map((team) => ({
                id: team.id,
                key: team.key,
                name: team.name,
              })),
            }),
      ),
    );

  const inspectCredential = (credential: Credential): Effect.Effect<LinearAccount> =>
    probeToken(credential.token).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          credentialId: credential.credentialId,
          status: error.reason === "unauthenticated" ? "unauthenticated" : "unverified",
          accountName: "Linear account",
          accountEmail: null,
          teams: [],
        } as const),
      ),
    );

  const inspectToken = (token: string) =>
    probeToken(token).pipe(
      Effect.map((account) => ({ _tag: "Success" as const, account })),
      Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
    );

  const connectionOf = (
    accounts: ReadonlyArray<LinearAccount>,
    hasStoredToken: boolean,
    environmentAccount?: LinearConnection["environmentAccount"],
  ): LinearConnection => {
    const primary =
      environmentAccount ??
      accounts.find((account) => account.status === "authenticated") ??
      accounts[0];
    return {
      status: primary?.status ?? "unauthenticated",
      hasStoredToken,
      accountName: primary?.accountName ?? null,
      accountEmail: primary?.accountEmail ?? null,
      teams: primary?.teams ?? [],
      accounts,
      ...(environmentAccount === undefined ? {} : { environmentAccount }),
    };
  };
  const failedConnection = (error: LinearApiError): LinearConnection => ({
    status: error.reason === "unauthenticated" ? "unauthenticated" : "unverified",
    hasStoredToken: false,
    accountName: null,
    accountEmail: null,
    teams: [],
    accounts: [],
  });

  const inspectEnvironmentAccount = Option.match(config.envToken, {
    onNone: () => Effect.succeed<LinearConnection["environmentAccount"]>(undefined),
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
              teams: [],
            };
          }
          return {
            status: inspected.account.status,
            accountName: inspected.account.accountName,
            accountEmail: inspected.account.accountEmail,
            teams: inspected.account.teams,
          };
        }),
      ),
  });

  const connectionUnlocked = Effect.gen(function* () {
    const credentials = yield* storedCredentials;
    if (credentials.length > 0) {
      const legacy = yield* storedToken;
      const accounts = yield* Effect.forEach(credentials, inspectCredential);
      const migratedCredentialId = Option.isSome(legacy)
        ? credentials.find(({ token }) => token === legacy.value)?.credentialId
        : undefined;
      return {
        ...connectionOf(accounts, true, yield* inspectEnvironmentAccount),
        ...(migratedCredentialId === undefined ? {} : { migratedCredentialId }),
      };
    }
    const legacy = yield* storedToken;
    if (Option.isSome(legacy)) {
      const inspected = yield* inspectToken(legacy.value);
      if (inspected._tag === "Failure") {
        return { ...failedConnection(inspected.error), hasStoredToken: true };
      }
      const account = inspected.account;
      yield* writeCredentials([{ credentialId: account.credentialId, token: legacy.value }]);
      return {
        ...connectionOf([account], true, yield* inspectEnvironmentAccount),
        migratedCredentialId: account.credentialId,
      };
    }
    if (Option.isSome(config.envToken)) {
      const account = yield* inspectEnvironmentAccount;
      if (account === undefined) return connectionOf([], false);
      return {
        status: account.status,
        hasStoredToken: false,
        accountName: account.accountName,
        accountEmail: account.accountEmail,
        teams: account.teams,
        accounts: [],
        environmentAccount: account,
      };
    }
    return connectionOf([], false);
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
    environmentTokenConfigured: Option.isSome(config.envToken),
    connection,
    completeLegacyMigration: credentialPoolMutex.withPermits(1)(removeLegacyToken),
    connect: (value) =>
      credentialPoolMutex.withPermits(1)(
        Effect.gen(function* () {
          const credentials = [...(yield* storedCredentials)];
          const legacy = yield* storedToken;
          if (credentials.length === 0 && Option.isSome(legacy)) {
            const account = yield* probeToken(legacy.value).pipe(
              Effect.catchTags({
                LinearApiError: (error) =>
                  error.reason === "unauthenticated"
                    ? Effect.succeed(undefined)
                    : Effect.fail(error),
              }),
            );
            if (account !== undefined) {
              credentials.push({ credentialId: account.credentialId, token: legacy.value });
            }
          }

          const token = value.trim();
          const account = yield* probeToken(token);
          const index = credentials.findIndex(
            (credential) => credential.credentialId === account.credentialId,
          );
          const credential = { credentialId: account.credentialId, token };
          if (index === -1) credentials.push(credential);
          else credentials[index] = credential;
          yield* writeCredentials(credentials);
          if (Option.isSome(legacy)) yield* removeLegacyToken.pipe(Effect.ignore);
          return {
            ...(yield* connectionUnlocked),
            connectedCredentialId: account.credentialId,
          };
        }),
      ),
    disconnect: (input) =>
      credentialPoolMutex.withPermits(1)(
        Effect.gen(function* () {
          const credentials = yield* storedCredentials;
          if (input === undefined && credentials.length > 1) {
            return yield* new LinearAccountSelectionRequiredError();
          }
          const credentialId =
            input?.credentialId ??
            (credentials.length === 1 ? credentials[0]?.credentialId : undefined);
          if (credentialId === undefined) {
            const legacy = yield* storedToken;
            if (Option.isSome(legacy)) yield* removeLegacyToken;
            return yield* connectionUnlocked;
          }
          const removed = credentials.find(
            (credential) => credential.credentialId === credentialId,
          );
          if (removed !== undefined) {
            const legacy = yield* storedToken;
            if (Option.isSome(legacy) && legacy.value === removed.token) {
              yield* removeLegacyToken;
            }
          }
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
      }
      if (input.updatedBefore !== undefined) filter.updatedAt = { lte: input.updatedBefore };
      const first = Math.min(input.limit + 1, MAX_PAGE);
      return request(
        input.credentialId,
        "issue list",
        LIST_QUERY,
        first === 0 ? {} : { first, filter },
        ListEnvelope,
      ).pipe(
        Effect.map(({ data }) => ({
          issues: data.issues.nodes.slice(0, input.limit),
          truncated: data.issues.nodes.length > input.limit || data.issues.pageInfo.hasNextPage,
        })),
      );
    },
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

export const layer = Layer.effect(LinearApi, make);
