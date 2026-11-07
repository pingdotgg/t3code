import { assert, it } from "@effect/vitest";
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as ProjectEnrichment from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const identity = (workspaceRoot: string, version = 1): RepositoryIdentity => ({
  canonicalKey: `example.test/v${version}${workspaceRoot}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://example.test/v${version}${workspaceRoot}.git`,
  },
  rootPath: workspaceRoot,
});

const waitForAvailable = Effect.fn("ProjectEnrichmentServiceTest.waitForAvailable")(function* (
  service: ProjectEnrichment.ProjectEnrichmentService["Service"],
  workspaceRoot: string,
  predicate: (value: ProjectEnrichment.ProjectEnrichment) => boolean,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* service.subscribeChanges;
      for (;;) {
        const available = yield* service.peek(workspaceRoot);
        if (predicate(available)) return available;
        yield* PubSub.take(changes);
      }
    }),
  );
});

const layer = (
  metadataLayer: Layer.Layer<
    | ProjectFaviconResolver.ProjectFaviconResolver
    | RepositoryIdentityResolver.RepositoryIdentityResolver
  >,
  options: ProjectEnrichment.ProjectEnrichmentServiceOptions = {},
) =>
  Layer.effect(ProjectEnrichment.ProjectEnrichmentService, ProjectEnrichment.make(options)).pipe(
    Layer.provide(metadataLayer),
  );

it.effect("publishes repository completion while favicon enrichment is still pending", () =>
  Effect.gen(function* () {
    const releaseFavicon = yield* Deferred.make<void>();
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) => Effect.succeed(identity(workspaceRoot)),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: (workspaceRoot) =>
          Deferred.await(releaseFavicon).pipe(Effect.as(`${workspaceRoot}/favicon.svg`)),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      const changes = yield* service.subscribeChanges;
      yield* service.request("/completed");

      const change = yield* PubSub.take(changes);
      assert.equal(change.workspaceRoot, "/completed");
      assert.isTrue(change.repositoryIdentityResolved);
      assert.equal(change.enrichment.repositoryIdentity?.canonicalKey, "example.test/v1/completed");
      assert.isNull(change.enrichment.faviconPath);
    }).pipe(Effect.provide(layer(layerMetadata)));
  }),
);

it.effect("keeps repository workers available when every favicon worker is hung", () =>
  Effect.gen(function* () {
    const faviconWorkersStarted = yield* Deferred.make<void>();
    const faviconStarts = yield* Ref.make(0);
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) => Effect.succeed(identity(workspaceRoot)),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () =>
          Effect.gen(function* () {
            const started = yield* Ref.updateAndGet(faviconStarts, (count) => count + 1);
            if (started === 2) {
              yield* Deferred.succeed(faviconWorkersStarted, undefined);
            }
            return yield* Effect.never;
          }),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* service.request("/favicon-hung-a");
      yield* service.request("/favicon-hung-b");
      yield* Deferred.await(faviconWorkersStarted);

      yield* service.request("/repository-later");
      const available = yield* waitForAvailable(
        service,
        "/repository-later",
        (value) => value.repositoryIdentity !== null,
      );

      assert.equal(available.repositoryIdentity?.canonicalKey, "example.test/v1/repository-later");
      assert.equal(yield* Ref.get(faviconStarts), 2);
    }).pipe(
      Effect.provide(
        layer(layerMetadata, {
          cacheCapacity: 8,
          maxPending: 4,
          concurrency: 2,
        }),
      ),
    );
  }),
);

