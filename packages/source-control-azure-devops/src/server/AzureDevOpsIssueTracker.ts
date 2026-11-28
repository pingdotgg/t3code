/**
 * Azure DevOps work items as an issue tracker, over `az`. Work items belong to a project, so the
 * scope is `organization/project` and every call names the organization. Listing is a WIQL
 * query paged by a `(changedDate, id)` keyset cursor, because WIQL has no offset.
 */
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueEvent,
  type IssueInvolvement,
  type IssueLinkedPullRequest,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import {
  azureDevOpsReactionType,
  closedStateNames,
  workItemStates,
  decodeCommentsJson,
  decodeUpdatesJson,
  decodeWorkItemJson,
  decodeWorkItemsJson,
  pullRequestNumberOf,
  type AzureDevOpsWorkItem,
  type ClosedStates,
} from "./azureDevOpsIssueJson.ts";
import { decodePullRequestJson } from "./azureDevOpsPullRequestJson.ts";

const KIND = IssueTrackerKind.make("azure-devops");

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
const CLOSED_STATES_TTL = Duration.minutes(10);
/** Updates are read a page per `az` process, oldest first, so a long history is bounded. */
const UPDATE_PAGE_LIMIT = 5;
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
      Schema.Struct({
        name: Schema.String,
        isDisabled: Schema.optional(Schema.Boolean),
        states: Schema.optional(
          Schema.Array(Schema.Struct({ name: Schema.String, category: Schema.String })),
        ),
      }),
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
  // `az` replaces a value starting with `@` by the contents of that local file.
  if (parts.some((part) => part.startsWith("@"))) return null;
  // A legacy organization is its hostname, so its scope may be the project alone.
  if (host.toLowerCase().endsWith(".visualstudio.com")) {
    const project = parts.length === 1 || parts.length === 2 ? parts.at(-1) : undefined;
    return project === undefined ? null : { organization: `https://${host}`, project };
  }
  if (parts.length !== 2) return null;
  const [organization, project] = parts as [string, string];
  return { organization: `https://${host}/${encodeURIComponent(organization)}`, project };
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
    // WIQL over REST has no way to ask who was mentioned (`@RecentMentions` is a web portal
    // macro), so a mention filter has nothing to narrow by.
    case "mentioned":
    case "all":
      return "";
  }
}

function stateClause(state: "all" | "open" | "closed", closedStates: ClosedStates): string {
  const closed = `(${[...closedStates].map(quoted).join(", ")})`;
  switch (state) {
    case "open":
      return ` AND [System.State] NOT IN ${closed}`;
    case "closed":
      return ` AND [System.State] IN ${closed}`;
    case "all":
      return "";
  }
}

