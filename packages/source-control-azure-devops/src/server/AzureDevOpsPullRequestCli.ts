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
  PullRequestUpdatedAtState,
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
/** Records still fresh for some reader are kept past this; see `trimActivity`. */
export const ACTIVITY_CACHE_CAPACITY = 1024;
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
  /** The record's generation when the read started. */
  generation: number;
}

interface ActivityRecord {
  readonly number: number;
  /** The repository its readers name it by, lowercased; null until one does. */
  repository: string | null;
  at: string | null;
  readAt: number | null;
  /** The revision the last finished read dated. */
  revision: string | null;
  /** Whether the last finished read failed. */
  failed: boolean;
  reading: ActivityRead | null;
  /** Moved by each forget; only a read started since then is fresh. */
  generation: number;
  readGeneration: number;
}

export interface AzureDevOpsListedActivity {
  /** The latest time known so far. */
  readonly at: string | null;
  readonly state?: PullRequestUpdatedAtState;
  /** Present when a read is due; it succeeds with whether `at` or `state` would now differ. */
  readonly settle?: Effect.Effect<boolean>;
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
      /** Skip the queue background reads share, for a pull request someone has open. */
      readonly immediate?: boolean;
      /** The name `forgetActivity` scopes this pull request by. */
      readonly repository?: string;
    }) => Effect.Effect<string | null>;

    /** What `activityAt` would answer without waiting: a due read is handed back to run later. */
    readonly listedActivity: (input: {
      readonly cwd: string;
      readonly pullRequest: AzureDevOpsActivitySubject;
      readonly maxAge: Duration.Duration;
      readonly repository?: string;
    }) => Effect.Effect<AzureDevOpsListedActivity>;

    /**
     * Makes every matching date due for a read, as if it had aged out; a read already out when
     * this runs counts as none. A pull request no reader has named by repository matches any.
     */
    readonly forgetActivity: (scope?: {
      readonly repository: string;
      readonly number?: number;
    }) => Effect.Effect<void>;

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
    }) => Effect.Effect<AzureDevOpsPullRequest | void, AzureDevOpsPullRequestCliError>;

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
  /** Least recently used first. */
  const activity = new Map<string, ActivityRecord>();
  /** Records a trim found protected, set aside until `keptUntil` so no trim walks them again. */
  const kept = new Map<string, ActivityRecord>();
  let keptUntil = Infinity;

  type ActivitySubject = {
    readonly cwd: string;
    readonly location: AzureDevOpsRepositoryLocation;
    readonly number: number;
  };

  const activityKey = (input: ActivitySubject) =>
    JSON.stringify([input.cwd, input.location.project, input.location.repository, input.number]);

  const activityRecord = (input: ActivitySubject, repository?: string): ActivityRecord => {
    const key = activityKey(input);
    let record = kept.get(key);
    if (record === undefined) {
      record = activity.get(key) ?? {
        number: input.number,
        repository: null,
        at: null,
        readAt: null,
        revision: null,
        failed: false,
        reading: null,
        generation: 0,
        readGeneration: 0,
      };
      activity.delete(key);
      activity.set(key, record);
    }
    if (repository !== undefined) record.repository = repository.toLowerCase();
    return record;
  };

  const isFreshAt = (
    record: ActivityRecord,
    revision: string,
    maxAge: Duration.Duration,
    now: number,
  ) =>
    record.reading === null &&
    record.readAt !== null &&
    record.revision === revision &&
    record.readGeneration === record.generation &&
    now - record.readAt < Duration.toMillis(maxAge);

  /** Until when some reader would still take the record as fresh, or it is being read. */
  const protectedUntil = (record: ActivityRecord) =>
    record.reading !== null
      ? Infinity
      : record.readAt !== null && record.readGeneration === record.generation
        ? record.readAt + Duration.toMillis(LISTED_ACTIVITY_MAX_AGE)
        : -Infinity;

  /** A read that ended may have unprotected a kept record. */
  const release = (key: string, record: ActivityRecord) => {
    if (kept.get(key) === record) keptUntil = Math.min(keptUntil, protectedUntil(record));
  };

  /**
   * Least recently used first, but never a protected record: a list larger than the capacity
   * would otherwise evict its own dates and read them all again. So the capacity is soft; past it
   * stay only the reads out now or finished in the last few minutes. Protected records wait in
   * `kept` and rejoin as most recent, so a trim walks each one once per protection.
   */
  const trimActivity = (now: number) => {
    if (activity.size + kept.size <= ACTIVITY_CACHE_CAPACITY) return;
    if (now >= keptUntil) {
      keptUntil = Infinity;
      for (const [key, record] of kept) {
        const until = protectedUntil(record);
        if (until > now) {
          keptUntil = Math.min(keptUntil, until);
        } else {
          kept.delete(key);
          activity.set(key, record);
        }
      }
    }
    while (activity.size + kept.size > ACTIVITY_CACHE_CAPACITY) {
      const oldest = activity.entries().next().value;
      if (oldest === undefined) return;
      const [key, record] = oldest;
      activity.delete(key);
      const until = protectedUntil(record);
      if (until > now) {
        kept.set(key, record);
        keptUntil = Math.min(keptUntil, until);
      }
    }
  };

  const remember = (input: ActivitySubject, at: string | null) =>
    Effect.sync(() => {
      const record = activityRecord(input);
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
    read.generation = record.generation;
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
        record.at = latestAzureDevOpsTime([record.at, threads.activityAt]);
        return threads;
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (record.reading === read) record.reading = null;
          // A read nobody saw finish must not count as one; a failed read still does.
          if (!Exit.hasInterrupts(exit)) {
            record.readAt = startedAt;
            record.readGeneration = read.generation;
            record.failed = Exit.isFailure(exit);
            if (read.revision !== null) record.revision = read.revision;
          }
          release(activityKey(input), record);
        }).pipe(Effect.andThen(Deferred.done(read.done, exit))),
      ),
    );
  });

  /**
   * Concurrent readers of one pull request share a single process. A null revision asks for
   * the conversation itself, which, like any read not `queued`, runs at once instead of waiting
   * behind background reads.
   */
  const readThreads = Effect.fn("AzureDevOpsPullRequestCli.readThreads")(function (
    input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    },
    revision: string | null,
    queued: boolean,
  ): Effect.Effect<AzureDevOpsThreads, AzureDevOpsPullRequestCliError> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const record = activityRecord(input);
        const now = revision === null || !queued;
        const again = () => readThreads(input, revision, queued);
        // The reader that started it was interrupted; this one still wants the answer.
        const join = (read: ActivityRead) =>
          Deferred.await(read.done).pipe(Effect.catchCauseIf(Cause.hasInterruptsOnly, again));
        const current = record.reading;
        if (current !== null) {
          // A read already out may predate this revision or a forget; one still waiting will not.
          const outdated =
            current.started &&
            (current.generation !== record.generation ||
              (revision !== null && current.revision !== revision));
          if (outdated)
            return restore(Deferred.await(current.done).pipe(Effect.exit, Effect.andThen(again)));
          if (revision !== null && current.revision !== revision) {
            current.revision = revision;
          }
          if (now && claim(current)) return runRead(input, record, current, restore);
          return restore(join(current));
        }
        const read: ActivityRead = {
          done: Deferred.makeUnsafe(),
          revision,
          started: false,
          generation: record.generation,
        };
        record.reading = read;
        if (now) {
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
              release(activityKey(input), record);
              return Deferred.interrupt(read.done);
            }),
          ),
          Effect.andThen(restore(join(read))),
        );
      }),
    );
  });

  const isFresh = (
    subject: ActivitySubject,
    revision: string,
    maxAge: Duration.Duration,
    repository?: string,
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        trimActivity(now);
        return isFreshAt(activityRecord(subject, repository), revision, maxAge, now);
      }),
    );

  /** Reads an open pull request's threads unless a fresh enough read already dated `revision`. */
  const dateActivity = (
    subject: ActivitySubject,
    revision: string,
    maxAge: Duration.Duration,
    queued: boolean,
    repository?: string,
  ) =>
    isFresh(subject, revision, maxAge, repository).pipe(
      Effect.flatMap((fresh) =>
        fresh ? Effect.void : Effect.ignore(readThreads(subject, revision, queued)),
      ),
    );

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
      return readThreads(input, null, false).pipe(Effect.map((threads) => threads.comments));
    }),

    activityAt: Effect.fn("AzureDevOpsPullRequestCli.activityAt")(function* (input) {
      const { location, ...pullRequest } = input.pullRequest;
      if (location === null) return pullRequest.updatedAt;
      const subject = { cwd: input.cwd, location, number: pullRequest.number };
      // Closed and merged rows are not read for activity; their closing time stands.
      if (pullRequest.state === "open") {
        yield* dateActivity(
          subject,
          pullRequest.revision,
          input.maxAge,
          input.immediate !== true,
          input.repository,
        );
      }
      const key = activityKey(subject);
      return latestAzureDevOpsTime([
        pullRequest.updatedAt,
        (kept.get(key) ?? activity.get(key))?.at,
      ]);
    }),

    listedActivity: Effect.fn("AzureDevOpsPullRequestCli.listedActivity")(function* (input) {
      const { location, ...pullRequest } = input.pullRequest;
      if (location === null || pullRequest.state !== "open") return { at: pullRequest.updatedAt };
      const subject = { cwd: input.cwd, location, number: pullRequest.number };
      const known = () => {
        const record = activityRecord(subject);
        return {
          at: latestAzureDevOpsTime([pullRequest.updatedAt, record.at]),
          state:
            record.readAt === null || record.revision !== pullRequest.revision
              ? ("pending" as const)
              : record.failed
                ? ("unavailable" as const)
                : undefined,
        };
      };
      const shown = known();
      const answer = { at: shown.at, ...(shown.state === undefined ? {} : { state: shown.state }) };
      if (yield* isFresh(subject, pullRequest.revision, input.maxAge, input.repository)) {
        return answer;
      }
      return {
        ...answer,
        settle: dateActivity(
          subject,
          pullRequest.revision,
          input.maxAge,
          true,
          input.repository,
        ).pipe(
          Effect.map(() => {
            const settled = known();
            return settled.at !== shown.at || settled.state !== shown.state;
          }),
        ),
      };
    }),

    forgetActivity: Effect.fn("AzureDevOpsPullRequestCli.forgetActivity")(function (scope) {
      return Effect.sync(() => {
        const repository = scope?.repository.toLowerCase();
        for (const records of [activity, kept]) {
          for (const record of records.values()) {
            if (
              scope === undefined ||
              ((record.repository === null || record.repository === repository) &&
                (scope.number === undefined || record.number === scope.number))
            ) {
              record.generation += 1;
            }
          }
        }
        keptUntil = -Infinity;
      });
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
        Effect.tap((pushes) => remember(input, pushes.activityAt)),
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
          // `az devops invoke` does not escape query values, so `#` or `&` in a path would truncate it.
          `path=${encodeURIComponent(toItemPath(input.path))}`,
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
          .pipe(
            // `pr update` prints the pull request it left, in the shape `pr show` prints.
            Effect.map((result) => {
              const decoded = decodePullRequestJson(result.stdout.trim());
              return Result.isSuccess(decoded) ? (decoded.success ?? undefined) : undefined;
            }),
          );
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
