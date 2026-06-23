import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

it.effect("keeps shell snapshots and later deltas moving while project enrichment is hung", () =>
  Effect.gen(function* () {
    const repositoryStarted = yield* Deferred.make<void>();
    const releaseRepository = yield* Deferred.make<void>();
    const metadataLayer = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          Deferred.succeed(repositoryStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRepository)),
            Effect.as({
              canonicalKey: "example.test/project",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "https://example.test/project.git",
              },
              rootPath: workspaceRoot,
            }),
          ),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    );
    const testLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(ProjectEnrichment.layer),
      Layer.provideMerge(metadataLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "projection-snapshot-query-test-" }),
      ),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const projectId = ProjectId.make("project:hung-enrichment");
      const now = "2026-06-22T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Hung enrichment',
          '/work/hung-enrichment',
          NULL,
          '[]',
          ${now},
          ${now},
          NULL
        )
      `;

      const snapshotFiber = yield* query
        .getShellSnapshot()
        .pipe(Effect.forkChild({ startImmediately: true }));
      const snapshot = yield* Fiber.join(snapshotFiber);
      assert.equal(snapshot.projects[0]?.id, projectId);
      assert.isNull(snapshot.projects[0]?.repositoryIdentity ?? null);
      yield* Deferred.await(repositoryStarted);

      const delivered = yield* Stream.fromIterable(["project", "thread"] as const).pipe(
        Stream.mapEffect((kind) =>
          kind === "project"
            ? query.getProjectShellById(projectId).pipe(Effect.as(kind))
            : Effect.succeed(kind),
        ),
        Stream.runCollect,
      );
      assert.deepEqual(Array.from(delivered), ["project", "thread"]);

      yield* Deferred.succeed(releaseRepository, undefined);
    }).pipe(Effect.provide(testLayer));
  }),
);
