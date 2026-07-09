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
  type LinearIssueFilter,
  type LinearIssueSummary,
  type LinearLabel,
  type LinearLinkedPullRequest,
  type LinearListIssuesResult,
  type LinearMutationResult,
  type LinearProject,
  type LinearSubIssue,
  type LinearTeam,
  type LinearUser,
  type LinearWorkflowState,
  type LinearWorkflowStateType,
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

const StateNode = Schema.Struct({
  name: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
});

const TeamRef = Schema.Struct({
  id: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
});

const RawViewer = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});

const RawIssueSummary = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  priorityLabel: Schema.optional(Schema.String),
  state: Schema.optional(Schema.NullOr(StateNode)),
  assignee: Schema.optional(Schema.NullOr(NamedNode)),
  team: Schema.optional(Schema.NullOr(TeamRef)),
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
  state: Schema.optional(Schema.NullOr(StateNode)),
  assignee: Schema.optional(Schema.NullOr(NamedNode)),
  team: Schema.optional(Schema.NullOr(TeamRef)),
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

const RawPageInfo = Schema.Struct({
  hasNextPage: Schema.optional(Schema.Boolean),
  endCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawIssuePage = Schema.Struct({
  nodes: Schema.Array(RawIssueSummary),
  pageInfo: Schema.optional(RawPageInfo),
});

const listEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(Schema.Struct({ issues: Schema.optional(Schema.NullOr(RawIssuePage)) })),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

const RawTeam = Schema.Struct({
  id: Schema.String,
  key: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
const teamsEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        teams: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawTeam) }))),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

const RawState = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});
const statesEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        team: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              states: Schema.optional(
                Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawState) })),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

const RawProject = Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String) });
const projectsEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        projects: Schema.optional(
          Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawProject) })),
        ),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

const RawLabel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});
const labelsEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        issueLabels: Schema.optional(
          Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawLabel) })),
        ),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

const RawUser = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
const usersEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        users: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawUser) }))),
        viewer: Schema.optional(
          Schema.NullOr(Schema.Struct({ id: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

const SuccessNode = Schema.Struct({ success: Schema.optional(Schema.Boolean) });
const mutationEnvelope = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        issueUpdate: Schema.optional(Schema.NullOr(SuccessNode)),
        commentCreate: Schema.optional(Schema.NullOr(SuccessNode)),
        attachmentCreate: Schema.optional(Schema.NullOr(SuccessNode)),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorEntry)),
});

// ── GraphQL documents ────────────────────────────────────────────────

const SUMMARY_FIELDS = `id identifier title url priorityLabel state { name type } assignee { name } team { id key }`;

const SEARCH_DOCUMENT = `query T3CodeLinearSearch($term: String!, $first: Int!) {
  searchIssues(term: $term, first: $first) { nodes { ${SUMMARY_FIELDS} } }
}`;

const RECENT_DOCUMENT = `query T3CodeLinearRecent($first: Int!) {
  issues(first: $first, orderBy: updatedAt) { nodes { ${SUMMARY_FIELDS} } }
}`;

const LIST_ISSUES_DOCUMENT = `query T3CodeLinearList($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { ${SUMMARY_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const TEAMS_DOCUMENT = `query T3CodeLinearTeams { teams(first: 250) { nodes { id key name } } }`;

const STATES_DOCUMENT = `query T3CodeLinearStates($teamId: String!) {
  team(id: $teamId) { states { nodes { id name type position color } } }
}`;

const PROJECTS_DOCUMENT = `query T3CodeLinearProjects { projects(first: 250) { nodes { id name } } }`;

const LABELS_DOCUMENT = `query T3CodeLinearLabels { issueLabels(first: 250) { nodes { id name color } } }`;

const USERS_DOCUMENT = `query T3CodeLinearUsers { users(first: 250) { nodes { id name displayName email } } viewer { id } }`;

const ISSUE_DOCUMENT = `query T3CodeLinearIssue($id: String!, $relations: Int!) {
  issue(id: $id) {
    id identifier title url description priorityLabel
    state { name type }
    assignee { name }
    team { id key }
    labels(first: $relations) { nodes { name } }
    children(first: $relations) { nodes { identifier title state { name } } }
    attachments(first: $relations) { nodes { title url sourceType } }
    comments(first: $relations) { nodes { body createdAt user { name } } }
  }
}`;

const VIEWER_DOCUMENT = `query T3CodeLinearViewer { viewer { id name email } }`;

const UPDATE_ISSUE_STATE_DOCUMENT = `mutation T3CodeLinearUpdateState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`;

const CREATE_COMMENT_DOCUMENT = `mutation T3CodeLinearComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

