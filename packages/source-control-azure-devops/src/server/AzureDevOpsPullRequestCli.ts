import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type {
  PullRequestAction,
  PullRequestComment,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestState,
} from "@t3tools/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
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
  type AzureDevOpsThreads,
} from "./azureDevOpsPullRequestJson.ts";
import { latestAzureDevOpsTime } from "./azureDevOpsPullRequests.ts";
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
/** A 2,000-file page exceeds the default 1 MiB output budget. */
const CHANGE_ENTRIES_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** JSON escaping and base64 can exceed the decoded file's size. */
const ITEM_CONTENT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Review history is unpaged and independent of diff size. */
const REVIEW_HISTORY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Azure's iteration-change page limit. */
const CHANGE_ENTRIES_PER_PAGE = 2000;

/** Count raw entries, including folders and malformed rows. */
const MAX_CHANGE_ENTRIES = 10_000;

/** How old a thread read may be before a pull request's date is read again. */
export const ACTIVITY_MAX_AGE = Duration.minutes(1);
/** Listed rows tolerate older comment times; a push, vote or state change still rereads. */
export const LISTED_ACTIVITY_MAX_AGE = Duration.minutes(5);
const ACTIVITY_CACHE_CAPACITY = 1024;
/** Each read is a Python startup; every reader shares this budget. */
const ACTIVITY_READ_CONCURRENCY = 4;

interface AzureDevOpsActivitySubject {
  readonly number: number;
  readonly location: AzureDevOpsRepositoryLocation | null;
  readonly state: PullRequestState;
  readonly revision: string;
  readonly updatedAt: string | null;
}

interface ActivityRead {
  readonly done: Deferred.Deferred<AzureDevOpsThreads, AzureDevOpsPullRequestCliError>;
  /** The revision this read dates; null when the conversation itself was asked for. */
  revision: string | null;
  /** False while a background read waits for its turn. */
  started: boolean;
}

interface ActivityRecord {
  at: string | null;
  readAt: number | null;
  /** The revision the last finished read dated. */
  revision: string | null;
  reading: ActivityRead | null;
}

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
      /** Matched by `--creator`, which takes the email a row shows as its login. */
      readonly author?: string | undefined;
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

    readonly listThreads: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestComment>, AzureDevOpsPullRequestCliError>;

    /**
     * Azure keeps no last-updated time on a pull request, so an open one is dated by its newest
     * thread, which includes the system thread each push adds, and by any push read for a diff.
     * A failed read keeps the latest time already seen; times never move back.
     */
    readonly activityAt: (input: {
      readonly cwd: string;
      readonly pullRequest: AzureDevOpsActivitySubject;
      readonly maxAge: Duration.Duration;
    }) => Effect.Effect<string | null>;

    readonly listIterations: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<AzureDevOpsIteration>, AzureDevOpsPullRequestCliError>;

    /** Changes cover the whole PR from its merge base. */
    readonly listIterationChanges: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
      readonly iterationId: number;
    }) => Effect.Effect<AzureDevOpsIterationChanges, AzureDevOpsPullRequestCliError>;

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

function isReviewerName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && !name.startsWith("-");
}

