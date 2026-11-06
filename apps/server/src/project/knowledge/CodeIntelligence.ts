// @effect-diagnostics nodeBuiltinImport:off - this boundary owns the analysis process, its IPC, and the index generation directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  ProjectCodeQueryResult,
  type ProjectCodeIndexEvent,
  type ProjectCodeIndexTarget,
  type ProjectId,
  type ProjectCodeQuery as ProjectCodeQueryType,
  type ProjectCodeQueryInput as ProjectCodeQueryInputType,
  type ProjectCodeQueryResult as ProjectCodeQueryResultType,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsDriver from "../../vcs/VcsDriver.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import {
  INDEX_DIRECTORY,
  checkoutPathKey,
  generationDirectory,
  indexRootFor,
  isIndexPath,
  listGenerations,
  publishGeneration,
  readIndexedCheckout,
  readPublishedGeneration,
  writeIndexedCheckout,
} from "./codeIndexLayout.ts";
import {
  hasLegacyIndexFiles,
  isBuildRunning,
  pinPublishedGeneration,
  removeGenerationUnlessRead,
  removeIndexRoot,
  removeLegacyIndexFromCheckout,
  tryLockBuild,
} from "./codeIndexLocks.ts";
import type { CodeIntelligenceCommand } from "./codeIntelligenceWorkerThread.ts";

// Each build is a process parsing a whole checkout, and indexing starts without anyone asking.
const MAX_CONCURRENT_BUILDS = 2;

export class CodeIntelligenceProjectNotFound extends Schema.TaggedError<CodeIntelligenceProjectNotFound>()(
  "CodeIntelligenceProjectNotFound",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} is unavailable for code analysis.`;
  }
}

export class CodeIntelligenceThreadMismatch extends Schema.TaggedError<CodeIntelligenceThreadMismatch>()(
  "CodeIntelligenceThreadMismatch",
  { projectId: Schema.String, threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} does not belong to project ${this.projectId}.`;
  }
}

export class CodeIntelligencePathOutsideCheckout extends Schema.TaggedError<CodeIntelligencePathOutsideCheckout>()(
  "CodeIntelligencePathOutsideCheckout",
  { path: Schema.String },
) {
  override get message(): string {
    return `Code analysis path '${this.path}' resolves outside the checkout.`;
  }
}

export class CodeIntelligenceInspectionFailed extends Schema.TaggedError<CodeIntelligenceInspectionFailed>()(
  "CodeIntelligenceInspectionFailed",
  {
    projectId: Schema.String,
    threadId: Schema.NullOr(Schema.String),
    path: Schema.String,
    reason: Schema.Literals(["worker-failed", "invalid-result"]),
  },
) {
  override get message(): string {
    return `Code analysis failed for '${this.path}'.`;
  }
}

class CodeIntelligenceWorkerError extends Schema.TaggedError<CodeIntelligenceWorkerError>()(
  "CodeIntelligenceWorkerError",
  {
    reason: Schema.Literals(["worker-failed", "invalid-result", "path-outside-checkout"]),
  },
) {}

type CheckoutLookupError =
  | CodeIntelligenceProjectNotFound
  | CodeIntelligenceThreadMismatch
  | ProjectStore.ProjectStoreV2Error
  | ProjectionStore.ProjectionStoreV2Error
  | WorkspacePaths.WorkspacePathsError;

/** How one build of a checkout's index ended. */
export type CodeIndexRefreshOutcome =
  | { readonly _tag: "Published"; readonly generation: number }
  // The published generation already matches the checkout, or there is none to refresh.
  | { readonly _tag: "Unchanged" }
  // Another server process is building the checkout; this one started no build.
  | { readonly _tag: "BuildingElsewhere" }
  | { readonly _tag: "Failed"; readonly reason: CodeIntelligenceWorkerError["reason"] | "listing" };

