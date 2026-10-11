import { assert, it } from "@effect/vitest";
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

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
  );

it.effect("preserves either enrichment field when the other resolver fails", () =>
  Effect.gen(function* () {
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          workspaceRoot === "/repo-fails"
            ? Effect.die("repository resolver failed")
            : Effect.succeed(identity(workspaceRoot)),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: (workspaceRoot) =>
          workspaceRoot === "/favicon-fails"
            ? Effect.fail(
                new ProjectFaviconResolver.ProjectFaviconResolutionError({
                  operation: "stat-candidate",
                  workspaceRoot,
                  cause: "favicon resolver failed",
                }),
              )
            : Effect.succeed(`${workspaceRoot}/favicon.svg`),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* service.request("/favicon-fails");
      yield* service.request("/repo-fails");

      const faviconFailure = yield* waitForAvailable(
        service,
        "/favicon-fails",
        (value) => value.repositoryIdentity !== null,
      );
      assert.equal(
        faviconFailure.repositoryIdentity?.canonicalKey,
        "example.test/v1/favicon-fails",
      );
      assert.isNull(faviconFailure.faviconPath);

      const repositoryFailure = yield* waitForAvailable(
        service,
        "/repo-fails",
        (value) => value.faviconPath !== null,
      );
      assert.isNull(repositoryFailure.repositoryIdentity);
      assert.equal(repositoryFailure.faviconPath, "/repo-fails/favicon.svg");
    }).pipe(Effect.provide(layer(layerMetadata)));
  }),
);

it.effect("does not warn about favicons for workspace roots that no longer exist", () =>
  Effect.gen(function* () {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });
    const metadataLayer = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) => Effect.succeed(identity(workspaceRoot)),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: (workspaceRoot) =>
          Effect.fail(
            workspaceRoot === "/missing"
              ? new ProjectFaviconResolver.ProjectFaviconResolutionError({
                  operation: "normalize-workspace",
                  workspaceRoot,
                  cause: new WorkspacePaths.WorkspaceRootNotExistsError({
                    workspaceRoot,
                    normalizedWorkspaceRoot: workspaceRoot,
                  }),
                })
              : new ProjectFaviconResolver.ProjectFaviconResolutionError({
                  operation: "stat-candidate",
                  workspaceRoot,
                  cause: "favicon resolver failed",
                }),
          ),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* service.request("/missing");
      yield* service.request("/broken");

      for (let attempt = 0; attempt < 100 && warnings.length === 0; attempt += 1) {
        yield* Effect.yieldNow;
      }

      assert.lengthOf(warnings, 1);
      assert.nestedPropertyVal(warnings[0], "[1].workspaceRoot", "/broken");
    }).pipe(
      Effect.provide(
        layer(metadataLayer, { concurrency: 1 }).pipe(
          Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      ),
    );
  }),
);

it.effect("publishes repository completion while favicon enrichment is still pending", () =>
  Effect.gen(function* () {
    const releaseFavicon = yield* Deferred.make<void>();
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) => Effect.succeed(identity(workspaceRoot)),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
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

it.effect("getAvailable returns immediately while repository identity is still unresolved", () =>
  Effect.gen(function* () {
    const repositoryStarted = yield* Deferred.make<void>();
    const releaseRepository = yield* Deferred.make<void>();
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          Deferred.succeed(repositoryStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRepository)),
            Effect.as(identity(workspaceRoot)),
          ),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: (workspaceRoot) => Effect.succeed(`${workspaceRoot}/favicon.svg`),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;

      // Non-blocking path must not wait on hung git/identity resolution.
      const immediate = yield* service.getAvailable("/pending-identity");
      assert.isNull(immediate.repositoryIdentity);
      assert.isNull(immediate.faviconPath);
      assert.isFalse(immediate.repositoryIdentityResolved);

      yield* Deferred.await(repositoryStarted);

      // Background lane still resolves after the snapshot path has returned.
      yield* Deferred.succeed(releaseRepository, undefined);
      const resolved = yield* waitForAvailable(
        service,
        "/pending-identity",
        (value) => value.repositoryIdentity !== null,
      );
      assert.equal(resolved.repositoryIdentity?.canonicalKey, "example.test/v1/pending-identity");
      assert.isTrue(resolved.repositoryIdentityResolved);
    }).pipe(Effect.provide(layer(layerMetadata)));
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

        // Warm success null stays resolved and does not republish.
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

it.effect("rescans a favicon only after 15 minutes", () =>
  Effect.gen(function* () {
    const faviconScans = yield* Ref.make(0);
    const layerMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) => Effect.succeed(identity(workspaceRoot)),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        // Each scan returns a new path, so a wait can tell a rescan from the cached value.
        resolvePath: (workspaceRoot) =>
          Ref.updateAndGet(faviconScans, (count) => count + 1).pipe(
            Effect.map((scan) => `${workspaceRoot}/favicon-${scan}.svg`),
          ),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* service.getAvailable("/repo");
      yield* waitForAvailable(
        service,
        "/repo",
        (value) => value.faviconPath === "/repo/favicon-1.svg",
      );

      // Callers such as the shell stream read projects far more often than this.
      for (let minute = 1; minute < 15; minute += 1) {
        yield* TestClock.adjust("1 minute");
        yield* service.getAvailable("/repo");
      }
      assert.equal(yield* Ref.get(faviconScans), 1);

      yield* TestClock.adjust("1 minute");
      yield* service.getAvailable("/repo");
      yield* waitForAvailable(
        service,
        "/repo",
        (value) => value.faviconPath === "/repo/favicon-2.svg",
      );
      assert.equal(yield* Ref.get(faviconScans), 2);
    }).pipe(Effect.provide(layer(layerMetadata)));
  }),
);

it.effect(
  "follows repository identity changes within a minute without rescanning the favicon",
  () =>
    Effect.gen(function* () {
      // 0: no repository yet, then one version per remote.
      const remoteVersion = yield* Ref.make(0);
      const faviconScans = yield* Ref.make(0);
      const layerMetadata = Layer.merge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (workspaceRoot) =>
            Ref.get(remoteVersion).pipe(
              Effect.map((version) => (version === 0 ? null : identity(workspaceRoot, version))),
            ),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          resolvePath: () => Ref.update(faviconScans, (count) => count + 1).pipe(Effect.as(null)),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ProjectEnrichment.ProjectEnrichmentService;
        yield* service.getAvailable("/folder");
        yield* waitForAvailable(service, "/folder", (value) => value.repositoryIdentityResolved);
        assert.equal((yield* service.peek("/folder")).repositoryIdentity, null);

        // The folder is published as a repository, then its remote moves to another host.
        for (const version of [1, 2]) {
          yield* Ref.set(remoteVersion, version);
          yield* TestClock.adjust("1 minute");
          yield* service.getAvailable("/folder");
          const available = yield* waitForAvailable(
            service,
            "/folder",
            (value) => value.repositoryIdentity?.canonicalKey === `example.test/v${version}/folder`,
          );
          assert.equal(
            available.repositoryIdentity?.canonicalKey,
            `example.test/v${version}/folder`,
          );
        }
        assert.equal(yield* Ref.get(faviconScans), 1);
      }).pipe(Effect.provide(layer(layerMetadata)));
    }),
);
