import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const available = yield* service.peek(workspaceRoot);
    if (predicate(available)) return available;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(`Project metadata for ${workspaceRoot} was not resolved in time.`);
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
    Layer.provide(NodeServices.layer),
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

it.effect.each([
  ["without a remote", Effect.succeed(null)],
  ["whose identity lookup fails", Effect.die("git is unavailable")],
] as const)("reports the checkout containing a subdirectory project %s", ([, identity]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "enrichment-root-" });
    const projectRoot = path.join(repoRoot, "ios");
    yield* fileSystem.makeDirectory(path.join(repoRoot, ".git"));
    yield* fileSystem.makeDirectory(projectRoot);
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => identity,
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    );

    const available = yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* service.request(projectRoot);
      return yield* waitForAvailable(
        service,
        projectRoot,
        (value) => value.repositoryRoot !== null,
      );
    }).pipe(Effect.provide(layer(layerMetadata)));

    assert.isNull(available.repositoryIdentity);
    assert.equal(available.repositoryRoot, repoRoot);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
