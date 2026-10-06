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
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerWorkspacePaths = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

const layerMetadata = Layer.merge(
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

const layerTestFor = (
  projectMetadataLayer: Layer.Layer<
    | ProjectFaviconResolver.ProjectFaviconResolver
    | RepositoryIdentityResolver.RepositoryIdentityResolver
  >,
) =>
  RuntimeLayer.layerProjectService.pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(layerWorkspacePaths),
    Layer.provideMerge(projectMetadataLayer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-service-test-" })),
    Layer.provide(NodeServices.layer),
  );

const layerTest = layerTestFor(layerMetadata);

/** Every dependency of ProjectService.make, so a test can swap one of them. */
const layerProjectServiceDependencies = Layer.mergeAll(
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provideMerge(LegacyV1ThreadImporter.layer.pipe(Layer.provide(RuntimeLayer.layerEventSink))),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(layerWorkspacePaths),
  Layer.provideMerge(layerMetadata),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-service-race-" })),
  Layer.provide(NodeServices.layer),
);

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

it.layer(layerTest)("ProjectService", (it) => {
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
        autoPull: true,
        projectIcon: { kind: "emoji", emoji: "🦊" },
        faviconPath: "/work/project/custom.svg",
        defaultThreadEnvMode: "worktree",
      });
      assert.equal(updated.title, "Renamed");
      assert.equal(updated.createdAt, created.createdAt);
      assert.isTrue(updated.autoPull);
      assert.deepEqual(updated.projectIcon, { kind: "emoji", emoji: "🦊" });
      assert.equal(updated.faviconPath, "/work/project/custom.svg");
      assert.equal(updated.defaultThreadEnvMode, "worktree");

      const byId = yield* service.getById(projectId);
      const byWorkspace = yield* service.getByWorkspaceRoot("/work/project/");
      assert.isTrue(Option.isSome(byId));
      assert.isTrue(Option.isSome(byWorkspace));
      assert.equal(Option.getOrThrow(byWorkspace).id, projectId);
      assert.isTrue(Option.getOrThrow(byId).autoPull);
      assert.deepEqual(Option.getOrThrow(byId).projectIcon, updated.projectIcon);
      assert.equal(Option.getOrThrow(byId).faviconPath, updated.faviconPath);
      assert.equal(Option.getOrThrow(byId).defaultThreadEnvMode, "worktree");
      const reset = yield* service.update({
        commandId: CommandId.make("command:project:reset-appearance"),
        projectId,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
      });
      assert.isFalse(reset.autoPull);
      assert.isNull(reset.projectIcon);
      assert.equal(reset.faviconPath, hydratedCreated.faviconPath);
      assert.isNull(reset.defaultThreadEnvMode);
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
        ["project.created", "project.meta-updated", "project.meta-updated", "project.deleted"],
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

  it.effect("commits the event, the row and the receipt together, once per command id", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:retry");
      const input = {
        commandId: CommandId.make("command:retry:create"),
        projectId,
        title: "Retry",
        workspaceRoot: "/work/retry",
      };
      const first = yield* service.create(input);
      // A retry re-plans against the row it created; its receipt still answers.
      const retried = yield* service.create(input);
      assert.deepEqual(retried, first);
      const updateInput = {
        commandId: CommandId.make("command:retry:update"),
        projectId,
        autoPull: true,
      };
      yield* service.update(updateInput);
      yield* service.update(updateInput);

      const committed = yield* sql<{
        readonly sequence: number;
        readonly event_type: string;
        readonly receipt_sequence: number;
        readonly status: string;
        readonly aggregate_kind: string;
      }>`
        SELECT events.sequence, events.event_type,
          receipts.result_sequence AS receipt_sequence, receipts.status, receipts.aggregate_kind
        FROM orchestration_events AS events
        JOIN orchestration_command_receipts AS receipts ON receipts.command_id = events.command_id
        WHERE events.stream_id = ${projectId}
        ORDER BY events.sequence
      `;
      assert.deepEqual(
        committed.map((row) => [row.event_type, row.status, row.aggregate_kind]),
        [
          ["project.created", "accepted", "project"],
          ["project.meta-updated", "accepted", "project"],
        ],
      );
      for (const row of committed) assert.equal(row.receipt_sequence, row.sequence);
      assert.isTrue(Option.getOrThrow(yield* service.getById(projectId)).autoPull);
    }),
  );

  it.effect("replays a rejected receipt instead of re-planning the command", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:rejected");
      yield* service.create({
        commandId: CommandId.make("command:rejected:create"),
        projectId,
        title: "Rejected",
        workspaceRoot: "/work/rejected",
      });
      const invalid = {
        commandId: CommandId.make("command:rejected:script"),
        projectId,
        scripts: [
          {
            id: "Not.Valid",
            name: "Invalid",
            command: "true",
            icon: "play" as const,
            runOnWorktreeCreate: false,
          },
        ],
      };
      const first = yield* service.update(invalid).pipe(Effect.flip);
      assert.equal(first._tag, "ProjectOperationError");
      // Same id, now a valid payload: the recorded rejection wins.
      const replayed = yield* service
        .update({ ...invalid, scripts: [{ ...invalid.scripts[0]!, id: "valid" }] })
        .pipe(Effect.flip);
      assert.equal(replayed._tag, "ProjectOperationError");
      assert.include(
        String(replayed._tag === "ProjectOperationError" && replayed.cause),
        "Script ID",
      );
      const receipts = yield* sql<{ readonly status: string; readonly aggregate_id: string }>`
        SELECT status, aggregate_id FROM orchestration_command_receipts
        WHERE command_id = ${invalid.commandId}
      `;
      assert.deepEqual(receipts, [{ status: "rejected", aggregate_id: projectId }]);
      const events = yield* sql`
        SELECT sequence FROM orchestration_events WHERE command_id = ${invalid.commandId}
      `;
      assert.deepEqual(events, []);
      assert.deepEqual(Option.getOrThrow(yield* service.getById(projectId)).scripts, []);
    }),
  );

  it.effect("rejects a workspace another active project holds", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const other = ProjectId.make("project:conflict:mover");
      yield* service.create({
        commandId: CommandId.make("command:conflict:holder"),
        projectId: ProjectId.make("project:conflict:holder"),
        title: "Holder",
        workspaceRoot: "/work/conflict",
      });
      yield* service.create({
        commandId: CommandId.make("command:conflict:mover"),
        projectId: other,
        title: "Mover",
        workspaceRoot: "/work/conflict-mover",
      });
      const move = yield* service
        .update({
          commandId: CommandId.make("command:conflict:move"),
          projectId: other,
          workspaceRoot: "/work/conflict",
        })
        .pipe(Effect.flip);
      assert.equal(move._tag, "ProjectConflictError");
      assert.equal(
        Option.getOrThrow(yield* service.getById(other)).workspaceRoot,
        "/work/conflict-mover",
      );
    }),
  );

  it.effect("replays a workspace conflict after the workspace frees up", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const holderId = ProjectId.make("project:freed:holder");
      yield* service.create({
        commandId: CommandId.make("command:freed:holder"),
        projectId: holderId,
        title: "Holder",
        workspaceRoot: "/work/freed",
      });
      const claim = {
        commandId: CommandId.make("command:freed:claim"),
        projectId: ProjectId.make("project:freed:claim"),
        title: "Claim",
        workspaceRoot: "/work/freed",
      };
      const first = yield* service.create(claim).pipe(Effect.flip);
      yield* service.delete({
        commandId: CommandId.make("command:freed:delete"),
        projectId: holderId,
      });
      // A fresh plan would now succeed; the recorded conflict still answers.
      const replayed = yield* service.create(claim).pipe(Effect.flip);
      assert.deepEqual(replayed, first);
      assert.instanceOf(replayed, ProjectService.ProjectConflictError);
      assert.isTrue(
        Option.isNone(yield* service.getById(claim.projectId, { includeDeleted: true })),
      );
    }),
  );

  it.effect("returns the deleted project when a completed delete is retried", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:delete-retry");
      yield* service.create({
        commandId: CommandId.make("command:delete-retry:create"),
        projectId,
        title: "Delete retry",
        workspaceRoot: "/work/delete-retry",
      });
      const input = { commandId: CommandId.make("command:delete-retry:delete"), projectId };
      const deleted = yield* service.delete(input);
      assert.deepEqual(yield* service.delete(input), deleted);
      const events = yield* sql<{ readonly command_id: string }>`
        SELECT command_id FROM orchestration_events
        WHERE stream_id = ${projectId} AND event_type = 'project.deleted'
      `;
      assert.deepEqual(events, [{ command_id: input.commandId }]);
    }),
  );

  it.effect("treats a deleted project as missing for updates and new deletes", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:deleted-target");
      yield* service.create({
        commandId: CommandId.make("command:deleted-target:create"),
        projectId,
        title: "Deleted target",
        workspaceRoot: "/work/deleted-target",
      });
      yield* service.delete({
        commandId: CommandId.make("command:deleted-target:delete"),
        projectId,
      });
      const again = yield* service
        .delete({ commandId: CommandId.make("command:deleted-target:delete-again"), projectId })
        .pipe(Effect.flip);
      assert.instanceOf(again, ProjectService.ProjectNotFoundError);
      const events = yield* sql<{ readonly event_type: string }>`
        SELECT event_type FROM orchestration_events
        WHERE stream_id = ${projectId} ORDER BY sequence ASC
      `;
      assert.deepEqual(
        events.map((event) => event.event_type),
        ["project.created", "project.deleted"],
      );
    }),
  );

  it.effect("rolls back the event and receipt when the row write fails", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:atomic");
      yield* sql`
        CREATE TRIGGER fail_project_row BEFORE INSERT ON projection_projects
        WHEN NEW.project_id = 'project:atomic'
        BEGIN SELECT RAISE(ABORT, 'injected row failure'); END
      `;
      const input = {
        commandId: CommandId.make("command:atomic:create"),
        projectId,
        title: "Atomic",
        workspaceRoot: "/work/atomic",
      };
      const failure = yield* service.create(input).pipe(Effect.flip);
      assert.equal(failure._tag, "ProjectOperationError");
      const leftovers = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_events WHERE command_id = ${input.commandId}) +
          (SELECT COUNT(*) FROM orchestration_command_receipts WHERE command_id = ${input.commandId}) +
          (SELECT COUNT(*) FROM projection_projects WHERE project_id = ${projectId}) AS count
      `;
      assert.equal(leftovers[0]?.count, 0);
      yield* sql`DROP TRIGGER fail_project_row`;
      assert.equal((yield* service.create(input)).id, projectId);
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

      const layerSlowMetadata = Layer.merge(
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
      }).pipe(Effect.provide(layerTestFor(layerSlowMetadata)));
    }),
);

it.effect("keeps project snapshots available when optional metadata enrichment fails", () =>
  Effect.gen(function* () {
    const layerFailingMetadata = Layer.merge(
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
    }).pipe(Effect.provide(layerTestFor(layerFailingMetadata)));
  }),
);

it.effect("invalidates workspace-derived metadata when a project moves", () =>
  Effect.gen(function* () {
    const metadataVersion = yield* Ref.make(1);
    const layerVersionedMetadata = Layer.merge(
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
    }).pipe(Effect.provide(layerTestFor(layerVersionedMetadata)));
  }),
);

it.effect("serializes two projects claiming the same workspace root", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const firstReachedCommit = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    // Hold the first claim between its plan and its commit.
    const gatedSink = EventSink.EventSinkV2.of({
      ...eventSink,
      commitProjectCommand: (input) =>
        input.projectId === "project:race:first"
          ? Deferred.succeed(firstReachedCommit, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(eventSink.commitProjectCommand(input)),
            )
          : eventSink.commitProjectCommand(input),
    });
    const service = yield* ProjectService.make.pipe(
      Effect.provideService(EventSink.EventSinkV2, gatedSink),
    );
    const claim = (name: string) =>
      service.create({
        commandId: CommandId.make(`command:race:${name}`),
        projectId: ProjectId.make(`project:race:${name}`),
        title: name,
        workspaceRoot: "/work/race",
      });
    const first = yield* claim("first").pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(firstReachedCommit);
    const second = yield* claim("second").pipe(
      Effect.flip,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    assert.isUndefined(second.pollUnsafe());
    yield* Deferred.succeed(releaseFirst, undefined);
    assert.equal((yield* Fiber.join(first)).id, "project:race:first");
    assert.equal((yield* Fiber.join(second))._tag, "ProjectConflictError");
  }).pipe(Effect.provide(layerProjectServiceDependencies)),
);

it.effect("rejects an update that waited on the lock while its project was deleted", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const deleteReachedCommit = yield* Deferred.make<void>();
    const releaseDelete = yield* Deferred.make<void>();
    // Hold the delete between its plan and its commit, inside the project lock.
    const gatedSink = EventSink.EventSinkV2.of({
      ...eventSink,
      commitProjectCommand: (input) =>
        input.commandType === "project.delete"
          ? Deferred.succeed(deleteReachedCommit, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDelete)),
              Effect.andThen(eventSink.commitProjectCommand(input)),
            )
          : eventSink.commitProjectCommand(input),
    });
    const service = yield* ProjectService.make.pipe(
      Effect.provideService(EventSink.EventSinkV2, gatedSink),
    );
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:update-race");
    yield* service.create({
      commandId: CommandId.make("command:update-race:create"),
      projectId,
      title: "Update race",
      workspaceRoot: "/work/update-race",
    });
    const deletion = yield* service
      .delete({ commandId: CommandId.make("command:update-race:delete"), projectId })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(deleteReachedCommit);
    const updateCommandId = CommandId.make("command:update-race:update");
    // The update sees the active row, then queues behind the delete's lock.
    const update = yield* service
      .update({ commandId: updateCommandId, projectId, title: "Too late" })
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseDelete, undefined);
    assert.isNotNull((yield* Fiber.join(deletion)).deletedAt);
    assert.instanceOf(yield* Fiber.join(update), ProjectService.ProjectNotFoundError);
    // The planner rejected it under the lock, so the rejection has a receipt.
    const receipts = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_command_receipts WHERE command_id = ${updateCommandId}
    `;
    assert.deepEqual(receipts, [{ status: "rejected" }]);
    const events = yield* sql<{ readonly event_type: string }>`
      SELECT event_type FROM orchestration_events
      WHERE stream_id = ${projectId} ORDER BY sequence ASC
    `;
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["project.created", "project.deleted"],
    );
    assert.equal(
      Option.getOrThrow(yield* service.getById(projectId, { includeDeleted: true })).title,
      "Update race",
    );
  }).pipe(Effect.provide(layerProjectServiceDependencies)),
);
