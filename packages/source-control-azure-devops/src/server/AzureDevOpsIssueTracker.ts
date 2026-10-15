/**
 * Azure DevOps work items as an issue tracker, over the same `az` the pull request reads use.
 *
 * Work items belong to a project rather than a repository, so the scope is `organization/project`
 * and every call names the organization explicitly instead of detecting it from the checkout.
 * Listing is a WIQL query with `timePrecision`, paged by a `(changedDate, id)` keyset cursor
 * because WIQL has no offset; the rest of the reads are `az boards` commands and `wit` REST
 * routes reached through `az devops invoke`, which signs in the way the extension does.
 *
 * @module source-control-azure-devops/server/AzureDevOpsIssueTracker
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueInvolvement,
  type IssueLinkedPullRequest,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import {
  azureDevOpsReactionType,
  decodeCommentsJson,
  decodeProfileJson,
  decodeUpdatesJson,
  decodeWorkItemJson,
  decodeWorkItemsJson,
  pullRequestNumberOf,
  type AzureDevOpsWorkItem,
} from "./azureDevOpsIssueJson.ts";
import { decodePullRequestJson } from "./azureDevOpsPullRequestJson.ts";

const KIND = IssueTrackerKind.make("azure-devops");

/**
 * The states the stock Basic, Agile and Scrum processes carry, which is what a project that has
 * not customised its workflow can be moved between. A project with states of its own refuses a
 * name it lacks at write time, with Azure's own message.
 */
const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  // On comments only; a work item itself takes none, and `setReaction` says so.
  reactions: true,
  // Azure has no issue templates. Its work item types are picked here, not by the reader.
  templates: false,
  linkedPullRequests: true,
  events: true,
  search: true,
  states: [
    { category: "open", name: "New" },
    { category: "open", name: "To Do" },
    { category: "open", name: "Active" },
    { category: "open", name: "Doing" },
    { category: "closed", name: "Resolved" },
    { category: "closed", name: "Done" },
    { category: "closed", name: "Closed" },
    { category: "closed", name: "Removed" },
  ],
  closeReasons: [],
};

/**
 * Everything granted. Azure states no permission anywhere `az boards` reaches: the answer lives
 * in the security namespaces, behind identity descriptors that would be several calls per work
 * item to resolve. Controls stay live and a viewer who may not use one is told so by Azure.
 */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

const REST_API_VERSION = "7.1";
const PAGE_SIZE = 100;
/** Linked pull requests are read one `az` process each, so a work item's links are bounded. */
const LINKED_PULL_REQUEST_LIMIT = 10;
/** Which work item type a new issue is filed as, in order of preference across the stock processes. */
const CREATE_TYPES = ["Issue", "Bug", "Task", "User Story", "Product Backlog Item"];