/** `<iso date the list is sorted by>|<id>` of the last row handed over, where the next page starts. */
function parseCursor(cursor: string): { readonly date: string; readonly id: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\|([1-9]\d{0,9})$/.exec(cursor);
  return match === null ? null : { date: match[1]!, id: Number(match[2]) };
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
      detail: error.detail,
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
    readonly stdin?: string | undefined;
  }) =>
    azure
      .execute({
        cwd: input.cwd,
        args: [...input.args, "--only-show-errors", "--output", "json"],
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.mapError(fail(input.operation)),
      );

  const read = <A>(input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string | undefined;
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
  const invokeWithBody = Effect.fn("AzureDevOpsIssueTracker.invokeWithBody")(function* (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly body: unknown;
  }) {
    const unwritable = (cause: unknown) =>
      refused(input.operation, "Could not write the Azure DevOps request body.", cause);
    const file = yield* fs
      .makeTempFileScoped({ prefix: "t3-azure-issue-" })
      .pipe(Effect.mapError(unwritable));
    yield* fs.writeFileString(file, encodeJson(input.body)).pipe(Effect.mapError(unwritable));
    return yield* run({
      cwd: input.cwd,
      operation: input.operation,
      args: [...input.args, "--in-file", file, "--media-type", "application/json"],
    });
  }, Effect.scoped);

  const workItemTypes = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly organization: string;
    readonly project: string;
  }) =>
    read({
      cwd: input.cwd,
      operation: input.operation,
      // Form layouts can exceed the CLI output cap; only workflow metadata is needed.
      args: [
        ...invokeArgs({ ...input, resource: "workitemtypes" }),
        "--query",
        "{value: value[].{name: name, isDisabled: isDisabled || `false`, states: (states || `[]`)[].{name: name, category: category}}}",
      ],
      decode: decodeAs(decodeTypes),
    }).pipe(Effect.map((types) => types.value));

  // Shares one in-flight workflow read per project; only a success replaces the cached states.
  const workflowReads = yield* Cache.makeWith(
    (key: string) => {
      const [cwd, organization, project] = JSON.parse(key) as [string, string, string];
      return workItemTypes({ cwd, organization, project, operation: "listIssues" }).pipe(
        Effect.map(closedStateNames),
        Effect.tap((closed) => Cache.set(listClosedStates, key, closed)),
      );
    },
    { capacity: Infinity, timeToLive: () => Duration.zero },
  );
  // Each `az` call costs seconds of startup, and a project's states rarely change.
  const listClosedStates: Cache.Cache<string, ClosedStates, IssueTrackerError> =
    yield* Cache.makeWith((key: string) => Cache.get(workflowReads, key), {
      capacity: 256,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? CLOSED_STATES_TTL : Duration.zero),
    });

  const readWorkItem = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly organization: string;
    readonly number: number;
  }) =>
    run({
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
    });

  const decodeWorkItem = (
    raw: string,
    input: { readonly operation: string; readonly project: string; readonly closed: ClosedStates },
  ): Effect.Effect<AzureDevOpsWorkItem, IssueTrackerError> => {
    const decoded = decodeWorkItemJson(raw, input.closed);
    if (Result.isFailure(decoded)) return Effect.fail(unreadable(input.operation, decoded.failure));
    const item = decoded.success;
    // Azure addresses the item by organization and id. Verify it belongs to this project.
    return item !== null && item.project?.toLowerCase() === input.project.toLowerCase()
      ? Effect.succeed(item)
      : Effect.fail(notFound(input.operation));
  };

  const workItem = (
    input: Parameters<typeof readWorkItem>[0] & Parameters<typeof decodeWorkItem>[1],
  ) => readWorkItem(input).pipe(Effect.flatMap((raw) => decodeWorkItem(raw, input)));

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

  /** Newest first, so the first page is the current discussion and a cursor leads to older ones. */
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
          "order=desc",
          "$expand=reactions",
          "api-version=7.1-preview.4",
          ...(input.cursor === undefined ? [] : [`continuationToken=${input.cursor}`]),
        ],
      }),
      decode: decodeCommentsJson,
    }).pipe(Effect.map((page) => ({ ...page, comments: page.comments.toReversed() })));

  const updates = Effect.fn("AzureDevOpsIssueTracker.updates")(function* (input: {
    readonly cwd: string;
    readonly organization: string;
    readonly project: string;
    readonly number: number;
    readonly closed: ClosedStates;
  }) {
    const events: IssueEvent[] = [];
    for (let page = 0; page < UPDATE_PAGE_LIMIT; page += 1) {
      const answer = yield* read({
        cwd: input.cwd,
        operation: "getIssue",
        args: invokeArgs({
          ...input,
          resource: "updates",
          route: [`id=${input.number}`],
          query: [`$top=${PAGE_SIZE}`, ...(page === 0 ? [] : [`$skip=${page * PAGE_SIZE}`])],
        }),
        decode: (raw) => decodeUpdatesJson(raw, input.closed),
      });
      events.push(...answer.events);
      if (answer.count < PAGE_SIZE) break;
    }
    return events;
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
    readonly stdin?: string | undefined;
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
      stdin: input.stdin,
    }).pipe(Effect.asVoid);

  /** Azure keeps tags as one `; `-joined field and takes exactly one assignee. */
  const fieldArgs = (
    operation: string,
    input: {
      readonly labels?: ReadonlyArray<string> | undefined;
      readonly assignees?: ReadonlyArray<string> | undefined;
    },
  ): Effect.Effect<ReadonlyArray<string>, IssueTrackerError> => {
    if ((input.assignees?.length ?? 0) > 1) {
      return Effect.fail(refused(operation, "An Azure DevOps work item has one assignee at most."));
    }
    const fields = [
      ...(input.labels === undefined ? [] : [["System.Tags", input.labels.join("; ")] as const]),
      ...(input.assignees === undefined
        ? []
        : [["System.AssignedTo", input.assignees[0] ?? ""] as const]),
    ];
    // `az` reads `field=@path` as that local file, and a field value has no stdin to go through.
    if (fields.some(([, value]) => value.startsWith("@"))) {
      return Effect.fail(
        refused(operation, "Azure DevOps takes no label or assignee that starts with `@`."),
      );
    }
    return Effect.succeed(fields.map(([name, value]) => `${name}=${value}`));
  };

  return {
    kind: KIND,
    capabilities: CAPABILITIES,

    // Listing filters with WIQL's `@Me`, so nothing compares against a name. Looking one up
    // needs a profile host that a PAT saved for one organization cannot reach.
    getViewer: () => Effect.succeed("@Me"),

    listIssues: Effect.fn("AzureDevOpsIssueTracker.listIssues")(function* (input) {
      const cursor = input.cursor === undefined ? undefined : parseCursor(input.cursor);
      if (cursor === null) {
        return yield* refused("listIssues", "The cursor was not one Azure DevOps handed out.");
      }
      const limit = Math.min(Math.max(input.limit, 1), PAGE_SIZE);
      const text = input.query?.trim() ?? "";
      const created = input.sort === "created";
      const dateField = created ? "[System.CreatedDate]" : "[System.ChangedDate]";
      return yield* scoped("listIssues", input).pipe(
        Effect.flatMap((scope) => {
          const key = JSON.stringify([input.cwd, scope.organization, scope.project]);
          const refresh = cursor === undefined && input.refresh === true;
          const closed = refresh ? Cache.get(workflowReads, key) : Cache.get(listClosedStates, key);
          return closed.pipe(Effect.map((closed) => ({ scope, closed })));
        }),
        Effect.flatMap(({ scope, closed }) =>
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
                stateClause(input.state, closed) +
                involvementClause(input.involvement) +
                (text.length === 0 ? "" : ` AND [System.Title] CONTAINS ${quoted(text)}`) +
                (input.labels ?? [])
                  .map((label) => ` AND [System.Tags] CONTAINS ${quoted(label)}`)
                  .join("") +
                (input.assignee === undefined
                  ? ""
                  : ` AND [System.AssignedTo] = ${quoted(input.assignee)}`) +
                (cursor === undefined
                  ? ""
                  : ` AND (${dateField} < ${quoted(cursor.date)} OR (${dateField} = ${quoted(cursor.date)} AND [System.Id] < ${cursor.id}))`) +
                ` ORDER BY ${dateField} DESC, [System.Id] DESC`,
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
                : invokeWithBody({
                    cwd: input.cwd,
                    operation: "listIssues",
                    // az resolves `wit/workitems` to the create route (`workitems/${type}`)
                    // and fails before sending; `workitemsbatch` has a single route.
                    args: invokeArgs({ ...scope, resource: "workitemsbatch", method: "POST" }),
                    body: {
                      ids: ids.slice(0, limit).map((row) => row.id),
                      fields: LIST_FIELDS,
                    },
                  }).pipe(
                    Effect.flatMap((raw) => {
                      const decoded = decodeWorkItemsJson(raw, closed);
                      return Result.isSuccess(decoded)
                        ? Effect.succeed(decoded.success)
                        : Effect.fail(unreadable("listIssues", decoded.failure));
                    }),
                    Effect.map((hydrated) => {
                      // The cursor is the last row WIQL sorted, so its order is restored.
                      const position = new Map(ids.map((row, index) => [String(row.id), index]));
                      const items = hydrated.toSorted(
                        (left, right) =>
                          (position.get(left.key) ?? 0) - (position.get(right.key) ?? 0),
                      );
                      const last = items.at(-1);
                      return {
                        items,
                        nextCursor:
                          ids.length > limit && last !== undefined
                            ? `${created ? last.createdAt : last.updatedAt}|${last.key}`
                            : null,
                      };
                    }),
                  ),
            ),
          ),
        ),
      );
    }),

    getIssue: (input) =>
      target("getIssue", input).pipe(
        Effect.flatMap((scope) =>
          Effect.gen(function* () {
            const request = { ...scope, cwd: input.cwd, operation: "getIssue" };
            // Reading the item does not need the workflow. Decode it only after the workflow loads.
            const [types, itemRead] = yield* Effect.all(
              [workItemTypes(request), Effect.result(readWorkItem(request))],
              { concurrency: 2 },
            );
            const closed = closedStateNames(types);
            const item = yield* decodeWorkItem(yield* Effect.fromResult(itemRead), {
              ...request,
              closed,
            });
            return { item, closed, states: workItemStates(types, item) };
          }).pipe(
            Effect.flatMap(({ item, closed, states }) =>
              Effect.all(
                [
                  comments({ ...scope, cwd: input.cwd, operation: "getIssue" }),
                  updates({ ...scope, cwd: input.cwd, closed }),
                  linkedPullRequests({ cwd: input.cwd, organization: scope.organization, item }),
                ],
                { concurrency: 3 },
              ).pipe(
                Effect.map(([conversation, events, links]) => ({
                  ...item,
                  // Its type's own entry, so the category is the one that type gives the name.
                  state: states.find((state) => state.name === item.state.name) ?? item.state,
                  states,
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
        // `az` would read a `continuationToken=@path` as that local file.
        Effect.filterOrFail(
          () => !input.cursor.startsWith("@"),
          () => refused("getComments", "The cursor was not one Azure DevOps handed out."),
        ),
        Effect.flatMap((scope) =>
          comments({ ...scope, cwd: input.cwd, operation: "getComments", cursor: input.cursor }),
        ),
      ),

    create: (input) => {
      const title = AzureDevOpsCli.textOption("--title", input.title);
      const body =
        input.body.length === 0
          ? undefined
          : AzureDevOpsCli.textOption("--description", input.body);
      // az has one stdin, so a second value read from it goes in a call of its own.
      const bodyFollows = title.stdin !== undefined && body?.stdin !== undefined;
      return scoped("create", input).pipe(
        Effect.flatMap((scope) =>
          workItemTypes({ ...scope, cwd: input.cwd, operation: "create" }).pipe(
            Effect.flatMap((types) => {
              const names = types.flatMap((type) => (type.isDisabled ? [] : [type.name]));
              const type = CREATE_TYPES.find((name) => names.includes(name)) ?? names[0];
              return type === undefined
                ? Effect.fail(refused("create", "The project offers no work item type to file."))
                : fieldArgs("create", {
                    ...(input.labels.length === 0 ? {} : { labels: input.labels }),
                    ...(input.assignees.length === 0 ? {} : { assignees: input.assignees }),
                  }).pipe(
                    Effect.map((fields) => ({ type, fields, closed: closedStateNames(types) })),
                  );
            }),
            Effect.flatMap(({ type, fields, closed }) =>
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
                  title.arg,
                  ...(body === undefined || bodyFollows ? [] : [body.arg]),
                  ...(fields.length === 0 ? [] : ["--fields", ...fields]),
                ],
                stdin: title.stdin ?? body?.stdin,
                decode: (raw) => decodeWorkItemJson(raw, closed),
              }),
            ),
            Effect.filterOrFail(
              (item) => item !== null,
              () => unreadable("create", "incomplete-response"),
            ),
            Effect.tap((item) =>
              body === undefined || !bodyFollows
                ? Effect.void
                : update({
                    cwd: input.cwd,
                    operation: "create",
                    organization: scope.organization,
                    number: Number(item.key),
                    args: [body.arg],
                    stdin: body.stdin,
                  }),
            ),
            Effect.map((item) => ({ key: item.key, displayKey: item.displayKey, url: item.url })),
          ),
        ),
      );
    },

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
          fieldArgs("update", input).pipe(Effect.map((fields) => ({ scope, fields }))),
        ),
        // `az` names a work item by id alone, so the read proves the item is the scope's own; it
        // also names the field the item keeps its text in.
        Effect.flatMap(({ scope, fields }) =>
          workItem({ ...scope, cwd: input.cwd, operation: "update", closed: new Set() }).pipe(
            Effect.map((item) => ({ scope, fields, bodyField: item.bodyField })),
          ),
        ),
        Effect.flatMap(({ scope, fields, bodyField }) => {
          const texts = [
            ...(input.title === undefined
              ? []
              : [{ ...AzureDevOpsCli.textOption("--title", input.title), field: false }]),
            ...(input.body === undefined
              ? []
              : bodyField === "System.Description"
                ? [{ ...AzureDevOpsCli.textOption("--description", input.body), field: false }]
                : [{ ...AzureDevOpsCli.textOption(bodyField, input.body), field: true }]),
          ];
          // az has one stdin, so each value read from it needs its own call.
          const batches =
            texts.filter((text) => text.stdin !== undefined).length > 1
              ? texts.map((text) => [text])
              : [texts];
          return Effect.forEach(
            batches,
            (batch, index) => {
              // az keeps only the last `--fields`, so every field of a call goes in one.
              const pairs = [
                ...(index === 0 ? fields : []),
                ...batch.flatMap((text) => (text.field ? [text.arg] : [])),
              ];
              return update({
                ...scope,
                cwd: input.cwd,
                operation: "update",
                args: [
                  ...batch.flatMap((text) => (text.field ? [] : [text.arg])),
                  ...(pairs.length === 0 ? [] : ["--fields", ...pairs]),
                ],
                stdin: batch.find((text) => text.stdin !== undefined)?.stdin,
              });
            },
            { discard: true },
          );
        }),
      ),

    setState: (input) =>
      target("setState", input).pipe(
        // `az` names a work item by id alone, so the read also proves the item is the scope's own.
        Effect.flatMap((scope) =>
          workItem({ ...scope, cwd: input.cwd, operation: "setState", closed: new Set() }).pipe(
            Effect.flatMap((item) =>
              workItemTypes({ ...scope, cwd: input.cwd, operation: "setState" }).pipe(
                Effect.map((types) => workItemStates(types, item)),
              ),
            ),
            Effect.filterOrFail(
              (states) => states.some((state) => state.name === input.state),
              () => refused("setState", `This work item has no "${input.state}" state.`),
            ),
            Effect.flatMap(() =>
              update({
                ...scope,
                cwd: input.cwd,
                operation: "setState",
                args: ["--state", input.state],
              }),
            ),
          ),
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
