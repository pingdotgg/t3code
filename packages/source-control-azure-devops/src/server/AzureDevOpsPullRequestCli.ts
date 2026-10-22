import type {
  PullRequestReviewerCandidateList,
  PullRequestLabelCandidateList,
} from "@t3tools/contracts";
import { makeAzureDevOpsPullRequestTools } from "./azureDevOpsPullRequestTools.ts";
import type {
  PullRequestHostAction,
  PullRequestHostActionResult,
  PullRequestHostDetails,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActivityEvent,
  PullRequestAction,
  PullRequestCommit,
  PullRequestReviewThread,
  PullRequestReviewCommentDraft,
  PullRequestThreadStatus,
  PullRequestComment,
  PullRequestCheck,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeMethod,
} from "@t3tools/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import {
  decodeItemContentJson,
  decodeIterationChangesJson,
  decodeIterationsJson,
  decodePullRequestJson,
  decodePullRequestListJson,
  decodeThreadsJson,
  decodeDiscussionJson,
  decodeCommitsJson,
  decodeCommitJson,
  decodeCommitChangesJson,
  type AzureDevOpsChangeEntry,
  type AzureDevOpsItemContent,
  type AzureDevOpsIteration,
  type AzureDevOpsPullRequest,
  type AzureDevOpsRepositoryLocation,
} from "./azureDevOpsPullRequestJson.ts";
import type { ProviderListCursor } from "@t3tools/source-control-core/server/PullRequestProvider";

