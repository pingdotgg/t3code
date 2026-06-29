import { assert, it } from "@effect/vitest";
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const makeLayer = (
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
    const metadataLayer = Layer.merge(
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
    }).pipe(Effect.provide(makeLayer(metadataLayer)));
  }),
);

it.effect("publishes repository completion while favicon enrichment is still pending", () =>
  Effect.gen(function* () {
    const releaseFavicon = yield* Deferred.make<void>();
    const metadataLayer = Layer.merge(
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
    }).pipe(Effect.provide(makeLayer(metadataLayer)));
  }),
);

it.effect("keeps repository workers available when every favicon worker is hung", () =>
  Effect.gen(function* () {
    const faviconWorkersStarted = yield* Deferred.make<void>();
    const faviconStarts = yield* Ref.make(0);
    const metadataLayer = Layer.merge(
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
        makeLayer(metadataLayer, {
          cacheCapacity: 8,
          maxPending: 4,
          concurrency: 2,
        }),
      ),
    );
  }),
);

it.effect("deduplicates requests, bounds pending work, and reloads invalidated roots", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const repositoryCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const version = yield* Ref.make(1);
    const metadataLayer = Layer.merge(
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
        makeLayer(metadataLayer, {
          cacheCapacity: 8,
          maxPending: 2,
          concurrency: 1,
        }),
      ),
    );
  }),
);