/** @public */
export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  // Let `az` parse all three remote formats.
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

  /** Use the extension's credentials; `az rest` uses the default tenant. */
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

  /** Azure's items route requires a leading slash. */
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

  const activityReads = yield* Semaphore.make(ACTIVITY_READ_CONCURRENCY);
  const activity = new Map<string, ActivityRecord>();

  const activityKey = (input: {
    readonly cwd: string;
    readonly location: AzureDevOpsRepositoryLocation;
    readonly number: number;
  }) =>
    JSON.stringify([input.cwd, input.location.project, input.location.repository, input.number]);

  const activityRecord = (key: string): ActivityRecord => {
    const held = activity.get(key);
    if (held !== undefined) {
      activity.delete(key);
      activity.set(key, held);
      return held;
    }
    if (activity.size >= ACTIVITY_CACHE_CAPACITY) {
      const oldest = activity.keys().next().value;
      if (oldest !== undefined) activity.delete(oldest);
    }
    const record: ActivityRecord = { at: null, readAt: null, revision: null, reading: null };
    activity.set(key, record);
    return record;
  };

  const remember = (key: string, at: string | null) =>
    Effect.sync(() => {
      const record = activityRecord(key);
      record.at = latestAzureDevOpsTime([record.at, at]);
    });

  /** Whoever starts a read runs its process; everyone else shares the answer. */
  const claim = (read: ActivityRead) => {
    if (read.started) return false;
    read.started = true;
    return true;
  };

  const runRead = Effect.fn("AzureDevOpsPullRequestCli.runRead")(function* (
    input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    },
    record: ActivityRecord,
    read: ActivityRead,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) {
    let startedAt: number | null = null;
    return yield* restore(
      Effect.gen(function* () {
        startedAt = yield* Clock.currentTimeMillis;
        const threads = yield* invoke({
          cwd: input.cwd,
          operation: "listThreads",
          resource: "pullRequestThreads",
          routeParameters: pullRequestRoute(input),
          maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
          decode: decodeThreadsJson,
        });
        yield* remember(activityKey(input), threads.activityAt);
        return threads;
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (record.reading === read) record.reading = null;
          // A read nobody saw finish must not count as one; a failed read still does.
          if (Exit.hasInterrupts(exit)) return;
          record.readAt = startedAt;
          if (read.revision !== null) record.revision = read.revision;
        }).pipe(Effect.andThen(Deferred.done(read.done, exit))),
      ),
    );
  });

  /**
   * Concurrent readers of one pull request share a single process. A null revision asks for
   * the conversation itself, which runs at once instead of waiting behind background reads.
   */
  const readThreads = Effect.fn("AzureDevOpsPullRequestCli.readThreads")(function (
    input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    },
    revision: string | null,
  ): Effect.Effect<AzureDevOpsThreads, AzureDevOpsPullRequestCliError> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const record = activityRecord(activityKey(input));
        const again = () => readThreads(input, revision);
        // The reader that started it was interrupted; this one still wants the answer.
        const join = (read: ActivityRead) =>
          Deferred.await(read.done).pipe(Effect.catchCauseIf(Cause.hasInterruptsOnly, again));
        const current = record.reading;
        if (current !== null) {
          if (revision === null && claim(current)) return runRead(input, record, current, restore);
          if (revision !== null && current.revision !== revision) {
            // A read already out may predate this revision; one still waiting will not.
            if (current.started)
              return restore(Deferred.await(current.done).pipe(Effect.exit, Effect.andThen(again)));
            current.revision = revision;
          }
          return restore(join(current));
        }
        const read: ActivityRead = { done: Deferred.makeUnsafe(), revision, started: false };
        record.reading = read;
        if (revision === null) {
          read.started = true;
          return runRead(input, record, read, restore);
        }
        return restore(
          Effect.raceFirst(
            activityReads.withPermits(1)(
              Effect.uninterruptibleMask((restoreRead) =>
                Effect.suspend(() =>
                  claim(read) ? runRead(input, record, read, restoreRead) : Effect.void,
                ),
              ),
            ),
            Deferred.await(read.done).pipe(Effect.exit),
          ),
        ).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() => {
              if (!claim(read)) return Effect.void;
              if (record.reading === read) record.reading = null;
              return Deferred.interrupt(read.done);
            }),
          ),
          Effect.andThen(restore(join(read))),
        );
      }),
    );
  });

  /** Decoding can shorten a non-final page; advance by raw rows. */
  const listPullRequestPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly author?: string | undefined;
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
        ...(input.author === undefined || input.involvement === "authored"
          ? []
          : ["--creator", input.author]),
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
    getViewer: Effect.fn("AzureDevOpsPullRequestCli.getViewer")(function (input) {
      return executeJson({ cwd: input.cwd, args: ["account", "show", "--query", "user"] }).pipe(
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
        // `az account show` cannot identify PAT logins; the extension resolves `--creator me`.
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
      );
    }),

    listPullRequests: Effect.fn("AzureDevOpsPullRequestCli.listPullRequests")(function (input) {
      return listPullRequestPage({
        cwd: input.cwd,
        repository: input.repository,
        state: input.state,
        involvement: input.involvement,
        viewer: input.viewer,
        author: input.author,
        limit: input.limit,
        skip: input.cursor?.delivered ?? 0,
        cursorAdvance: 0,
        items: [],
      });
    }),

    getPullRequest: Effect.fn("AzureDevOpsPullRequestCli.getPullRequest")(function (input) {
      return executeJson({
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
      );
    }),

    listThreads: Effect.fn("AzureDevOpsPullRequestCli.listThreads")(function (input) {
      return readThreads(input, null).pipe(Effect.map((threads) => threads.comments));
    }),

    activityAt: Effect.fn("AzureDevOpsPullRequestCli.activityAt")(function* (input) {
      const { location, ...pullRequest } = input.pullRequest;
      if (location === null) return pullRequest.updatedAt;
      const subject = { cwd: input.cwd, location, number: pullRequest.number };
      const key = activityKey(subject);
      // Closed and merged rows are not read for activity; their closing time stands.
      if (pullRequest.state === "open") {
        const record = activityRecord(key);
        const now = yield* Clock.currentTimeMillis;
        const fresh =
          record.reading === null &&
          record.readAt !== null &&
          record.revision === pullRequest.revision &&
          now - record.readAt < Duration.toMillis(input.maxAge);
        if (!fresh) yield* Effect.ignore(readThreads(subject, pullRequest.revision));
      }
      return latestAzureDevOpsTime([pullRequest.updatedAt, activity.get(key)?.at]);
    }),

    listIterations: Effect.fn("AzureDevOpsPullRequestCli.listIterations")(function (input) {
      return invoke({
        cwd: input.cwd,
        operation: "listIterations",
        resource: "pullRequestIterations",
        routeParameters: pullRequestRoute(input),
        maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
        decode: decodeIterationsJson,
      }).pipe(
        Effect.tap((pushes) => remember(activityKey(input), pushes.activityAt)),
        Effect.map((pushes) => pushes.iterations),
      );
    }),

    listIterationChanges: Effect.fn("AzureDevOpsPullRequestCli.listIterationChanges")(
      function (input) {
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
    ),

    readItemContent: Effect.fn("AzureDevOpsPullRequestCli.readItemContent")(function (input) {
      return invoke({
        cwd: input.cwd,
        operation: "readItemContent",
        resource: "items",
        routeParameters: repositoryRoute(input.location),
        queryParameters: [
          `path=${toItemPath(input.path)}`,
          "versionDescriptor.versionType=commit",
          `versionDescriptor.version=${input.commit}`,
          "includeContent=true",
          // Encoded content cannot identify binaries; request Azure's binary flag.
          "includeContentMetadata=true",
          // `az devops invoke` requires JSON; otherwise Azure returns raw file bytes.
          "$format=json",
        ],
        maxOutputBytes: ITEM_CONTENT_MAX_OUTPUT_BYTES,
        decode: decodeItemContentJson,
      });
    }),

    setPullRequestReviewers: Effect.fn("AzureDevOpsPullRequestCli.setPullRequestReviewers")(
      function* (input) {
        if (input.reviewers.some((reviewer) => !isReviewerName(reviewer))) {
          return yield* new AzureDevOpsReviewerNameError({ command: "az", cwd: input.cwd });
        }
        return yield* azure
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
              // Repeating `--reviewers` replaces the earlier list.
              "--reviewers",
              ...input.reviewers,
              "--only-show-errors",
              "--output",
              "json",
            ],
          })
          .pipe(Effect.asVoid);
      },
    ),

    runPullRequestAction: Effect.fn("AzureDevOpsPullRequestCli.runPullRequestAction")(
      function (input) {
        return azure
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
          .pipe(Effect.asVoid);
      },
    ),

    updatePullRequest: Effect.fn("AzureDevOpsPullRequestCli.updatePullRequest")(function (input) {
      return azure
        .execute({
          cwd: input.cwd,
          args: [
            "repos",
            "pr",
            "update",
            ...detectArgs,
            "--id",
            String(input.number),
            // One argv entry preserves leading dashes and multi-string descriptions.
            ...(input.title === undefined ? [] : [`--title=${input.title}`]),
            ...(input.body === undefined ? [] : [`--description=${input.body}`]),
            "--only-show-errors",
            "--output",
            "json",
          ],
        })
        .pipe(Effect.asVoid);
    }),
  });
});

export const layer = Layer.effect(AzureDevOpsPullRequestCli, make);