const LIST_FIELDS = [
  "System.Id",
  "System.Title",
  "System.State",
  "System.CreatedDate",
  "System.ChangedDate",
  "System.CreatedBy",
  "System.AssignedTo",
  "System.CommentCount",
  "System.Tags",
  "System.TeamProject",
  "Microsoft.VSTS.Common.ClosedDate",
];

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeWiql = Schema.decodeUnknownResult(
  Schema.Struct({
    workItems: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.Int })))),
  }),
);
const decodeTypes = Schema.decodeUnknownResult(
  Schema.Struct({
    value: Schema.Array(
      Schema.Struct({ name: Schema.String, isDisabled: Schema.optional(Schema.Boolean) }),
    ),
  }),
);
const decodeTags = Schema.decodeUnknownResult(
  Schema.Struct({ value: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);
const decodeTeams = Schema.decodeUnknownResult(Schema.Array(Schema.Struct({ id: Schema.String })));
const decodeMembers = Schema.decodeUnknownResult(
  Schema.Array(
    Schema.Struct({
      identity: Schema.Struct({
        uniqueName: Schema.String,
        displayName: Schema.optional(Schema.NullOr(Schema.String)),
        imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
        isContainer: Schema.optional(Schema.Boolean),
      }),
    }),
  ),
);
const decodeUnknown = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/** The parts of an `organization/project` scope, as the organization URL and the project name. */
function parseScope(
  host: string,
  scope: string,
): { readonly organization: string; readonly project: string } | null {
  const parts = scope.split("/").flatMap((part) => part.trim() || []);
  if (parts.length !== 2) return null;
  const [organization, project] = parts as [string, string];
  return {
    organization: host.toLowerCase().endsWith(".visualstudio.com")
      ? `https://${host}`
      : `https://${host}/${encodeURIComponent(organization)}`,
    project,
  };
}

function parseNumber(key: string): number | null {
  return /^[1-9]\d{0,9}$/.test(key) ? Number(key) : null;
}

/** WIQL string literals are single-quoted and escape a quote by doubling it. */
function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function involvementClause(involvement: IssueInvolvement): string {
  switch (involvement) {
    case "assigned":
      return " AND [System.AssignedTo] = @Me";
    case "authored":
      return " AND [System.CreatedBy] = @Me";
    // Azure records no mention of a person on a work item, so a mention filter has nothing to narrow by.
    case "mentioned":
    case "all":
      return "";
  }
}

function stateClause(state: "all" | "open" | "closed"): string {
  const closed = "('Closed', 'Completed', 'Done', 'Removed', 'Resolved')";
  switch (state) {
    case "open":
      return ` AND [System.State] NOT IN ${closed}`;
    case "closed":
      return ` AND [System.State] IN ${closed}`;
    case "all":
      return "";
  }
}

/** `<iso changed date>|<id>` of the last row handed over, which is where the next page starts. */
function parseCursor(cursor: string): { readonly changedAt: string; readonly id: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\|([1-9]\d{0,9})$/.exec(cursor);
  return match === null ? null : { changedAt: match[1]!, id: Number(match[2]) };
}

function reasonFor(error: AzureDevOpsCli.AzureDevOpsCliError): IssueTrackerError["reason"] {
  switch (error._tag) {
    case "AzureDevOpsCliUnavailableError":
      return "missing-tool";
    case "AzureDevOpsCliAuthenticationError":
      return "unauthenticated";
    case "AzureDevOpsCliRateLimitError":
      return "rate-limited";
    case "AzureDevOpsPullRequestNotFoundError":
      return "not-found";
    default:
      return "failed";
  }
}

export const make: Effect.Effect<
  IssueTrackerApi,
  never,
  AzureDevOpsCli.AzureDevOpsCli | FileSystem.FileSystem
> = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fs = yield* FileSystem.FileSystem;

  const fail = (operation: string) => (error: AzureDevOpsCli.AzureDevOpsCliError) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: reasonFor(error),
      detail: error.message,
      cause: error,
    });

  const refused = (operation: string, detail: string, cause?: unknown) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const unreadable = (operation: string, cause: unknown) =>
    refused(operation, `Azure DevOps returned an unreadable ${operation} response.`, cause);

  const notFound = (operation: string) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "not-found",
      detail: "Azure DevOps could not find the requested work item.",
    });

  const scoped = (
    operation: string,
    input: { readonly host: string; readonly scope: string },
  ): Effect.Effect<
    { readonly organization: string; readonly project: string },
    IssueTrackerError
  > => {
    const parsed = parseScope(input.host, input.scope);
    return parsed === null
      ? Effect.fail(refused(operation, "An Azure DevOps scope is named `organization/project`."))
      : Effect.succeed(parsed);
  };

  const run = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    azure
      .execute({ cwd: input.cwd, args: [...input.args, "--only-show-errors", "--output", "json"] })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.mapError(fail(input.operation)),
      );

  const read = <A>(input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, IssueTrackerError> =>
    run(input).pipe(
      Effect.flatMap((raw) => {
        const decoded = input.decode(raw);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(unreadable(input.operation, decoded.failure));
      }),
    );

  const decodeAs =
    <A>(schema: (value: unknown) => Result.Result<A, unknown>) =>
    (raw: string): Result.Result<A, unknown> =>
      Result.flatMap(decodeUnknown(raw), schema);

  /** A `wit` REST route, addressed by resource and route parameters rather than by URL. */
  const invokeArgs = (input: {
    readonly organization: string;
    readonly project: string;
    readonly resource: string;
    readonly route?: ReadonlyArray<string>;
    readonly query?: ReadonlyArray<string>;
    readonly method?: string;
    readonly apiVersion?: string;
  }) => [
    "devops",
    "invoke",
    "--detect",
    "false",
    "--organization",
    input.organization,
    "--area",
    "wit",
    "--resource",
    input.resource,
    "--api-version",
    input.apiVersion ?? REST_API_VERSION,
    "--route-parameters",
    `project=${input.project}`,
    ...(input.route ?? []),
    ...(input.query === undefined || input.query.length === 0
      ? []
      : ["--query-parameters", ...input.query]),
    ...(input.method === undefined ? [] : ["--http-method", input.method]),
  ];

  /** A request with a body, which `az devops invoke` only takes from a file. */
  const invokeWithBody = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly body: unknown;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs
          .makeTempFileScoped({ prefix: "t3-azure-issue-" })
          .pipe(Effect.mapError((cause) => refused(input.operation, cause.message, cause)));
        yield* fs
          .writeFileString(file, encodeJson(input.body))
          .pipe(Effect.mapError((cause) => refused(input.operation, cause.message, cause)));
        return yield* run({
          cwd: input.cwd,
          operation: input.operation,
          args: [...input.args, "--in-file", file, "--media-type", "application/json"],
        });
      }),
    );

  const workItem = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly organization: string;
    readonly number: number;
  }): Effect.Effect<AzureDevOpsWorkItem, IssueTrackerError> =>
    read({
      cwd: input.cwd,
      operation: input.operation,
      args: [
        "boards",
        "work-item",
        "show",
        "--detect",
        "false",
        "--organization",
        input.organization,
        "--id",
        String(input.number),
        "--expand",
        "relations",
      ],
      decode: decodeWorkItemJson,
    }).pipe(
      Effect.filterOrFail(
        (item) => item !== null,
        () => notFound(input.operation),
      ),
    );

  /** The work item as `az` addresses it, or a not-found for a key that names no id. */
  const target = (
    operation: string,
    input: { readonly host: string; readonly scope: string; readonly key: string },
  ) =>
    scoped(operation, input).pipe(
      Effect.flatMap((scope) => {
        const number = parseNumber(input.key);
        return number === null
          ? Effect.fail(notFound(operation))
          : Effect.succeed({ ...scope, number });
      }),
    );

  const comments = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly organization: string;
    readonly project: string;
    readonly number: number;
    readonly cursor?: string | undefined;
  }) =>
    read({
      cwd: input.cwd,
      operation: input.operation,
      args: invokeArgs({
        ...input,
        resource: "comments",
        route: [`workItemId=${input.number}`],
        apiVersion: "7.1-preview",
        query: [
          `$top=${PAGE_SIZE}`,
          "order=asc",
          "$expand=reactions",
          "api-version=7.1-preview.4",
          ...(input.cursor === undefined ? [] : [`continuationToken=${input.cursor}`]),
        ],
      }),
      decode: decodeCommentsJson,
    });

  const linkedPullRequests = (input: {
    readonly cwd: string;
    readonly organization: string;
    readonly item: AzureDevOpsWorkItem;
  }): Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, IssueTrackerError> => {
    const numbers = [
      ...new Set(input.item.relations.flatMap((relation) => pullRequestNumberOf(relation) ?? [])),
    ].slice(0, LINKED_PULL_REQUEST_LIMIT);
    return Effect.forEach(
      numbers,
      (number) =>
        read({
          cwd: input.cwd,
          operation: "getIssue",
          args: [
            "repos",
            "pr",
            "show",
            "--detect",
            "false",
            "--organization",
            input.organization,
            "--id",
            String(number),
          ],
          decode: decodePullRequestJson,
        }).pipe(
          Effect.map((pullRequest) =>
            pullRequest === null || pullRequest.location === null
              ? []
              : [
                  {
                    repository: `${pullRequest.location.project}/${pullRequest.location.repository}`,
                    number: pullRequest.number,
                    title: pullRequest.title,
                    url: pullRequest.url,
                    state: pullRequest.state,
                    isDraft: pullRequest.isDraft,
                    // Azure links a pull request to a work item but never says whether completing
                    // it resolves the item; that lives in a completion option nothing reports.
                    closesIssue: false,
                  },
                ],
          ),
          // A link to a pull request this account cannot see is left out, not a failed detail.
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.succeed([]),
          ),
        ),
      { concurrency: 2 },
    ).pipe(Effect.map((links) => links.flat()));
  };

  const update = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly organization: string;
    readonly number: number;
    readonly args: ReadonlyArray<string>;
  }) =>
    run({
      cwd: input.cwd,
      operation: input.operation,
      args: [
        "boards",
        "work-item",
        "update",
        "--detect",
        "false",
        "--organization",
        input.organization,
        "--id",
        String(input.number),
        ...input.args,
      ],
    }).pipe(Effect.asVoid);

  /** Azure keeps tags as one `; `-joined field and takes exactly one assignee. */
  const fieldArgs = (input: {
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignees?: ReadonlyArray<string> | undefined;
  }): ReadonlyArray<string> => {
    const fields = [
      ...(input.labels === undefined ? [] : [`System.Tags=${input.labels.join("; ")}`]),
      ...(input.assignees === undefined ? [] : [`System.AssignedTo=${input.assignees[0] ?? ""}`]),
    ];
    return fields.length === 0 ? [] : ["--fields", ...fields];
  };

  return {
    kind: KIND,
    capabilities: CAPABILITIES,

    // The profile the token belongs to, which is what WIQL's `@Me` resolves to. Its email is the
    // `uniqueName` every identity on a work item carries, so the two compare.
    getViewer: (input) =>
      read({
        cwd: input.cwd,
        operation: "getViewer",
        args: [
          "devops",
          "invoke",
          "--detect",
          "true",
          "--area",
          "profile",
          "--resource",
          "profiles",
          "--api-version",
          REST_API_VERSION,
          "--route-parameters",
          "id=me",
        ],
        decode: decodeProfileJson,
      }).pipe(
        Effect.filterOrFail(
          (login) => login !== null,
          () => refused("getViewer", "Azure DevOps could not name the signed-in account."),
        ),
      ),

    listIssues: (input) => {
      const cursor = input.cursor === undefined ? undefined : parseCursor(input.cursor);
      if (cursor === null) {
        return Effect.fail(
          refused("listIssues", "The cursor was not one Azure DevOps handed out."),
        );
      }
      const limit = Math.min(Math.max(input.limit, 1), PAGE_SIZE);
      const text = input.query?.trim() ?? "";
      return scoped("listIssues", input).pipe(
        Effect.flatMap((scope) =>
          invokeWithBody({
            cwd: input.cwd,
            operation: "listIssues",
            args: invokeArgs({
              ...scope,
              resource: "wiql",
              method: "POST",
              // One more than the page, which is how a next page reveals itself.
              query: ["timePrecision=true", `$top=${limit + 1}`],
            }),
            body: {
              query:
                `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${quoted(scope.project)}` +
                stateClause(input.state) +
                involvementClause(input.involvement) +
                (text.length === 0 ? "" : ` AND [System.Title] CONTAINS ${quoted(text)}`) +
                (cursor === undefined
                  ? ""
                  : ` AND ([System.ChangedDate] < ${quoted(cursor.changedAt)} OR ([System.ChangedDate] = ${quoted(cursor.changedAt)} AND [System.Id] < ${cursor.id}))`) +
                " ORDER BY [System.ChangedDate] DESC, [System.Id] DESC",
            },
          }).pipe(
            Effect.flatMap((raw) => {
              const decoded = decodeAs(decodeWiql)(raw);
              return Result.isSuccess(decoded)
                ? Effect.succeed(decoded.success.workItems ?? [])
                : Effect.fail(unreadable("listIssues", decoded.failure));
            }),
            Effect.flatMap((ids) =>
              ids.length === 0
                ? Effect.succeed({ items: [], nextCursor: null })
                : read({
                    cwd: input.cwd,
                    operation: "listIssues",
                    args: invokeArgs({
                      ...scope,
                      resource: "workitems",
                      query: [
                        `ids=${ids
                          .slice(0, limit)
                          .map((row) => row.id)
                          .join(",")}`,
                        `fields=${LIST_FIELDS.join(",")}`,
                      ],
                    }),
                    decode: decodeWorkItemsJson,
                  }).pipe(
                    Effect.map((items) => {
                      const last = items.at(-1);
                      return {
                        items,
                        nextCursor:
                          ids.length > limit && last !== undefined
                            ? `${last.updatedAt}|${last.key}`
                            : null,
                      };
                    }),
                  ),
            ),
          ),
        ),
      );
    },

    getIssue: (input) =>
      target("getIssue", input).pipe(
        Effect.flatMap((scope) =>
          workItem({ ...scope, cwd: input.cwd, operation: "getIssue" }).pipe(
            Effect.flatMap((item) =>
              Effect.all(
                [
                  comments({ ...scope, cwd: input.cwd, operation: "getIssue" }),
                  read({
                    cwd: input.cwd,
                    operation: "getIssue",
                    args: invokeArgs({
                      ...scope,
                      resource: "updates",
                      route: [`id=${scope.number}`],
                      query: [`$top=${PAGE_SIZE}`],
                    }),
                    decode: decodeUpdatesJson,
                  }),
                  linkedPullRequests({ cwd: input.cwd, organization: scope.organization, item }),
                ],
                { concurrency: 3 },
              ).pipe(
                Effect.map(([conversation, events, links]) => ({
                  ...item,
                  // Nothing cheap names the viewer here; the service already read it per host.
                  viewer: null,
                  viewerPermissions: VIEWER_PERMISSIONS,
                  comments: conversation.comments,
                  commentsCursor: conversation.nextCursor,
                  events,
                  linkedPullRequests: links,
                })),
              ),
            ),
          ),
        ),
      ),

    getComments: (input) =>
      target("getComments", input).pipe(
        Effect.flatMap((scope) =>
          comments({ ...scope, cwd: input.cwd, operation: "getComments", cursor: input.cursor }),
        ),
      ),

    getViewerPermissions: () => Effect.succeed(VIEWER_PERMISSIONS),

    create: (input) =>
      scoped("create", input).pipe(
        Effect.flatMap((scope) =>
          read({
            cwd: input.cwd,
            operation: "create",
            args: invokeArgs({ ...scope, resource: "workitemtypes" }),
            decode: decodeAs(decodeTypes),
          }).pipe(
            Effect.flatMap((types) => {
              const names = types.value.flatMap((type) => (type.isDisabled ? [] : [type.name]));
              const type = CREATE_TYPES.find((name) => names.includes(name)) ?? names[0];
              return type === undefined
                ? Effect.fail(refused("create", "The project offers no work item type to file."))
                : Effect.succeed(type);
            }),
            Effect.flatMap((type) =>
              read({
                cwd: input.cwd,
                operation: "create",
                args: [
                  "boards",
                  "work-item",
                  "create",
                  "--detect",
                  "false",
                  "--organization",
                  scope.organization,
                  "--project",
                  scope.project,
                  "--type",
                  type,
                  "--title",
                  input.title,
                  ...(input.body.length === 0 ? [] : ["--description", input.body]),
                  ...fieldArgs({
                    ...(input.labels.length === 0 ? {} : { labels: input.labels }),
                    ...(input.assignees.length === 0 ? {} : { assignees: input.assignees }),
                  }),
                ],
                decode: decodeWorkItemJson,
              }),
            ),
            Effect.filterOrFail(
              (item) => item !== null,
              () => unreadable("create", "incomplete-response"),
            ),
            Effect.map((item) => ({ key: item.key, displayKey: item.displayKey, url: item.url })),
          ),
        ),
      ),

    comment: (input) =>
      target("comment", input).pipe(
        Effect.flatMap((scope) =>
          invokeWithBody({
            cwd: input.cwd,
            operation: "comment",
            args: invokeArgs({
              ...scope,
              resource: "comments",
              route: [`workItemId=${scope.number}`],
              method: "POST",
              apiVersion: "7.1-preview",
              query: ["format=markdown", "api-version=7.1-preview.4"],
            }),
            body: { text: input.body },
          }),
        ),
        Effect.asVoid,
      ),

    update: (input) =>
      target("update", input).pipe(
        Effect.flatMap((scope) =>
          update({
            ...scope,
            cwd: input.cwd,
            operation: "update",
            args: [
              ...(input.title === undefined ? [] : ["--title", input.title]),
              ...(input.body === undefined ? [] : ["--description", input.body]),
              ...fieldArgs(input),
            ],
          }),
        ),
      ),

    setState: (input) =>
      target("setState", input).pipe(
        Effect.flatMap((scope) =>
          update({
            ...scope,
            cwd: input.cwd,
            operation: "setState",
            args: ["--state", input.state],
          }),
        ),
      ),

    setReaction: (input) =>
      target("setReaction", input).pipe(
        Effect.flatMap((scope) => {
          const type = azureDevOpsReactionType(input.content);
          if (input.subjectId === undefined) {
            return Effect.fail(
              refused("setReaction", "Azure DevOps reactions go on comments only."),
            );
          }
          if (!/^[1-9]\d{0,9}$/.test(input.subjectId)) {
            return Effect.fail(
              refused("setReaction", "The comment id names no Azure DevOps comment."),
            );
          }
          if (type === null) {
            return Effect.fail(refused("setReaction", "Azure DevOps has no such reaction."));
          }
          return run({
            cwd: input.cwd,
            operation: "setReaction",
            args: invokeArgs({
              ...scope,
              resource: "commentsReactions",
              route: [
                `workItemId=${scope.number}`,
                `commentId=${input.subjectId}`,
                `reactionType=${type}`,
              ],
              method: input.reacted ? "PUT" : "DELETE",
              apiVersion: "7.1-preview",
              query: ["api-version=7.1-preview.1"],
            }),
          }).pipe(Effect.asVoid);
        }),
      ),

    listCandidates: (input) =>
      scoped("listCandidates", input).pipe(
        Effect.flatMap((scope) =>
          Effect.all(
            [
              read({
                cwd: input.cwd,
                operation: "listCandidates",
                args: invokeArgs({ ...scope, resource: "tags" }),
                decode: decodeAs(decodeTags),
              }).pipe(
                Effect.map((tags) =>
                  tags.value.map((tag) => ({ name: tag.name, color: null, description: null })),
                ),
              ),
              // Nothing in `az boards` lists who a work item may go to; the project's teams are
              // the nearest thing, read a handful at a time.
              read({
                cwd: input.cwd,
                operation: "listCandidates",
                args: [
                  "devops",
                  "team",
                  "list",
                  "--detect",
                  "false",
                  "--organization",
                  scope.organization,
                  "--project",
                  scope.project,
                  "--top",
                  "10",
                ],
                decode: decodeAs(decodeTeams),
              }).pipe(
                Effect.flatMap((teams) =>
                  Effect.forEach(
                    teams,
                    (team) =>
                      read({
                        cwd: input.cwd,
                        operation: "listCandidates",
                        args: [
                          "devops",
                          "team",
                          "list-member",
                          "--detect",
                          "false",
                          "--organization",
                          scope.organization,
                          "--project",
                          scope.project,
                          "--team",
                          team.id,
                          "--top",
                          String(PAGE_SIZE),
                        ],
                        decode: decodeAs(decodeMembers),
                      }),
                    { concurrency: 3 },
                  ),
                ),
                Effect.map((members) => {
                  const byLogin = new Map<
                    string,
                    { id: string; login: string; name: string | null; avatarUrl: string | null }
                  >();
                  for (const { identity } of members.flat()) {
                    const login = identity.uniqueName.trim();
                    if (
                      identity.isContainer ||
                      login.length === 0 ||
                      byLogin.has(login.toLowerCase())
                    ) {
                      continue;
                    }
                    byLogin.set(login.toLowerCase(), {
                      id: login,
                      login,
                      name: identity.displayName?.trim() || null,
                      avatarUrl: identity.imageUrl?.trim() || null,
                    });
                  }
                  return [...byLogin.values()];
                }),
              ),
            ],
            { concurrency: 2 },
          ),
        ),
        // Teams are a sample of who can be assigned, so somebody missing is not ineligible.
        Effect.map(([labels, assignees]) => ({ labels, assignees, truncated: true })),
      ),
  };
});