export class CodeIntelligence extends Context.Service<
  CodeIntelligence,
  {
    /** Answers from the published index generation and never waits for a build. */
    readonly query: (
      input: ProjectCodeQueryInputType,
    ) => Effect.Effect<
      ProjectCodeQueryResultType,
      | CheckoutLookupError
      | CodeIntelligencePathOutsideCheckout
      | CodeIntelligenceInspectionFailed
      | WorkspaceEntries.WorkspaceEntriesError
    >;
    /** Builds a successor generation, coalesced per checkout, and waits for the outcome. */
    readonly refresh: (
      input: ProjectCodeIndexTarget,
    ) => Effect.Effect<CodeIndexRefreshOutcome, CheckoutLookupError>;
    /**
     * Requests a coalesced rebuild of a checkout that already has a published index and returns
     * at once. A checkout nobody has queried is left unindexed, and so is every checkout while
     * automatic indexing is off.
     */
    readonly refreshIfIndexed: (cwd: string) => Effect.Effect<void>;
    /**
     * Starts the first index of a project's own checkout and returns at once. It does nothing once
     * one exists, after a failed build, or outside a repository. Worktrees are covered by
     * `refreshForActiveAgent` instead, so merely viewing a worktree thread never indexes it.
     */
    readonly ensureProjectIndexed: (projectId: ProjectId) => Effect.Effect<void>;
    /**
     * Keeps a checkout indexed while an agent works in it. Indexes a worktree that has none and
     * refreshes one that does, without waiting for either.
     */
    readonly refreshForActiveAgent: (target: ProjectCodeIndexTarget) => Effect.Effect<void>;
    /**
     * Stops this process's builds of a checkout and removes its index, leaving any generation
     * a reader still pins to the next sweep.
     */
    readonly removeCheckoutIndex: (checkoutPath: string) => Effect.Effect<void>;
    /** Clears an older version's folders from each checkout, leaving its current index alone. */
    readonly removeLegacyIndexes: (checkoutPaths: ReadonlyArray<string>) => Effect.Effect<void>;
    /** Whether the checkout has an index, current or left by an older version. */
    readonly hasCheckoutIndex: (checkoutPath: string) => Effect.Effect<boolean>;
    /**
     * Removes indexes for checkouts that are gone or that `isKnown` rejects. A running build always
     * holds its lock and has a record, so this only finds leftovers.
     */
    readonly removeOrphanedIndexes: (
      isKnown: (checkoutPath: string) => boolean,
    ) => Effect.Effect<void>;
    /** Interrupts every build this process is running, for when automatic indexing is turned off. */
    readonly stopBuilds: Effect.Effect<void>;
    /**
     * Publications and failed builds of the target's checkout from the moment this returns.
     * Watching a project also starts its first index.
     */
    readonly subscribeIndex: (
      input: ProjectCodeIndexTarget,
    ) => Effect.Effect<Stream.Stream<ProjectCodeIndexEvent>, CheckoutLookupError, Scope.Scope>;
  }
>()("t3/project/knowledge/CodeIntelligence") {}

const WorkerReply = Schema.Union([
  Schema.Struct({ result: ProjectCodeQueryResult }),
  Schema.Struct({ built: Schema.Struct({ changed: Schema.Boolean }) }),
  Schema.Struct({
    progress: Schema.Struct({
      phase: Schema.Literals(["scanning", "parsing", "storing", "resolving", "linking"]),
      current: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  }),
  Schema.Struct({ error: Schema.String }),
]);
const decodeWorkerReply = Schema.decodeUnknownSync(WorkerReply);
type WorkerTerminal = Exclude<typeof WorkerReply.Type, { readonly progress: unknown }>;

function normalizeQueryPaths(
  query: ProjectCodeQueryType,
  checkoutPath: string,
  workspacePaths: WorkspacePaths.WorkspacePaths["Service"],
): Effect.Effect<ProjectCodeQueryType, WorkspacePaths.WorkspacePathsError> {
  if (query.operation === "dependencies" || query.operation === "affected") {
    return workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: checkoutPath,
        relativePath: query.filePath,
      })
      .pipe(
        Effect.map(({ relativePath }) => ({
          ...query,
          filePath: relativePath,
        })),
      );
  }
  if (
    query.operation === "callers" ||
    query.operation === "callees" ||
    query.operation === "references" ||
    query.operation === "impact" ||
    query.operation === "tests"
  ) {
    if (query.symbol.filePath === undefined) return Effect.succeed(query);
    return workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: checkoutPath,
        relativePath: query.symbol.filePath,
      })
      .pipe(
        Effect.map(({ relativePath }) => ({
          ...query,
          symbol: {
            ...query.symbol,
            filePath: relativePath,
          },
        })),
      );
  }
  if (query.operation === "path") {
    const normalize = (symbol: typeof query.from) =>
      symbol.filePath === undefined
        ? Effect.succeed(symbol)
        : workspacePaths
            .resolveRelativePathWithinRoot({
              workspaceRoot: checkoutPath,
              relativePath: symbol.filePath,
            })
            .pipe(Effect.map(({ relativePath }) => ({ ...symbol, filePath: relativePath })));
    return Effect.all([normalize(query.from), normalize(query.to)]).pipe(
      Effect.map(([from, to]) => ({ ...query, from, to })),
    );
  }
  if (query.operation === "symbols" && query.filePath !== undefined) {
    return workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: checkoutPath,
        relativePath: query.filePath,
      })
      .pipe(
        Effect.map(({ relativePath }) => ({
          ...query,
          filePath: relativePath,
        })),
      );
  }
  return Effect.succeed(query);
}

interface AnalysisLaunch {
  readonly executablePath: string;
  readonly isExecutable: boolean;
}

