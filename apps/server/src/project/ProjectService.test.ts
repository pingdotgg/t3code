import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, type Project, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const workspacePathsLayer = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

const metadataLayer = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: (workspaceRoot) =>
      Effect.succeed({
        canonicalKey: `github.com/t3tools/${workspaceRoot.split("/").at(-1)}`,
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: `git@github.com:t3tools/${workspaceRoot.split("/").at(-1)}.git`,
        },
        rootPath: workspaceRoot,
      }),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: (workspaceRoot) => Effect.succeed(`${workspaceRoot}/favicon.svg`),
  }),
);

const makeTestLayer = (
  projectMetadataLayer: Layer.Layer<
    | ProjectFaviconResolver.ProjectFaviconResolver
    | RepositoryIdentityResolver.RepositoryIdentityResolver
  >,
) =>
  ProjectServiceLayerLive.pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(workspacePathsLayer),
    Layer.provideMerge(projectMetadataLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-service-test-" })),
    Layer.provide(NodeServices.layer),
  );

const TestLayer = makeTestLayer(metadataLayer);

const waitForProject = Effect.fn("ProjectServiceTest.waitForProject")(function* (
  service: ProjectService.ProjectService["Service"],
  projectId: ProjectId,
  predicate: (project: Project) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const project = Option.getOrThrow(yield* service.getById(projectId));
    if (predicate(project)) return project;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(`Project ${projectId} was not enriched in time.`);
});

it.layer(TestLayer)("ProjectService", (it) => {
  it.effect("creates, updates, resolves, snapshots, and soft-deletes projects", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("project:service-test");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex_custom"),
        model: "gpt-5.1-codex",
      } as const;
      yield* TestClock.setTime(Date.parse("2026-06-20T10:00:00.000Z"));

      const created = yield* service.create({
        commandId: CommandId.make("command:project:create"),
        projectId,
        title: "Project",
        workspaceRoot: "/work/project/",
        defaultModelSelection: modelSelection,
        scripts: [
          {
            id: "setup",
            name: "Setup",
            command: "vp install",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      });
      assert.equal(created.workspaceRoot, "/work/project");
      assert.isNull(created.repositoryIdentity);
      assert.isNull(created.faviconPath);

      const hydratedCreated = yield* waitForProject(
        service,
        projectId,
        (project) => project.repositoryIdentity !== null && project.faviconPath !== null,
      );
      assert.equal(hydratedCreated?.repositoryIdentity?.canonicalKey, "github.com/t3tools/project");
      assert.equal(hydratedCreated?.faviconPath, "/work/project/favicon.svg");

      const updated = yield* service.update({
        commandId: CommandId.make("command:project:update"),
        projectId,
        title: "Renamed",
      });
      assert.equal(updated.title, "Renamed");
      assert.equal(updated.createdAt, created.createdAt);

      const byId = yield* service.getById(projectId);
      const byWorkspace = yield* service.getByWorkspaceRoot("/work/project/");
      assert.isTrue(Option.isSome(byId));
      assert.isTrue(Option.isSome(byWorkspace));
      assert.equal(Option.getOrThrow(byWorkspace).id, projectId);
      assert.deepEqual(
        (yield* service.snapshot).projects.map((project) => project.id),
        [projectId],
      );

      const deleted = yield* service.delete({
        commandId: CommandId.make("command:project:delete"),
        projectId,
      });
      assert.isNotNull(deleted.deletedAt);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
      assert.isTrue(Option.isSome(yield* service.getById(projectId, { includeDeleted: true })));
      assert.deepEqual((yield* service.snapshot).projects, []);

      const sql = yield* SqlClient.SqlClient;
      const changes = yield* sql<{ readonly event_type: string }>`
        SELECT event_type
        FROM orchestration_events
        WHERE aggregate_kind = 'project' AND stream_id = ${projectId}
        ORDER BY sequence ASC
      `;
      assert.deepEqual(
        changes.map((change) => change.event_type),
        ["project.created", "project.meta-updated", "project.deleted"],
      );
    }),
  );

  it.effect("rejects active workspace collisions", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      yield* TestClock.setTime(Date.parse("2026-06-20T10:00:00.000Z"));
      yield* service.create({
        commandId: CommandId.make("command:collision:first"),
        projectId: ProjectId.make("project:collision:first"),
        title: "First",
        workspaceRoot: "/work/shared",
      });
      const error = yield* service
        .create({
          commandId: CommandId.make("command:collision:second"),
          projectId: ProjectId.make("project:collision:second"),
          title: "Second",
          workspaceRoot: "/work/shared",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProjectConflictError");
    }),
  );

  it.effect("auto-bootstraps a workspace exactly once", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      yield* TestClock.setTime(Date.parse("2026-06-20T10:00:00.000Z"));
      const input = {
        commandId: CommandId.make("command:bootstrap:first"),
        projectId: ProjectId.make("project:bootstrap"),
        title: "Bootstrap",
        workspaceRoot: "/work/bootstrap/",
      };
      const first = yield* service.bootstrap(input);
      const second = yield* service.bootstrap({
        ...input,
        commandId: CommandId.make("command:bootstrap:second"),
        projectId: ProjectId.make("project:bootstrap:unused"),
      });
      assert.isTrue(first.created);
      assert.isFalse(second.created);
      assert.equal(second.project.id, first.project.id);
    }),
  );
});

