import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestCheck,
  PullRequestComment,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeMethod,
} from "@t3tools/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import { decodeBuildPolicyChecksJson } from "./azureDevOpsPullRequestChecks.ts";
import {
  decodeItemContentJson,
  decodeIterationChangesJson,
  decodeIterationsJson,
  decodePullRequestJson,
  decodePullRequestListJson,
  decodeThreadsJson,
  decodeViewerJson,
  type AzureDevOpsChangeEntry,
  type AzureDevOpsItemContent,
  type AzureDevOpsIteration,
  type AzureDevOpsPullRequest,
  type AzureDevOpsRepositoryLocation,
} from "./azureDevOpsPullRequestJson.ts";
import type { ProviderListCursor } from "@t3tools/source-control-core/server/PullRequestProvider";

export class AzureDevOpsPullRequestReadError extends Schema.TaggedError<AzureDevOpsPullRequestReadError>()(
  "AzureDevOpsPullRequestReadError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Azure CLI returned an unreadable ${this.operation} response.`;
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

export type AzureDevOpsPullRequestCliError =
  | AzureDevOpsCli.AzureDevOpsCliError
  | AzureDevOpsPullRequestReadError
  | AzureDevOpsPullRequestIncompleteError
  | AzureDevOpsReviewerNameError
  | AzureDevOpsViewerUnavailableError;

const REST_API_VERSION = "7.1";
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
const POLICY_EVALUATIONS_PER_PAGE = 100;
const MAX_POLICY_EVALUATIONS = 1000;

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

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<AzureDevOpsPullRequest, AzureDevOpsPullRequestCliError>;

    readonly listBuildChecks: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, AzureDevOpsPullRequestCliError>;

    /** Threads are not reachable through `az repos pr`, so they come from the REST API. */
    readonly listThreads: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestComment>, AzureDevOpsPullRequestCliError>;

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
export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

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

  return AzureDevOpsPullRequestCli.of({
    getViewer: (input) =>
      executeJson({ cwd: input.cwd, args: ["account", "show", "--query", "user"] }).pipe(
        Effect.flatMap((result): Effect.Effect<string, AzureDevOpsPullRequestCliError> => {
          const decoded = decodeViewerJson(`{"user":${result.stdout.trim() || "null"}}`);
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              new AzureDevOpsPullRequestReadError({
                command: "az",
                cwd: input.cwd,
                operation: "getViewer",
                cause: decoded.failure,
              }),
            );
          }
          return decoded.success === null
            ? Effect.fail(new AzureDevOpsViewerUnavailableError({ command: "az", cwd: input.cwd }))
            : Effect.succeed(decoded.success);
        }),
        // `az devops login` signs in with a personal access token, which `az account show` knows
        // nothing about, and nothing in `az` prints whose token it is. `--creator me` is resolved
        // by the extension itself, so the viewer's own pull request names them.
        Effect.catchIf(
          (error) => error._tag !== "AzureDevOpsCliUnavailableError",
          () =>
            executeJson({
              cwd: input.cwd,
              args: [
                "repos",
                "pr",
                "list",
                ...detectArgs,
                "--creator",
                "me",
                "--status",
                "all",
                "--top",
                "1",
              ],
            }).pipe(
              Effect.flatMap((result): Effect.Effect<string, AzureDevOpsPullRequestCliError> => {
                const decoded = decodePullRequestListJson(result.stdout.trim() || "[]");
                const login = Result.isSuccess(decoded)
                  ? decoded.success.items[0]?.author?.login
                  : undefined;
                return login === undefined
                  ? Effect.fail(
                      new AzureDevOpsViewerUnavailableError({ command: "az", cwd: input.cwd }),
                    )
                  : Effect.succeed(login);
              }),
            ),
        ),
      ),

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

    listBuildChecks: Effect.fnUntraced(function* (input) {
      const checks: PullRequestCheck[] = [];
      // The CLI resolves the PR's project ID and scopes evaluations to its CodeReview artifact.
      // Page all policies before filtering builds so a later required check cannot be missed.
      for (let skip = 0; skip < MAX_POLICY_EVALUATIONS; skip += POLICY_EVALUATIONS_PER_PAGE) {
        const result = yield* executeJson({
          cwd: input.cwd,
          args: [
            "repos",
            "pr",
            "policy",
            "list",
            ...detectArgs,
            "--id",
            String(input.number),
            "--top",
            String(POLICY_EVALUATIONS_PER_PAGE),
            "--skip",
            String(skip),
          ],
        });
        const decoded = decodeBuildPolicyChecksJson(result.stdout.trim());
        if (result.stdoutTruncated || Result.isFailure(decoded)) {
          return yield* new AzureDevOpsPullRequestReadError({
            command: "az",
            cwd: input.cwd,
            operation: "listBuildChecks",
            cause: Result.isFailure(decoded) ? decoded.failure : "Policy output was truncated",
          });
        }
        checks.push(...decoded.success.checks);
        if (decoded.success.rawCount < POLICY_EVALUATIONS_PER_PAGE) return checks;
      }
      return yield* new AzureDevOpsPullRequestReadError({
        command: "az",
        cwd: input.cwd,
        operation: "listBuildChecks",
        cause: "Policy evaluation pagination exceeded the read limit",
      });
    }),

    listThreads: (input) =>
      invoke({
        cwd: input.cwd,
        operation: "listThreads",
        resource: "pullRequestThreads",
        routeParameters: pullRequestRoute(input),
        maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
        decode: decodeThreadsJson,
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
          queryParameters: [`$top=${CHANGE_ENTRIES_PER_PAGE}`, `$skip=${skip}`],
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
});

export const layer = Layer.effect(AzureDevOpsPullRequestCli, make);