/**
 * Isolate fatal tree-sitter WASM aborts in a child. V8 accepts liftoff-only only at process startup;
 * executable builds bake it in because they cannot receive Node flags.
 */
function analysisCommand(launch: AnalysisLaunch): ReadonlyArray<string> {
  if (launch.isExecutable) return ["__code-intelligence"];
  const fromSource = import.meta.url.endsWith(".ts");
  return [
    ...(fromSource ? ["--experimental-strip-types"] : []),
    "--liftoff-only",
    NodeURL.fileURLToPath(new URL(fromSource ? "../../bin.ts" : "./bin.mjs", import.meta.url)),
    "__code-intelligence",
  ];
}

/**
 * A server run under `node --watch` exports WATCH_REPORT_DEPENDENCIES, which makes any Node
 * child report its imports over its IPC channel; on the analysis channel those reports would
 * read as malformed replies.
 */
function analysisEnvironment(): NodeJS.ProcessEnv {
  const { WATCH_REPORT_DEPENDENCIES: _watchReport, ...environment } = process.env;
  // ELECTRON_RUN_AS_NODE keeps the desktop's Electron binary a plain Node runtime. The worker
  // selects each generation itself; the control directory is a default that holds no index.
  return { ...environment, CODEGRAPH_DIR: INDEX_DIRECTORY, ELECTRON_RUN_AS_NODE: "1" };
}