const CREATE_ATTACHMENT_DOCUMENT = `mutation T3CodeLinearAttachment($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success }
}`;

// ── Helpers ──────────────────────────────────────────────────────────

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

const WORKFLOW_STATE_TYPES: ReadonlyArray<LinearWorkflowStateType> = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "triage",
];

function coerceStateType(value: string | null | undefined): LinearWorkflowStateType | undefined {
  return value != null && (WORKFLOW_STATE_TYPES as ReadonlyArray<string>).includes(value)
    ? (value as LinearWorkflowStateType)
    : undefined;
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
    stateType: coerceStateType(raw.state?.type),
    priorityLabel: clean(raw.priorityLabel),
    assigneeName: clean(raw.assignee?.name),
    teamKey: clean(raw.team?.key),
    teamId: clean(raw.team?.id),
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
    stateType: coerceStateType(raw.state?.type),
    priorityLabel: clean(raw.priorityLabel),
    assigneeName: clean(raw.assignee?.name),
    teamKey: clean(raw.team?.key),
    teamId: clean(raw.team?.id),
    description: raw.description ?? "",
    labels,
    subIssues,
    linkedPullRequests,
    attachments,
    comments,
  };
}

function toTeam(raw: typeof RawTeam.Type): LinearTeam {
  return { id: raw.id, key: clean(raw.key) ?? raw.id, name: clean(raw.name) ?? raw.id };
}

function toWorkflowState(raw: typeof RawState.Type, teamId: string): LinearWorkflowState {
  return {
    id: raw.id,
    name: clean(raw.name) ?? raw.id,
    type: coerceStateType(raw.type) ?? "unstarted",
    position: raw.position ?? 0,
    color: clean(raw.color),
    teamId,
  };
}

function toProject(raw: typeof RawProject.Type): LinearProject {
  return { id: raw.id, name: clean(raw.name) ?? raw.id };
}

function toLabel(raw: typeof RawLabel.Type): LinearLabel {
  return { id: raw.id, name: clean(raw.name) ?? raw.id, color: clean(raw.color) };
}

function toUser(raw: typeof RawUser.Type, viewerId: string | undefined): LinearUser {
  return {
    id: raw.id,
    name: clean(raw.name) ?? clean(raw.displayName) ?? raw.id,
    displayName: clean(raw.displayName),
    email: clean(raw.email),
    ...(viewerId !== undefined && raw.id === viewerId ? { isMe: true } : {}),
  };
}