it.effect(
  "reports successful cached null as resolved while cold and failed lookups stay unresolved",
  () =>
    Effect.gen(function* () {
      const repositoryStarted = yield* Deferred.make<void>();
      const releaseRepository = yield* Deferred.make<void>();
      const layerMetadata = Layer.merge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (workspaceRoot) => {
            if (workspaceRoot === "/no-remote") {
              return Effect.succeed(null);
            }
            if (workspaceRoot === "/fails") {
              return Effect.die("repository resolver failed");
            }
            return Deferred.succeed(repositoryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRepository)),
              Effect.as(identity(workspaceRoot)),
            );
          },
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          invalidate: () => Effect.void,
          resolvePath: () => Effect.succeed(null),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ProjectEnrichment.ProjectEnrichmentService;
        const changes = yield* service.subscribeChanges;

        const cold = yield* service.peek("/never-requested");
        assert.isNull(cold.repositoryIdentity);
        assert.isFalse(cold.repositoryIdentityResolved);

        const inFlight = yield* service.getAvailable("/in-flight");
        assert.isNull(inFlight.repositoryIdentity);
        assert.isFalse(inFlight.repositoryIdentityResolved);
        yield* Deferred.await(repositoryStarted);
        assert.isFalse((yield* service.peek("/in-flight")).repositoryIdentityResolved);

        yield* service.request("/no-remote");
        const nullChange = yield* PubSub.take(changes);
        assert.equal(nullChange.workspaceRoot, "/no-remote");
        assert.isTrue(nullChange.repositoryIdentityResolved);
        assert.isNull(nullChange.enrichment.repositoryIdentity);
        assert.isTrue(nullChange.enrichment.repositoryIdentityResolved);

        const warmNull = yield* service.getAvailable("/no-remote");
        assert.isNull(warmNull.repositoryIdentity);
        assert.isTrue(warmNull.repositoryIdentityResolved);

        yield* service.request("/fails");
        const failChange = yield* PubSub.take(changes);
        assert.equal(failChange.workspaceRoot, "/fails");
        assert.isFalse(failChange.repositoryIdentityResolved);
        const failed = yield* service.peek("/fails");
        assert.isNull(failed.repositoryIdentity);
        assert.isFalse(failed.repositoryIdentityResolved);
      }).pipe(Effect.provide(layer(layerMetadata)));
    }),
);

it.effect("deduplicates requests, bounds pending work, and reloads invalidated roots", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const repositoryCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const version = yield* Ref.make(1);
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          Effect.gen(function* () {
            yield* Ref.update(repositoryCalls, (calls) => [...calls, workspaceRoot]);
            if (workspaceRoot === "/first" && (yield* Ref.get(version)) === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return identity(workspaceRoot, yield* Ref.get(version));
          }),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: (workspaceRoot) => Effect.succeed(`${workspaceRoot}/favicon.svg`),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* Effect.forEach(Array.from({ length: 20 }), () => service.request("/first"), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Deferred.await(firstStarted);
      yield* service.request("/second");
      yield* service.request("/dropped");
      assert.deepEqual(yield* Ref.get(repositoryCalls), ["/first"]);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* waitForAvailable(service, "/second", (value) => value.repositoryIdentity !== null);
      assert.deepEqual(yield* Ref.get(repositoryCalls), ["/first", "/second"]);

      yield* service.request("/dropped");
      yield* waitForAvailable(service, "/dropped", (value) => value.repositoryIdentity !== null);
      assert.deepEqual(yield* Ref.get(repositoryCalls), ["/first", "/second", "/dropped"]);

      yield* Ref.set(version, 2);
      yield* service.invalidate(["/first"]);
      const invalidated = yield* service.getAvailable("/first");
      assert.isNull(invalidated.repositoryIdentity);
      const refreshed = yield* waitForAvailable(
        service,
        "/first",
        (value) => value.repositoryIdentity?.canonicalKey === "example.test/v2/first",
      );
      assert.equal(refreshed.repositoryIdentity?.canonicalKey, "example.test/v2/first");
      assert.deepEqual(yield* Ref.get(repositoryCalls), [
        "/first",
        "/second",
        "/dropped",
        "/first",
      ]);
    }).pipe(
      Effect.provide(
        layer(layerMetadata, {
          cacheCapacity: 8,
          maxPending: 2,
          concurrency: 1,
        }),
      ),
    );
  }),
);