it.effect(
  "returns project mutations before slow enrichment and shares the eventual result across reads",
  () =>
    Effect.gen(function* () {
      const repositoryStarted = yield* Deferred.make<void>();
      const releaseRepository = yield* Deferred.make<void>();
      const repositoryCalls = yield* Ref.make(0);
      const faviconCalls = yield* Ref.make(0);

      const slowMetadataLayer = Layer.merge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (workspaceRoot) =>
            Effect.gen(function* () {
              yield* Ref.update(repositoryCalls, (count) => count + 1);
              yield* Deferred.succeed(repositoryStarted, undefined);
              yield* Deferred.await(releaseRepository);
              return {
                canonicalKey: "github.com/t3tools/slow-project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:t3tools/slow-project.git",
                },
                rootPath: workspaceRoot,
              };
            }),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          resolvePath: (workspaceRoot) =>
            Ref.updateAndGet(faviconCalls, (count) => count + 1).pipe(
              Effect.as(`${workspaceRoot}/favicon.svg`),
            ),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ProjectService.ProjectService;
        const projectId = ProjectId.make("project:slow-enrichment");
        const createFiber = yield* service
          .create({
            commandId: CommandId.make("command:slow-enrichment:create"),
            projectId,
            title: "Slow enrichment",
            workspaceRoot: "/work/slow-enrichment",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(repositoryStarted);
        yield* Effect.yieldNow;
        assert.isDefined(createFiber.pollUnsafe());

        const created = yield* Fiber.join(createFiber);
        assert.isNull(created.repositoryIdentity);
        assert.isNull(created.faviconPath);

        const updated = yield* service.update({
          commandId: CommandId.make("command:slow-enrichment:update"),
          projectId,
          title: "Updated before enrichment",
        });
        assert.equal(updated.title, "Updated before enrichment");
        assert.isNull(updated.repositoryIdentity);
        assert.equal(updated.faviconPath, "/work/slow-enrichment/favicon.svg");

        const immediateReadFiber = yield* service
          .getById(projectId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        assert.isDefined(immediateReadFiber.pollUnsafe());
        const immediateRead = Option.getOrThrow(yield* Fiber.join(immediateReadFiber));
        assert.isNull(immediateRead.repositoryIdentity);
        assert.equal(immediateRead.faviconPath, "/work/slow-enrichment/favicon.svg");

        const snapshotFiber = yield* service.snapshot.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        assert.isDefined(snapshotFiber.pollUnsafe());
        const immediateSnapshot = yield* Fiber.join(snapshotFiber);
        assert.isNull(immediateSnapshot.projects[0]?.repositoryIdentity ?? null);

        yield* Deferred.succeed(releaseRepository, undefined);

        const firstProject = yield* waitForProject(
          service,
          projectId,
          (project) => project.repositoryIdentity !== null && project.faviconPath !== null,
        );
        assert.isDefined(firstProject);
        assert.equal(
          firstProject.repositoryIdentity?.canonicalKey,
          "github.com/t3tools/slow-project",
        );
        assert.equal(firstProject.faviconPath, "/work/slow-enrichment/favicon.svg");

        const byId = Option.getOrThrow(yield* service.getById(projectId));
        const secondSnapshot = yield* service.snapshot;
        assert.equal(byId.repositoryIdentity?.canonicalKey, "github.com/t3tools/slow-project");
        assert.equal(secondSnapshot.projects[0]?.faviconPath, "/work/slow-enrichment/favicon.svg");
        assert.equal(yield* Ref.get(repositoryCalls), 1);
        assert.equal(yield* Ref.get(faviconCalls), 1);
      }).pipe(Effect.provide(makeTestLayer(slowMetadataLayer)));
    }),
);

