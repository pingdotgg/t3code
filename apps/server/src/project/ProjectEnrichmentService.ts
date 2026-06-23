import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const DEFAULT_CACHE_CAPACITY = 512;
const DEFAULT_MAX_PENDING = 512;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_SUCCESS_TTL = Duration.minutes(1);
const DEFAULT_FAILURE_TTL = Duration.seconds(5);

export interface ProjectEnrichment {
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly faviconPath: string | null;
}

export interface ProjectEnrichmentChange {
  readonly workspaceRoot: string;
  readonly enrichment: ProjectEnrichment;
  readonly repositoryIdentityResolved: boolean;
}

export interface ProjectEnrichmentServiceOptions {
  readonly cacheCapacity?: number;
  /** Maximum active and queued roots for each enrichment field. */
  readonly maxPending?: number;
  /** Worker concurrency for each enrichment field. */
  readonly concurrency?: number;
  readonly successTtl?: Duration.Input;
  readonly failureTtl?: Duration.Input;
}

export class ProjectEnrichmentService extends Context.Service<
  ProjectEnrichmentService,
  {
    /** Read resolved metadata without starting or awaiting filesystem work. */
    readonly peek: (workspaceRoot: string) => Effect.Effect<ProjectEnrichment>;
    /** Schedule missing metadata for bounded background resolution. */
    readonly request: (workspaceRoot: string) => Effect.Effect<void>;
    /** Read immediately available metadata and schedule anything missing. */
    readonly getAvailable: (workspaceRoot: string) => Effect.Effect<ProjectEnrichment>;
    /** Invalidate workspace-derived metadata. */
    readonly invalidate: (workspaceRoots: Iterable<string>) => Effect.Effect<void>;
    /** Subscribe to ephemeral completion notifications. */
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<ProjectEnrichmentChange>,
      never,
      Scope.Scope
    >;
  }
>()("t3/project/ProjectEnrichmentService") {}

function availableValue<A, E>(cached: Option.Option<Exit.Exit<A, E>>): A | null {
  return Option.match(cached, {
    onNone: () => null,
    onSome: (exit) =>
      Exit.match(exit, {
        onFailure: () => null,
        onSuccess: (value) => value,
      }),
  });
}

interface EnrichmentWorkLane {
  readonly pendingRoots: Ref.Ref<ReadonlySet<string>>;
  readonly queue: Queue.Queue<string>;
}