const refusalDetails = {
  "permission-denied": "Your Azure account does not have permission for this action.",
  inactive: "This pull request is no longer active.",
  "root-commit": "A root commit cannot be compared with its parent.",
  "review-position-unavailable":
    "The file's current review position is unavailable. Refresh the pull request before commenting.",
  "stale-suggestion":
    "The source branch changed. Refresh the pull request before applying this suggestion.",
  "invalid-suggestion-anchor":
    "Only a suggestion anchored to the current source file can be applied.",
  "outdated-suggestion": "The lines this suggestion was written for are no longer in the file.",
  "binary-suggestion": "A suggestion cannot be applied to a binary file.",
  "changed-suggestion":
    "The lines this suggestion targets changed after it was written. Review the current code before applying it.",
  "invalid-suggestion": "Choose a comment containing exactly one suggestion on a valid line range.",
  "already-applied-suggestion": "This suggestion is already present in the source file.",
  "reviewer-ineligible":
    "Only an optional reviewer with no vote can decline. Authors cannot decline or flag their own review.",
  "draft-vote": "Publish this draft before voting.",
  "draft-completion": "Publish this draft before completing it.",
  "not-completed": "Only a completed pull request can be reverted.",
  "branch-operation-failed": "Azure could not complete the branch operation.",
  "branch-operation-id-missing": "Azure omitted the branch operation id.",
} as const;

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class AzureDevOpsPullRequestReadError extends Schema.TaggedError<AzureDevOpsPullRequestReadError>()(
  "AzureDevOpsPullRequestReadError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
    operation: Schema.String,
    reason: Schema.optional(
      Schema.Literals([
        "permission-denied",
        "inactive",
        "root-commit",
        "review-position-unavailable",
        "stale-suggestion",
        "invalid-suggestion-anchor",
        "outdated-suggestion",
        "binary-suggestion",
        "changed-suggestion",
        "invalid-suggestion",
        "already-applied-suggestion",
        "reviewer-ineligible",
        "draft-vote",
        "draft-completion",
        "not-completed",
        "branch-operation-failed",
        "branch-operation-id-missing",
      ]),
    ),
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return this.reason
      ? refusalDetails[this.reason]
      : `Azure CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Azure CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsViewerUnavailableError extends Schema.TaggedError<AzureDevOpsViewerUnavailableError>()(
  "AzureDevOpsViewerUnavailableError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "Azure CLI could not name the signed-in account. Run `az login` and retry.";
  }

  override get message(): string {
    return `Azure CLI failed in getViewer: ${this.detail}`;
  }
}

export class AzureDevOpsDiscussionPreparationError extends Schema.TaggedError<AzureDevOpsDiscussionPreparationError>()(
  "AzureDevOpsDiscussionPreparationError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {
  get detail(): string {
    return "Could not prepare the Azure DevOps discussion update.";
  }
  override get message(): string {
    return this.detail;
  }
}

/**
 * Not a decode failure either: az answered with a well-formed pull request that simply carries
 * no branch or link, which is a response this cannot place rather than one it cannot read.
 */
export class AzureDevOpsPullRequestIncompleteError extends Schema.TaggedError<AzureDevOpsPullRequestIncompleteError>()(
  "AzureDevOpsPullRequestIncompleteError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  get detail(): string {
    return "Azure DevOps returned no branch or link for the pull request.";
  }

  override get message(): string {
    return `Azure CLI failed in getPullRequest: ${this.detail}`;
  }
}

export class AzureDevOpsReviewerNameError extends Schema.TaggedError<AzureDevOpsReviewerNameError>()(
  "AzureDevOpsReviewerNameError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "A reviewer is named by an email address or an identity id.";
  }

  override get message(): string {
    return `Azure CLI failed in setPullRequestReviewers: ${this.detail}`;
  }
}

type AzureDevOpsMergeStrategies = NonNullable<PullRequestHostDetails["allowedMergeStrategies"]>;

export type AzureDevOpsPullRequestCliError =
  | AzureDevOpsCli.AzureDevOpsCliError
  | AzureDevOpsPullRequestReadError
  | AzureDevOpsPullRequestIncompleteError
  | AzureDevOpsReviewerNameError
  | AzureDevOpsViewerUnavailableError
  | AzureDevOpsDiscussionPreparationError;

const REST_API_VERSION = "7.1";
const encodeReplyBody = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      content: Schema.String,
      parentCommentId: Schema.Literal(1),
      commentType: Schema.Literal(1),
    }),
  ),
);
const encodeCommentBody = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ content: Schema.String })),
);
const encodeStatusBody = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String })),
);
const encodeNewThreadBody = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      comments: Schema.Array(
        Schema.Struct({
          content: Schema.String,
          commentType: Schema.Literal(1),
          parentCommentId: Schema.Literal(0),
        }),
      ),
      status: Schema.Literal("active"),
      pullRequestThreadContext: Schema.optional(
        Schema.Struct({
          changeTrackingId: Schema.Int,
          iterationContext: Schema.Struct({
            firstComparingIteration: Schema.Int,
            secondComparingIteration: Schema.Int,
          }),
        }),
      ),
      threadContext: Schema.optional(
        Schema.Struct({
          filePath: Schema.String,
          leftFileStart: Schema.optional(Schema.Struct({ line: Schema.Int, offset: Schema.Int })),
          leftFileEnd: Schema.optional(Schema.Struct({ line: Schema.Int, offset: Schema.Int })),
          rightFileStart: Schema.optional(Schema.Struct({ line: Schema.Int, offset: Schema.Int })),
          rightFileEnd: Schema.optional(Schema.Struct({ line: Schema.Int, offset: Schema.Int })),
        }),
      ),
    }),
  ),
);
const PULL_REQUEST_LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/**
 * A full page of change entries is two thousand files, each carrying its path, its url and
 * several object ids, which is past the megabyte a read is given by default.
 */
const CHANGE_ENTRIES_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/**
 * Four times the megabyte of file the other hosts hand over, because Azure has no route that
 * serves the bytes themselves: the file arrives inside a JSON envelope, escaped if it is text and
 * base64 if it is not, and both are larger than the file they carry.
 */
const ITEM_CONTENT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/**
 * Neither route pages, so each answers with the whole of it at once and grows with how
 * long the review ran rather than with how large the change is.
 */
const REVIEW_HISTORY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Azure's own ceiling for one page of an iteration's changes. */
const CHANGE_ENTRIES_PER_PAGE = 2000;

/**
 * Where following the pages stops, counted in the entries Azure was asked to skip rather than in
 * the files that survived decoding: a page can be entirely folders and other entries a review has
 * nothing to show for, and bounding on what was kept would follow such a change forever.
 */
const MAX_CHANGE_ENTRIES = 10_000;

export interface AzureDevOpsIterationChanges {
  readonly changes: ReadonlyArray<AzureDevOpsChangeEntry>;
  readonly truncated: boolean;
}

export class AzureDevOpsPullRequestCli extends Context.Service<
  AzureDevOpsPullRequestCli,
  {
    /** Policies and statuses, and the merge strategies the policies allow. */
    readonly listChecks: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
      iterationId: number | null;
    }) => Effect.Effect<
      {
        checks: ReadonlyArray<PullRequestCheck>;
        allowedMergeStrategies: AzureDevOpsMergeStrategies;
      },
      AzureDevOpsPullRequestCliError
    >;
    /** Only the policy read behind `allowedMergeStrategies`, for checking a completion. */
    readonly listMergeStrategies: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
    }) => Effect.Effect<AzureDevOpsMergeStrategies, AzureDevOpsPullRequestCliError>;
    readonly listLabelCandidates: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
    }) => Effect.Effect<PullRequestLabelCandidateList, AzureDevOpsPullRequestCliError>;
    readonly setLabels: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
      labels: ReadonlyArray<string>;
      applied: boolean;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;
    readonly getHostDetails: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
    }) => Effect.Effect<PullRequestHostDetails, AzureDevOpsPullRequestCliError>;
    readonly runHostAction: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
      action: PullRequestHostAction;
    }) => Effect.Effect<PullRequestHostActionResult, AzureDevOpsPullRequestCliError>;
    readonly getViewer: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, AzureDevOpsPullRequestCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /**
       * Where to carry on from. Azure has no date filter for a pull request listing, so the only
       * part of a cursor it can use is how many rows have already been handed over.
       */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<
      {
        readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
        readonly truncated: boolean;
        readonly cursorAdvance: number;
      },
      AzureDevOpsPullRequestCliError
    >;

    readonly listReviewerCandidates: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, AzureDevOpsPullRequestCliError>;

    readonly readVisit: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
      hashes?: ReadonlyArray<string>;
      viewed?: boolean;
    }) => Effect.Effect<
      { hashes: Readonly<Record<string, number>>; denied: boolean },
      AzureDevOpsPullRequestCliError
    >;
    readonly readAccess: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
    }) => Effect.Effect<
      { credentialKey: string; permissions: Readonly<Record<string, boolean | null>> },
      AzureDevOpsPullRequestCliError
    >;
    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<AzureDevOpsPullRequest, AzureDevOpsPullRequestCliError>;

    /** Threads are not reachable through `az repos pr`, so they come from the REST API. */
    readonly readDiscussion: (input: {
      iterationId?: number;
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
      viewer?: string;
    }) => Effect.Effect<
      {
        comments: ReadonlyArray<PullRequestComment>;
        reviewThreads: ReadonlyArray<PullRequestReviewThread>;
        events?: ReadonlyArray<PullRequestActivityEvent>;
        identities?: Readonly<Record<string, string>>;
        untrackedThreadIds?: ReadonlyArray<string>;
      },
      AzureDevOpsPullRequestCliError
    >;
    readonly listCommits: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, AzureDevOpsPullRequestCliError>;
    readonly getCommitScope: (input: {
      cwd: string;
      location: AzureDevOpsRepositoryLocation;
      commit: string;
    }) => Effect.Effect<
      { iteration: AzureDevOpsIteration; changes: AzureDevOpsIterationChanges },
      AzureDevOpsPullRequestCliError
    >;
    readonly listThreads: (input: {
      readonly viewer?: string;
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestComment>, AzureDevOpsPullRequestCliError>;

    readonly setCommentLike: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
      readonly threadId: string;
      readonly commentId: string;
      readonly liked: boolean;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;
    /**
     * Starts one discussion per entry. Every line anchor is resolved against the latest push
     * before anything is posted, so a review whose anchor is gone posts none of its comments.
     */
    readonly createThreads: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
      readonly threads: ReadonlyArray<{
        readonly body: string;
        readonly comment?: PullRequestReviewCommentDraft;
      }>;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;
    readonly updateComment: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
      readonly threadId: string;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;
    readonly deleteComment: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
      readonly threadId: string;
      readonly commentId: string;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;
    readonly setThreadStatus: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
      readonly threadId: string;
      readonly status: PullRequestThreadStatus;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;
    readonly replyToThread: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
      readonly threadId: string;
      readonly body: string;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;

    /**
     * Azure hangs the changed files off an iteration rather than off the pull
     * request, so reading a diff starts here.
     */
    readonly listIterations: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<AzureDevOpsIteration>, AzureDevOpsPullRequestCliError>;

    /**
     * What one iteration changed, against the merge base rather than against the previous push,
     * which is the whole of the pull request rather than the latest slice of it.
     */
    readonly listIterationChanges: (input: {
      readonly compareTo?: number;
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
      readonly iterationId: number;
    }) => Effect.Effect<AzureDevOpsIterationChanges, AzureDevOpsPullRequestCliError>;

    /**
     * One file's text at one commit. Azure has no diff route that carries content, so both sides
     * of every changed file are read this way and the patch is made from them here.
     */
    readonly readItemContent: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly path: string;
      readonly commit: string;
    }) => Effect.Effect<AzureDevOpsItemContent, AzureDevOpsPullRequestCliError>;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;

    readonly updatePullRequest: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;

    /**
     * `az repos pr reviewer` is the whole of what Azure offers here: it adds and removes named
     * identities, and has no counterpart that says who could be named.
     */
    readonly setPullRequestReviewers: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<string>;
      readonly requested: boolean;
    }) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestCli") {}

function statusArgs(state: PullRequestListState): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["--status", "active"];
    case "merged":
      return ["--status", "completed"];
    case "closed":
      return ["--status", "abandoned"];
    case "all":
      return ["--status", "all"];
  }
}

function involvementArgs(input: {
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<string> {
  switch (input.involvement) {
    case "authored":
      return ["--creator", input.viewer];
    case "reviewing":
      return ["--reviewer", input.viewer];
    case "all":
      return [];
  }
}

function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  switch (action) {
    case "merge":
      return ["--status", "completed", "--squash", mergeMethod === "squash" ? "true" : "false"];
    case "enable-auto-merge":
      return [
        "--auto-complete",
        "true",
        ...(mergeMethod === undefined
          ? []
          : ["--squash", mergeMethod === "squash" ? "true" : "false"]),
      ];
    case "disable-auto-merge":
      return ["--auto-complete", "false"];
    case "ready":
      return ["--draft", "false"];
    case "draft":
      return ["--draft", "true"];
    case "close":
      return ["--status", "abandoned"];
    case "update-branch":
      return [];
    case "reopen":
      return ["--status", "active"];
    case "revert":
    case "approve-workflows":
    case "delete-branch":
      throw new Error(`Azure DevOps pull request action ${action} is unsupported`);
  }
}

/**
 * The dash is the whole point — these are argv, and a value that looks like a
 * flag stops being a value.
 */
function isReviewerName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && !name.startsWith("-");
}

/** @public Service construction is part of the canonical Effect module API. */
const decodeAccess = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      credentialKey: Schema.String,
      permissions: Schema.Record(Schema.String, Schema.NullOr(Schema.Boolean)),
    }),
  ),
);
const decodeVisit = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      denied: Schema.optional(Schema.Boolean),
      dataProviders: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            visit: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  viewedState: Schema.optional(Schema.NullOr(Schema.String)),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  ),
);
const decodeViewedState = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      hashes: Schema.Union([Schema.Record(Schema.String, Schema.Int), Schema.Array(Schema.Never)]),
    }),
  ),
);

const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fileSystem = yield* FileSystem.FileSystem;

  // The remote takes three shapes and only `az` knows how to read all of them.
  const detectArgs = ["--detect", "true"] as const;

  const executeJson = (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly maxOutputBytes?: number;
  }) =>
    azure.execute({
      cwd: input.cwd,
      args: [...input.args, "--only-show-errors", "--output", "json"],
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
    });

  /**
   * Used in place of `az rest` because it signs in the way the azure-devops extension does: `az
   * rest` mints its own token against the tenant `az` defaults to, and an organisation in any
   * other tenant answers that with a sign-in page, which arrives here as unreadable output
   * rather than as a failure.
   */
  const writeResponse = Effect.fn("AzureDevOpsPullRequestCli.writeResponse")(function* (input: {
    cwd: string;
    resource: string;
    routeParameters: ReadonlyArray<string>;
    area?: string;
    method: "POST" | "PATCH" | "DELETE" | "PUT";
    body?: string;
  }) {
    let bodyFile: string | undefined;
    if (input.body !== undefined) {
      bodyFile = yield* fileSystem
        .makeTempFileScoped({ prefix: "t3-azure-comment-", suffix: ".json" })
        .pipe(
          Effect.mapError(
            (cause) => new AzureDevOpsDiscussionPreparationError({ cwd: input.cwd, cause }),
          ),
        );
      yield* fileSystem
        .writeFileString(bodyFile, input.body)
        .pipe(
          Effect.mapError(
            (cause) => new AzureDevOpsDiscussionPreparationError({ cwd: input.cwd, cause }),
          ),
        );
    }
    if (input.area === "notification" && (input.method === "POST" || input.method === "DELETE")) {
      const subscriptionId = input.routeParameters
        .find((value) => value.startsWith("subscriptionId="))
        ?.slice("subscriptionId=".length);
      return yield* azure.notificationSubscriptions({
        cwd: input.cwd,
        method: input.method,
        ...(subscriptionId === undefined ? {} : { subscriptionId }),
        ...(bodyFile === undefined ? {} : { bodyFile }),
      });
    }
    if (input.resource === "pullRequests" && input.method === "PATCH" && bodyFile !== undefined) {
      const parameters = new Map(
        input.routeParameters.map((parameter) => {
          const index = parameter.indexOf("=");
          return [parameter.slice(0, index), parameter.slice(index + 1)] as const;
        }),
      );
      return yield* azure.patchPullRequest({
        cwd: input.cwd,
        bodyFile,
        routeValues: {
          project: parameters.get("project")!,
          repositoryId: parameters.get("repositoryId")!,
          pullRequestId: parameters.get("pullRequestId")!,
        },
      });
    }
    return yield* executeJson({
      cwd: input.cwd,
      args: [
        "devops",
        "invoke",
        ...detectArgs,
        "--area",
        input.area ?? "git",
        "--resource",
        input.resource,
        "--api-version",
        input.area === "policy" ? "7.1-preview" : REST_API_VERSION,
        ...(input.routeParameters.length === 0
          ? []
          : ["--route-parameters", ...input.routeParameters]),
        "--http-method",
        input.method,
        ...(bodyFile === undefined ? [] : ["--in-file", bodyFile, "--encoding", "utf-8"]),
      ],
    });
  }, Effect.scoped);

  const write = (input: Parameters<typeof writeResponse>[0]) =>
    writeResponse(input).pipe(Effect.asVoid);

  const invoke = <A>(input: {
    readonly cwd: string;
    readonly operation: string;
    readonly resource: string;
    readonly routeParameters: ReadonlyArray<string>;
    readonly queryParameters?: ReadonlyArray<string>;
    readonly maxOutputBytes?: number;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, AzureDevOpsPullRequestCliError> =>
    executeJson({
      cwd: input.cwd,
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      args: [
        "devops",
        "invoke",
        ...detectArgs,
        "--area",
        "git",
        "--resource",
        input.resource,
        "--api-version",
        REST_API_VERSION,
        "--route-parameters",
        ...input.routeParameters,
        ...(input.queryParameters === undefined
          ? []
          : ["--query-parameters", ...input.queryParameters]),
      ],
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = input.decode(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new AzureDevOpsPullRequestReadError({
                command: "az",
                cwd: input.cwd,
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  /**
   * Azure names its own items with a leading slash, which the repository paths carried around
   * here have had taken off so they match the patch and the viewed mark. Put it back on the way
   * out, because the items route is documented in Azure's own spelling.
   */
  const toItemPath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

  const repositoryRoute = (location: AzureDevOpsRepositoryLocation): ReadonlyArray<string> => [
    `project=${location.project}`,
    `repositoryId=${location.repository}`,
  ];

  const pullRequestRoute = (input: {
    readonly location: AzureDevOpsRepositoryLocation;
    readonly number: number;
  }): ReadonlyArray<string> => [
    ...repositoryRoute(input.location),
    `pullRequestId=${input.number}`,
  ];

  /**
   * Azure pages by raw offset. Keep reading when malformed rows leave the decoded page short, and
   * retain the raw count so the next public cursor skips every row this walk consumed.
   */
  const listPullRequestPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly skip: number;
    readonly cursorAdvance: number;
    readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
  }): Effect.Effect<
    {
      readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
      readonly truncated: boolean;
      readonly cursorAdvance: number;
    },
    AzureDevOpsPullRequestCliError
  > => {
    const remaining = input.limit - input.items.length;
    const top = remaining + 1;
    return executeJson({
      cwd: input.cwd,
      maxOutputBytes: PULL_REQUEST_LIST_MAX_OUTPUT_BYTES,
      args: [
        "repos",
        "pr",
        "list",
        ...detectArgs,
        "--repository",
        input.repository,
        ...statusArgs(input.state),
        ...involvementArgs(input),
        "--include-links",
        ...(input.skip === 0 ? [] : ["--skip", String(input.skip)]),
        "--top",
        String(top),
      ],
    }).pipe(
      Effect.flatMap((result) => {
        const raw = result.stdout.trim();
        if (raw.length === 0) {
          return Effect.succeed({
            items: input.items,
            truncated: false,
            cursorAdvance: input.cursorAdvance,
          });
        }
        const decoded = decodePullRequestListJson(raw);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new AzureDevOpsPullRequestReadError({
              command: "az",
              cwd: input.cwd,
              operation: "listPullRequests",
              cause: decoded.failure,
            }),
          );
        }

        const lastItemIndex = decoded.success.rawIndexes[remaining - 1];
        if (lastItemIndex !== undefined) {
          const consumed = lastItemIndex + 1;
          return Effect.succeed({
            items: [...input.items, ...decoded.success.items.slice(0, remaining)],
            truncated: consumed < decoded.success.rawCount || decoded.success.rawCount === top,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }

        const items = [...input.items, ...decoded.success.items];
        if (decoded.success.rawCount < top) {
          return Effect.succeed({
            items,
            truncated: false,
            cursorAdvance: input.cursorAdvance + decoded.success.rawCount,
          });
        }
        return listPullRequestPage({
          ...input,
          skip: input.skip + decoded.success.rawCount,
          cursorAdvance: input.cursorAdvance + decoded.success.rawCount,
          items,
        });
      }),
    );
  };

  const tools = makeAzureDevOpsPullRequestTools({
    listIterations: (input) => api.listIterations(input),
    readItemContent: (input) => api.readItemContent(input),
    resolveIdentities: (input) => azure.resolveIdentities(input),
    execute: executeJson,
    write,
    writeJson: (input) => writeResponse(input).pipe(Effect.map((output) => output.stdout)),
    identity: (input) => azure.authenticatedIdentity(input),
    uploadAttachment: (input) =>
      azure.uploadAttachment({
        cwd: input.cwd,
        fileName: input.fileName,
        data: input.data,
        routeValues: {
          project: input.location.project,
          repositoryId: input.location.repository,
          pullRequestId: String(input.number),
        },
      }),
    subscriptions: (input) => azure.notificationSubscriptions({ ...input, method: "GET" }),
    failure: (input) => new AzureDevOpsPullRequestReadError(input),
  });

  const api: AzureDevOpsPullRequestCli["Service"] = AzureDevOpsPullRequestCli.of({
    readAccess: (input) =>
      azure
        .pullRequestContext({
          ...input,
          project: input.location.project,
          repository: input.location.repository,
          operation: "permissions",
        })
        .pipe(
          Effect.flatMap((output) => decodeAccess(output.stdout)),
          Effect.mapError(
            (cause) =>
              new AzureDevOpsPullRequestReadError({
                cwd: input.cwd,
                command: "az",
                operation: "read permissions",
                cause,
              }),
          ),
        ),
    readVisit: (input) =>
      azure
        .pullRequestContext({
          ...input,
          project: input.location.project,
          repository: input.location.repository,
          operation: "visit",
        })
        .pipe(
          Effect.flatMap((output) => decodeVisit(output.stdout)),
          Effect.flatMap((data) => {
            const value =
              data.dataProviders?.["ms.vss-code-web.pr-detail-visit-data-provider"]?.visit
                ?.viewedState;
            return value
              ? decodeViewedState(value).pipe(
                  Effect.map((state) => ({
                    hashes: Array.isArray(state.hashes)
                      ? {}
                      : (state.hashes as Readonly<Record<string, number>>),
                    denied: false,
                  })),
                )
              : Effect.succeed({ hashes: {}, denied: data.denied ?? false });
          }),
          Effect.mapError(
            (cause) =>
              new AzureDevOpsPullRequestReadError({
                cwd: input.cwd,
                command: "az",
                operation: "read viewed files",
                cause,
              }),
          ),
        ),
    listReviewerCandidates: tools.reviewerCandidates,
    listLabelCandidates: tools.labelCandidates,
    listChecks: tools.checks,
    listMergeStrategies: tools.mergeStrategies,
    setLabels: tools.setLabels,
    getHostDetails: tools.details,
    runHostAction: tools.run,
    getViewer: (input) =>
      azure.authenticatedIdentity(input).pipe(Effect.map((identity) => identity.login)),

    listPullRequests: (input) =>
      listPullRequestPage({
        cwd: input.cwd,
        repository: input.repository,
        state: input.state,
        involvement: input.involvement,
        viewer: input.viewer,
        limit: input.limit,
        skip: input.cursor?.delivered ?? 0,
        cursorAdvance: 0,
        items: [],
      }),

    getPullRequest: (input) =>
      executeJson({
        cwd: input.cwd,
        args: ["repos", "pr", "show", ...detectArgs, "--id", String(input.number)],
      }).pipe(
        Effect.flatMap(
          (result): Effect.Effect<AzureDevOpsPullRequest, AzureDevOpsPullRequestCliError> => {
            const decoded = decodePullRequestJson(result.stdout.trim());
            if (!Result.isSuccess(decoded)) {
              return Effect.fail(
                new AzureDevOpsPullRequestReadError({
                  command: "az",
                  cwd: input.cwd,
                  operation: "getPullRequest",
                  cause: decoded.failure,
                }),
              );
            }
            return decoded.success === null
              ? Effect.fail(
                  new AzureDevOpsPullRequestIncompleteError({
                    command: "az",
                    cwd: input.cwd,
                    number: input.number,
                  }),
                )
              : Effect.succeed(decoded.success);
          },
        ),
      ),

    readDiscussion: (input) =>
      invoke({
        cwd: input.cwd,
        operation: "readDiscussion",
        queryParameters:
          input.iterationId === undefined
            ? []
            : [`$iteration=${input.iterationId}`, "$baseIteration=0"],
        resource: "pullRequestThreads",
        routeParameters: pullRequestRoute(input),
        maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
        decode: (raw) => decodeDiscussionJson(raw, input.viewer, input.iterationId),
      }),
    listCommits: (input) =>
      invoke({
        cwd: input.cwd,
        operation: "listCommits",
        resource: "pullRequestCommits",
        routeParameters: pullRequestRoute(input),
        queryParameters: ["$top=1000"],
        maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
        decode: decodeCommitsJson,
      }),
    getCommitScope: Effect.fn("AzureDevOpsPullRequestCli.getCommitScope")(function* (input) {
      const commit = yield* invoke({
        cwd: input.cwd,
        operation: "getCommit",
        resource: "commits",
        routeParameters: [...repositoryRoute(input.location), `commitId=${input.commit}`],
        decode: decodeCommitJson,
      });
      const parent = commit.parents?.[0];
      if (!parent)
        return yield* new AzureDevOpsPullRequestReadError({
          command: "az",
          cwd: input.cwd,
          operation: "commit parent",
          reason: "root-commit",
          cause: "A root commit cannot be compared with its parent.",
        });
      const changes = yield* invoke({
        cwd: input.cwd,
        operation: "commitChanges",
        resource: "commitDiffs",
        routeParameters: repositoryRoute(input.location),
        queryParameters: [
          `baseVersion=${parent}`,
          "baseVersionType=commit",
          `targetVersion=${commit.commitId}`,
          "targetVersionType=commit",
          "$top=2000",
        ],
        maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
        decode: decodeCommitChangesJson,
      });
      return {
        iteration: { id: 1, headCommit: commit.commitId, mergeBaseCommit: parent },
        changes,
      };
    }),
    listThreads: (input) =>
      invoke({
        cwd: input.cwd,
        operation: "listThreads",
        resource: "pullRequestThreads",
        routeParameters: pullRequestRoute(input),
        maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
        decode: (raw) => decodeThreadsJson(raw, input.viewer),
      }),

    setCommentLike: (input) =>
      write({
        cwd: input.cwd,
        resource: "pullRequestCommentLikes",
        routeParameters: [
          ...pullRequestRoute(input),
          `threadId=${input.threadId}`,
          `commentId=${input.commentId}`,
        ],
        method: input.liked ? "POST" : "DELETE",
      }),
    createThreads: Effect.fn(function* (input) {
      const anchored = input.threads.some((thread) => thread.comment !== undefined);
      const latest = anchored ? (yield* api.listIterations(input)).at(-1) : undefined;
      const changes =
        latest === undefined
          ? []
          : (yield* api.listIterationChanges({ ...input, iterationId: latest.id })).changes;
      const bodies: string[] = [];
      for (const { body, comment } of input.threads) {
        const change = changes.find((change) => change.path === comment?.path.replace(/^\//, ""));
        if (latest && comment && change?.changeTrackingId === undefined) {
          return yield* new AzureDevOpsPullRequestReadError({
            cwd: input.cwd,
            command: "az",
            operation: "anchor review comment",
            reason: "review-position-unavailable",
            cause:
              "The file's current review position is unavailable. Refresh the pull request before commenting.",
          });
        }
        bodies.push(
          encodeNewThreadBody({
            comments: [{ content: body, parentCommentId: 0, commentType: 1 }],
            status: "active",
            ...(latest && change?.changeTrackingId !== undefined
              ? {
                  pullRequestThreadContext: {
                    changeTrackingId: change.changeTrackingId,
                    iterationContext: {
                      firstComparingIteration: latest.id,
                      secondComparingIteration: latest.id,
                    },
                  },
                }
              : {}),
            ...(comment === undefined
              ? {}
              : {
                  threadContext: (() => {
                    if (comment.fileLevel) return { filePath: toItemPath(comment.path) };
                    const position = comment.position;
                    const left =
                      position.kind === "deleted" ||
                      (position.kind === "context" && position.side === "left");
                    const line = left ? position.oldLine : position.newLine;
                    const startLine = Math.min(comment.startLine ?? line, line);
                    return {
                      filePath: toItemPath(comment.path),
                      ...(left
                        ? {
                            leftFileStart: { line: startLine, offset: 1 },
                            leftFileEnd: { line, offset: 1 },
                          }
                        : {
                            rightFileStart: { line: startLine, offset: 1 },
                            rightFileEnd: { line, offset: 1 },
                          }),
                    };
                  })(),
                }),
          }),
        );
      }
      for (const body of bodies)
        yield* write({
          cwd: input.cwd,
          resource: "pullRequestThreads",
          routeParameters: pullRequestRoute(input),
          method: "POST",
          body,
        });
    }),
    replyToThread: (input) =>
      write({
        cwd: input.cwd,
        resource: "pullRequestThreadComments",
        routeParameters: [...pullRequestRoute(input), `threadId=${input.threadId}`],
        method: "POST",
        body: encodeReplyBody({ content: input.body, parentCommentId: 1, commentType: 1 }),
      }),
    updateComment: (input) =>
      write({
        cwd: input.cwd,
        resource: "pullRequestThreadComments",
        routeParameters: [
          ...pullRequestRoute(input),
          `threadId=${input.threadId}`,
          `commentId=${input.commentId}`,
        ],
        method: "PATCH",
        body: encodeCommentBody({ content: input.body }),
      }),
    deleteComment: (input) =>
      write({
        cwd: input.cwd,
        resource: "pullRequestThreadComments",
        routeParameters: [
          ...pullRequestRoute(input),
          `threadId=${input.threadId}`,
          `commentId=${input.commentId}`,
        ],
        method: "DELETE",
      }),
    setThreadStatus: (input) =>
      write({
        cwd: input.cwd,
        resource: "pullRequestThreads",
        routeParameters: [...pullRequestRoute(input), `threadId=${input.threadId}`],
        method: "PATCH",
        body: encodeStatusBody({ status: input.status }),
      }),

    listIterations: (input) =>
      invoke({
        cwd: input.cwd,
        operation: "listIterations",
        resource: "pullRequestIterations",
        routeParameters: pullRequestRoute(input),
        maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
        decode: decodeIterationsJson,
      }),

    listIterationChanges: (input) => {
      const page = (skip: number) =>
        invoke({
          cwd: input.cwd,
          operation: "listIterationChanges",
          resource: "pullRequestIterationChanges",
          routeParameters: [...pullRequestRoute(input), `iterationId=${input.iterationId}`],
          // Azure pages this route at 1000 entries by default; this is its own maximum per page,
          // and it names where the next page starts rather than answering with the whole change.
          queryParameters: [
            `$top=${CHANGE_ENTRIES_PER_PAGE}`,
            `$skip=${skip}`,
            ...(input.compareTo === undefined ? [] : [`$compareTo=${input.compareTo}`]),
          ],
          maxOutputBytes: CHANGE_ENTRIES_MAX_OUTPUT_BYTES,
          decode: decodeIterationChangesJson,
        });
      const from = (
        skip: number,
        collected: ReadonlyArray<AzureDevOpsChangeEntry>,
      ): Effect.Effect<AzureDevOpsIterationChanges, AzureDevOpsPullRequestCliError> =>
        page(skip).pipe(
          Effect.flatMap((answer) => {
            const changes = [...collected, ...answer.changes];
            if (answer.nextSkip === null) return Effect.succeed({ changes, truncated: false });
            return answer.nextSkip <= skip || answer.nextSkip >= MAX_CHANGE_ENTRIES
              ? Effect.succeed({ changes, truncated: true })
              : from(answer.nextSkip, changes);
          }),
        );
      return from(0, []);
    },

    readItemContent: (input) =>
      invoke({
        cwd: input.cwd,
        operation: "readItemContent",
        resource: "items",
        routeParameters: repositoryRoute(input.location),
        queryParameters: [
          `path=${toItemPath(input.path)}`,
          "versionDescriptor.versionType=commit",
          `versionDescriptor.version=${input.commit}`,
          "includeContent=true",
          // Azure leaves `contentMetadata` out unless this is asked for, and with it goes its own
          // word on whether the file is binary, which is the only reliable one, since a binary
          // file arrives encoded rather than as the bytes it is on the host.
          "includeContentMetadata=true",
          // Without this Azure answers with the file's own bytes rather than with a JSON
          // envelope, and `az devops invoke` refuses anything it cannot parse as JSON.
          "$format=json",
        ],
        maxOutputBytes: ITEM_CONTENT_MAX_OUTPUT_BYTES,
        decode: decodeItemContentJson,
      }),

    setPullRequestReviewers: (input) =>
      input.reviewers.some((reviewer) => !isReviewerName(reviewer))
        ? Effect.fail(new AzureDevOpsReviewerNameError({ command: "az", cwd: input.cwd }))
        : azure
            .execute({
              cwd: input.cwd,
              args: [
                "repos",
                "pr",
                "reviewer",
                input.requested ? "add" : "remove",
                ...detectArgs,
                "--id",
                String(input.number),
                // One `--reviewers` takes them all, because az reads the flag as a list and a
                // second one would replace the first rather than add to it.
                "--reviewers",
                ...input.reviewers,
                "--only-show-errors",
                "--output",
                "json",
              ],
            })
            .pipe(Effect.asVoid),

    runPullRequestAction: (input) =>
      azure
        .execute({
          cwd: input.cwd,
          args: [
            "repos",
            "pr",
            "update",
            ...detectArgs,
            "--id",
            String(input.number),
            ...actionArgs(input.action, input.mergeMethod),
            "--only-show-errors",
            "--output",
            "json",
          ],
        })
        .pipe(Effect.asVoid),

    updatePullRequest: (input) =>
      azure
        .execute({
          cwd: input.cwd,
          args: [
            "repos",
            "pr",
            "update",
            ...detectArgs,
            "--id",
            String(input.number),
            // One argument rather than a flag and a value beside it: a description usually opens
            // with a bullet, and az reads a dash in the next argv slot as a flag of its own.
            // `--description` also takes several strings, and this keeps the whole text as one.
            ...(input.title === undefined ? [] : [`--title=${input.title}`]),
            ...(input.body === undefined ? [] : [`--description=${input.body}`]),
            "--only-show-errors",
            "--output",
            "json",
          ],
        })
        .pipe(Effect.asVoid),
  });
  return api;
});

export const layer = Layer.effect(AzureDevOpsPullRequestCli, make);