it.effect(
  "retains resolved identities through expiry and failed refreshes until a successful replacement",
  () =>
    Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const phase = yield* Ref.make<"initial" | "failed" | "changed" | "removed">("initial");
      const calls = yield* Ref.make(0);
      const layerMetadata = Layer.merge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (workspaceRoot) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (count) => count + 1);
              switch (yield* Ref.get(phase)) {
                case "failed":
                  yield* Deferred.succeed(refreshStarted, undefined);
                  yield* Deferred.await(releaseRefresh);
                  return yield* Effect.die("repository resolver failed");
                case "changed":
                  return identity(workspaceRoot, 2);
                case "removed":
                  return null;
                default:
                  return identity(workspaceRoot);
              }
            }),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          invalidate: () => Effect.void,
          resolvePath: () => Effect.succeed(null),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ProjectEnrichment.ProjectEnrichmentService;
        const changes = yield* service.subscribeChanges;
        assert.deepEqual(yield* service.readRepositoryIdentity("/repo"), identity("/repo"));
        yield* Ref.set(phase, "failed");
        yield* TestClock.adjust("61 seconds");

        const expired = yield* service.getAvailable("/repo");
        assert.deepEqual(expired.repositoryIdentity, identity("/repo"));
        assert.isTrue(expired.repositoryIdentityResolved);
        yield* Deferred.await(refreshStarted);
        assert.deepEqual((yield* service.peek("/repo")).repositoryIdentity, identity("/repo"));
        yield* Deferred.succeed(releaseRefresh, undefined);
        yield* PubSub.take(changes);
        const failed = yield* service.getAvailable("/repo");
        assert.deepEqual(failed.repositoryIdentity, identity("/repo"));
        assert.deepEqual(yield* service.readRepositoryIdentity("/repo"), identity("/repo"));
        assert.equal(yield* Ref.get(calls), 2);

        yield* Ref.set(phase, "changed");
        yield* TestClock.adjust("6 seconds");
        yield* service.request("/repo");
        const changed = yield* PubSub.take(changes);
        assert.deepEqual(changed.enrichment.repositoryIdentity, identity("/repo", 2));
        assert.deepEqual((yield* service.peek("/repo")).repositoryIdentity, identity("/repo", 2));

        yield* Ref.set(phase, "removed");
        yield* TestClock.adjust("61 seconds");
        yield* service.request("/repo");
        const removed = yield* PubSub.take(changes);
        assert.isNull(removed.enrichment.repositoryIdentity);
        assert.isTrue(removed.repositoryIdentityResolved);
        yield* TestClock.adjust("61 seconds");
        const expiredNull = yield* service.peek("/repo");
        assert.isNull(expiredNull.repositoryIdentity);
        assert.isTrue(expiredNull.repositoryIdentityResolved);
      }).pipe(Effect.provide(layer(layerMetadata)));
    }),
);

it.effect("bounds retained repository results and clears them on invalidation", () =>
  Effect.gen(function* () {
    const service = yield* ProjectEnrichment.ProjectEnrichmentService;
    yield* service.readRepositoryIdentity("/evicted");
    yield* service.readRepositoryIdentity("/retained");
    yield* service.readRepositoryIdentity("/invalidated");
    yield* TestClock.adjust("61 seconds");
    const evicted = yield* service.peek("/evicted");
    assert.isNull(evicted.repositoryIdentity);
    assert.isFalse(evicted.repositoryIdentityResolved);
    assert.deepEqual((yield* service.peek("/retained")).repositoryIdentity, identity("/retained"));
    yield* service.invalidate(["/invalidated"]);
    const invalidated = yield* service.peek("/invalidated");
    assert.isNull(invalidated.repositoryIdentity);
    assert.isFalse(invalidated.repositoryIdentityResolved);
  }).pipe(
    Effect.provide(
      layer(
        Layer.merge(
          Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
            resolve: (workspaceRoot) => Effect.succeed(identity(workspaceRoot)),
          }),
          Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
            invalidate: () => Effect.void,
            resolvePath: () => Effect.succeed(null),
          }),
        ),
        { cacheCapacity: 2 },
      ),
    ),
  ),
);

it.effect("does not retain an invalidated lookup over a newer confirmed null", () =>
  Effect.gen(function* () {
    const begin = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          Deferred.await(begin).pipe(
            Effect.andThen(Deferred.isDone(started)),
            Effect.flatMap((isRefresh) =>
              isRefresh
                ? Effect.succeed(null)
                : Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(identity(workspaceRoot)),
                  ),
            ),
          ),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      const oldRead = yield* service
        .readRepositoryIdentity("/repo")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(begin, undefined);
      yield* Deferred.await(started);
      yield* service.invalidate(["/repo"]);
      assert.isNull(yield* service.readRepositoryIdentity("/repo"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(oldRead);
      assert.isNull((yield* service.peek("/repo")).repositoryIdentity);
      yield* TestClock.adjust("61 seconds");
      const expired = yield* service.peek("/repo");
      assert.isNull(expired.repositoryIdentity);
      assert.isTrue(expired.repositoryIdentityResolved);
    }).pipe(Effect.provide(layer(layerMetadata)));
  }),
);