it.effect("keeps project snapshots available when optional metadata enrichment fails", () =>
  Effect.gen(function* () {
    const failingMetadataLayer = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: (workspaceRoot) =>
          Effect.fail(
            new ProjectFaviconResolver.ProjectFaviconResolutionError({
              operation: "stat-candidate",
              workspaceRoot,
              cause: "permission denied",
            }),
          ),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("project:failed-enrichment");
      yield* service.create({
        commandId: CommandId.make("command:failed-enrichment:create"),
        projectId,
        title: "Still visible",
        workspaceRoot: "/work/failed-enrichment",
      });

      const snapshot = yield* service.snapshot;
      assert.equal(snapshot.projects.length, 1);
      assert.equal(snapshot.projects[0]?.id, projectId);
      assert.equal(snapshot.projects[0]?.title, "Still visible");
      assert.isNull(snapshot.projects[0]?.repositoryIdentity ?? null);
      assert.isNull(snapshot.projects[0]?.faviconPath ?? null);
    }).pipe(Effect.provide(makeTestLayer(failingMetadataLayer)));
  }),
);

it.effect("invalidates workspace-derived metadata when a project moves", () =>
  Effect.gen(function* () {
    const metadataVersion = yield* Ref.make(1);
    const versionedMetadataLayer = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          Ref.get(metadataVersion).pipe(
            Effect.map((version) => ({
              canonicalKey: `example.test/v${version}${workspaceRoot}`,
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: `https://example.test/v${version}${workspaceRoot}.git`,
              },
              rootPath: workspaceRoot,
            })),
          ),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: (workspaceRoot) =>
          Ref.get(metadataVersion).pipe(
            Effect.map((version) => `${workspaceRoot}/favicon-v${version}.svg`),
          ),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("project:moved-enrichment");
      yield* service.create({
        commandId: CommandId.make("command:moved-enrichment:create"),
        projectId,
        title: "Moved",
        workspaceRoot: "/work/original",
      });
      assert.equal(
        (yield* waitForProject(
          service,
          projectId,
          (project) => project.faviconPath === "/work/original/favicon-v1.svg",
        )).faviconPath,
        "/work/original/favicon-v1.svg",
      );

      yield* Ref.set(metadataVersion, 2);
      yield* service.update({
        commandId: CommandId.make("command:moved-enrichment:away"),
        projectId,
        workspaceRoot: "/work/temporary",
      });
      yield* service.snapshot;

      yield* Ref.set(metadataVersion, 3);
      yield* service.update({
        commandId: CommandId.make("command:moved-enrichment:return"),
        projectId,
        workspaceRoot: "/work/original",
      });
      assert.equal(
        (yield* waitForProject(
          service,
          projectId,
          (project) => project.faviconPath === "/work/original/favicon-v3.svg",
        )).faviconPath,
        "/work/original/favicon-v3.svg",
      );
    }).pipe(Effect.provide(makeTestLayer(versionedMetadataLayer)));
  }),
);