/** Build a Linear `IssueFilter` object from our filter contract. */
function buildIssueFilter(
  filter: LinearIssueFilter | undefined,
): Record<string, unknown> | undefined {
  if (filter === undefined) return undefined;
  const out: Record<string, unknown> = {};
  if (filter.teamId) out.team = { id: { eq: filter.teamId } };
  if (filter.assigneeId) out.assignee = { id: { eq: filter.assigneeId } };
  if (filter.stateId) out.state = { id: { eq: filter.stateId } };
  else if (filter.stateType) out.state = { type: { eq: filter.stateType } };
  if (filter.projectId) out.project = { id: { eq: filter.projectId } };
  if (filter.labelId) out.labels = { some: { id: { eq: filter.labelId } } };
  if (typeof filter.priority === "number") out.priority = { eq: filter.priority };
  const query = filter.query?.trim();
  if (query !== undefined && query.length > 0) {
    out.or = [
      { title: { containsIgnoreCase: query } },
      { description: { containsIgnoreCase: query } },
    ];
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    readonly probeAuth: Effect.Effect<LinearAuthStatus, LinearTokenStoreError | LinearRequestError>;
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
    readonly listIssues: (input: {
      readonly filter?: LinearIssueFilter | undefined;
      readonly first: number;
      readonly after?: string | undefined;
    }) => Effect.Effect<
      LinearListIssuesResult,
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly listTeams: Effect.Effect<
      ReadonlyArray<LinearTeam>,
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly listWorkflowStates: (input: {
      readonly teamId: string;
    }) => Effect.Effect<
      ReadonlyArray<LinearWorkflowState>,
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly listProjects: Effect.Effect<
      ReadonlyArray<LinearProject>,
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly listLabels: Effect.Effect<
      ReadonlyArray<LinearLabel>,
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly listUsers: Effect.Effect<
      ReadonlyArray<LinearUser>,
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly updateIssueState: (input: {
      readonly issueId: string;
      readonly stateId: string;
    }) => Effect.Effect<
      LinearMutationResult,
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly createComment: (input: {
      readonly issueId: string;
      readonly body: string;
    }) => Effect.Effect<
      LinearMutationResult,
      LinearAuthError | LinearRequestError | LinearTokenStoreError
    >;
    readonly createAttachment: (input: {
      readonly issueId: string;
      readonly url: string;
      readonly title?: string | undefined;
      readonly subtitle?: string | undefined;
    }) => Effect.Effect<
      LinearMutationResult,
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
            Effect.flatMap((envelope): Effect.Effect<LinearAuthStatus, LinearRequestError> => {
              if (envelope.errors !== undefined && envelope.errors.length > 0) {
                const message = firstGraphQlErrorMessage(envelope.errors);
                // Only auth-related GraphQL errors mean a rejected token;
                // other errors are real API/outage failures and propagate.
                return isAuthMessage(message)
                  ? Effect.succeed<LinearAuthStatus>({
                      status: "unauthenticated",
                      detail: "The stored Linear token was rejected.",
                    })
                  : Effect.fail(
                      new LinearRequestError({
                        operation: "probeAuth",
                        detail: message ?? "Linear reported an error for the request.",
                      }),
                    );
              }
              const viewer = envelope.data?.viewer ?? undefined;
              const name = clean(viewer?.name);
              return Effect.succeed<LinearAuthStatus>({
                status: "authenticated",
                account: {
                  name: name ?? "Linear account",
                  ...(clean(viewer?.email) ? { email: clean(viewer?.email) } : {}),
                },
              });
            }),
            // A rejected token → "unauthenticated"; genuine connectivity/API
            // errors (LinearRequestError) stay in the channel so a transient
            // outage isn't shown as "not connected".
            Effect.catchTags({
              LinearAuthError: () =>
                Effect.succeed<LinearAuthStatus>({
                  status: "unauthenticated",
                  detail: "The stored Linear token was rejected.",
                }),
            }),
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

  // Run a read query: resolve token → POST → fail on GraphQL errors → envelope.
  const runReadQuery = <S extends Schema.Top>(
    operation: LinearApiOperation,
    document: string,
    variables: Record<string, unknown>,
    envelope: S,
  ): Effect.Effect<
    S["Type"],
    LinearAuthError | LinearRequestError | LinearTokenStoreError,
    S["DecodingServices"]
  > =>
    requireToken(operation).pipe(
      Effect.flatMap((token) => runGraphql(operation, token, document, variables, envelope)),
      Effect.flatMap((env) => {
        const errs = (env as { errors?: ReadonlyArray<typeof GraphQlErrorEntry.Type> }).errors;
        return errs !== undefined && errs.length > 0
          ? failFromGraphQlErrors(operation, errs)
          : Effect.succeed(env);
      }),
    );

  const listIssues: LinearApi["Service"]["listIssues"] = (input) =>
    runReadQuery(
      "listIssues",
      LIST_ISSUES_DOCUMENT,
      {
        filter: buildIssueFilter(input.filter) ?? null,
        first: input.first,
        after: input.after ?? null,
      },
      listEnvelope,
    ).pipe(
      Effect.map((envelope) => {
        const page = envelope.data?.issues ?? null;
        const nodes = page?.nodes ?? [];
        return {
          issues: nodes.map(toSummary),
          pageInfo: {
            hasNextPage: page?.pageInfo?.hasNextPage ?? false,
            ...(clean(page?.pageInfo?.endCursor)
              ? { endCursor: clean(page?.pageInfo?.endCursor)! }
              : {}),
          },
        };
      }),
    );

  const listTeams: LinearApi["Service"]["listTeams"] = runReadQuery(
    "listTeams",
    TEAMS_DOCUMENT,
    {},
    teamsEnvelope,
  ).pipe(Effect.map((envelope) => (envelope.data?.teams?.nodes ?? []).map(toTeam)));

  const listWorkflowStates: LinearApi["Service"]["listWorkflowStates"] = (input) =>
    runReadQuery(
      "listWorkflowStates",
      STATES_DOCUMENT,
      { teamId: input.teamId },
      statesEnvelope,
    ).pipe(
      Effect.map((envelope) =>
        (envelope.data?.team?.states?.nodes ?? [])
          .map((state) => toWorkflowState(state, input.teamId))
          .sort((a, b) => a.position - b.position),
      ),
    );

  const listProjects: LinearApi["Service"]["listProjects"] = runReadQuery(
    "listProjects",
    PROJECTS_DOCUMENT,
    {},
    projectsEnvelope,
  ).pipe(Effect.map((envelope) => (envelope.data?.projects?.nodes ?? []).map(toProject)));

  const listLabels: LinearApi["Service"]["listLabels"] = runReadQuery(
    "listLabels",
    LABELS_DOCUMENT,
    {},
    labelsEnvelope,
  ).pipe(Effect.map((envelope) => (envelope.data?.issueLabels?.nodes ?? []).map(toLabel)));

  const listUsers: LinearApi["Service"]["listUsers"] = runReadQuery(
    "listUsers",
    USERS_DOCUMENT,
    {},
    usersEnvelope,
  ).pipe(
    Effect.map((envelope) => {
      const viewerId = clean(envelope.data?.viewer?.id);
      return (envelope.data?.users?.nodes ?? []).map((user) => toUser(user, viewerId));
    }),
  );

  const mutationSucceeded = (
    node: { readonly success?: boolean | undefined } | null | undefined,
  ): LinearMutationResult => ({ success: node?.success ?? false });

  const updateIssueState: LinearApi["Service"]["updateIssueState"] = (input) =>
    runReadQuery(
      "updateIssueState",
      UPDATE_ISSUE_STATE_DOCUMENT,
      { id: input.issueId, stateId: input.stateId },
      mutationEnvelope,
    ).pipe(Effect.map((envelope) => mutationSucceeded(envelope.data?.issueUpdate)));

  const createComment: LinearApi["Service"]["createComment"] = (input) =>
    runReadQuery(
      "createComment",
      CREATE_COMMENT_DOCUMENT,
      { issueId: input.issueId, body: input.body },
      mutationEnvelope,
    ).pipe(Effect.map((envelope) => mutationSucceeded(envelope.data?.commentCreate)));

  const createAttachment: LinearApi["Service"]["createAttachment"] = (input) =>
    runReadQuery(
      "createAttachment",
      CREATE_ATTACHMENT_DOCUMENT,
      {
        input: {
          issueId: input.issueId,
          url: input.url,
          title: input.title ?? "T3 Code",
          ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
        },
      },
      mutationEnvelope,
    ).pipe(Effect.map((envelope) => mutationSucceeded(envelope.data?.attachmentCreate)));

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

  // After a token write we surface the resulting auth status, but a probe that
  // can't reach Linear (outage) must not turn the write itself into a failure —
  // the standalone `probeAuth` RPC still reports connectivity errors.
  const probeAuthLenient: Effect.Effect<LinearAuthStatus, LinearTokenStoreError> = probeAuth.pipe(
    Effect.catchTags({
      LinearRequestError: () =>
        Effect.succeed<LinearAuthStatus>({
          status: "unauthenticated",
          detail: "Saved, but couldn't reach Linear to verify the token.",
        }),
    }),
  );

  const setToken: LinearApi["Service"]["setToken"] = (token) =>
    persistToken("setToken", token.trim()).pipe(Effect.flatMap(() => probeAuthLenient));

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
      Effect.flatMap(() => probeAuthLenient),
    );

  return LinearApi.of({
    probeAuth,
    searchIssues,
    fetchIssues,
    listIssues,
    listTeams,
    listWorkflowStates,
    listProjects,
    listLabels,
    listUsers,
    updateIssueState,
    createComment,
    createAttachment,
    setToken,
    clearToken,
  });
});

export const layer = Layer.effect(LinearApi, make);