function runInAnalysisProcess(
  launch: AnalysisLaunch,
  command: CodeIntelligenceCommand,
  beforeCommand?: (analysisPid: number) => Effect.Effect<void>,
): Effect.Effect<WorkerTerminal, CodeIntelligenceWorkerError> {
  return Effect.callback((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(launch.executablePath, analysisCommand(launch), {
        env: analysisEnvironment(),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    } catch {
      resume(Effect.fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" })));
      return;
    }
    // A first build can hold a core for many minutes and nobody may be waiting on it, while a
    // query has a caller. Set before the build's own threads exist so they inherit it.
    if (command.type === "build" && child.pid !== undefined) {
      try {
        NodeOS.setPriority(child.pid, NodeOS.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Only ordering; a process that refuses it still builds correctly.
      }
    }
    let terminal:
      | { readonly _tag: "reply"; readonly value: WorkerTerminal }
      | { readonly _tag: "error"; readonly error: CodeIntelligenceWorkerError }
      | undefined;
    let closed = false;
    let resolveClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const fail = (error: CodeIntelligenceWorkerError, shouldKill = false) => {
      terminal ??= { _tag: "error", error };
      if (shouldKill) child.kill("SIGKILL");
    };
    child.on("message", (raw: unknown) => {
      if (terminal !== undefined) return;
      let decoded: typeof WorkerReply.Type;
      try {
        decoded = decodeWorkerReply(raw);
      } catch {
        fail(new CodeIntelligenceWorkerError({ reason: "invalid-result" }), true);
        return;
      }
      if ("progress" in decoded) return;
      if ("error" in decoded) {
        fail(
          new CodeIntelligenceWorkerError({
            reason: decoded.error === "path-outside-checkout" ? decoded.error : "worker-failed",
          }),
        );
      } else terminal = { _tag: "reply", value: decoded };
    });
    child.once("error", () => {
      fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" }));
    });
    // `close` follows the IPC channel closing, so every reply has been read by then.
    child.once("close", (code) => {
      closed = true;
      resolveClosed?.();
      if (terminal === undefined || code !== 0) {
        resume(
          Effect.fail(
            terminal?._tag === "error"
              ? terminal.error
              : new CodeIntelligenceWorkerError({ reason: "worker-failed" }),
          ),
        );
      } else if (terminal._tag === "error") {
        resume(Effect.fail(terminal.error));
      } else {
        resume(Effect.succeed(terminal.value));
      }
    });
    const send = () =>
      child.send(command, (error) => {
        if (error !== null)
          fail(new CodeIntelligenceWorkerError({ reason: "worker-failed" }), true);
      });
    const holding =
      beforeCommand === undefined || child.pid === undefined
        ? undefined
        : Effect.runFork(beforeCommand(child.pid));
    if (holding === undefined) send();
    else {
      holding.addObserver((exit) => {
        if (exit._tag === "Success" && !closed) send();
      });
      child.once("close", () => holding.interruptUnsafe());
    }
    // The SDK's sync ignores abort signals, so only killing the process stops the indexing,
    // and the build lock is released only after it has exited.
    return Effect.promise(async () => {
      holding?.interruptUnsafe();
      if (!closed) child.kill("SIGKILL");
      await closedPromise;
    });
  });
}

/** One checkout's builds in this process. */
interface CheckoutIndex {
  // Covers every request made before it started.
  running: Deferred.Deferred<CodeIndexRefreshOutcome> | null;
  // Covers requests made while `running` was in flight, which it may have read past.
  queued: Deferred.Deferred<CodeIndexRefreshOutcome> | null;
  // Whether the most recent build failed, leaving an older generation answering.
  lastFailed: boolean;
  // The loop running those builds, interrupted to stop them when the checkout is removed.
  fiber: Fiber.Fiber<void> | null;
  // Whether this checkout's first build already asked clients to read again. Once per checkout,
  // or a build that ends at once loops through a query starting the next one.
  firstBuildAnnounced: boolean;
}

const REFRESH_LIMITATIONS = {
  building: "A newer index generation is being built; these results come from the current one.",
  failed: "The last index refresh failed; these results come from the generation before it.",
} as const;

const removeGeneration = (indexRoot: string, generation: number) =>
  Effect.promise(() =>
    NodeFSP.rm(NodePath.join(indexRoot, generationDirectory(generation)), {
      recursive: true,
      force: true,
    }).catch(() => undefined),
  );

// Best effort: a generation left behind is swept by the next build.
const removeUnlessRead = (indexRoot: string, generation: number) =>
  Effect.try({
    try: () => removeGenerationUnlessRead(indexRoot, generation),
    catch: () => undefined,
  }).pipe(Effect.ignore);

export interface CodeIntelligenceOptions {
  /** Runs once a build's analysis process has started, before it receives the build. */
  readonly beforeBuildCommand?: (analysisPid: number) => Effect.Effect<void>;
}

const removeLegacyIndexFiles = (checkoutPath: string) =>
  Effect.sync(() => {
    if (hasLegacyIndexFiles(checkoutPath)) removeLegacyIndexFromCheckout(checkoutPath);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to remove a checkout's old index files", { checkoutPath, cause }),
    ),
  );

const make = Effect.fn("CodeIntelligence.make")(function* (options: CodeIntelligenceOptions) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcs = yield* VcsDriver.VcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const builds = yield* Semaphore.make(MAX_CONCURRENT_BUILDS);
  const indexRootOf = (checkoutPath: string) => indexRootFor(config.codeIndexDir, checkoutPath);
  const launch: AnalysisLaunch = {
    executablePath: yield* HostProcess.ExecutablePath,
    isExecutable: yield* HostProcess.IsExecutable,
  };
  const serviceScope = yield* Effect.scope;
  const checkouts = new Map<string, CheckoutIndex>();
  const stateOf = (checkoutPath: string) => {
    const existing = checkouts.get(checkoutPathKey(checkoutPath));
    if (existing !== undefined) return existing;
    const created: CheckoutIndex = {
      running: null,
      queued: null,
      lastFailed: false,
      fiber: null,
      firstBuildAnnounced: false,
    };
    checkouts.set(checkoutPathKey(checkoutPath), created);
    return created;
  };
  // Off, only a code query indexes a checkout; every proactive path reads this per call.
  const autoIndexEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.autoCodeIndexEnabled),
    Effect.orElseSucceed(() => false),
  );
  const indexChanges = yield* PubSub.unbounded<{
    readonly checkoutPath: string;
    readonly event: ProjectCodeIndexEvent;
  }>();
  // Clients only treat events as a re-read signal, and older ones cannot decode a new outcome, so
  // "read again" is a publication with no generation.
  const publishReRead = (checkoutPath: string) =>
    PubSub.publish(indexChanges, {
      checkoutPath,
      event: { outcome: "published", generation: null },
    });

  const resolveCheckout = Effect.fn("CodeIntelligence.resolveCheckout")(function* (
    input: ProjectCodeIndexTarget,
  ) {
    const projectOption = yield* projects.get(input.projectId);
    if (Option.isNone(projectOption) || projectOption.value.deletedAt !== null) {
      return yield* new CodeIntelligenceProjectNotFound({ projectId: input.projectId });
    }
    let registeredRoot = projectOption.value.workspaceRoot;
    if (input.threadId !== undefined) {
      const thread = yield* threads.getThread(input.threadId);
      if (thread.projectId !== input.projectId) {
        return yield* new CodeIntelligenceThreadMismatch({
          projectId: input.projectId,
          threadId: input.threadId,
        });
      }
      registeredRoot = thread.worktreePath ?? registeredRoot;
    }
    return yield* workspacePaths.normalizeWorkspaceRoot(registeredRoot);
  });

  const listCheckout = Effect.fn("CodeIntelligence.listCheckout")(function* (checkoutPath: string) {
    const indexRoot = indexRootOf(checkoutPath);
    // Git lists a repository in full. The finder caps its listing, and holds only part of a
    // checkout until its first scan ends, which is exactly when a new project is indexed.
    const repository = yield* vcs.listWorkspaceFiles(checkoutPath).pipe(Effect.option);
    if (Option.isSome(repository)) {
      // An unmerged path is listed once per stage.
      const files = [...new Set(repository.value.paths)].filter((path) => !isIndexPath(path));
      return {
        checkoutPath,
        indexRoot,
        files,
        filesListed: files.length,
        listingTruncated: repository.value.truncated,
      };
    }
    yield* workspaceEntries.refresh(checkoutPath);
    const listing = yield* workspaceEntries.list({ cwd: checkoutPath });
    const files = listing.entries
      // A checkout that still holds an older version's index would otherwise report its files
      // as unsupported source.
      .filter(
        (entry) => entry.kind === "file" && entry.ignored !== true && !isIndexPath(entry.path),
      )
      .map((entry) => entry.path);
    return {
      checkoutPath,
      indexRoot,
      files,
      filesListed: files.length,
      listingTruncated: listing.truncated,
    };
  });

  const buildGeneration = Effect.fn("CodeIntelligence.buildGeneration")(function* (
    checkoutPath: string,
  ): Effect.fn.Return<
    CodeIndexRefreshOutcome,
    CodeIntelligenceWorkerError | WorkspaceEntries.WorkspaceEntriesError
  > {
    const indexRoot = indexRootOf(checkoutPath);
    const plan = yield* Effect.try({
      try: () => ({
        published: readPublishedGeneration(indexRoot),
        existing: listGenerations(indexRoot),
      }),
      catch: () => new CodeIntelligenceWorkerError({ reason: "worker-failed" }),
    });
    // Interrupted builds, and superseded generations whose last reader is gone. The build lock
    // keeps every other builder out, so none of these is being written.
    for (const existing of plan.existing) {
      if (existing !== plan.published) yield* removeUnlessRead(indexRoot, existing);
    }
    const generation = Math.max(plan.published ?? 0, ...plan.existing) + 1;
    const listing = yield* listCheckout(checkoutPath);
    const reply = yield* runInAnalysisProcess(
      launch,
      {
        type: "build",
        input: {
          ...listing,
          from: plan.published === null ? null : generationDirectory(plan.published),
          to: generationDirectory(generation),
          generation,
        },
      },
      options.beforeBuildCommand,
    ).pipe(Effect.onError(() => removeGeneration(indexRoot, generation)));
    if (!("built" in reply)) {
      yield* removeGeneration(indexRoot, generation);
      return yield* new CodeIntelligenceWorkerError({ reason: "invalid-result" });
    }
    if (!reply.built.changed) return { _tag: "Unchanged" } as const;
    yield* Effect.try({
      try: () => publishGeneration(indexRoot, generation),
      catch: () => new CodeIntelligenceWorkerError({ reason: "worker-failed" }),
    }).pipe(Effect.onError(() => removeGeneration(indexRoot, generation)));
    const previous = plan.published;
    // New readers pin the new generation from here on; a reader of the old one removes it.
    if (previous !== null) yield* removeUnlessRead(indexRoot, previous);
    return { _tag: "Published", generation } as const;
  });

  const buildOnce = (checkoutPath: string): Effect.Effect<CodeIndexRefreshOutcome> =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const indexRoot = indexRootOf(checkoutPath);
          const release = tryLockBuild(indexRoot);
          // One step: a concurrent removal must never see a locked root without a record.
          if (release !== null) writeIndexedCheckout(indexRoot, checkoutPath);
          return release;
        },
        catch: () => new CodeIntelligenceWorkerError({ reason: "worker-failed" }),
      }),
      // Waiting would tie this server to another's build; that build covers the checkout.
      (release) =>
        release === null
          ? Effect.succeed({ _tag: "BuildingElsewhere" } as const)
          : Effect.gen(function* () {
              // Folders an older version left in the checkout go on the first build that sees them.
              yield* removeLegacyIndexFiles(checkoutPath);
              return yield* buildGeneration(checkoutPath);
            }),
      (release) => Effect.sync(() => release?.()),
    ).pipe(
      // Outside the lock: a checkout waiting its turn must not read as building to other servers.
      builds.withPermits(1),
      Effect.catch((error) =>
        Effect.succeed({
          _tag: "Failed",
          reason: error._tag === "CodeIntelligenceWorkerError" ? error.reason : "listing",
        } as const),
      ),
      Effect.tap((outcome) =>
        outcome._tag === "Failed"
          ? Effect.logWarning("Code index build failed", { checkoutPath, reason: outcome.reason })
          : Effect.void,
      ),
    );

  const runBuilds = Effect.fn("CodeIntelligence.runBuilds")(function* (
    checkoutPath: string,
    state: CheckoutIndex,
  ) {
    let current = state.running;
    while (current !== null) {
      const outcome = yield* buildOnce(checkoutPath);
      // Subscribers query again on failure; repeating that event would keep starting builds
      // for a persistent failure even when nobody explicitly asks to retry.
      if (
        outcome._tag === "Published" ||
        (outcome._tag === "Failed" && !state.lastFailed) ||
        (outcome._tag === "Unchanged" && state.lastFailed)
      ) {
        state.lastFailed = outcome._tag === "Failed";
        const generation =
          outcome._tag === "Published"
            ? outcome.generation
            : yield* Effect.sync(() => {
                try {
                  return readPublishedGeneration(indexRootOf(checkoutPath));
                } catch {
                  return null;
                }
              });
        // Existing clients understand a published generation becoming available again.
        const event: ProjectCodeIndexEvent = {
          outcome: outcome._tag === "Failed" ? "failed" : "published",
          generation,
        };
        yield* PubSub.publish(indexChanges, { checkoutPath, event });
      }
      yield* Deferred.succeed(current, outcome);
      // Promoting and reading the next build in one step keeps a concurrent request from
      // starting a second loop for the same checkout.
      current = yield* Effect.sync(() => {
        state.running = state.queued;
        state.queued = null;
        return state.running;
      });
    }
  });

  /** The build that will cover a request made now; starts one when the checkout is idle. */
  const requestBuild = (checkoutPath: string) =>
    Effect.suspend(() => {
      const state = stateOf(checkoutPath);
      if (state.queued !== null) return Effect.succeed(state.queued);
      const next = Deferred.makeUnsafe<CodeIndexRefreshOutcome>();
      if (state.running !== null) {
        state.queued = next;
        return Effect.succeed(next);
      }
      state.running = next;
      return Effect.gen(function* () {
        // Once per checkout: a build that ends at once (another server holds the lock, or the
        // index path is refused) would otherwise be restarted by the query its own signal runs.
        if (!state.firstBuildAnnounced) {
          const unindexed = yield* Effect.sync(() => {
            try {
              return readPublishedGeneration(indexRootOf(checkoutPath)) === null;
            } catch {
              return false;
            }
          });
          if (unindexed) {
            state.firstBuildAnnounced = true;
            yield* publishReRead(checkoutPath);
          }
        }
        const fiber = yield* runBuilds(checkoutPath, state).pipe(Effect.forkIn(serviceScope));
        // Outside the loop: a fiber interrupted before its first step runs none of its own code.
        fiber.addObserver((exit) => {
          if (Exit.isSuccess(exit)) return;
          const pending = [state.running, state.queued];
          state.running = null;
          state.queued = null;
          for (const deferred of pending) {
            if (deferred !== null) Deferred.doneUnsafe(deferred, Exit.failCause(exit.cause));
          }
        });
        state.fiber = fiber;
        return next;
      });
      // Interruption here would leave `running` set with no loop behind it, wedging the checkout
      // until restart. The forked loop itself stays interruptible.
    }).pipe(Effect.uninterruptible);

  const refresh: CodeIntelligence["Service"]["refresh"] = Effect.fn("CodeIntelligence.refresh")(
    function* (input) {
      const checkoutPath = yield* resolveCheckout(input);
      return yield* Deferred.await(yield* requestBuild(checkoutPath));
    },
  );

  const query: CodeIntelligence["Service"]["query"] = Effect.fn("CodeIntelligence.query")(
    function* (input) {
      const checkoutPath = yield* resolveCheckout(input);
      const normalizedQuery = yield* normalizeQueryPaths(input.query, checkoutPath, workspacePaths);
      const indexRoot = indexRootOf(checkoutPath);
      const { generation: published } = yield* Effect.acquireRelease(
        Effect.try({
          try: () => pinPublishedGeneration(indexRoot),
          catch: () =>
            new CodeIntelligenceInspectionFailed({
              projectId: input.projectId,
              threadId: input.threadId ?? null,
              path: checkoutPath,
              reason: "worker-failed",
            }),
        }),
        (pin) => Effect.sync(pin.release),
      );
      // A query converges the index on the checkout without waiting for it; freshness only
      // observes.
      if (normalizedQuery.operation !== "freshness") yield* requestBuild(checkoutPath);
      const listing = yield* listCheckout(checkoutPath);
      const queryPath =
        normalizedQuery.operation === "dependencies" ||
        normalizedQuery.operation === "affected" ||
        normalizedQuery.operation === "symbols"
          ? normalizedQuery.filePath
          : normalizedQuery.operation === "callers" ||
              normalizedQuery.operation === "callees" ||
              normalizedQuery.operation === "references" ||
              normalizedQuery.operation === "impact" ||
              normalizedQuery.operation === "tests"
            ? normalizedQuery.symbol.filePath
            : normalizedQuery.operation === "path"
              ? (normalizedQuery.from.filePath ?? normalizedQuery.to.filePath)
              : undefined;
      const toQueryError = (reason: CodeIntelligenceWorkerError["reason"]) => {
        if (reason === "path-outside-checkout" && queryPath !== undefined) {
          return new CodeIntelligencePathOutsideCheckout({ path: queryPath });
        }
        return new CodeIntelligenceInspectionFailed({
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          path:
            queryPath ??
            (normalizedQuery.operation === "symbols"
              ? (normalizedQuery.name ?? checkoutPath)
              : normalizedQuery.operation === "search"
                ? normalizedQuery.text
                : checkoutPath),
          reason: reason === "invalid-result" ? "invalid-result" : "worker-failed",
        });
      };
      const reply = yield* runInAnalysisProcess(launch, {
        type: "query",
        input: {
          ...listing,
          query: normalizedQuery,
          indexDirectory: published === null ? null : generationDirectory(published),
        },
      }).pipe(Effect.mapError((cause) => toQueryError(cause.reason)));
      if (!("result" in reply)) return yield* toQueryError("invalid-result");
      const state = checkouts.get(checkoutPathKey(checkoutPath));
      const needsRefresh =
        reply.result.index?.state === "unindexed" ||
        reply.result.index?.state === "indexing" ||
        reply.result.index?.state === "stale";
      const refreshing: keyof typeof REFRESH_LIMITATIONS | undefined =
        needsRefresh && (state?.running != null || isBuildRunning(indexRoot))
          ? "building"
          : state?.lastFailed
            ? "failed"
            : undefined;
      if (refreshing === undefined || reply.result.index === undefined) return reply.result;
      return {
        ...reply.result,
        coverage: {
          ...reply.result.coverage,
          limitations: [
            ...reply.result.coverage.limitations,
            REFRESH_LIMITATIONS[refreshing],
          ].slice(-16),
        },
        index: { ...reply.result.index, refresh: refreshing },
      };
    },
    Effect.scoped,
  );

  const refreshIfIndexed: CodeIntelligence["Service"]["refreshIfIndexed"] = Effect.fn(
    "CodeIntelligence.refreshIfIndexed",
  )(function* (cwd) {
    if (!(yield* autoIndexEnabled)) return;
    const checkoutPath = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(Effect.option);
    if (Option.isNone(checkoutPath)) return;
    const published = yield* Effect.sync(() => {
      try {
        return readPublishedGeneration(indexRootOf(checkoutPath.value));
      } catch {
        return null;
      }
    });
    if (published !== null) yield* requestBuild(checkoutPath.value);
  });

  const ensureProjectIndexed: CodeIntelligence["Service"]["ensureProjectIndexed"] = Effect.fn(
    "CodeIntelligence.ensureProjectIndexed",
  )(function* (projectId) {
    if (!(yield* autoIndexEnabled)) return;
    const checkoutPath = yield* resolveCheckout({ projectId }).pipe(Effect.option);
    if (Option.isNone(checkoutPath)) return;
    const state = checkouts.get(checkoutPathKey(checkoutPath.value));
    // A failed build waits for a code query; retrying here would repeat a persistent failure each
    // time a client looked at the project.
    if (state?.running != null || state?.lastFailed === true) return;
    const unindexed = yield* Effect.sync(() => {
      try {
        return readPublishedGeneration(indexRootOf(checkoutPath.value)) === null;
      } catch {
        return false;
      }
    });
    if (!unindexed) return;
    // A folder outside any repository may be anything, including something huge.
    const isRepository = yield* vcs
      .isInsideWorkTree(checkoutPath.value)
      .pipe(Effect.orElseSucceed(() => false));
    if (isRepository) yield* requestBuild(checkoutPath.value);
  });

  const refreshForActiveAgent: CodeIntelligence["Service"]["refreshForActiveAgent"] = Effect.fn(
    "CodeIntelligence.refreshForActiveAgent",
  )(function* (target) {
    if (!(yield* autoIndexEnabled)) return;
    const checkoutPath = yield* resolveCheckout(target).pipe(Effect.option);
    if (Option.isNone(checkoutPath)) return;
    const published = yield* Effect.sync(() => {
      try {
        return readPublishedGeneration(indexRootOf(checkoutPath.value));
      } catch {
        return null;
      }
    });
    if (published !== null) {
      yield* requestBuild(checkoutPath.value);
      return;
    }
    // A worktree always indexes for its agent; a folder outside any repository does not.
    const isRepository = yield* vcs
      .isInsideWorkTree(checkoutPath.value)
      .pipe(Effect.orElseSucceed(() => false));
    if (isRepository) yield* requestBuild(checkoutPath.value);
  });

  const removeCheckoutIndex: CodeIntelligence["Service"]["removeCheckoutIndex"] = Effect.fn(
    "CodeIntelligence.removeCheckoutIndex",
  )(function* (checkoutPath) {
    // A checkout that is already gone no longer normalizes; its index still needs removing.
    const path = yield* workspacePaths
      .normalizeWorkspaceRoot(checkoutPath)
      .pipe(Effect.orElseSucceed(() => NodePath.resolve(checkoutPath)));
    const state = checkouts.get(checkoutPathKey(path));
    const hadBuild = state?.fiber != null && state.running !== null;
    // The interrupt returns only after the build process is killed and its lock released.
    if (state?.fiber != null) yield* Fiber.interrupt(state.fiber);
    checkouts.delete(checkoutPathKey(path));
    const hadFiles = yield* Effect.sync(
      () => listGenerations(indexRootOf(path)).length > 0 || hasLegacyIndexFiles(path),
    );
    const removal = yield* Effect.exit(
      Effect.sync(() => {
        removeIndexRoot(indexRootOf(path));
        if (hasLegacyIndexFiles(path)) removeLegacyIndexFromCheckout(path);
      }),
    );
    if (Exit.isFailure(removal)) {
      yield* Effect.logWarning("failed to remove a checkout's code index", {
        checkoutPath: path,
        cause: removal.cause,
      });
    }
    // A mounted badge reads again on any event; without one it would keep showing Ready.
    if (hadFiles || hadBuild) yield* publishReRead(path);
  });

  const removeLegacyIndexes: CodeIntelligence["Service"]["removeLegacyIndexes"] = Effect.fn(
    "CodeIntelligence.removeLegacyIndexes",
  )(function* (checkoutPaths) {
    yield* Effect.forEach(checkoutPaths, removeLegacyIndexFiles, { discard: true });
  });

  const hasCheckoutIndex: CodeIntelligence["Service"]["hasCheckoutIndex"] = Effect.fn(
    "CodeIntelligence.hasCheckoutIndex",
  )(function* (checkoutPath) {
    const path = yield* workspacePaths
      .normalizeWorkspaceRoot(checkoutPath)
      .pipe(Effect.orElseSucceed(() => NodePath.resolve(checkoutPath)));
    return yield* Effect.sync(
      () =>
        listGenerations(indexRootOf(path)).length > 0 ||
        isBuildRunning(indexRootOf(path)) ||
        hasLegacyIndexFiles(path),
    );
  });

  const removeOrphanedIndexes: CodeIntelligence["Service"]["removeOrphanedIndexes"] = Effect.fn(
    "CodeIntelligence.removeOrphanedIndexes",
  )(function* (isKnown) {
    const roots = yield* Effect.sync(() => {
      try {
        return NodeFS.readdirSync(config.codeIndexDir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? [entry.name] : [],
        );
      } catch {
        return [];
      }
    });
    for (const name of roots) {
      yield* Effect.gen(function* () {
        const indexRoot = NodePath.join(config.codeIndexDir, name);
        const owner = readIndexedCheckout(indexRoot);
        // A build always holds the lock and has a record, so a root without one is a leftover.
        if (owner === null) {
          yield* Effect.sync(() => removeIndexRoot(indexRoot));
          return;
        }
        if (isKnown(owner) && NodeFS.existsSync(owner)) return;
        yield* removeCheckoutIndex(owner);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to remove an orphaned code index", { indexRoot: name, cause }),
        ),
      );
    }
  });

  const stopBuilds: CodeIntelligence["Service"]["stopBuilds"] = Effect.gen(function* () {
    for (const [path, state] of checkouts) {
      // `running` is cleared when a loop ends, so a finished build is not stopped or announced.
      if (state.fiber === null || state.running === null) continue;
      yield* Fiber.interrupt(state.fiber);
      // The checkout can build again later, so it announces its next first build.
      state.firstBuildAnnounced = false;
      // A badge stuck on Indexing has nothing to read again unless it hears about this.
      yield* publishReRead(path);
    }
  });

  const subscribeIndex: CodeIntelligence["Service"]["subscribeIndex"] = Effect.fn(
    "CodeIntelligence.subscribeIndex",
  )(function* (input) {
    const checkoutPath = yield* resolveCheckout(input);
    const subscription = yield* PubSub.subscribe(indexChanges);
    yield* ensureProjectIndexed(input.projectId);
    return Stream.fromSubscription(subscription).pipe(
      Stream.filter(
        (change) => checkoutPathKey(change.checkoutPath) === checkoutPathKey(checkoutPath),
      ),
      Stream.map((change) => change.event),
    );
  });

  return CodeIntelligence.of({
    query,
    refresh,
    refreshIfIndexed,
    ensureProjectIndexed,
    refreshForActiveAgent,
    removeCheckoutIndex,
    removeLegacyIndexes,
    hasCheckoutIndex,
    removeOrphanedIndexes,
    stopBuilds,
    subscribeIndex,
  });
});

export const layer = Layer.effect(CodeIntelligence, make({}));

/** The service with test seams; production uses `layer`. */
export const layerWith = (options: CodeIntelligenceOptions) =>
  Layer.effect(CodeIntelligence, make(options));