export const make = Effect.fn("ProjectEnrichmentService.make")(function* (
  options: ProjectEnrichmentServiceOptions = {},
) {
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
  const cacheCapacity = Math.max(1, options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY);
  const maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const successTtl = options.successTtl ?? DEFAULT_SUCCESS_TTL;
  const failureTtl = options.failureTtl ?? DEFAULT_FAILURE_TTL;

  const repositoryIdentityCache = yield* Cache.makeWith(
    (workspaceRoot: string) => Effect.exit(repositoryIdentityResolver.resolve(workspaceRoot)),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onFailure: () => failureTtl,
        onSuccess: (result) => (Exit.isSuccess(result) ? successTtl : failureTtl),
      }),
    },
  );
  const faviconCache = yield* Cache.makeWith(
    (workspaceRoot: string) => Effect.exit(faviconResolver.resolvePath(workspaceRoot)),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onFailure: () => failureTtl,
        onSuccess: (result) => (Exit.isSuccess(result) ? successTtl : failureTtl),
      }),
    },
  );
  const makeWorkLane = Effect.gen(function* () {
    const pendingRoots = yield* Ref.make<ReadonlySet<string>>(new Set());
    const queue = yield* Effect.acquireRelease(Queue.dropping<string>(maxPending), (queue) =>
      Queue.shutdown(queue),
    );
    return { pendingRoots, queue } satisfies EnrichmentWorkLane;
  });
  const repositoryIdentityLane = yield* makeWorkLane;
  const faviconLane = yield* makeWorkLane;
  const changes = yield* Effect.acquireRelease(
    PubSub.sliding<ProjectEnrichmentChange>(256),
    (pubsub) => PubSub.shutdown(pubsub),
  );

  const removePending = (lane: EnrichmentWorkLane, workspaceRoot: string) =>
    Ref.update(lane.pendingRoots, (current) => {
      if (!current.has(workspaceRoot)) return current;
      const next = new Set(current);
      next.delete(workspaceRoot);
      return next;
    });

  const reservePending = (lane: EnrichmentWorkLane, workspaceRoot: string) =>
    Ref.modify(lane.pendingRoots, (current) => {
      if (current.has(workspaceRoot) || current.size >= maxPending) {
        return [false, current] as const;
      }
      const next = new Set(current);
      next.add(workspaceRoot);
      return [true, next] as const;
    });

  const logFailure = <A, E>(
    workspaceRoot: string,
    field: "repositoryIdentity" | "faviconPath",
    result: Exit.Exit<A, E>,
  ) =>
    Exit.isFailure(result)
      ? Effect.logWarning("Failed to enrich optional project metadata", {
          workspaceRoot,
          field,
          cause: Cause.pretty(result.cause),
        })
      : Effect.void;

  const resolveRepositoryIdentity = Effect.fn("ProjectEnrichmentService.resolveRepositoryIdentity")(
    function* (workspaceRoot: string) {
      const repositoryIdentity = yield* Cache.get(repositoryIdentityCache, workspaceRoot);
      yield* logFailure(workspaceRoot, "repositoryIdentity", repositoryIdentity);
      const faviconPath = yield* Cache.getSuccess(faviconCache, workspaceRoot);
      yield* PubSub.publish(changes, {
        workspaceRoot,
        repositoryIdentityResolved: Exit.isSuccess(repositoryIdentity),
        enrichment: {
          repositoryIdentity: availableValue(Option.some(repositoryIdentity)),
          faviconPath: availableValue(faviconPath),
        },
      });
    },
  );

  const resolveFavicon = Effect.fn("ProjectEnrichmentService.resolveFavicon")(function* (
    workspaceRoot: string,
  ) {
    const faviconPath = yield* Cache.get(faviconCache, workspaceRoot);
    yield* logFailure(workspaceRoot, "faviconPath", faviconPath);
  });

  const startWorkers = (
    lane: EnrichmentWorkLane,
    resolve: (workspaceRoot: string) => Effect.Effect<void>,
  ) => {
    const worker = Queue.take(lane.queue).pipe(
      Effect.flatMap((workspaceRoot) =>
        resolve(workspaceRoot).pipe(Effect.ensuring(removePending(lane, workspaceRoot))),
      ),
      Effect.forever,
    );
    return Effect.forEach(Array.from({ length: concurrency }), () => Effect.forkScoped(worker), {
      discard: true,
    });
  };
  yield* Effect.all(
    [
      startWorkers(repositoryIdentityLane, resolveRepositoryIdentity),
      startWorkers(faviconLane, resolveFavicon),
    ],
    { concurrency: "unbounded", discard: true },
  );

  const requestLane = Effect.fn("ProjectEnrichmentService.requestLane")(function* (
    lane: EnrichmentWorkLane,
    workspaceRoot: string,
    field: "repositoryIdentity" | "faviconPath",
  ) {
    if (!(yield* reservePending(lane, workspaceRoot))) return;
    if (!(yield* Queue.offer(lane.queue, workspaceRoot))) {
      yield* removePending(lane, workspaceRoot);
      yield* Effect.logWarning("Project metadata enrichment queue is full", {
        workspaceRoot,
        field,
      });
    }
  });

  const peek: ProjectEnrichmentService["Service"]["peek"] = Effect.fn(
    "ProjectEnrichmentService.peek",
  )(function* (workspaceRoot) {
    const [repositoryIdentity, faviconPath] = yield* Effect.all(
      [
        Cache.getSuccess(repositoryIdentityCache, workspaceRoot),
        Cache.getSuccess(faviconCache, workspaceRoot),
      ] as const,
      { concurrency: "unbounded" },
    );
    return {
      repositoryIdentity: availableValue(repositoryIdentity),
      faviconPath: availableValue(faviconPath),
    };
  });

  const request: ProjectEnrichmentService["Service"]["request"] = Effect.fn(
    "ProjectEnrichmentService.request",
  )(function* (workspaceRoot) {
    const [hasRepositoryIdentity, hasFaviconPath] = yield* Effect.all(
      [Cache.has(repositoryIdentityCache, workspaceRoot), Cache.has(faviconCache, workspaceRoot)],
      { concurrency: "unbounded" },
    );
    yield* Effect.all(
      [
        hasRepositoryIdentity
          ? Effect.void
          : requestLane(repositoryIdentityLane, workspaceRoot, "repositoryIdentity"),
        hasFaviconPath ? Effect.void : requestLane(faviconLane, workspaceRoot, "faviconPath"),
      ],
      { concurrency: "unbounded", discard: true },
    );
  });

  const getAvailable: ProjectEnrichmentService["Service"]["getAvailable"] = Effect.fn(
    "ProjectEnrichmentService.getAvailable",
  )(function* (workspaceRoot) {
    const available = yield* peek(workspaceRoot);
    yield* request(workspaceRoot);
    return available;
  });

  const invalidate: ProjectEnrichmentService["Service"]["invalidate"] = Effect.fn(
    "ProjectEnrichmentService.invalidate",
  )(function* (workspaceRoots) {
    yield* Effect.forEach(
      new Set(workspaceRoots),
      (workspaceRoot) =>
        Effect.all(
          [
            Cache.invalidate(repositoryIdentityCache, workspaceRoot),
            Cache.invalidate(faviconCache, workspaceRoot),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      { discard: true },
    );
  });

  return ProjectEnrichmentService.of({
    peek,
    request,
    getAvailable,
    invalidate,
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(ProjectEnrichmentService, make());
